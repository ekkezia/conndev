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

// ---------- Encoder ----------
#define ENC_CLK  2
#define ENC_DT   3
#define ENC_SW   6

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

#define IMG_X 8
#define IMG_Y 64
#define IMG_W 264
#define IMG_H 148

#define INFO_X 8
#define INFO_Y 24
#define INFO_W 72
#define TITLE_Y 24
#define DIST_Y  44

// ---------- State ----------
const int MAX_NEAREST = 5;
int nearestIndices[MAX_NEAREST];
float nearestDistances[MAX_NEAREST];
int nearestCount = 0;
int selectedNearest = 0;

bool wifiConnected = false;
bool isLoading = false;
int lastHttpCode = 0;

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

  nearestCount = MAX_NEAREST;
}

// ---------- UI ----------
void drawTopIndicators() {
  tft.fillRect(0, 0, SCREEN_W, TOPBAR_H, ST77XX_BLACK);

  tft.setTextSize(1);
  tft.setTextColor(ST77XX_WHITE, ST77XX_BLACK);

  tft.setCursor(16, 8);
  tft.print("NEXT/REFRESH");

  int wifiX = SCREEN_W / 2 - 10;
  int loadX = SCREEN_W / 2 + 10;
  int y = TOPBAR_H / 2;

  uint16_t wifiColor = wifiConnected ? 0x07E0 : 0xF800;
  tft.fillCircle(wifiX, y, 4, wifiColor);
  tft.drawCircle(wifiX, y, 4, ST77XX_WHITE);

  if (isLoading && (millis() / 200) % 2) {
    tft.fillCircle(loadX, y, 4, ST77XX_WHITE);
  } else {
    tft.drawCircle(loadX, y, 4, ST77XX_WHITE);
    tft.fillCircle(loadX, y, 3, ST77XX_BLACK);
  }

  int16_t x1, y1;
  uint16_t w, h;
  tft.getTextBounds("CAPTURE", 0, 8, &x1, &y1, &w, &h);
  tft.setCursor(SCREEN_W - w - 16, 8);
  tft.print("CAPTURE");
}

void printName20(const char* s) {
  for (int i = 0; i < 20 && s[i] != '\0'; i++) {
    tft.print(s[i]);
  }
}

void drawText() {
  tft.fillRect(INFO_X, INFO_Y, INFO_W, 110, ST77XX_BLACK);

  if (nearestCount == 0) return;

  const Camera& cam = cameras[nearestIndices[selectedNearest]];

  tft.setTextColor(ST77XX_WHITE, ST77XX_BLACK);

  tft.setTextSize(2);
  tft.setCursor(INFO_X, TITLE_Y);
  printName20(cam.name);

  tft.setTextSize(2);
  tft.setCursor(INFO_X, DIST_Y);
  tft.print((int)nearestDistances[selectedNearest]);
  tft.print(" m");
}

