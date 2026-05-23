#include <WiFiNINA.h>
#include <WiFiUdp.h>
#include <NTPClient.h>
#include <Arduino_LSM6DS3.h>
#include <Wire.h>
#include <SPI.h>
#include <Adafruit_DRV2605.h>
#include <Adafruit_NeoPixel.h>
#include <Adafruit_GFX.h>
#include <Adafruit_ST7789.h>
#include "arduino_secrets.h"

#if defined(__has_include)
  #if __has_include(<Arduino_OV767X.h>)
    #include <Arduino_OV767X.h>
    #define HAS_OV7670_CAMERA 1
  #else
    #define HAS_OV7670_CAMERA 0
  #endif
#else
  #define HAS_OV7670_CAMERA 0
#endif

// ================= UDP =================
WiFiUDP udp;
IPAddress serverIp;
const unsigned int serverUdpPort = 4210;
const unsigned int localUdpPort  = 4211; // listens for feedback
char incomingPacket[160];

// ================= PIN MAP (Nano 33 IoT) =================
const int POT_PIN       = A0;
const int DRAW_BTN_PIN  = 11;
const int CLICK_BTN_PIN = 12;

// ================= NEOPIXELS =================
#define NEOPIXEL_PIN 5
#define STAR_LED_COUNT 5
#define STATUS_PIXEL_INDEX 0
#define PIXEL_ORDER NEO_GRB
Adafruit_NeoPixel pixels(STAR_LED_COUNT, NEOPIXEL_PIN, NEO_GRB + NEO_KHZ800);

// ================= LCD (Waveshare 1.69" ST7789) =================
#define TFT_CS   8
#define TFT_DC   7
#define TFT_RST  6
Adafruit_ST7789 tft = Adafruit_ST7789(TFT_CS, TFT_DC, TFT_RST);

// ================= TIMING =================
const unsigned long SEND_INTERVAL      = 200;
const unsigned long DEBOUNCE_DELAY     = 50;
const unsigned long DRAW_SYNC_INTERVAL = 1000;
const unsigned long DEBUG_PRINT_INTERVAL = 1000;
const unsigned long CAMERA_SAMPLE_INTERVAL = 220;
unsigned long lastSendMs               = 0;
unsigned long lastDrawSyncSend         = 0;
unsigned long lastDebugPrintMs         = 0;
unsigned long lastCameraSampleMs       = 0;

// ================= NTP =================
WiFiUDP ntpUDP;
NTPClient timeClient(ntpUDP, "pool.ntp.org", 0, 60000);
bool ntpBegun = false;
bool ntpStarted = false;
unsigned long lastNtpAttempt = 0;

// ================= BUTTONS =================
int drawState = LOW;
int drawBtnState = HIGH;
int lastDrawBtnState = HIGH;
unsigned long lastDrawDebounce = 0;

int clickBtnState = HIGH;
int lastClickBtnState = HIGH;
unsigned long lastClickDebounce = 0;

// ================= COLOR =================
int pickedColorRgb[3] = {255, 255, 255}; // r,g,b
uint16_t pickedColor565 = 0xFFFF;
bool lcdReady = false;
bool cameraReady = false;
bool cameraWarned = false;
uint8_t* cameraFrameBuffer = nullptr;
size_t cameraFrameBytes = 0;

// ================= IMU =================
float ax = 0, ay = 0, az = 0, gx = 0, gy = 0, gz = 0;
int sensitivity = 5;
int potMinSeen = 1023;
int potMaxSeen = 0;
const int POT_MIN_SPAN = 24;
const String deviceName = "kezia-nano33";
bool imuReady = false;

// ================= FAST SWING EFFECT =================
const float SWING_THRESHOLD = 150.0; // adjust experimentally

// ================= HAPTICS =================
Adafruit_DRV2605 drv;

#define HAPTIC_TICK       3
#define HAPTIC_CLICK      1
#define HAPTIC_DOUBLE     10
#define HAPTIC_SOFT_BUMP  14
#define HAPTIC_RAMP_UP    47

