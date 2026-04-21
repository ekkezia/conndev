#include <SPI.h>
#include <WiFiNINA.h>
#include <Adafruit_GFX.h>
#include <Adafruit_ST7789.h>
#include <JPEGDEC.h>
#include "cameras.h"
#include "arduino_secrets.h"

// ---------- TFT ----------
#define TFT_CS   10
#define TFT_DC   7
#define TFT_RST  8
#define TFT_BL   9

Adafruit_ST7789 tft = Adafruit_ST7789(TFT_CS, TFT_DC, TFT_RST);

// ---------- Encoder / Buttons ----------
#define ENC_CLK      2
#define ENC_DT       3
#define ENC_SW       4
#define CAPTURE_BTN  5

// ---------- WiFi ----------
char ssid[] = SECRET_SSID;
char pass[] = SECRET_PASS;

// ---------- Location ----------
const float USER_LAT = 40.69234f;
const float USER_LON = -73.987453f;

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
#define INFO_W 220
#define TITLE_Y 24
#define DIST_Y  44

// ---------- State ----------
const int MAX_NEAREST = 5;
int nearestIndices[MAX_NEAREST];
float nearestDistances[MAX_NEAREST];
int nearestCount = 0;
int selectedNearest = 0;   // 0..nearestCount, where nearestCount = GALLERY item

const int MAX_CAPTURES = 10;

struct CaptureRecord {
  int cameraIndex;
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
  WiFiSSLClient client;
  String path;
  int32_t streamPos;
  int32_t contentLength;
  bool chunked;
};

NetJPEGFile netFile;

