#include <SPI.h>
#include <WiFi.h>
#include <WebServer.h>
#include <WiFiClientSecure.h>
#include <Preferences.h>
#include <Adafruit_GFX.h>
#include <Adafruit_ST7789.h>
#include <JPEGDEC.h>
#include <ArduinoJson.h>
#include <Adafruit_GPS.h>
#include <qrcode.h>
#include "arduino_secrets.h"

// ---------- TFT ----------
#define TFT_CS   D3
#define TFT_DC   D2
#define TFT_RST  D1
#define TFT_BL   D0

Adafruit_ST7789 tft = Adafruit_ST7789(TFT_CS, TFT_DC, TFT_RST);

// ---------- Encoder / Buttons ----------
#define ENC_CLK      D4
#define ENC_DT       D5
#define ENC_SW       D6
#define CAPTURE_BTN  D9   // was hardcoded 13 (not broken out on XIAO S3)

// ---------- GPS ----------
#define GPS_RX_PIN D7
#define GPS_TX_PIN -1

// --- Baterry Reading ---
#define A_PIN D0

// ---------- GPS Setup ----------
#define GPSSerial Serial1
Adafruit_GPS GPS(&GPSSerial);

// ---------- WiFi ----------
const char* DEFAULT_WIFI_SSID = SECRET_SSID;
const char* DEFAULT_WIFI_PASS = SECRET_PASS;
char wifiSsid[33] = {0};
char wifiPass[65] = {0};

WebServer provisionServer(80);
Preferences prefs;

const char* PROVISION_AP_SSID = "LilCam-Setup";
const char* PROVISION_AP_PASS = "";
const char* PROVISION_URL = "http://192.168.4.1";
const char* PREF_NAMESPACE = "lilcam";
const char* PREF_KEY_SSID = "wifi_ssid";
const char* PREF_KEY_PASS = "wifi_pass";
const unsigned long PROVISION_SKIP_TIMEOUT_MS = 15000;

// ---------- Direct API ----------
const char* API_HOST = "webcams.nyctmc.org";
const int   API_PORT = 443;
const char* CAMERA_LIST_PATH = "/api/cameras";

// ---------- Location ----------
float userLat = 40.69234f;
float userLon = -73.987453f;
bool hasLocation = false;

float lastFetchLat = 0.0f;
float lastFetchLon = 0.0f;
bool hasFetchedNearestOnce = false;
const float NEAREST_REFETCH_THRESHOLD_METERS = 25.0f;

// ---------- Screen ----------
#define SCREEN_W 280
#define SCREEN_H 240

// ---------- Layout ----------
#define TOPBAR_H 24
#define BOTTOMBAR_H 24

#define IMG_X 8
#define IMG_Y 64
#define IMG_W 264
#define IMG_H 148

#define INFO_X 8
#define INFO_Y 24
#define INFO_W 264
#define TITLE_Y 24
#define DIST_Y  44

// ---------- State ----------
const int MAX_NEAREST = 5;
const int MAX_CAPTURES = 10;

struct Camera {
  char id[40];
  char name[96];
  float lat;
  float lon;
  char imageUrl[140];
  float distanceMeters;
};

Camera nearestCameras[MAX_NEAREST];
int nearestCount = 0;
int selectedNearest = 0;

struct CaptureRecord {
  Camera cam;
  unsigned long capturedAtMs;
};

CaptureRecord captures[MAX_CAPTURES];
int captureCount = 0;
int selectedCapture = 0;

enum AppMode {
  MODE_NEAREST,
  MODE_CAPTURES
};

AppMode appMode = MODE_NEAREST;

bool wifiConnected = false;
bool isLoading = false;
int lastHttpCode = 0;

int lastCLK = HIGH;
int lastSW = HIGH;
int lastCaptureBtn = HIGH;

unsigned long lastButtonMs = 0;
unsigned long lastCaptureMs = 0;
const unsigned long buttonDebounceMs = 180;

JPEGDEC jpeg;

bool appBootstrapped = false;
bool provisioningActive = false;
bool provisioningCompleted = false;
bool hasStoredCredentials = false;
bool gpsWaitingScreenDrawn = false;
bool gpsSearchTextVisible = true;
unsigned long gpsBlinkMs = 0;
unsigned long provisioningStartedMs = 0;
const unsigned long GPS_BLINK_INTERVAL_MS = 450;
const unsigned long BOOT_SPLASH_MS = 1000;

// ---------- Network JPEG ----------
struct NetJPEGFile {
  WiFiClientSecure client;
  String path;
  int32_t streamPos;
  int32_t contentLength;
  bool chunked;
};

NetJPEGFile netFile;

// ---------- Chunked Reader ----------
struct ChunkedReader {
  WiFiClientSecure* client;
  int remainingInChunk;
  bool done;
};

// ---------- Helpers ----------
const char* wifiStatusToString(int s) {
  switch (s) {
    case WL_IDLE_STATUS:      return "IDLE";
    case WL_NO_SSID_AVAIL:   return "NO_SSID";
    case WL_SCAN_COMPLETED:   return "SCAN_DONE";
    case WL_CONNECTED:        return "CONNECTED";
    case WL_CONNECT_FAILED:   return "CONNECT_FAILED";
    case WL_CONNECTION_LOST:  return "CONNECTION_LOST";
    case WL_DISCONNECTED:     return "DISCONNECTED";
    default:                  return "UNKNOWN";
  }
}

void logWifiStatus(const char* prefix) {
  int s = WiFi.status();
  Serial.print(prefix);
  Serial.print(" WiFi.status() = ");
  Serial.print(s);
  Serial.print(" (");
  Serial.print(wifiStatusToString(s));
  Serial.println(")");

  if (s == WL_CONNECTED) {
    Serial.print("IP: ");
    Serial.println(WiFi.localIP());
    Serial.print("RSSI: ");
    Serial.println(WiFi.RSSI());
  }
}

void safeCopy(char* dst, size_t dstSize, const char* src) {
  if (!dst || dstSize == 0) return;
  if (!src) {
    dst[0] = '\0';
    return;
  }
  strncpy(dst, src, dstSize - 1);
  dst[dstSize - 1] = '\0';
}

void applyDefaultWifiCredentials() {
  safeCopy(wifiSsid, sizeof(wifiSsid), DEFAULT_WIFI_SSID);
  safeCopy(wifiPass, sizeof(wifiPass), DEFAULT_WIFI_PASS);
}

void loadProvisionedCredentials() {
  applyDefaultWifiCredentials();
  hasStoredCredentials = false;

  if (!prefs.begin(PREF_NAMESPACE, true)) {
    Serial.println("[PROVISION] Preferences open failed (read). Using defaults.");
    return;
  }

  String savedSsid = prefs.getString(PREF_KEY_SSID, "");
  String savedPass = prefs.getString(PREF_KEY_PASS, "");
  prefs.end();

  if (savedSsid.length() > 0) {
    safeCopy(wifiSsid, sizeof(wifiSsid), savedSsid.c_str());
    safeCopy(wifiPass, sizeof(wifiPass), savedPass.c_str());
    hasStoredCredentials = true;
    Serial.print("[PROVISION] Loaded saved SSID: ");
    Serial.println(wifiSsid);
  } else {
    hasStoredCredentials = (strlen(wifiSsid) > 0);
    Serial.println("[PROVISION] No saved credentials. Using defaults.");
  }
}