const uint8_t PIXEL_BRIGHTNESS = 55;
const uint8_t DRAW_ANIM_R = 90;
const uint8_t DRAW_ANIM_G = 60;
const uint8_t DRAW_ANIM_B = 30;
const uint8_t DRAW_ON_R = 180;
const uint8_t DRAW_ON_G = 0;
const uint8_t DRAW_ON_B = 120;

void showAllPixels(uint32_t color);
void clearPixels();
void updateColorFromCamera();
void renderPickedColorOnLcd();

uint32_t rgb(uint8_t r, uint8_t g, uint8_t b) {
  return pixels.Color(r, g, b);
}

int clampInt(int value, int minValue, int maxValue) {
  if (value < minValue) return minValue;
  if (value > maxValue) return maxValue;
  return value;
}

uint16_t rgb888ToRgb565(uint8_t r, uint8_t g, uint8_t b) {
  return ((uint16_t)(r & 0xF8) << 8) |
         ((uint16_t)(g & 0xFC) << 3) |
         ((uint16_t)(b >> 3));
}

void rgb565ToRgb888(uint16_t c, uint8_t& r, uint8_t& g, uint8_t& b) {
  r = ((c >> 11) & 0x1F) * 255 / 31;
  g = ((c >> 5) & 0x3F) * 255 / 63;
  b = (c & 0x1F) * 255 / 31;
}

void renderPickedColorOnLcd() {
  if (!lcdReady) return;

  pickedColor565 = rgb888ToRgb565(
    (uint8_t)clampInt(pickedColorRgb[0], 0, 255),
    (uint8_t)clampInt(pickedColorRgb[1], 0, 255),
    (uint8_t)clampInt(pickedColorRgb[2], 0, 255)
  );

  tft.fillScreen(ST77XX_BLACK);
  tft.fillRect(0, 0, tft.width(), tft.height() - 48, pickedColor565);
  tft.drawRect(0, 0, tft.width(), tft.height() - 48, ST77XX_WHITE);

  tft.fillRect(0, tft.height() - 48, tft.width(), 48, ST77XX_BLACK);
  tft.setTextWrap(false);
  tft.setTextColor(ST77XX_WHITE);
  tft.setTextSize(2);
  tft.setCursor(8, tft.height() - 42);
  tft.print("R:");
  tft.print(pickedColorRgb[0]);
  tft.print(" G:");
  tft.print(pickedColorRgb[1]);

  tft.setCursor(8, tft.height() - 22);
  tft.print("B:");
  tft.print(pickedColorRgb[2]);
}

void updateColorFromCamera() {
#if HAS_OV7670_CAMERA
  if (!cameraReady || cameraFrameBuffer == nullptr || cameraFrameBytes < 2) return;

  Camera.readFrame(cameraFrameBuffer);

  const int w = Camera.width();
  const int h = Camera.height();
  if (w <= 0 || h <= 0) return;

  const size_t centerPixelIndex = (size_t)(h / 2) * (size_t)w + (size_t)(w / 2);
  const size_t centerByteIndex = centerPixelIndex * 2;
  if ((centerByteIndex + 1) >= cameraFrameBytes) return;

  const uint16_t be565 =
    ((uint16_t)cameraFrameBuffer[centerByteIndex] << 8) |
    ((uint16_t)cameraFrameBuffer[centerByteIndex + 1]);

  uint8_t r = 0, g = 0, b = 0;
  rgb565ToRgb888(be565, r, g, b);
  pickedColorRgb[0] = r;
  pickedColorRgb[1] = g;
  pickedColorRgb[2] = b;
  renderPickedColorOnLcd();
#else
  if (!cameraWarned) {
    cameraWarned = true;
    Serial.println("OV7670 library not found for this board build; color picker camera disabled.");
  }
#endif
}

