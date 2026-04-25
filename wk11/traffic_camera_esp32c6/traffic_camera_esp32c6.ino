#include <SPI.h>
#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <Adafruit_GFX.h>
#include <Adafruit_ST7789.h>
#include <JPEGDEC.h>
#include <ArduinoJson.h>
#include <TinyGPSPlus.h>
#include "arduino_secrets.h"

// ---------- TFT ----------
// XIAO ESP32-C6 pin names. Keep these if your LCD is wired this way.
// TFT SPI hardware pins on XIAO ESP32-C6 are usually:
// SCK = D8, MOSI/SDA = D10. MISO is not used by the display.
#define TFT_CS   D3
#define TFT_DC   D2
#define TFT_RST  D1
#define TFT_BL   D0

Adafruit_ST7789 tft = Adafruit_ST7789(TFT_CS, TFT_DC, TFT_RST);

// ---------- Encoder / Buttons ----------
#define ENC_CLK      D4
#define ENC_DT       D5
#define ENC_SW       D6
#define CAPTURE_BTN  13

// ---------- GPS ----------
// Adafruit Ultimate GPS Breakout v3 default baud: 9600
// Wire GPS TX -> XIAO D7. GPS RX can stay unconnected.
#define GPS_RX_PIN D7
#define GPS_TX_PIN -1

HardwareSerial GPSSerial(1);
TinyGPSPlus gps;

// ---------- WiFi ----------
char ssid[] = SECRET_SSID;
char pass[] = SECRET_PASS;

// ---------- Direct API ----------
const char* API_HOST = "webcams.nyctmc.org";
const int   API_PORT = 443;
const char* CAMERA_LIST_PATH = "/api/cameras";

// ---------- Location ----------
// Fallback location used until GPS gets a valid fix.
float userLat = 40.69234f;
float userLon = -73.987453f;
bool hasLocation = true;

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
int selectedNearest = 0;   // 0..nearestCount, where nearestCount = GALLERY item

struct CaptureRecord {
  Camera cam;
  unsigned long capturedAtMs;
};

CaptureRecord captures[MAX_CAPTURES];
int captureCount = 0;
int selectedCapture = 0;   // 0..captureCount, where captureCount = BACK item

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

  // Re-sort current nearest set by updated distance
  for (int i = 0; i < nearestCount - 1; i++) {
    for (int j = i + 1; j < nearestCount; j++) {
      if (nearestCameras[j].distanceMeters < nearestCameras[i].distanceMeters) {
        Camera tmp = nearestCameras[i];
        nearestCameras[i] = nearestCameras[j];
        nearestCameras[j] = tmp;
      }
    }
  }

  // Keep selection in bounds
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
    Serial.print("m  lat=");
    Serial.print(nearestCameras[i].lat, 6);
    Serial.print(" lon=");
    Serial.print(nearestCameras[i].lon, 6);
    Serial.print("  name=");
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
    Serial.print("m  lat=");
    Serial.print(nearestCameras[i].lat, 6);
    Serial.print(" lon=");
    Serial.print(nearestCameras[i].lon, 6);
    Serial.print("  name=");
    Serial.println(nearestCameras[i].name);
  }
}

bool shouldRefetchNearestList() {
  if (!hasFetchedNearestOnce) {
    Serial.println("Nearest list has never been fetched before -> refetch");
    return true;
  }

  float movedMeters = haversine(lastFetchLat, lastFetchLon, userLat, userLon);

  Serial.print("Distance moved since last nearest fetch: ");
  Serial.print(movedMeters, 2);
  Serial.println(" m");

  if (movedMeters >= NEAREST_REFETCH_THRESHOLD_METERS) {
    Serial.println("Moved enough -> refetch nearest list");
    return true;
  }

  Serial.println("Movement below threshold -> keep current nearest list");
  return false;
}

// ---------- Location / GPS ----------
void pumpGPS(unsigned long durationMs = 0) {
  unsigned long start = millis();

  do {
    while (GPSSerial.available()) {
      gps.encode(GPSSerial.read());
    }
    delay(1);
  } while (durationMs > 0 && millis() - start < durationMs);
}