bool saveProvisionedCredentials(const String& ssidValue, const String& passValue) {
  if (ssidValue.length() == 0) return false;
  if (!prefs.begin(PREF_NAMESPACE, false)) {
    Serial.println("[PROVISION] Preferences open failed (write).");
    return false;
  }

  size_t writtenSsid = prefs.putString(PREF_KEY_SSID, ssidValue);
  size_t writtenPass = prefs.putString(PREF_KEY_PASS, passValue);
  prefs.end();

  bool ok1 = (writtenSsid == ssidValue.length());
  bool ok2 = (writtenPass == passValue.length());
  if (!(ok1 && ok2)) return false;

  safeCopy(wifiSsid, sizeof(wifiSsid), ssidValue.c_str());
  safeCopy(wifiPass, sizeof(wifiPass), passValue.c_str());
  hasStoredCredentials = true;
  return true;
}

String provisioningPageHtml() {
  String html =
    "<!doctype html><html><head><meta name='viewport' content='width=device-width,initial-scale=1'>"
    "<title>LilCam Setup</title>"
    "<style>"
    "body{font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:#f7f7f7;padding:24px;color:#111}"
    "main{max-width:420px;margin:0 auto;background:#fff;padding:20px;border-radius:14px;box-shadow:0 8px 24px rgba(0,0,0,.08)}"
    "h1{font-size:1.3rem;margin:0 0 8px 0}p{margin:0 0 16px 0;color:#444}"
    "label{display:block;font-size:.92rem;margin:10px 0 6px}"
    "input{width:100%;padding:10px;border:1px solid #d0d0d0;border-radius:10px;font-size:1rem;box-sizing:border-box}"
    "button{margin-top:14px;width:100%;padding:12px;border:none;border-radius:10px;background:#111;color:#fff;font-weight:600}"
    "#status{margin-top:12px;font-size:.92rem;color:#0b7a2b;min-height:20px}"
    "</style></head><body><main>"
    "<h1>LilCam Wi-Fi Setup</h1><p>Enter your Wi-Fi credentials to provision this device.</p>"
    "<form id='f'>"
    "<label for='ssid'>Wi-Fi</label><input id='ssid' name='ssid' maxlength='32' required>"
    "<label for='password'>Wi-Fi Password</label><input id='password' name='password' type='password' maxlength='64'>"
    "<button type='submit'>Save & Connect</button></form><div id='status'></div>"
    "</main><script>"
    "const f=document.getElementById('f');const s=document.getElementById('status');"
    "f.addEventListener('submit',async(e)=>{e.preventDefault();"
    "const d=new URLSearchParams(new FormData(f));"
    "s.textContent='Saving...';"
    "const r=await fetch('/provision',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:d.toString()});"
    "s.textContent=await r.text();"
    "});"
    "</script></body></html>";
  return html;
}

void handleProvisionRoot() {
  provisionServer.send(200, "text/html", provisioningPageHtml());
}

void handleProvisionSubmit() {
  String newSsid = provisionServer.arg("ssid");
  String newPass = provisionServer.arg("password");
  newSsid.trim();

  if (newSsid.length() == 0) {
    provisionServer.send(400, "text/plain", "SSID is required.");
    return;
  }

  if (!saveProvisionedCredentials(newSsid, newPass)) {
    provisionServer.send(500, "text/plain", "Failed to save credentials.");
    return;
  }

  provisioningCompleted = true;
  Serial.print("[PROVISION] Received credentials for SSID: ");
  Serial.println(wifiSsid);
  provisionServer.send(200, "text/plain", "Saved. Device will now continue startup.");
}

void startProvisionPortal() {
  Serial.println("[PROVISION] Starting AP portal...");
  WiFi.mode(WIFI_AP_STA);
  if (strlen(PROVISION_AP_PASS) >= 8) WiFi.softAP(PROVISION_AP_SSID, PROVISION_AP_PASS);
  else                                WiFi.softAP(PROVISION_AP_SSID);

  IPAddress apIp = WiFi.softAPIP();
  Serial.print("[PROVISION] AP SSID: ");
  Serial.println(PROVISION_AP_SSID);
  Serial.print("[PROVISION] AP IP: ");
  Serial.println(apIp);

  provisionServer.on("/", HTTP_GET, handleProvisionRoot);
  provisionServer.on("/provision", HTTP_POST, handleProvisionSubmit);
  provisionServer.onNotFound(handleProvisionRoot);
  provisionServer.begin();

  provisioningActive = true;
  provisioningStartedMs = millis();
}

void stopProvisionPortal() {
  if (!provisioningActive) return;
  provisionServer.stop();
  WiFi.softAPdisconnect(true);
  provisioningActive = false;
  Serial.println("[PROVISION] AP portal stopped.");
}

void clearNearestList() {
  nearestCount = 0;
  selectedNearest = 0;

  for (int i = 0; i < MAX_NEAREST; i++) {
    nearestCameras[i].id[0] = '\0';
    nearestCameras[i].name[0] = '\0';
    nearestCameras[i].imageUrl[0] = '\0';
    nearestCameras[i].lat = 0.0f;
    nearestCameras[i].lon = 0.0f;
    nearestCameras[i].distanceMeters = 99999999.0f;
  }
}

bool selectedNearestIsCamera() {
  return (nearestCount > 0 &&
          selectedNearest >= 0 &&
          selectedNearest < nearestCount &&
          nearestCameras[selectedNearest].id[0] != '\0');
}

bool selectedNearestIsGallery() {
  return (selectedNearest == nearestCount);
}

bool selectedCaptureIsEntry() {
  return (captureCount > 0 &&
          selectedCapture >= 0 &&
          selectedCapture < captureCount);
}

bool selectedCaptureIsBack() {
  return (selectedCapture == captureCount);
}

Camera* getActiveCamera() {
  if (appMode == MODE_NEAREST) {
    if (selectedNearestIsCamera()) {
      return &nearestCameras[selectedNearest];
    }
    return nullptr;
  }

  if (appMode == MODE_CAPTURES) {
    if (selectedCaptureIsEntry()) {
      return &captures[selectedCapture].cam;
    }
    return nullptr;
  }

  return nullptr;
}

// ---------- Distance ----------
float haversine(float lat1, float lon1, float lat2, float lon2) {
  const float R = 6371000.0f;
  float dLat = (lat2 - lat1) * PI / 180.0f;
  float dLon = (lon2 - lon1) * PI / 180.0f;

  float a = sin(dLat / 2.0f) * sin(dLat / 2.0f) +
            cos(lat1 * PI / 180.0f) * cos(lat2 * PI / 180.0f) *
            sin(dLon / 2.0f) * sin(dLon / 2.0f);

  return R * 2.0f * atan2(sqrt(a), sqrt(1.0f - a));
}

void insertNearestCamera(const char* id, const char* name, float lat, float lon, const char* imageUrl) {
  float d = haversine(userLat, userLon, lat, lon);

  for (int j = 0; j < MAX_NEAREST; j++) {
    if (d < nearestCameras[j].distanceMeters) {
      for (int k = MAX_NEAREST - 1; k > j; k--) {
        nearestCameras[k] = nearestCameras[k - 1];
      }

      safeCopy(nearestCameras[j].id, sizeof(nearestCameras[j].id), id);
      safeCopy(nearestCameras[j].name, sizeof(nearestCameras[j].name), name);
      safeCopy(nearestCameras[j].imageUrl, sizeof(nearestCameras[j].imageUrl), imageUrl);
      nearestCameras[j].lat = lat;
      nearestCameras[j].lon = lon;
      nearestCameras[j].distanceMeters = d;
      break;
    }
  }
}