neoPixelType pixelOrderFromName(const String& order) {
  if (order == "rgb") return NEO_RGB;
  if (order == "rbg") return NEO_RBG;
  if (order == "grb") return NEO_GRB;
  if (order == "gbr") return NEO_GBR;
  if (order == "brg") return NEO_BRG;
  if (order == "bgr") return NEO_BGR;
  return NEO_GRB;
}

void showAllPixels(uint32_t color) {
  for (int i = 0; i < STAR_LED_COUNT; i++) pixels.setPixelColor(i, color);
  pixels.show();
}

void clearPixels() {
  pixels.clear();
  pixels.show();
}

void setStatusPixel(uint32_t color) {
  pixels.setPixelColor(STATUS_PIXEL_INDEX, color);
  pixels.show();
}

void clearStatusPixel() {
  pixels.setPixelColor(STATUS_PIXEL_INDEX, 0);
  pixels.show();
}

void restorePixelsFromDrawState() {
  if (drawState) showAllPixels(rgb(DRAW_ON_R, DRAW_ON_G, DRAW_ON_B));
  else clearPixels();
}

void blinkPixelsOneByOne(uint32_t color, int onMs = 85, int offMs = 45) {
  for (int i = 0; i < STAR_LED_COUNT; i++) {
    pixels.clear();
    pixels.setPixelColor(i, color);
    pixels.show();
    delay(onMs);
    pixels.setPixelColor(i, 0);
    pixels.show();
    delay(offMs);
  }
}

void sweepPixelsFill(uint32_t color, int stepMs = 55) {
  pixels.clear();
  pixels.show();
  for (int i = 0; i < STAR_LED_COUNT; i++) {
    pixels.setPixelColor(i, color);
    pixels.show();
    delay(stepMs);
  }
}

void blinkAllPixelsOnce(uint32_t color, int onMs = 80, int offMs = 80) {
  showAllPixels(color);
  delay(onMs);
  clearPixels();
  delay(offMs);
  restorePixelsFromDrawState();
}

void applyDrawPixelState(bool isDrawing) {
  const uint32_t animColor = rgb(DRAW_ANIM_R, DRAW_ANIM_G, DRAW_ANIM_B);
  const uint32_t drawOnColor = rgb(DRAW_ON_R, DRAW_ON_G, DRAW_ON_B);
  blinkPixelsOneByOne(animColor);
  if (isDrawing) showAllPixels(drawOnColor);
  else clearPixels();
  Serial.print("LED draw state -> ");
  Serial.println(isDrawing ? "ON(fuchsia)" : "OFF");
}

void playHaptic(int effect) {
  drv.setWaveform(0, effect);
  drv.setWaveform(1, 0);
  drv.go();
}

void playHaptic2(int effect1, int effect2) {
  drv.setWaveform(0, effect1);
  drv.setWaveform(1, effect2);
  drv.setWaveform(2, 0);
  drv.go();
}

void sendUdpJson(const String& msg) {
  udp.beginPacket(serverIp, serverUdpPort);
  udp.print(msg);
  udp.endPacket();
}

int normalizePotToSensitivity(int potRaw) {
  if (potRaw < potMinSeen) potMinSeen = potRaw;
  if (potRaw > potMaxSeen) potMaxSeen = potRaw;

  const int span = potMaxSeen - potMinSeen;
  if (span < POT_MIN_SPAN) return sensitivity;

  const int mapped = map(potRaw, potMinSeen, potMaxSeen, 1, 10);
  return constrain(mapped, 1, 10);
}

void publishPower(bool on) {
  String msg = "{\"path\":\"kezia/imu/power\",\"data\":{\"power\":";
  msg += (on ? "true" : "false");
  msg += "}}";
  sendUdpJson(msg);
}

void pulseClick() {
  sendUdpJson("{\"path\":\"kezia/imu/click\",\"data\":true}");
  Serial.println("CLICK UDP!");
}

void pulseDraw() {
  String state = drawState ? "start" : "stop";
  String msg = "{\"path\":\"kezia/imu/draw\",\"data\":\"";
  msg += state;
  msg += "\"}";
  sendUdpJson(msg);
  Serial.print("DRAW UDP: ");
  Serial.println(state);
}