bool refreshLocation() {
  // Read GPS for a short window before checking fix.
  pumpGPS(1200);

  if (gps.location.isValid() && gps.location.age() < 10000) {
    userLat = gps.location.lat();
    userLon = gps.location.lng();
    hasLocation = true;

    Serial.print("GPS fix: ");
    Serial.print(userLat, 6);
    Serial.print(", ");
    Serial.print(userLon, 6);
    Serial.print("  sats=");
    if (gps.satellites.isValid()) {
      Serial.println(gps.satellites.value());
    } else {
      Serial.println("?");
    }

    return true;
  }

  // Keep fallback/last-known coordinate so the app can still run indoors.
  hasLocation = true;

  Serial.print("No GPS fix yet. Using fallback/last location: ");
  Serial.print(userLat, 6);
  Serial.print(", ");
  Serial.print(userLon, 6);
  Serial.print("  GPS chars=");
  Serial.println(gps.charsProcessed());

  return true;
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

    if (!client.connected() && !client.available()) {
      break;
    }

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
  if (!readLineFromClient(*r.client, line)) {
    return false;
  }

  line.trim();
  if (line.length() == 0) {
    return chunkedReaderNextChunk(r);
  }

  int semicolon = line.indexOf(';');
  if (semicolon >= 0) {
    line = line.substring(0, semicolon);
  }

  int chunkSize = (int)strtol(line.c_str(), nullptr, 16);

  Serial.print("Next chunk size = ");
  Serial.println(chunkSize);

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
    if (!chunkedReaderNextChunk(r)) {
      return -1;
    }
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
          if (r.client->available()) {
            r.client->read();
            got++;
          } else {
            delay(1);
          }
        }
      }

      return b;
    }

    if (!r.client->connected() && !r.client->available()) {
      return -1;
    }

    delay(1);
  }

  return -1;
}

// ---------- Direct camera list fetch helpers ----------
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
    if (line == "\r" || line.length() == 0) {
      break;
    }

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

  Serial.print("Content-Length: ");
  Serial.println(contentLength);
  Serial.print("Chunked: ");
  Serial.println(chunked ? "YES" : "NO");

  return true;
}

bool waitForArrayStartRaw(WiFiClientSecure& client) {
  unsigned long start = millis();
  while (millis() - start < 5000) {
    while (client.available()) {
      char c = (char)client.read();
      if (c == '[') return true;
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
    Serial.println("fetchNearestCamerasDirect: no WiFi or no location");
    lastHttpCode = -21;
    return false;
  }

  clearNearestList();

  WiFiClientSecure client;
  client.setInsecure();
  Serial.println();
  Serial.println("---- fetchNearestCamerasDirect ----");
  logWifiStatus("Before list fetch:");

  if (!client.connect(API_HOST, API_PORT)) {
    Serial.println("SSL connect failed for camera list");
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
      if (client.available()) {
        b = client.read();
      }
    }

    if (b < 0) {
      break;
    }

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

    if (escape) {
      escape = false;
      continue;
    }

    if (c == '\\' && inString) {
      escape = true;
      continue;
    }

    if (c == '"') {
      inString = !inString;
      continue;
    }

    if (!inString) {
      if (c == '{') braceDepth++;
      if (c == '}') braceDepth--;

      if (braceDepth == 0) {
        StaticJsonDocument<512> camDoc;
        DeserializationError err = deserializeJson(camDoc, objBuf);

        if (!err) {
          const char* id = camDoc["id"];
          const char* name = camDoc["name"];
          float lat = camDoc["latitude"] | 0.0f;
          float lon = camDoc["longitude"] | 0.0f;
          const char* imageUrl = camDoc["imageUrl"];

          if (id && name && imageUrl) {
            insertNearestCamera(id, name, lat, lon, imageUrl);
            parsedCount++;
          }
        } else {
          Serial.print("Camera object parse error: ");
          Serial.println(err.c_str());
        }

        inObject = false;
        objBuf = "";
      }
    }
  }

  Serial.print("Parsed camera objects: ");
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
  int refreshX = (SCREEN_W - w) / 2;
  tft.setCursor(refreshX, 8);
  tft.setTextColor(refreshColor, ST77XX_BLACK);
  tft.print("REFRESH");

  tft.getTextBounds("CAPTURE", 0, 8, &x1, &y1, &w, &h);
  tft.setCursor(SCREEN_W - w - 16, 8);
  tft.setTextColor(captureColor, ST77XX_BLACK);
  tft.print("CAPTURE");
}