void recomputeCurrentNearestDistances() {
  if (nearestCount <= 0) return;

  for (int i = 0; i < nearestCount; i++) {
    nearestCameras[i].distanceMeters =
      haversine(userLat, userLon, nearestCameras[i].lat, nearestCameras[i].lon);
  }

  for (int i = 0; i < nearestCount - 1; i++) {
    for (int j = i + 1; j < nearestCount; j++) {
      if (nearestCameras[j].distanceMeters < nearestCameras[i].distanceMeters) {
        Camera tmp = nearestCameras[i];
        nearestCameras[i] = nearestCameras[j];
        nearestCameras[j] = tmp;
      }
    }
  }

  if (selectedNearest >= nearestCount) {
    selectedNearest = nearestCount - 1;
    if (selectedNearest < 0) selectedNearest = 0;
  }

  Serial.println("Recomputed distances for existing nearest list");
  for (int i = 0; i < nearestCount; i++) {
    Serial.print("slot ");
    Serial.print(i);
    Serial.print("  dist=");
    Serial.print((int)nearestCameras[i].distanceMeters);
    Serial.print("m  name=");
    Serial.println(nearestCameras[i].name);
  }
}

void finalizeNearestCount() {
  nearestCount = 0;
  for (int i = 0; i < MAX_NEAREST; i++) {
    if (nearestCameras[i].id[0] != '\0') {
      nearestCount++;
    }
  }

  if (selectedNearest > nearestCount) {
    selectedNearest = 0;
  }

  Serial.print("nearestCount = ");
  Serial.println(nearestCount);
  for (int i = 0; i < nearestCount; i++) {
    Serial.print("slot ");
    Serial.print(i);
    Serial.print("  dist=");
    Serial.print((int)nearestCameras[i].distanceMeters);
    Serial.print("m  name=");
    Serial.println(nearestCameras[i].name);
  }
}

bool shouldRefetchNearestList() {
  if (!hasFetchedNearestOnce) {
    Serial.println("Nearest list never fetched -> refetch");
    return true;
  }

  float movedMeters = haversine(lastFetchLat, lastFetchLon, userLat, userLon);
  Serial.print("Distance moved since last fetch: ");
  Serial.print(movedMeters, 2);
  Serial.println(" m");

  if (movedMeters >= NEAREST_REFETCH_THRESHOLD_METERS) {
    Serial.println("Moved enough -> refetch");
    return true;
  }

  Serial.println("Below threshold -> keep current list");
  return false;
}

// ---------- GPS ----------
void pumpGPS(unsigned long durationMs = 0) {
  unsigned long start = millis();

  do {
    bool readAny = false;

    while (GPSSerial.available()) {
      GPS.read();
      readAny = true;

      if (GPS.newNMEAreceived()) {
        GPS.parse(GPS.lastNMEA());
      }
    }

    if (durationMs == 0) break;
    if (!readAny) delay(1);
  } while (durationMs > 0 && millis() - start < durationMs);
}

bool refreshLocation() {
  pumpGPS(1200);

  if (GPS.fix) {
    userLat = GPS.latitudeDegrees;
    userLon = GPS.longitudeDegrees;
    hasLocation = true;

    Serial.print("GPS fix: ");
    Serial.print(userLat, 6);
    Serial.print(", ");
    Serial.print(userLon, 6);
    Serial.print("  sats=");
    Serial.println((int)GPS.satellites);
    return true;
  }

  if (hasLocation) {
    Serial.print("No GPS fix. Using last known location: ");
    Serial.print(userLat, 6);
    Serial.print(", ");
    Serial.println(userLon, 6);
    return true;
  }

  Serial.println("No GPS fix yet and no last known location.");
  return false;
}

// ---------- Chunked helpers ----------
bool readLineFromClient(WiFiClientSecure& client, String& out, unsigned long timeoutMs = 4000) {
  out = "";
  unsigned long start = millis();

  while (millis() - start < timeoutMs) {
    while (client.available()) {
      char c = (char)client.read();
      if (c == '\r') continue;
      if (c == '\n') return true;
      out += c;
      start = millis();
    }
    if (!client.connected() && !client.available()) break;
    delay(1);
  }
  return false;
}

void chunkedReaderBegin(ChunkedReader& r, WiFiClientSecure& client) {
  r.client = &client;
  r.remainingInChunk = 0;
  r.done = false;
}

bool chunkedReaderNextChunk(ChunkedReader& r) {
  if (r.done) return false;

  String line;
  if (!readLineFromClient(*r.client, line)) return false;

  line.trim();
  if (line.length() == 0) return chunkedReaderNextChunk(r);

  int semicolon = line.indexOf(';');
  if (semicolon >= 0) line = line.substring(0, semicolon);

  int chunkSize = (int)strtol(line.c_str(), nullptr, 16);

  if (chunkSize <= 0) {
    r.done = true;
    while (true) {
      String trailer;
      if (!readLineFromClient(*r.client, trailer, 500)) break;
      if (trailer.length() == 0) break;
    }
    return false;
  }

  r.remainingInChunk = chunkSize;
  return true;
}

int chunkedReaderReadByte(ChunkedReader& r) {
  if (r.done) return -1;

  while (r.remainingInChunk == 0) {
    if (!chunkedReaderNextChunk(r)) return -1;
  }

  unsigned long start = millis();
  while (millis() - start < 4000) {
    if (r.client->available()) {
      int b = r.client->read();
      r.remainingInChunk--;

      if (r.remainingInChunk == 0) {
        unsigned long crlfStart = millis();
        int got = 0;
        while (millis() - crlfStart < 1000 && got < 2) {
          if (r.client->available()) { r.client->read(); got++; }
          else delay(1);
        }
      }
      return b;
    }
    if (!r.client->connected() && !r.client->available()) return -1;
    delay(1);
  }
  return -1;
}

// ---------- HTTP helpers ----------
bool skipHttpHeaders(WiFiClientSecure& client, bool& chunked, int& contentLength) {
  chunked = false;
  contentLength = -1;

  String status = client.readStringUntil('\n');
  status.trim();
  Serial.print("Status line: ");
  Serial.println(status);

  if (!(status.startsWith("HTTP/1.1 200") || status.startsWith("HTTP/1.0 200"))) {
    lastHttpCode = -20;
    return false;
  }

  lastHttpCode = 200;

  while (true) {
    String line = client.readStringUntil('\n');
    if (line == "\r" || line.length() == 0) break;

    String lower = line;
    lower.toLowerCase();

    if (lower.startsWith("content-length:")) {
      String value = line.substring(line.indexOf(':') + 1);
      value.trim();
      contentLength = value.toInt();
    }
    if (lower.startsWith("transfer-encoding:") && lower.indexOf("chunked") >= 0) {
      chunked = true;
    }
  }

  return true;
}

bool waitForArrayStartRaw(WiFiClientSecure& client) {
  unsigned long start = millis();
  while (millis() - start < 5000) {
    while (client.available()) {
      if ((char)client.read() == '[') return true;
    }
    if (!client.connected()) break;
    delay(1);
  }
  return false;
}

bool waitForArrayStartChunked(ChunkedReader& reader) {
  unsigned long start = millis();
  while (millis() - start < 5000) {
    int b = chunkedReaderReadByte(reader);
    if (b < 0) break;
    if ((char)b == '[') return true;
  }
  return false;
}