// ---------- Helpers ----------
const char* wifiStatusToString(int s) {
  switch (s) {
    case WL_IDLE_STATUS:      return "IDLE";
    case WL_NO_MODULE:        return "NO_MODULE";
    case WL_CONNECTED:        return "CONNECTED";
    case WL_CONNECT_FAILED:   return "CONNECT_FAILED";
    case WL_CONNECTION_LOST:  return "CONNECTION_LOST";
    case WL_DISCONNECTED:     return "DISCONNECTED";
    case WL_AP_LISTENING:     return "AP_LISTENING";
    case WL_AP_CONNECTED:     return "AP_CONNECTED";
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

bool selectedNearestIsCamera() {
  return (nearestCount > 0 &&
          selectedNearest >= 0 &&
          selectedNearest < nearestCount &&
          nearestIndices[selectedNearest] >= 0);
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

int activeCameraIndex() {
  if (appMode == MODE_NEAREST) {
    if (selectedNearestIsCamera()) {
      return nearestIndices[selectedNearest];
    }
    return -1;
  }

  if (appMode == MODE_CAPTURES) {
    if (selectedCaptureIsEntry()) {
      return captures[selectedCapture].cameraIndex;
    }
    return -1;
  }

  return -1;
}

// ---------- Distance ----------
float haversine(float lat1, float lon1, float lat2, float lon2) {
  const float R = 6371000.0f;
  float dLat = (lat2 - lat1) * PI / 180.0f;
  float dLon = (lon2 - lon1) * PI / 180.0f;

  float a = sin(dLat / 2) * sin(dLat / 2) +
            cos(lat1 * PI / 180.0f) * cos(lat2 * PI / 180.0f) *
            sin(dLon / 2) * sin(dLon / 2);

  return R * 2.0f * atan2(sqrt(a), sqrt(1.0f - a));
}

// ---------- Find nearest ----------
void computeNearest() {
  for (int i = 0; i < MAX_NEAREST; i++) {
    nearestDistances[i] = 99999999.0f;
    nearestIndices[i] = -1;
  }

  for (int i = 0; i < cameraCount; i++) {
    float d = haversine(USER_LAT, USER_LON, cameras[i].lat, cameras[i].lon);

    for (int j = 0; j < MAX_NEAREST; j++) {
      if (d < nearestDistances[j]) {
        for (int k = MAX_NEAREST - 1; k > j; k--) {
          nearestDistances[k] = nearestDistances[k - 1];
          nearestIndices[k] = nearestIndices[k - 1];
        }
        nearestDistances[j] = d;
        nearestIndices[j] = i;
        break;
      }
    }
  }

  nearestCount = 0;
  for (int i = 0; i < MAX_NEAREST; i++) {
    if (nearestIndices[i] >= 0) {
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
    Serial.print(" -> camera index ");
    Serial.print(nearestIndices[i]);
    Serial.print("  dist=");
    Serial.print((int)nearestDistances[i]);
    Serial.print("m  name=");
    Serial.println(cameras[nearestIndices[i]].name);
  }
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
      const Camera& cam = cameras[nearestIndices[selectedNearest]];
      tft.setCursor(INFO_X, TITLE_Y);
      printName20(cam.name);

      tft.setCursor(INFO_X, DIST_Y);
      tft.print((int)nearestDistances[selectedNearest]);
      tft.print(" m");
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
      const Camera& cam = cameras[captures[selectedCapture].cameraIndex];
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

  int camIndex = nearestIndices[selectedNearest];

  if (captureCount < MAX_CAPTURES) {
    captures[captureCount].cameraIndex = camIndex;
    captures[captureCount].capturedAtMs = millis();
    captureCount++;
  } else {
    for (int i = 0; i < MAX_CAPTURES - 1; i++) {
      captures[i] = captures[i + 1];
    }
    captures[MAX_CAPTURES - 1].cameraIndex = camIndex;
    captures[MAX_CAPTURES - 1].capturedAtMs = millis();
    captureCount = MAX_CAPTURES;
  }

  Serial.print("Saved capture for camera index ");
  Serial.print(camIndex);
  Serial.print("  captureCount=");
  Serial.println(captureCount);
}

// ---------- Network helpers ----------
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
  Serial.println("webcams.nyctmc.org");
  Serial.print("Path: ");
  Serial.println(path);

  if (!wifiConnected) {
    Serial.println("WiFi not connected, aborting request");
    lastHttpCode = -10;
    return false;
  }

  if (!netFile.client.connect("webcams.nyctmc.org", 443)) {
    Serial.println("SSL connect failed");
    lastHttpCode = -1;
    return false;
  }

  Serial.println("SSL connected, sending HTTP request");

  netFile.client.print("GET " + path + " HTTP/1.1\r\n");
  netFile.client.println("Host: webcams.nyctmc.org");
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

    Serial.print("HDR: ");
    Serial.println(line);

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
  int camIndex = activeCameraIndex();
  if (camIndex < 0 || camIndex >= cameraCount) {
    Serial.println("jpegOpen: invalid active camera");
    return nullptr;
  }

  const Camera& cam = cameras[camIndex];

  String path = "/api/cameras/";
  path += cam.id;
  path += "/image";

  Serial.print("jpegOpen active camera id = ");
  Serial.println(cam.id);
  Serial.print("camera name = ");
  Serial.println(cam.name);

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
  int camIndex = activeCameraIndex();
  if (camIndex < 0 || camIndex >= cameraCount) {
    Serial.println("drawImage: invalid active camera");
    return;
  }

  const Camera& cam = cameras[camIndex];

  Serial.println();
  Serial.println("==== drawImage ====");
  Serial.print("active camera id = ");
  Serial.println(cam.id);
  Serial.print("camera name = ");
  Serial.println(cam.name);
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
        Serial.println("Refresh camera");
        flashRefreshLabel();
        drawLoadingOverlay();
        delay(10);
        drawImage();
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
        Serial.println("Refresh capture entry");
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

  Serial.println();
  Serial.println("Booting sketch");

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

  computeNearest();

  Serial.print("Connecting to WiFi SSID: ");
  Serial.println(ssid);

  WiFi.begin(ssid, pass);

  unsigned long wifiStart = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - wifiStart < 20000) {
    logWifiStatus("Waiting:");
    delay(500);
  }

  wifiConnected = (WiFi.status() == WL_CONNECTED);
  logWifiStatus("After WiFi.begin:");

  drawAllBars();
  drawText();

  if (selectedNearestIsCamera()) {
    drawImage();
  } else {
    drawImageMessage("GALLERY");
  }

  lastCLK = digitalRead(ENC_CLK);
  lastSW = digitalRead(ENC_SW);
  lastCaptureBtn = digitalRead(CAPTURE_BTN);
}

// ---------- LOOP ----------
void loop() {
  bool nowConnected = (WiFi.status() == WL_CONNECTED);

  if (nowConnected != wifiConnected) {
    wifiConnected = nowConnected;
    Serial.println();
    Serial.println("WiFi state changed");
    logWifiStatus("Loop:");
    drawAllBars();
  }

  readEncoder();
  readEncoderButton();
  readCaptureButton();
}