void publishSensorUdp() {
  String msg = "{\"path\":\"kezia/imu/data\",\"data\":";
  msg += "{\"device\":\"";
  msg += deviceName;
  msg += "\",\"draw\":\"";
  msg += (drawState ? "start" : "stop");
  msg += "\",\"sensor\":{";
  msg += "\"ax\":" + String(ax, 4) + ",";
  msg += "\"ay\":" + String(ay, 4) + ",";
  msg += "\"az\":" + String(az, 4) + ",";
  msg += "\"gx\":" + String(gx, 4) + ",";
  msg += "\"gy\":" + String(gy, 4) + ",";
  msg += "\"gz\":" + String(gz, 4) + ",";
  msg += "\"sensitivity\":" + String(sensitivity) + ",";
  msg += "\"color\":[" + String(pickedColorRgb[0]) + "," + String(pickedColorRgb[1]) + "," + String(pickedColorRgb[2]) + "],";
  msg += "\"timestamp\":";

  if (ntpStarted) {
    unsigned long long tsMs =
      (unsigned long long)timeClient.getEpochTime() * 1000ULL + (millis() % 1000);
    msg += String((unsigned long)tsMs);
  } else {
    msg += String(millis());
  }
  msg += "}}}";

  sendUdpJson(msg);
  Serial.println(msg);
}

void printDebugReadings(int potRaw) {
  Serial.print("[DBG] potRaw=");
  Serial.print(potRaw);
  Serial.print(" sens=");
  Serial.print(sensitivity);
  Serial.print(" drawBtn=");
  Serial.print(drawBtnState);
  Serial.print(" clickBtn=");
  Serial.print(clickBtnState);
  Serial.print(" drawState=");
  Serial.print(drawState ? "start" : "stop");
  Serial.print(" ax=");
  Serial.print(ax, 4);
  Serial.print(" ay=");
  Serial.print(ay, 4);
  Serial.print(" az=");
  Serial.print(az, 4);
  Serial.print(" gx=");
  Serial.print(gx, 4);
  Serial.print(" gy=");
  Serial.print(gy, 4);
  Serial.print(" gz=");
  Serial.print(gz, 4);
  Serial.print(" rgb=[");
  Serial.print(pickedColorRgb[0]);
  Serial.print(",");
  Serial.print(pickedColorRgb[1]);
  Serial.print(",");
  Serial.print(pickedColorRgb[2]);
  Serial.print("]");
  Serial.print(" | IMU=");
  Serial.println(imuReady ? "OK" : "NOT_READY");
}

void checkUdpFeedback() {
  int packetSize = udp.parsePacket();
  if (!packetSize) return;
  int len = udp.read(incomingPacket, sizeof(incomingPacket) - 1);
  if (len <= 0) return;
  incomingPacket[len] = '\0';

  String msg = String(incomingPacket);
  msg.trim();

  Serial.print("UDP feedback: ");
  Serial.println(msg);

  if (msg == "hover") {
    playHaptic(HAPTIC_TICK);
  } else if (msg == "click") {
    playHaptic(HAPTIC_CLICK);
  } else if (msg == "beat_hit perfect") {
    playHaptic2(HAPTIC_RAMP_UP, HAPTIC_DOUBLE);
    sweepPixelsFill(rgb(0, 140, 0));
    restorePixelsFromDrawState();
  } else if (msg == "beat_hit hit") {
    playHaptic(HAPTIC_TICK);
  } else if (msg == "beat_hit missed") {
    playHaptic(HAPTIC_SOFT_BUMP);
  }
}