bool fetchNearestCamerasDirect() {
  if (!wifiConnected || !hasLocation) {
    lastHttpCode = -21;
    return false;
  }

  clearNearestList();

  WiFiClientSecure client;
  client.setInsecure();

  Serial.println("---- fetchNearestCamerasDirect ----");

  if (!client.connect(API_HOST, API_PORT)) {
    Serial.println("SSL connect failed");
    lastHttpCode = -22;
    return false;
  }

  client.print("GET ");
  client.print(CAMERA_LIST_PATH);
  client.println(" HTTP/1.1");
  client.print("Host: ");
  client.println(API_HOST);
  client.println("Connection: close");
  client.println();

  bool chunked = false;
  int contentLength = -1;
  if (!skipHttpHeaders(client, chunked, contentLength)) {
    client.stop();
    return false;
  }

  bool arrayFound = false;
  ChunkedReader chunkReader;

  if (chunked) {
    chunkedReaderBegin(chunkReader, client);
    arrayFound = waitForArrayStartChunked(chunkReader);
  } else {
    arrayFound = waitForArrayStartRaw(client);
  }

  if (!arrayFound) {
    Serial.println("Could not find JSON array start");
    client.stop();
    lastHttpCode = -23;
    return false;
  }

  String objBuf = "";
  bool inObject = false;
  bool inString = false;
  bool escape = false;
  int braceDepth = 0;
  int parsedCount = 0;
  unsigned long lastDataMs = millis();

  while (true) {
    int b = -1;

    if (chunked) {
      b = chunkedReaderReadByte(chunkReader);
    } else {
      while (!client.available()) {
        if (!client.connected()) break;
        if (millis() - lastDataMs > 4000) break;
        delay(1);
      }
      if (client.available()) b = client.read();
    }

    if (b < 0) break;

    lastDataMs = millis();
    char c = (char)b;

    if (!inObject) {
      if (c == '{') {
        inObject = true;
        braceDepth = 1;
        inString = false;
        escape = false;
        objBuf = "{";
      } else if (c == ']') {
        finalizeNearestCount();
        client.stop();
        if (nearestCount > 0) {
          lastFetchLat = userLat;
          lastFetchLon = userLon;
          hasFetchedNearestOnce = true;
          return true;
        }
        return false;
      }
      continue;
    }

    objBuf += c;

    if (escape) { escape = false; continue; }
    if (c == '\\' && inString) { escape = true; continue; }
    if (c == '"') { inString = !inString; continue; }

    if (!inString) {
      if (c == '{') braceDepth++;
      if (c == '}') braceDepth--;

      if (braceDepth == 0) {
        StaticJsonDocument<512> camDoc;
        DeserializationError err = deserializeJson(camDoc, objBuf);

        if (!err) {
          const char* id       = camDoc["id"];
          const char* name     = camDoc["name"];
          float lat            = camDoc["latitude"]  | 0.0f;
          float lon            = camDoc["longitude"] | 0.0f;
          const char* imageUrl = camDoc["imageUrl"];

          if (id && name && imageUrl) {
            insertNearestCamera(id, name, lat, lon, imageUrl);
            parsedCount++;
          }
        }

        inObject = false;
        objBuf = "";
      }
    }
  }

  Serial.print("Parsed: ");
  Serial.println(parsedCount);

  finalizeNearestCount();
  client.stop();

  if (nearestCount > 0) {
    lastFetchLat = userLat;
    lastFetchLon = userLon;
    hasFetchedNearestOnce = true;
    return true;
  }

  return false;
}

// ---------- UI ----------
void drawTopBar(
  uint16_t nextColor = ST77XX_WHITE,
  uint16_t refreshColor = ST77XX_WHITE,
  uint16_t captureColor = ST77XX_WHITE
) {
  tft.fillRect(0, 0, SCREEN_W, TOPBAR_H, ST77XX_BLACK);
  tft.setTextSize(1);

  tft.setCursor(16, 8);
  tft.setTextColor(nextColor, ST77XX_BLACK);
  tft.print("NEXT");

  int16_t x1, y1;
  uint16_t w, h;
  tft.getTextBounds("REFRESH", 0, 8, &x1, &y1, &w, &h);
  tft.setCursor((SCREEN_W - w) / 2, 8);
  tft.setTextColor(refreshColor, ST77XX_BLACK);
  tft.print("REFRESH");

  tft.getTextBounds("CAPTURE", 0, 8, &x1, &y1, &w, &h);
  tft.setCursor(SCREEN_W - w - 16, 8);
  tft.setTextColor(captureColor, ST77XX_BLACK);
  tft.print("CAPTURE");
}

void drawBatteryIndicator(int x, int y, int levelPercent) {
  const int bodyW = 18, bodyH = 8, capW = 2, capH = 4;
  tft.drawRect(x, y, bodyW, bodyH, ST77XX_WHITE);
  tft.fillRect(x + bodyW, y + 2, capW, capH, ST77XX_WHITE);

  int fillW = map(levelPercent, 0, 100, 0, bodyW - 4);
  fillW = constrain(fillW, 0, bodyW - 4);
  tft.fillRect(x + 2, y + 2, fillW, bodyH - 4, ST77XX_WHITE);
}

void drawBottomUIBar() {
  int barY = SCREEN_H - BOTTOMBAR_H;
  tft.fillRect(0, barY, SCREEN_W, BOTTOMBAR_H, ST77XX_BLACK);

  int y = barY + BOTTOMBAR_H / 2;
  uint16_t wifiColor = wifiConnected ? ST77XX_GREEN : ST77XX_RED;
  tft.fillCircle(14, y, 4, wifiColor);
  tft.drawCircle(14, y, 4, ST77XX_WHITE);

  if (isLoading && (millis() / 200) % 2) {
    tft.fillCircle(30, y, 4, ST77XX_WHITE);
  } else {
    tft.drawCircle(30, y, 4, ST77XX_WHITE);
    tft.fillCircle(30, y, 3, ST77XX_BLACK);
  }

  drawBatteryIndicator(SCREEN_W - 28, barY + 8, 100);
}

void drawAllBars() {
  drawTopBar();
  drawBottomUIBar();
}

void flashNextLabel()    { drawTopBar(ST77XX_GREEN, ST77XX_WHITE, ST77XX_WHITE); drawBottomUIBar(); delay(90); drawAllBars(); }
void flashRefreshLabel() { drawTopBar(ST77XX_WHITE, ST77XX_GREEN, ST77XX_WHITE); drawBottomUIBar(); delay(90); drawAllBars(); }
void flashCaptureLabel() { drawTopBar(ST77XX_WHITE, ST77XX_WHITE, ST77XX_GREEN); drawBottomUIBar(); delay(90); drawAllBars(); }

void printName20(const char* s) {
  for (int i = 0; i < 20 && s[i] != '\0'; i++) tft.print(s[i]);
}