void drawBatteryIndicator(int x, int y, int levelPercent) {
  const int bodyW = 18;
  const int bodyH = 8;
  const int capW = 2;
  const int capH = 4;

  tft.drawRect(x, y, bodyW, bodyH, ST77XX_WHITE);
  tft.fillRect(x + bodyW, y + 2, capW, capH, ST77XX_WHITE);

  int innerW = bodyW - 4;
  int fillW = map(levelPercent, 0, 100, 0, innerW);
  if (fillW < 0) fillW = 0;
  if (fillW > innerW) fillW = innerW;

  tft.fillRect(x + 2, y + 2, fillW, bodyH - 4, ST77XX_WHITE);
}

void drawBottomUIBar() {
  int barY = SCREEN_H - BOTTOMBAR_H;
  tft.fillRect(0, barY, SCREEN_W, BOTTOMBAR_H, ST77XX_BLACK);

  int wifiX = 14;
  int loadX = 30;
  int y = barY + BOTTOMBAR_H / 2;

  uint16_t wifiColor = wifiConnected ? ST77XX_GREEN : ST77XX_RED;
  tft.fillCircle(wifiX, y, 4, wifiColor);
  tft.drawCircle(wifiX, y, 4, ST77XX_WHITE);

  if (isLoading && (millis() / 200) % 2) {
    tft.fillCircle(loadX, y, 4, ST77XX_WHITE);
  } else {
    tft.drawCircle(loadX, y, 4, ST77XX_WHITE);
    tft.fillCircle(loadX, y, 3, ST77XX_BLACK);
  }

  int batteryX = SCREEN_W - 28;
  int batteryY = barY + 8;
  drawBatteryIndicator(batteryX, batteryY, 100);
}

void drawAllBars() {
  drawTopBar();
  drawBottomUIBar();
}

void flashNextLabel() {
  drawTopBar(ST77XX_GREEN, ST77XX_WHITE, ST77XX_WHITE);
  drawBottomUIBar();
  delay(90);
  drawTopBar();
  drawBottomUIBar();
}

void flashRefreshLabel() {
  drawTopBar(ST77XX_WHITE, ST77XX_GREEN, ST77XX_WHITE);
  drawBottomUIBar();
  delay(90);
  drawTopBar();
  drawBottomUIBar();
}

void flashCaptureLabel() {
  drawTopBar(ST77XX_WHITE, ST77XX_WHITE, ST77XX_GREEN);
  drawBottomUIBar();
  delay(90);
  drawTopBar();
  drawBottomUIBar();
}

void printName20(const char* s) {
  for (int i = 0; i < 20 && s[i] != '\0'; i++) {
    tft.print(s[i]);
  }
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

      tft.setTextSize(2);
      tft.setCursor(INFO_X, DIST_Y);
      tft.print((int)cam.distanceMeters);
      tft.print(" m");

      char gpsBuf[36];
      snprintf(gpsBuf, sizeof(gpsBuf), "U %.4f,%.4f", userLat, userLon);

      tft.setTextSize(1);
      int16_t x1, y1;
      uint16_t w, h;
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
  int16_t x1, y1;
  uint16_t w1, h1;
  tft.getTextBounds(msg1, 0, 0, &x1, &y1, &w1, &h1);
  int x = IMG_X + (IMG_W - w1) / 2;
  int y = IMG_Y + (IMG_H / 2) - 18;
  tft.setCursor(x, y);
  tft.print(msg1);

  if (msg2) {
    tft.setTextSize(1);
    uint16_t w2, h2;
    tft.getTextBounds(msg2, 0, 0, &x1, &y1, &w2, &h2);
    int x2 = IMG_X + (IMG_W - w2) / 2;
    int y2 = y + 28;
    tft.setCursor(x2, y2);
    tft.print(msg2);
  }
}

void drawLoadingOverlay() {
  drawImageMessage("LOADING...");
}

void drawSavingOverlay() {
  drawImageMessage("SAVING...");
}