// ---------- Network helpers ----------
bool openJPEGStream(const String& path) {
  netFile.client.stop();
  netFile.streamPos = 0;
  netFile.contentLength = -1;
  netFile.chunked = false;
  netFile.path = path;
  lastHttpCode = 0;

  if (!netFile.client.connect("webcams.nyctmc.org", 443)) {
    lastHttpCode = -1;
    return false;
  }

  netFile.client.print("GET " + path + " HTTP/1.1\r\n");
  netFile.client.println("Host: webcams.nyctmc.org");
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
  const Camera& cam = cameras[nearestIndices[selectedNearest]];

  String path = "/api/cameras/";
  path += cam.id;
  path += "/image";

  if (!openJPEGStream(path)) {
    return nullptr;
  }

  if (netFile.chunked) {
    // Streaming chunked responses are unreliable with this callback style.
    netFile.client.stop();
    lastHttpCode = -3;
    return nullptr;
  }

  // If server provides content-length, use it.
  // Otherwise give a large fallback so decoder can proceed.
  *size = (netFile.contentLength > 0) ? netFile.contentLength : 200000;

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

  // Forward seek: just discard bytes until we reach target.
  if (position >= nf->streamPos) {
    if (!skipToPosition(position)) return nf->streamPos;
    return nf->streamPos;
  }

  // Backward seek: reopen stream, then skip forward to requested position.
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

  // Fully outside image box
  if (dstX >= IMG_X + IMG_W || dstY >= IMG_Y + IMG_H) return 1;
  if (dstX + w <= IMG_X || dstY + h <= IMG_Y) return 1;

  // Clip left
  if (dstX < IMG_X) {
    srcX = IMG_X - dstX;
    w -= srcX;
    dstX = IMG_X;
  }

  // Clip top
  if (dstY < IMG_Y) {
    srcY = IMG_Y - dstY;
    h -= srcY;
    dstY = IMG_Y;
  }

  // Clip right
  if (dstX + w > IMG_X + IMG_W) {
    w = (IMG_X + IMG_W) - dstX;
  }

  // Clip bottom
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
  isLoading = true;
  drawTopIndicators();

  tft.fillRect(IMG_X, IMG_Y, IMG_W, IMG_H, ST77XX_BLACK);
  tft.drawRect(IMG_X - 1, IMG_Y - 1, IMG_W + 2, IMG_H + 2, ST77XX_WHITE);

  if (!jpeg.open("x", jpegOpen, jpegClose, jpegRead, jpegSeek, jpegDraw)) {
    isLoading = false;
    drawTopIndicators();

    tft.setTextColor(ST77XX_RED, ST77XX_BLACK);
    tft.setTextSize(1);
    tft.setCursor(IMG_X + 8, IMG_Y + IMG_H / 2);
    tft.print("IMAGE LOAD FAILED");
    return;
  }

  int w = jpeg.getWidth();
  int h = jpeg.getHeight();

  // true contain using JPEGDEC's available discrete scales
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

  int rc = jpeg.decode(x, y, scale);
  jpeg.close();

  if (rc != 1) {
    tft.fillRect(IMG_X, IMG_Y, IMG_W, IMG_H, ST77XX_BLACK);
    tft.drawRect(IMG_X - 1, IMG_Y - 1, IMG_W + 2, IMG_H + 2, ST77XX_WHITE);
    tft.setTextColor(ST77XX_RED, ST77XX_BLACK);
    tft.setTextSize(1);
    tft.setCursor(IMG_X + 8, IMG_Y + IMG_H / 2);
    tft.print("JPEG DECODE FAILED");
  }

  isLoading = false;
  drawTopIndicators();
}

// ---------- INPUT ----------
int lastCLK;

void readEncoder() {
  int clk = digitalRead(ENC_CLK);

  if (clk != lastCLK && clk == LOW) {
    if (digitalRead(ENC_DT) != clk)
      selectedNearest = (selectedNearest + 1) % nearestCount;
    else
      selectedNearest = (selectedNearest - 1 + nearestCount) % nearestCount;

    drawText();
    drawImage();
  }

  lastCLK = clk;
}

void readButton() {
  if (digitalRead(ENC_SW) == LOW) {
    delay(200);
    drawImage();
  }
}

// ---------- SETUP ----------
void setup() {
  Serial.begin(115200);

  pinMode(TFT_BL, OUTPUT);
  digitalWrite(TFT_BL, HIGH);

  pinMode(ENC_CLK, INPUT_PULLUP);
  pinMode(ENC_DT, INPUT_PULLUP);
  pinMode(ENC_SW, INPUT_PULLUP);

  tft.init(240, 280);
  tft.setRotation(1);
  tft.setTextWrap(false);
  tft.fillScreen(ST77XX_BLACK);

  computeNearest();

  WiFi.begin(ssid, pass);
  while (WiFi.status() != WL_CONNECTED) {
    delay(500);
  }
  wifiConnected = true;

  drawTopIndicators();
  drawText();
  drawImage();

  lastCLK = digitalRead(ENC_CLK);
}

// ---------- LOOP ----------
void loop() {
  wifiConnected = (WiFi.status() == WL_CONNECTED);

  readEncoder();
  readButton();
}