void drawText() {
  tft.fillRect(INFO_X, INFO_Y, INFO_W, 110, ST77XX_BLACK);
  tft.setTextColor(ST77XX_WHITE, ST77XX_BLACK);
  tft.setTextSize(2);

  if (appMode == MODE_NEAREST) {
    if (selectedNearestIsCamera()) {
      const Camera& cam = nearestCameras[selectedNearest];
      tft.setCursor(INFO_X, TITLE_Y);
      printName20(cam.name);

      tft.setCursor(INFO_X, DIST_Y);
      tft.print((int)cam.distanceMeters);
      tft.print(" m");

      char gpsBuf[36];
      snprintf(gpsBuf, sizeof(gpsBuf), "U %.4f,%.4f", userLat, userLon);
      tft.setTextSize(1);
      int16_t x1, y1; uint16_t w, h;
      tft.getTextBounds(gpsBuf, 0, 0, &x1, &y1, &w, &h);
      int gpsX = INFO_X + INFO_W - w;
      if (gpsX < 120) gpsX = 120;
      tft.setCursor(gpsX, DIST_Y + 6);
      tft.print(gpsBuf);

      tft.setCursor(INFO_X, DIST_Y + 20);
      tft.print("C ");
      tft.print(cam.lat, 5);
      tft.print(", ");
      tft.print(cam.lon, 5);
      return;
    }

    if (selectedNearestIsGallery()) {
      tft.setCursor(INFO_X, TITLE_Y);
      tft.print("GALLERY");
      tft.setTextSize(1);
      tft.setCursor(INFO_X, DIST_Y + 4);
      tft.print("Click to see captures");
      return;
    }
  }

  if (appMode == MODE_CAPTURES) {
    if (captureCount == 0) {
      tft.setCursor(INFO_X, TITLE_Y);
      tft.print("CAPTURES");
      tft.setTextSize(1);
      tft.setCursor(INFO_X, DIST_Y + 4);
      tft.print("No captures yet");
      return;
    }

    if (selectedCaptureIsEntry()) {
      const Camera& cam = captures[selectedCapture].cam;
      tft.setCursor(INFO_X, TITLE_Y);
      printName20(cam.name);
      tft.setTextSize(1);
      tft.setCursor(INFO_X, DIST_Y + 4);
      tft.print("Capture ");
      tft.print(selectedCapture + 1);
      tft.print("/");
      tft.print(captureCount);
      return;
    }

    if (selectedCaptureIsBack()) {
      tft.setCursor(INFO_X, TITLE_Y);
      tft.print("BACK");
      tft.setTextSize(1);
      tft.setCursor(INFO_X, DIST_Y + 4);
      tft.print("Click to return");
      return;
    }
  }
}

void drawImageMessage(const char* msg1, const char* msg2 = nullptr, uint16_t color = ST77XX_WHITE) {
  tft.fillRect(IMG_X, IMG_Y, IMG_W, IMG_H, ST77XX_BLACK);
  tft.drawRect(IMG_X - 1, IMG_Y - 1, IMG_W + 2, IMG_H + 2, ST77XX_WHITE);
  tft.setTextColor(color, ST77XX_BLACK);

  tft.setTextSize(2);
  int16_t x1, y1; uint16_t w1, h1;
  tft.getTextBounds(msg1, 0, 0, &x1, &y1, &w1, &h1);
  tft.setCursor(IMG_X + (IMG_W - w1) / 2, IMG_Y + (IMG_H / 2) - 18);
  tft.print(msg1);

  if (msg2) {
    tft.setTextSize(1);
    uint16_t w2, h2;
    tft.getTextBounds(msg2, 0, 0, &x1, &y1, &w2, &h2);
    tft.setCursor(IMG_X + (IMG_W - w2) / 2, IMG_Y + (IMG_H / 2) + 10);
    tft.print(msg2);
  }
}

void drawLoadingOverlay() { drawImageMessage("LOADING..."); }
void drawSavingOverlay()  { drawImageMessage("SAVING..."); }

void drawBootSplash() {
  tft.fillScreen(ST77XX_BLACK);
  tft.setTextColor(ST77XX_WHITE, ST77XX_BLACK);
  tft.setTextSize(4);

  const char* title = "LilCam";
  int16_t x1, y1;
  uint16_t w, h;
  tft.getTextBounds(title, 0, 0, &x1, &y1, &w, &h);
  tft.setCursor((SCREEN_W - w) / 2, (SCREEN_H - h) / 2);
  tft.print(title);
}

static int qrDrawX = 0;
static int qrDrawY = 0;
static int qrDrawScale = 4;

void drawQrCodeDisplay(esp_qrcode_handle_t qrcode) {
  int size = esp_qrcode_get_size(qrcode);
  if (size <= 0) return;

  const int quiet = 2;
  int totalModules = size + quiet * 2;
  int sizePx = totalModules * qrDrawScale;
  tft.fillRect(qrDrawX, qrDrawY, sizePx, sizePx, ST77XX_WHITE);

  for (int yy = 0; yy < size; yy++) {
    for (int xx = 0; xx < size; xx++) {
      uint16_t c = esp_qrcode_get_module(qrcode, xx, yy) ? ST77XX_BLACK : ST77XX_WHITE;
      tft.fillRect(
        qrDrawX + (xx + quiet) * qrDrawScale,
        qrDrawY + (yy + quiet) * qrDrawScale,
        qrDrawScale,
        qrDrawScale,
        c
      );
    }
  }
}

void drawQrCode(int x, int y, int scale, const char* text) {
  qrDrawX = x;
  qrDrawY = y;
  qrDrawScale = scale;

  esp_qrcode_config_t cfg = ESP_QRCODE_CONFIG_DEFAULT();
  cfg.display_func = drawQrCodeDisplay;
  cfg.max_qrcode_version = 6;
  cfg.qrcode_ecc_level = ESP_QRCODE_ECC_LOW;
  esp_qrcode_generate(&cfg, text);
}

void drawProvisioningScreen() {
  tft.fillScreen(ST77XX_BLACK);
  tft.setTextWrap(false);
  tft.setTextColor(ST77XX_WHITE, ST77XX_BLACK);

  tft.setTextSize(2);
  tft.setCursor(20, 10);
  tft.print("Scan To Setup Wi-Fi");

  int qrScale = 5;
  int qrVersionSize = 33; // version 4 => 33 modules
  int qrSizePx = (qrVersionSize + 4) * qrScale; // + quiet zone
  int qrX = 8;
  int qrY = 40;
  tft.drawRect(qrX - 2, qrY - 2, qrSizePx + 4, qrSizePx + 4, ST77XX_WHITE);
  drawQrCode(qrX, qrY, qrScale, PROVISION_URL);

  tft.setTextSize(1);
  tft.setCursor(186, 52);
  tft.print("AP:");
  tft.setCursor(186, 66);
  tft.print(PROVISION_AP_SSID);
  tft.setCursor(186, 88);
  tft.print("URL:");
  tft.setCursor(186, 102);
  tft.print("192.168.4.1");
  tft.setCursor(186, 134);
  tft.print("Open page,");
  tft.setCursor(186, 146);
  tft.print("enter Wi-Fi,");
  tft.setCursor(186, 158);
  tft.print("then submit.");
}

void drawGpsWaitingScreen() {
  tft.fillScreen(ST77XX_BLACK);
  tft.setTextWrap(false);

  tft.drawRect(14, 48, SCREEN_W - 28, SCREEN_H - 96, ST77XX_WHITE);

  tft.setTextSize(2);
  tft.setTextColor(ST77XX_YELLOW, ST77XX_BLACK);

  const char* line1 = "GPS Searching...";
  int16_t x1, y1;
  uint16_t w1, h1;
  tft.getTextBounds(line1, 0, 0, &x1, &y1, &w1, &h1);
  tft.setCursor((SCREEN_W - w1) / 2, 96);
  tft.print(line1);

  tft.setTextColor(ST77XX_WHITE, ST77XX_BLACK);
  const char* line2 = "Go outside!";
  uint16_t w2, h2;
  tft.getTextBounds(line2, 0, 0, &x1, &y1, &w2, &h2);
  tft.setCursor((SCREEN_W - w2) / 2, 132);
  tft.print(line2);

  tft.setTextSize(1);
  tft.setCursor(84, 168);
  tft.print("Sats: 0  Q:0");

  gpsWaitingScreenDrawn = true;
  gpsSearchTextVisible = true;
  gpsBlinkMs = millis();
}