bool connectToNetwork() {
  if (WiFi.status() == WL_NO_MODULE) {
    Serial.println("WiFi module not detected (WL_NO_MODULE).");

    while (true) {
      setStatusPixel(rgb(180, 0, 0)); // red
      delay(150);
      clearStatusPixel();
      delay(150);
    }
  }

  if (strlen(SECRET_SSID) == 0) {
    Serial.println("SECRET_SSID is empty in arduino_secrets.h");

    while (true) {
      setStatusPixel(rgb(180, 0, 0)); // red
      delay(150);
      clearStatusPixel();
      delay(150);
    }
  }

  Serial.print("Connecting to SSID: ");
  Serial.println(SECRET_SSID);

  WiFi.begin(SECRET_SSID, SECRET_PASS);

  int attempts = 0;

  while (WiFi.status() != WL_CONNECTED && attempts < 20) {

    // BLUE BLINK while connecting
    setStatusPixel(rgb(0, 0, 180));
    delay(120);
    clearStatusPixel();
    delay(120);

    Serial.print("WiFi intentando... status=");
    Serial.println(WiFi.status());

    attempts++;
  }

  if (WiFi.status() == WL_CONNECTED) {

    Serial.println("WiFi OK");
    Serial.print("Arduino IP: ");
    Serial.println(WiFi.localIP());

    // GREEN BLINK ONCE when connected
    setStatusPixel(rgb(0, 180, 0));
    delay(400);
    clearStatusPixel();

    return true;
  }

  Serial.println("WiFi FALLO");

  // RED BLINK FOREVER on failure
  while (true) {
    setStatusPixel(rgb(180, 0, 0));
    delay(150);
    clearStatusPixel();
    delay(150);
  }

  return false;
}

void setup() {
  Serial.begin(115200);
  Serial.setTimeout(20);
  delay(500);

  pinMode(DRAW_BTN_PIN, INPUT_PULLUP);
  pinMode(CLICK_BTN_PIN, INPUT_PULLUP);

  pixels.begin();
  pixels.setBrightness(PIXEL_BRIGHTNESS);
  clearPixels();

  tft.init(240, 280);
  tft.setRotation(0);
  lcdReady = true;
  renderPickedColorOnLcd();

  connectToNetwork();

  if (!serverIp.fromString(SERVER_IP_ADDRESS)) {
    Serial.print("Invalid SERVER_IP_ADDRESS in arduino_secrets.h: ");
    Serial.println(SERVER_IP_ADDRESS);
    while (true) {
      setStatusPixel(rgb(180, 0, 0));
      delay(200);
      clearStatusPixel();
      delay(200);
    }
  }
  Serial.print("UDP server IP: ");
  Serial.println(serverIp);

  udp.begin(localUdpPort);
  Serial.print("Arduino UDP listening on port ");
  Serial.println(localUdpPort);

  if (!IMU.begin()) {
    Serial.println("IMU init failed (Arduino_LSM6DS3)");
    imuReady = false;
  } else {
    Serial.println("IMU OK (Arduino_LSM6DS3)");
    imuReady = true;
  }

  Wire.begin(); // Nano 33 IoT: fixed SDA/SCL pins
  if (!drv.begin()) {
    Serial.println("HAPTICS DRV2605 not found");
  } else {
    drv.selectLibrary(1);
    drv.setMode(DRV2605_MODE_INTTRIG);
    playHaptic(HAPTIC_TICK);
  }

#if HAS_OV7670_CAMERA
  if (!Camera.begin(QQVGA, RGB565, 1)) {
    Serial.println("OV7670 init failed");
    cameraReady = false;
  } else {
    cameraFrameBytes =
      (size_t)Camera.width() * (size_t)Camera.height() * (size_t)Camera.bytesPerPixel();
    cameraFrameBuffer = (uint8_t*)malloc(cameraFrameBytes);
    if (cameraFrameBuffer == nullptr) {
      Serial.println("OV7670 frame buffer alloc failed; camera disabled");
      cameraReady = false;
    } else {
      cameraReady = true;
      Serial.print("OV7670 OK w=");
      Serial.print(Camera.width());
      Serial.print(" h=");
      Serial.print(Camera.height());
      Serial.print(" bpp=");
      Serial.print(Camera.bytesPerPixel());
      Serial.print(" bytes=");
      Serial.println((unsigned long)cameraFrameBytes);
      updateColorFromCamera();
    }
  }
#endif

  publishPower(true); // start session on server side
  clearPixels();
}