// ---------- Capture bookkeeping ----------
void saveCurrentCapture() {
  if (!selectedNearestIsCamera()) {
    Serial.println("saveCurrentCapture: not on a camera item");
    return;
  }

  if (captureCount < MAX_CAPTURES) {
    captures[captureCount].cam = nearestCameras[selectedNearest];
    captures[captureCount].capturedAtMs = millis();
    captureCount++;
  } else {
    for (int i = 0; i < MAX_CAPTURES - 1; i++) {
      captures[i] = captures[i + 1];
    }
    captures[MAX_CAPTURES - 1].cam = nearestCameras[selectedNearest];
    captures[MAX_CAPTURES - 1].capturedAtMs = millis();
  }

  Serial.print("Saved capture: ");
  Serial.println(nearestCameras[selectedNearest].name);
  Serial.print("captureCount = ");
  Serial.println(captureCount);
}

// ---------- Network helpers for JPEG ----------
bool openJPEGStream(const String& path) {
  netFile.client.stop();
  netFile.streamPos = 0;
  netFile.contentLength = -1;
  netFile.chunked = false;
  netFile.path = path;
  lastHttpCode = 0;

  Serial.println();
  Serial.println("---- openJPEGStream ----");
  logWifiStatus("Before connect:");
  Serial.print("Host: ");
  Serial.println(API_HOST);
  Serial.print("Path: ");
  Serial.println(path);

  if (!wifiConnected) {
    Serial.println("WiFi not connected, aborting request");
    lastHttpCode = -10;
    return false;
  }

  netFile.client.setInsecure();

  if (!netFile.client.connect(API_HOST, 443)) {
    Serial.println("SSL connect failed");
    lastHttpCode = -1;
    return false;
  }

  Serial.println("SSL connected, sending HTTP request");

  netFile.client.print("GET " + path + " HTTP/1.1\r\n");
  netFile.client.print("Host: ");
  netFile.client.println(API_HOST);
  netFile.client.println("Connection: close");
  netFile.client.println();

  String status = netFile.client.readStringUntil('\n');
  status.trim();

  Serial.print("Status line: ");
  Serial.println(status);

  if (status.length() >= 12) {
    lastHttpCode = status.substring(9, 12).toInt();
  } else {
    Serial.println("Bad HTTP status line");
    lastHttpCode = -2;
    return false;
  }

  while (true) {
    String line = netFile.client.readStringUntil('\n');
    if (line == "\r" || line.length() == 0) {
      break;
    }

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

  Serial.print("HTTP code: ");
  Serial.println(lastHttpCode);
  Serial.print("Content-Length: ");
  Serial.println(netFile.contentLength);
  Serial.print("Chunked: ");
  Serial.println(netFile.chunked ? "YES" : "NO");

  return (lastHttpCode == 200);
}

bool skipToPosition(int32_t target) {
  const unsigned long timeoutMs = 3000;
  unsigned long start = millis();

  while (netFile.streamPos < target) {
    if (netFile.client.available()) {
      netFile.client.read();
      netFile.streamPos++;
      start = millis();
    } else {
      if (!netFile.client.connected()) return false;
      if (millis() - start > timeoutMs) return false;
      delay(1);
    }
  }
  return true;
}

// ---------- JPEG CALLBACKS ----------
void* jpegOpen(const char*, int32_t* size) {
  Camera* cam = getActiveCamera();
  if (!cam) {
    Serial.println("jpegOpen: no active camera");
    return nullptr;
  }

  String path = "/api/cameras/";
  path += cam->id;
  path += "/image";

  Serial.print("jpegOpen active camera id = ");
  Serial.println(cam->id);
  Serial.print("camera name = ");
  Serial.println(cam->name);

  if (!openJPEGStream(path)) {
    Serial.print("jpegOpen failed, lastHttpCode = ");
    Serial.println(lastHttpCode);
    return nullptr;
  }

  if (netFile.chunked) {
    Serial.println("jpegOpen aborted: chunked response");
    netFile.client.stop();
    lastHttpCode = -3;
    return nullptr;
  }

  *size = (netFile.contentLength > 0) ? netFile.contentLength : 200000;

  Serial.print("jpegOpen success, size = ");
  Serial.println(*size);

  return &netFile;
}

void jpegClose(void* h) {
  ((NetJPEGFile*)h)->client.stop();
}

int32_t jpegRead(JPEGFILE* f, uint8_t* buf, int32_t len) {
  NetJPEGFile* nf = (NetJPEGFile*)f->fHandle;

  int32_t i = 0;
  const unsigned long timeoutMs = 1200;
  unsigned long start = millis();

  while (i < len) {
    if (nf->client.available()) {
      buf[i++] = nf->client.read();
      nf->streamPos++;
      start = millis();
    } else {
      if (!nf->client.connected()) break;
      if (millis() - start > timeoutMs) break;
      delay(1);
    }
  }

  return i;
}

int32_t jpegSeek(JPEGFILE* f, int32_t position) {
  NetJPEGFile* nf = (NetJPEGFile*)f->fHandle;

  if (position < 0) position = 0;

  if (position >= nf->streamPos) {
    if (!skipToPosition(position)) return nf->streamPos;
    return nf->streamPos;
  }

  if (!openJPEGStream(nf->path)) {
    return nf->streamPos;
  }

  if (!skipToPosition(position)) {
    return nf->streamPos;
  }

  return nf->streamPos;
}

// ---------- IMAGE ----------
int jpegDraw(JPEGDRAW* d) {
  int dstX = d->x;
  int dstY = d->y;
  int w = d->iWidth;
  int h = d->iHeight;

  int srcX = 0;
  int srcY = 0;

  if (dstX >= IMG_X + IMG_W || dstY >= IMG_Y + IMG_H) return 1;
  if (dstX + w <= IMG_X || dstY + h <= IMG_Y) return 1;

  if (dstX < IMG_X) {
    srcX = IMG_X - dstX;
    w -= srcX;
    dstX = IMG_X;
  }

  if (dstY < IMG_Y) {
    srcY = IMG_Y - dstY;
    h -= srcY;
    dstY = IMG_Y;
  }

  if (dstX + w > IMG_X + IMG_W) {
    w = (IMG_X + IMG_W) - dstX;
  }

  if (dstY + h > IMG_Y + IMG_H) {
    h = (IMG_Y + IMG_H) - dstY;
  }

  if (w <= 0 || h <= 0) return 1;

  for (int row = 0; row < h; row++) {
    uint16_t* rowPtr = d->pPixels + (srcY + row) * d->iWidth + srcX;
    tft.drawRGBBitmap(dstX, dstY + row, rowPtr, w, 1);
  }

  return 1;
}

void drawImage() {
  Camera* cam = getActiveCamera();
  if (!cam) {
    Serial.println("drawImage: no active camera");
    return;
  }

  Serial.println();
  Serial.println("==== drawImage ====");
  Serial.print("active camera id = ");
  Serial.println(cam->id);
  Serial.print("camera name = ");
  Serial.println(cam->name);
  logWifiStatus("drawImage:");

  isLoading = true;
  drawAllBars();
  drawLoadingOverlay();

  tft.drawRect(IMG_X - 1, IMG_Y - 1, IMG_W + 2, IMG_H + 2, ST77XX_WHITE);

  if (!jpeg.open("x", jpegOpen, jpegClose, jpegRead, jpegSeek, jpegDraw)) {
    isLoading = false;
    drawAllBars();

    Serial.print("jpeg.open failed, code = ");
    Serial.println(lastHttpCode);

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

  Serial.print("JPEG size: ");
  Serial.print(w);
  Serial.print(" x ");
  Serial.println(h);

  int scale = JPEG_SCALE_EIGHTH;
  int sw = w / 8;
  int sh = h / 8;

  if (w <= IMG_W && h <= IMG_H) {
    scale = 0;
    sw = w;
    sh = h;
  } else if ((w / 2) <= IMG_W && (h / 2) <= IMG_H) {
    scale = JPEG_SCALE_HALF;
    sw = w / 2;
    sh = h / 2;
  } else if ((w / 4) <= IMG_W && (h / 4) <= IMG_H) {
    scale = JPEG_SCALE_QUARTER;
    sw = w / 4;
    sh = h / 4;
  } else {
    scale = JPEG_SCALE_EIGHTH;
    sw = w / 8;
    sh = h / 8;
  }

  int x = IMG_X + (IMG_W - sw) / 2;
  int y = IMG_Y + (IMG_H - sh) / 2;

  Serial.print("Decode at x=");
  Serial.print(x);
  Serial.print(" y=");
  Serial.print(y);
  Serial.print(" scale=");
  Serial.println(scale);

  int rc = jpeg.decode(x, y, scale);
  jpeg.close();

  Serial.print("jpeg.decode rc = ");
  Serial.println(rc);

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

// ---------- INPUT ----------
void readEncoder() {
  int clk = digitalRead(ENC_CLK);

  if (clk != lastCLK && clk == LOW) {
    if (appMode == MODE_NEAREST) {
      int totalItems = nearestCount + 1; // +1 for GALLERY
      if (totalItems <= 0) totalItems = 1;

      if (digitalRead(ENC_DT) != clk) {
        selectedNearest = (selectedNearest + 1) % totalItems;
      } else {
        selectedNearest = (selectedNearest - 1 + totalItems) % totalItems;
      }

      Serial.print("selectedNearest = ");
      Serial.println(selectedNearest);

      flashNextLabel();
      drawText();

      if (selectedNearestIsCamera()) {
        drawLoadingOverlay();
        delay(10);
        drawImage();
      } else {
        drawImageMessage("GALLERY");
      }
    }

    else if (appMode == MODE_CAPTURES) {
      int totalItems = captureCount + 1; // +1 for BACK
      if (totalItems <= 0) totalItems = 1;

      if (digitalRead(ENC_DT) != clk) {
        selectedCapture = (selectedCapture + 1) % totalItems;
      } else {
        selectedCapture = (selectedCapture - 1 + totalItems) % totalItems;
      }

      Serial.print("selectedCapture = ");
      Serial.println(selectedCapture);

      flashNextLabel();
      drawText();

      if (selectedCaptureIsEntry()) {
        drawLoadingOverlay();
        delay(10);
        drawImage();
      } else {
        drawImageMessage("BACK");
      }
    }
  }

  lastCLK = clk;
}

void refreshNearestModeDataAndImage() {
  flashRefreshLabel();
  drawLoadingOverlay();

  if (!refreshLocation()) {
    drawAllBars();
    drawText();
    drawImageMessage("NO GPS");
    return;
  }

  bool needRefetch = shouldRefetchNearestList();

  if (needRefetch) {
    Serial.println("Refreshing nearest camera list from API...");

    if (!fetchNearestCamerasDirect()) {
      drawAllBars();
      drawText();
      drawImageMessage("FETCH FAILED", "Try refresh again", ST77XX_RED);
      return;
    }

    selectedNearest = 0;
    drawAllBars();
    drawText();

    if (selectedNearestIsCamera()) {
      delay(10);
      drawImage();
    } else {
      drawImageMessage("GALLERY");
    }
    return;
  }

  Serial.println("Keeping existing nearest list; refreshing current image only");
  recomputeCurrentNearestDistances();

  drawAllBars();
  drawText();

  if (selectedNearestIsCamera()) {
    delay(10);
    drawImage();
  } else {
    drawImageMessage("GALLERY");
  }
}

void readEncoderButton() {
  int sw = digitalRead(ENC_SW);
  unsigned long now = millis();

  if (sw != lastSW && sw == LOW && (now - lastButtonMs) > buttonDebounceMs) {
    lastButtonMs = now;

    if (appMode == MODE_NEAREST) {
      if (selectedNearestIsGallery()) {
        Serial.println("Entering GALLERY");
        appMode = MODE_CAPTURES;
        selectedCapture = 0;
        flashRefreshLabel();
        drawText();

        if (captureCount > 0 && selectedCaptureIsEntry()) {
          drawLoadingOverlay();
          delay(10);
          drawImage();
        } else {
          drawImageMessage("CAPTURES", "No captures yet");
        }
      } else if (selectedNearestIsCamera()) {
        Serial.println("Refresh current view");
        refreshNearestModeDataAndImage();
      }
    }

    else if (appMode == MODE_CAPTURES) {
      if (selectedCaptureIsBack()) {
        Serial.println("Back to nearest mode");
        appMode = MODE_NEAREST;
        selectedNearest = 0;
        flashRefreshLabel();
        drawText();

        if (selectedNearestIsCamera()) {
          drawLoadingOverlay();
          delay(10);
          drawImage();
        } else {
          drawImageMessage("GALLERY");
        }
      } else if (selectedCaptureIsEntry()) {
        Serial.println("Refresh capture entry image");
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
      Serial.println("capture pressed");
      flashCaptureLabel();
      drawSavingOverlay();
      delay(120);
      saveCurrentCapture();
      drawText();

      if (selectedNearestIsCamera()) {
        drawLoadingOverlay();
        delay(10);
        drawImage();
      }
    }
  }

  lastCaptureBtn = btn;
}

// ---------- SETUP ----------
void setup() {
  Serial.begin(115200);
  delay(1000);

  GPSSerial.begin(9600, SERIAL_8N1, GPS_RX_PIN, GPS_TX_PIN);

  Serial.println();
  Serial.println("Booting sketch");
  Serial.println("GPS serial started: GPS TX -> XIAO D7");

  pinMode(TFT_BL, OUTPUT);
  digitalWrite(TFT_BL, HIGH);

  pinMode(ENC_CLK, INPUT_PULLUP);
  pinMode(ENC_DT, INPUT_PULLUP);
  pinMode(ENC_SW, INPUT_PULLUP);
  pinMode(CAPTURE_BTN, INPUT_PULLUP);

  tft.init(240, 280);
  tft.setRotation(1);
  tft.setTextWrap(false);
  tft.fillScreen(ST77XX_BLACK);

  clearNearestList();

  Serial.print("Connecting to WiFi SSID: ");
  Serial.println(ssid);

  WiFi.mode(WIFI_STA);
  WiFi.disconnect(true);
  delay(300);
  WiFi.begin(ssid, pass);

  unsigned long wifiStart = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - wifiStart < 20000) {
    logWifiStatus("Waiting:");
    delay(500);
  }

  wifiConnected = (WiFi.status() == WL_CONNECTED);
  logWifiStatus("After WiFi.begin:");

  drawAllBars();

  if (wifiConnected) {
    refreshLocation();
    fetchNearestCamerasDirect();
  }

  drawText();

  if (selectedNearestIsCamera()) {
    drawImage();
  } else {
    drawImageMessage("NO CAMERAS", "Press refresh");
  }

  lastCLK = digitalRead(ENC_CLK);
  lastSW = digitalRead(ENC_SW);
  lastCaptureBtn = digitalRead(CAPTURE_BTN);
}

// ---------- LOOP ----------
void loop() {
  // ---- Always read GPS stream ----
  pumpGPS();

  // ---- LIVE GPS DEBUG + UPDATE ----
  static unsigned long lastGpsPrint = 0;

  if (millis() - lastGpsPrint > 1000) {
    lastGpsPrint = millis();

    Serial.print("GPS chars=");
    Serial.print(gps.charsProcessed());

    Serial.print(" valid=");
    Serial.print(gps.location.isValid());

    Serial.print(" age=");
    Serial.print(gps.location.age());

    Serial.print(" sats=");
    if (gps.satellites.isValid()) {
      Serial.print(gps.satellites.value());
    } else {
      Serial.print("?");
    }

    if (gps.location.isValid()) {
      float lat = gps.location.lat();
      float lon = gps.location.lng();

      Serial.print(" lat=");
      Serial.print(lat, 6);
      Serial.print(" lon=");
      Serial.print(lon, 6);

      // 🔥 update your app state continuously
      userLat = lat;
      userLon = lon;
      hasLocation = true;
    }

    Serial.println();
  }

  // ---- WiFi state handling (unchanged) ----
  bool nowConnected = (WiFi.status() == WL_CONNECTED);

  if (nowConnected != wifiConnected) {
    wifiConnected = nowConnected;
    Serial.println();
    Serial.println("WiFi state changed");
    logWifiStatus("Loop:");
    drawAllBars();
  }

  // ---- Input handling (unchanged) ----
  readEncoder();
  readEncoderButton();
  readCaptureButton();
}