void updateGpsWaitingAnimation() {
  if (!gpsWaitingScreenDrawn) {
    drawGpsWaitingScreen();
    return;
  }

  unsigned long now = millis();
  if (now - gpsBlinkMs < GPS_BLINK_INTERVAL_MS) return;
  gpsBlinkMs = now;
  gpsSearchTextVisible = !gpsSearchTextVisible;

  tft.fillRect(28, 92, SCREEN_W - 56, 24, ST77XX_BLACK);
  tft.setTextSize(2);
  tft.setTextColor(gpsSearchTextVisible ? ST77XX_YELLOW : ST77XX_BLACK, ST77XX_BLACK);

  const char* line1 = "GPS Searching...";
  int16_t x1, y1;
  uint16_t w1, h1;
  tft.getTextBounds(line1, 0, 0, &x1, &y1, &w1, &h1);
  tft.setCursor((SCREEN_W - w1) / 2, 96);
  tft.print(line1);

  char satBuf[24];
  snprintf(satBuf, sizeof(satBuf), "Sats: %d  Q:%d", (int)GPS.satellites, (int)GPS.fixquality);
  tft.fillRect(72, 164, 136, 12, ST77XX_BLACK);
  tft.setTextSize(1);
  tft.setTextColor(ST77XX_WHITE, ST77XX_BLACK);
  tft.setCursor(84, 168);
  tft.print(satBuf);
}

bool hasGpsFixWithCoordinates() {
  return GPS.fix;
}

void connectWifi() {
  Serial.println("[WiFi] Setting mode to STA...");
  WiFi.mode(WIFI_STA);
  WiFi.disconnect(true);
  delay(300);
  Serial.print("[WiFi] Connecting to SSID: ");
  Serial.println(wifiSsid);
  WiFi.begin(wifiSsid, wifiPass);

  unsigned long wifiStart = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - wifiStart < 20000) {
    logWifiStatus("[WiFi] Waiting:");
    delay(500);
  }

  wifiConnected = (WiFi.status() == WL_CONNECTED);
  if (wifiConnected) {
    Serial.println("[WiFi] Connected!");
    Serial.print("[WiFi] IP: ");
    Serial.println(WiFi.localIP());
    Serial.print("[WiFi] RSSI: ");
    Serial.println(WiFi.RSSI());
  } else {
    Serial.println("[WiFi] FAILED to connect within 20s");
    logWifiStatus("[WiFi] Final status:");
  }
}

void bootstrapAppAfterGpsFix() {
  if (appBootstrapped) return;
  appBootstrapped = true;
  stopProvisionPortal();

  userLat = GPS.latitudeDegrees;
  userLon = GPS.longitudeDegrees;
  hasLocation = true;

  Serial.print("[GPS] First valid fix acquired: ");
  Serial.print(userLat, 6);
  Serial.print(", ");
  Serial.println(userLon, 6);

  connectWifi();

  clearNearestList();
  drawAllBars();

  if (wifiConnected) {
    Serial.println("[APP] Fetching nearest cameras...");
    fetchNearestCamerasDirect();
  } else {
    Serial.println("[APP] Skipping fetch, no WiFi");
  }

  drawText();

  if (selectedNearestIsCamera()) {
    Serial.println("[APP] Drawing first camera image...");
    drawImage();
  } else {
    Serial.println("[APP] No cameras found, showing placeholder");
    drawImageMessage("NO CAMERAS", "Press refresh");
  }

  lastCLK        = digitalRead(ENC_CLK);
  lastSW         = digitalRead(ENC_SW);
  lastCaptureBtn = digitalRead(CAPTURE_BTN);

  Serial.println("[APP] Setup complete. Entering interactive mode.");
}

// ---------- Captures ----------
void saveCurrentCapture() {
  if (!selectedNearestIsCamera()) return;

  if (captureCount < MAX_CAPTURES) {
    captures[captureCount].cam = nearestCameras[selectedNearest];
    captures[captureCount].capturedAtMs = millis();
    captureCount++;
  } else {
    for (int i = 0; i < MAX_CAPTURES - 1; i++) captures[i] = captures[i + 1];
    captures[MAX_CAPTURES - 1].cam = nearestCameras[selectedNearest];
    captures[MAX_CAPTURES - 1].capturedAtMs = millis();
  }

  Serial.print("Saved: ");
  Serial.println(nearestCameras[selectedNearest].name);
}

// ---------- JPEG stream ----------
bool openJPEGStream(const String& path) {
  netFile.client.stop();
  netFile.streamPos = 0;
  netFile.contentLength = -1;
  netFile.chunked = false;
  netFile.path = path;
  lastHttpCode = 0;

  if (!wifiConnected) { lastHttpCode = -10; return false; }

  netFile.client.setInsecure();
  if (!netFile.client.connect(API_HOST, 443)) { lastHttpCode = -1; return false; }

  netFile.client.print("GET " + path + " HTTP/1.1\r\n");
  netFile.client.print("Host: ");
  netFile.client.println(API_HOST);
  netFile.client.println("Connection: close");
  netFile.client.println();

  String status = netFile.client.readStringUntil('\n');
  status.trim();

  if (status.length() >= 12) {
    lastHttpCode = status.substring(9, 12).toInt();
  } else {
    lastHttpCode = -2;
    return false;
  }

  while (true) {
    String line = netFile.client.readStringUntil('\n');
    if (line == "\r" || line.length() == 0) break;

    String lower = line;
    lower.toLowerCase();

    if (lower.startsWith("content-length:")) {
      String value = line.substring(line.indexOf(':') + 1);
      value.trim();
      netFile.contentLength = value.toInt();
    }
    if (lower.startsWith("transfer-encoding:") && lower.indexOf("chunked") >= 0) {
      netFile.chunked = true;
    }
  }

  return (lastHttpCode == 200);
}

bool skipToPosition(int32_t target) {
  unsigned long start = millis();
  while (netFile.streamPos < target) {
    if (netFile.client.available()) {
      netFile.client.read();
      netFile.streamPos++;
      start = millis();
    } else {
      if (!netFile.client.connected()) return false;
      if (millis() - start > 3000) return false;
      delay(1);
    }
  }
  return true;
}

// ---------- JPEG callbacks ----------
void* jpegOpen(const char*, int32_t* size) {
  Camera* cam = getActiveCamera();
  if (!cam) return nullptr;

  String path = "/api/cameras/";
  path += cam->id;
  path += "/image";

  if (!openJPEGStream(path)) return nullptr;

  if (netFile.chunked) {
    netFile.client.stop();
    lastHttpCode = -3;
    return nullptr;
  }

  *size = (netFile.contentLength > 0) ? netFile.contentLength : 200000;
  return &netFile;
}

void jpegClose(void* h) {
  ((NetJPEGFile*)h)->client.stop();
}

