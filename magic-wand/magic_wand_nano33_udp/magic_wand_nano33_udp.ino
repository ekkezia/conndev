#include <WiFiNINA.h>
#include <WiFiUdp.h>
#include <NTPClient.h>
#include <Arduino_LSM6DS3.h>
#include <Wire.h>
#include <Adafruit_DRV2605.h>
#include <Adafruit_NeoPixel.h>
#include "arduino_secrets.h"

// ================= UDP =================
WiFiUDP udp;
IPAddress serverIp(10, 23, 11, 207);   // updated computer/server IP
const unsigned int serverUdpPort = 4210;
const unsigned int localUdpPort  = 4211; // listens for feedback
char incomingPacket[160];

// ================= PIN MAP (Nano 33 IoT) =================
const int POT_PIN       = A0;
const int DRAW_BTN_PIN  = 11;
const int CLICK_BTN_PIN = 12;

// ================= NEOPIXELS =================
#define NEOPIXEL_PIN 6
#define STAR_LED_COUNT 5
#define STATUS_PIXEL_INDEX 0
Adafruit_NeoPixel pixels(STAR_LED_COUNT, NEOPIXEL_PIN, NEO_GRB + NEO_KHZ800);

// ================= TIMING =================
const unsigned long SEND_INTERVAL      = 200;
const unsigned long DEBOUNCE_DELAY     = 50;
const unsigned long DRAW_SYNC_INTERVAL = 1000;
const unsigned long DEBUG_PRINT_INTERVAL = 1000;
unsigned long lastSendMs               = 0;
unsigned long lastDrawSyncSend         = 0;
unsigned long lastDebugPrintMs         = 0;

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

// ================= IMU =================
float ax = 0, ay = 0, az = 0, gx = 0, gy = 0, gz = 0;
int sensitivity = 5;
const String deviceName = "kezia-nano33";
bool imuReady = false;

// ================= HAPTICS =================
Adafruit_DRV2605 drv;

#define HAPTIC_TICK       3
#define HAPTIC_CLICK      1
#define HAPTIC_DOUBLE     10
#define HAPTIC_SOFT_BUMP  14
#define HAPTIC_RAMP_UP    47

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
  if (drawState) showAllPixels(pixels.Color(180, 0, 120));
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
  const uint32_t animColor = pixels.Color(90, 60, 30);
  const uint32_t drawOnColor = pixels.Color(180, 0, 120);
  blinkPixelsOneByOne(animColor);
  if (isDrawing) showAllPixels(drawOnColor);
  else clearPixels();
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
    sweepPixelsFill(pixels.Color(0, 140, 0));
    restorePixelsFromDrawState();
  } else if (msg == "beat_hit hit") {
    playHaptic(HAPTIC_TICK);
  } else if (msg == "beat_hit missed") {
    playHaptic(HAPTIC_SOFT_BUMP);
  }
}

bool connectToNetwork() {
  int attempts = 0;
  WiFi.begin(SECRET_SSID, SECRET_PASS);
  while (WiFi.status() != WL_CONNECTED && attempts < 20) {
    Serial.println("WiFi intentando...");
    delay(1000);
    attempts++;
  }
  if (WiFi.status() == WL_CONNECTED) {
    Serial.println("WiFi OK");
    Serial.print("Arduino IP: ");
    Serial.println(WiFi.localIP());
    return true;
  }
  Serial.println("WiFi FALLO");
  return false;
}

void setup() {
  Serial.begin(115200);
  delay(500);

  pinMode(DRAW_BTN_PIN, INPUT_PULLUP);
  pinMode(CLICK_BTN_PIN, INPUT_PULLUP);

  pixels.begin();
  pixels.setBrightness(55);
  clearPixels();

  if (!connectToNetwork()) {
    while (true) {
      setStatusPixel(pixels.Color(180, 0, 0));
      delay(120);
      clearStatusPixel();
      delay(120);
    }
  }

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
        blinkAllPixelsOnce(pixels.Color(255, 255, 255));
        pulseClick();
      }
    }
  }
  lastClickBtnState = clickReading;

  if (now - lastSendMs >= SEND_INTERVAL) {
    lastSendMs = now;
    if (imuReady) {
      if (IMU.accelerationAvailable()) IMU.readAcceleration(ax, ay, az);
      if (IMU.gyroscopeAvailable()) IMU.readGyroscope(gx, gy, gz);
    }
    int potRaw = analogRead(POT_PIN);
    sensitivity = map(potRaw, 0, 1023, 1, 10);
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