void loop() {
  checkUdpFeedback();
  unsigned long now = millis();

  if (!ntpBegun) {
    timeClient.begin();
    ntpBegun = true;
  }

  if (!ntpStarted && now - lastNtpAttempt > 10000) {
    lastNtpAttempt = now;
    if (timeClient.forceUpdate()) {
      ntpStarted = true;
      Serial.println("NTP OK");
    }
  }

  if (WiFi.status() != WL_CONNECTED) {
    connectToNetwork();
    publishPower(true);
  }

  if (now - lastCameraSampleMs >= CAMERA_SAMPLE_INTERVAL) {
    lastCameraSampleMs = now;
    updateColorFromCamera();
  }

  int drawReading = digitalRead(DRAW_BTN_PIN);
  if (drawReading != lastDrawBtnState) lastDrawDebounce = now;
  if (now - lastDrawDebounce > DEBOUNCE_DELAY) {
    if (drawReading != drawBtnState) {
      drawBtnState = drawReading;
      if (drawBtnState == LOW) {
        drawState = !drawState;
        pulseDraw();
        applyDrawPixelState(drawState);
      }
    }
  }
  lastDrawBtnState = drawReading;

  int clickReading = digitalRead(CLICK_BTN_PIN);
  if (clickReading != lastClickBtnState) lastClickDebounce = now;
  if (now - lastClickDebounce > DEBOUNCE_DELAY) {
    if (clickReading != clickBtnState) {
      clickBtnState = clickReading;
      if (clickBtnState == LOW) {
        blinkAllPixelsOnce(rgb(255, 255, 255));
        pulseClick();
      }
    }
  }
  lastClickBtnState = clickReading;

  if (now - lastSendMs >= SEND_INTERVAL) {
    lastSendMs = now;
    if (imuReady) {

      if (IMU.accelerationAvailable()) {
        IMU.readAcceleration(ax, ay, az);
      }

      if (IMU.gyroscopeAvailable()) {

        IMU.readGyroscope(gx, gy, gz);

        float gyroMagnitude =
          sqrt(gx * gx + gy * gy + gz * gz);

        if (gyroMagnitude > SWING_THRESHOLD) {
          randomSwingFlash(gyroMagnitude);
        }
      }
    }

    int potRaw = analogRead(POT_PIN);
    sensitivity = normalizePotToSensitivity(potRaw);
    publishSensorUdp();
    if (now - lastDebugPrintMs >= DEBUG_PRINT_INTERVAL) {
      lastDebugPrintMs = now;
      printDebugReadings(potRaw);
    }
  }

  if (drawState && (now - lastDrawSyncSend >= DRAW_SYNC_INTERVAL)) {
    lastDrawSyncSend = now;
    pulseDraw();
  }
}

// ================= SWING EFFECT =================
unsigned long lastSwingFlash = 0;
const unsigned long SWING_FLASH_INTERVAL = 45;

void randomSwingFlash(float gyroMagnitude) {

  unsigned long now = millis();

  if (now - lastSwingFlash < SWING_FLASH_INTERVAL) return;

  lastSwingFlash = now;

  // probability increases with swing speed
  int chance = constrain(map((int)gyroMagnitude, 220, 800, 15, 95), 15, 95);

  if (random(100) < chance) {

    int flashCount = random(1, 4); // 1 to 3 pixels

    for (int i = 0; i < flashCount; i++) {

      int pixelIndex = random(STAR_LED_COUNT);

      uint8_t r = random(40, 255);
      uint8_t g = random(40, 255);
      uint8_t b = random(40, 255);

      pixels.setPixelColor(pixelIndex, rgb(r, g, b));
    }

    pixels.show();

    delay(8);

    restorePixelsFromDrawState();
  }
}