int32_t jpegRead(JPEGFILE* f, uint8_t* buf, int32_t len) {
  NetJPEGFile* nf = (NetJPEGFile*)f->fHandle;
  int32_t i = 0;
  unsigned long start = millis();

  while (i < len) {
    if (nf->client.available()) {
      buf[i++] = nf->client.read();
      nf->streamPos++;
      start = millis();
    } else {
      if (!nf->client.connected()) break;
      if (millis() - start > 1200) break;
      delay(1);
    }
  }
  return i;
}

int32_t jpegSeek(JPEGFILE* f, int32_t position) {
  NetJPEGFile* nf = (NetJPEGFile*)f->fHandle;
  if (position < 0) position = 0;

  if (position >= nf->streamPos) {
    skipToPosition(position);
    return nf->streamPos;
  }

  openJPEGStream(nf->path);
  skipToPosition(position);
  return nf->streamPos;
}

// ---------- JPEG draw ----------
int jpegDraw(JPEGDRAW* d) {
  int dstX = d->x, dstY = d->y, w = d->iWidth, h = d->iHeight;
  int srcX = 0, srcY = 0;

  if (dstX >= IMG_X + IMG_W || dstY >= IMG_Y + IMG_H) return 1;
  if (dstX + w <= IMG_X || dstY + h <= IMG_Y) return 1;

  if (dstX < IMG_X) { srcX = IMG_X - dstX; w -= srcX; dstX = IMG_X; }
  if (dstY < IMG_Y) { srcY = IMG_Y - dstY; h -= srcY; dstY = IMG_Y; }
  if (dstX + w > IMG_X + IMG_W) w = (IMG_X + IMG_W) - dstX;
  if (dstY + h > IMG_Y + IMG_H) h = (IMG_Y + IMG_H) - dstY;
  if (w <= 0 || h <= 0) return 1;

  for (int row = 0; row < h; row++) {
    uint16_t* rowPtr = d->pPixels + (srcY + row) * d->iWidth + srcX;
    tft.drawRGBBitmap(dstX, dstY + row, rowPtr, w, 1);
  }
  return 1;
}

void drawImage() {
  Camera* cam = getActiveCamera();
  if (!cam) return;

  isLoading = true;
  drawAllBars();
  drawLoadingOverlay();
  tft.drawRect(IMG_X - 1, IMG_Y - 1, IMG_W + 2, IMG_H + 2, ST77XX_WHITE);

  if (!jpeg.open("x", jpegOpen, jpegClose, jpegRead, jpegSeek, jpegDraw)) {
    isLoading = false;
    drawAllBars();
    tft.fillRect(IMG_X, IMG_Y, IMG_W, IMG_H, ST77XX_BLACK);
    tft.drawRect(IMG_X - 1, IMG_Y - 1, IMG_W + 2, IMG_H + 2, ST77XX_WHITE);
    tft.setTextColor(ST77XX_RED, ST77XX_BLACK);
    tft.setTextSize(1);
    tft.setCursor(IMG_X + 8, IMG_Y + IMG_H / 2 - 8);
    tft.print("IMAGE LOAD FAILED");
    tft.setCursor(IMG_X + 8, IMG_Y + IMG_H / 2 + 8);
    tft.print("CODE: ");
    tft.print(lastHttpCode);
    return;
  }

  int w = jpeg.getWidth();
  int h = jpeg.getHeight();

  int scale = JPEG_SCALE_EIGHTH;
  int sw = w / 8, sh = h / 8;

  if (w <= IMG_W && h <= IMG_H)                         { scale = 0;                  sw = w;     sh = h;     }
  else if ((w / 2) <= IMG_W && (h / 2) <= IMG_H)       { scale = JPEG_SCALE_HALF;    sw = w / 2; sh = h / 2; }
  else if ((w / 4) <= IMG_W && (h / 4) <= IMG_H)       { scale = JPEG_SCALE_QUARTER; sw = w / 4; sh = h / 4; }

  int x = IMG_X + (IMG_W - sw) / 2;
  int y = IMG_Y + (IMG_H - sh) / 2;

  int rc = jpeg.decode(x, y, scale);
  jpeg.close();

  if (rc != 1) {
    tft.fillRect(IMG_X, IMG_Y, IMG_W, IMG_H, ST77XX_BLACK);
    tft.drawRect(IMG_X - 1, IMG_Y - 1, IMG_W + 2, IMG_H + 2, ST77XX_WHITE);
    tft.setTextColor(ST77XX_RED, ST77XX_BLACK);
    tft.setTextSize(1);
    tft.setCursor(IMG_X + 8, IMG_Y + IMG_H / 2 - 8);
    tft.print("JPEG DECODE FAILED");
    tft.setCursor(IMG_X + 8, IMG_Y + IMG_H / 2 + 8);
    tft.print("RC: ");
    tft.print(rc);
  }

  isLoading = false;
  drawAllBars();
}

// ---------- Input ----------
void readEncoder() {
  int clk = digitalRead(ENC_CLK);

  if (clk != lastCLK && clk == LOW) {
    if (appMode == MODE_NEAREST) {
      int totalItems = nearestCount + 1;
      if (totalItems <= 0) totalItems = 1;

      if (digitalRead(ENC_DT) != clk) selectedNearest = (selectedNearest + 1) % totalItems;
      else                             selectedNearest = (selectedNearest - 1 + totalItems) % totalItems;

      flashNextLabel();
      drawText();

      if (selectedNearestIsCamera()) { drawLoadingOverlay(); delay(10); drawImage(); }
      else                            drawImageMessage("GALLERY");
    }

    else if (appMode == MODE_CAPTURES) {
      int totalItems = captureCount + 1;
      if (totalItems <= 0) totalItems = 1;

      if (digitalRead(ENC_DT) != clk) selectedCapture = (selectedCapture + 1) % totalItems;
      else                             selectedCapture = (selectedCapture - 1 + totalItems) % totalItems;

      flashNextLabel();
      drawText();

      if (selectedCaptureIsEntry()) { drawLoadingOverlay(); delay(10); drawImage(); }
      else                           drawImageMessage("BACK");
    }
  }

  lastCLK = clk;
}

void refreshNearestModeDataAndImage() {
  flashRefreshLabel();
  drawLoadingOverlay();

  if (!refreshLocation()) {
    drawAllBars(); drawText(); drawImageMessage("NO GPS");
    return;
  }

  if (shouldRefetchNearestList()) {
    if (!fetchNearestCamerasDirect()) {
      drawAllBars(); drawText(); drawImageMessage("FETCH FAILED", "Try refresh again", ST77XX_RED);
      return;
    }
    selectedNearest = 0;
  } else {
    recomputeCurrentNearestDistances();
  }

  drawAllBars();
  drawText();

  if (selectedNearestIsCamera()) { drawLoadingOverlay(); delay(10); drawImage(); }
  else                            drawImageMessage("GALLERY");
}

void readEncoderButton() {
  int sw = digitalRead(ENC_SW);
  unsigned long now = millis();

  if (sw != lastSW && sw == LOW && (now - lastButtonMs) > buttonDebounceMs) {
    lastButtonMs = now;

    if (appMode == MODE_NEAREST) {
      if (selectedNearestIsGallery()) {
        appMode = MODE_CAPTURES;
        selectedCapture = 0;
        flashRefreshLabel();
        drawText();
        if (captureCount > 0 && selectedCaptureIsEntry()) { drawLoadingOverlay(); delay(10); drawImage(); }
        else drawImageMessage("CAPTURES", "No captures yet");
      } else if (selectedNearestIsCamera()) {
        refreshNearestModeDataAndImage();
      }
    }

    else if (appMode == MODE_CAPTURES) {
      if (selectedCaptureIsBack()) {
        appMode = MODE_NEAREST;
        selectedNearest = 0;
        flashRefreshLabel();
        drawText();
        if (selectedNearestIsCamera()) { drawLoadingOverlay(); delay(10); drawImage(); }
        else drawImageMessage("GALLERY");
      } else if (selectedCaptureIsEntry()) {
        flashRefreshLabel();
        drawLoadingOverlay();
        delay(10);
        drawImage();
      }
    }
  }

  lastSW = sw;
}

void readCaptureButton() {
  int btn = digitalRead(CAPTURE_BTN);
  unsigned long now = millis();

  if (btn != lastCaptureBtn && btn == LOW && (now - lastCaptureMs) > buttonDebounceMs) {
    lastCaptureMs = now;

    if (appMode == MODE_NEAREST && selectedNearestIsCamera()) {
      flashCaptureLabel();
      drawSavingOverlay();
      delay(120);
      saveCurrentCapture();
      drawText();
      if (selectedNearestIsCamera()) { drawLoadingOverlay(); delay(10); drawImage(); }
    }
  }

  lastCaptureBtn = btn;
}

// ---------- Setup ----------
void setup() {
  Serial.begin(115200);
  delay(1000);
  Serial.println();
  Serial.println("=============================");
  Serial.println("  BOOT - XIAO ESP32-S3");
  Serial.println("=============================");

  // ---- Backlight ----
  Serial.println("[BL] Setting TFT_BL (D0) HIGH...");
  pinMode(TFT_BL, OUTPUT);
  digitalWrite(TFT_BL, HIGH);
  Serial.println("[BL] Backlight ON");

  // ---- SPI + LCD ----
  Serial.println("[LCD] Starting SPI...");
  SPI.begin(D8, -1, D10, D3);  // SCK, MISO(unused), MOSI, CS
  Serial.println("[LCD] SPI started: SCK=D8, MOSI=D10, CS=D3");

  Serial.println("[LCD] Calling tft.init(240, 280)...");
  tft.init(240, 280);
  Serial.println("[LCD] tft.init done");

  tft.setRotation(1);
  tft.setTextWrap(false);
  drawBootSplash();
  delay(BOOT_SPLASH_MS);

  // ---- Encoder ----
  Serial.println("[ENC] Configuring encoder pins...");
  Serial.println("[ENC]   CLK = D4");
  Serial.println("[ENC]   DT  = D5");
  Serial.println("[ENC]   SW  = D6");
  Serial.println("[ENC]   CAPTURE_BTN = D9");
  pinMode(ENC_CLK, INPUT_PULLUP);
  pinMode(ENC_DT,  INPUT_PULLUP);
  pinMode(ENC_SW,  INPUT_PULLUP);
  pinMode(CAPTURE_BTN, INPUT_PULLUP);
  Serial.print("[ENC] Initial pin states: CLK=");
  Serial.print(digitalRead(ENC_CLK));
  Serial.print(" DT=");
  Serial.print(digitalRead(ENC_DT));
  Serial.print(" SW=");
  Serial.print(digitalRead(ENC_SW));
  Serial.print(" CAP=");
  Serial.println(digitalRead(CAPTURE_BTN));

  // ---- GPS ----
  Serial.println("[GPS] Starting UART1 at 9600 baud, RX=D7 (TX disabled)...");
  GPSSerial.begin(9600, SERIAL_8N1, GPS_RX_PIN, GPS_TX_PIN);
  GPS.begin(9600);
  GPS.sendCommand(PMTK_SET_NMEA_OUTPUT_RMCGGA);
  GPS.sendCommand(PMTK_SET_NMEA_UPDATE_1HZ);
  GPS.sendCommand(PGCMD_ANTENNA);
  Serial.println("[GPS] Adafruit GPS initialized");
  delay(500);

// --- Battery Reading ---
// float readBattery() {
//   int raw = analogRead(A_PIN);
//   float voltage = (raw / 4095.0) * 3.3 * 2.0; // *2 because of divider
//   return voltage; // LiPo: ~4.2V full, ~3.3V empty
// }

// int batteryPercent(float v) {
//   return constrain((int)((v - 3.3) / (4.2 - 3.3) * 100), 0, 100);
// }

  loadProvisionedCredentials();
  startProvisionPortal();
  drawProvisioningScreen();

  lastCLK        = digitalRead(ENC_CLK);
  lastSW         = digitalRead(ENC_SW);
  lastCaptureBtn = digitalRead(CAPTURE_BTN);

  if (hasStoredCredentials) {
    Serial.println("[APP] Provision portal active. Submit new Wi-Fi or wait to continue with saved credentials.");
  } else {
    Serial.println("[APP] Provision portal active. Waiting for Wi-Fi form submission.");
  }
  Serial.println("=============================");
}

// ---------- Loop ----------
void loop() {
  if (!provisioningCompleted) {
    if (provisioningActive) {
      provisionServer.handleClient();
    }

    if (provisioningCompleted) {
      stopProvisionPortal();
      drawGpsWaitingScreen();
      Serial.println("[APP] Provisioning complete. Waiting for GPS fix...");
    } else if (hasStoredCredentials &&
               millis() - provisioningStartedMs > PROVISION_SKIP_TIMEOUT_MS) {
      stopProvisionPortal();
      provisioningCompleted = true;
      drawGpsWaitingScreen();
      Serial.println("[APP] Provisioning skipped. Using saved/default credentials.");
    }

    delay(2);
    return;
  }

  pumpGPS();

  static unsigned long lastGpsPrint = 0;
  if (!appBootstrapped) {
    updateGpsWaitingAnimation();

    if (hasGpsFixWithCoordinates()) {
      bootstrapAppAfterGpsFix();
    } else if (millis() - lastGpsPrint > 1000) {
      lastGpsPrint = millis();
      Serial.print("No GPS fix yet... sats=");
      Serial.print((int)GPS.satellites);
      Serial.print(" fixquality=");
      Serial.println((int)GPS.fixquality);
    }
    return;
  }

  if (millis() - lastGpsPrint > 1000) {
    lastGpsPrint = millis();

    if (GPS.fix) {
      Serial.print("Lat: ");
      Serial.print(GPS.latitudeDegrees, 6);
      Serial.print(" | Lon: ");
      Serial.print(GPS.longitudeDegrees, 6);
      Serial.print(" | Alt: ");
      Serial.print(GPS.altitude);
      Serial.print("m");
      Serial.print(" | Speed: ");
      Serial.print(GPS.speed * 1.852, 1);
      Serial.print("km/h");
      Serial.print(" | Sats: ");
      Serial.println((int)GPS.satellites);

      userLat = GPS.latitudeDegrees;
      userLon = GPS.longitudeDegrees;
      hasLocation = true;
    } else {
      Serial.println("No GPS fix yet...");
    }
  }

  bool nowConnected = (WiFi.status() == WL_CONNECTED);
  if (nowConnected != wifiConnected) {
    wifiConnected = nowConnected;
    logWifiStatus("Loop:");
    drawAllBars();
  }

  readEncoder();
  readEncoderButton();
  readCaptureButton();
  // readBattery();

  // Serial.print("CLK="); Serial.print(digitalRead(ENC_CLK));
  // Serial.print(" DT=");  Serial.print(digitalRead(ENC_DT));
  // Serial.print(" SW=");  Serial.println(digitalRead(ENC_SW));
  // delay(200);
}
