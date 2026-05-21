#include <Wire.h>
#include <Adafruit_MPU6050.h>
#include <Adafruit_Sensor.h>
#include <WiFiUdp.h>
#include <Wifi.h>
#include <NTPClient.h>
#include <ArduinoMqttClient.h>
#include "arduino_secrets.h"
#include "Adafruit_DRV2605.h"
#include <Adafruit_NeoPixel.h>

// ================= PORTABLE PIN FALLBACKS =================
// Some board cores do not define D0/D1/... aliases (they only expose A0/A1/...).
// These fallbacks keep the sketch compiling across XIAO/Nano-like cores.
#ifndef D0
  #ifdef A0
    #define D0 A0
  #else
    #define D0 0
  #endif
#endif
#ifndef D1
  #ifdef A1
    #define D1 A1
  #else
    #define D1 1
  #endif
#endif
#ifndef D2
  #ifdef A2
    #define D2 A2
  #else
    #define D2 2
  #endif
#endif
#ifndef D4
  #ifdef SDA
    #define D4 SDA
  #else
    #define D4 4
  #endif
#endif
#ifndef D5
  #ifdef SCL
    #define D5 SCL
  #else
    #define D5 5
  #endif
#endif
#ifndef D6
  #ifdef PIN_NEOPIXEL
    #define D6 PIN_NEOPIXEL
  #else
    #define D6 16
  #endif
#endif

// ================= UDP =================
WiFiUDP udp;

IPAddress serverIp(10, 23, 11, 207);
const unsigned int serverUdpPort = 4210;
const unsigned int localUdpPort  = 4211;

char incomingPacket[80];

// ================= PIN MAP =================
const int POT_PIN       = D0;
const int DRAW_BTN_PIN  = D1;
const int CLICK_BTN_PIN = D2;

// ================= NEOPIXELS =================
// Daisy-chain strip: one data pin, 5 pixels in series.
#define NEOPIXEL_PIN D6
#define STAR_LED_COUNT 5
#define STATUS_PIXEL_INDEX 0

Adafruit_NeoPixel pixels(STAR_LED_COUNT, NEOPIXEL_PIN, NEO_GRB + NEO_KHZ800);

// ================= CHASE STATE =================
bool chaseRunning           = false;
int  chaseIndex             = 0;
unsigned long lastChaseStep = 0;
const unsigned long CHASE_MS = 200;
bool preChaseDrawState      = false;

// ================= WIFI + MQTT =================
WiFiClient wifiClient;
MqttClient mqttClient(wifiClient);
WiFiUDP    ntpUDP;
NTPClient  timeClient(ntpUDP, "pool.ntp.org", 0, 60000);

// ================= IMU =================
Adafruit_MPU6050 imu;
bool imuReady = false;
float ax, ay, az, gx, gy, gz;

// ================= MQTT =================
const char broker[]     = "public.cloud.shiftr.io";
const int  port         = 1883;
const char topic[]      = "kezia/imu/data";
String     clientID     = "keziaIMU_";
const String deviceName = "kezia";

// ================= TIMING =================
const unsigned long SEND_INTERVAL      = 200;
const unsigned long DEBOUNCE_DELAY     = 50;
const unsigned long DRAW_SYNC_INTERVAL = 1000;
unsigned long lastMqttSend             = 0;
unsigned long lastDrawSyncSend         = 0;

// ================= BUTTONS =================
int drawState        = LOW;

int drawBtnState     = HIGH;
int lastDrawBtnState = HIGH;
unsigned long lastDrawDebounce = 0;

int clickBtnState     = HIGH;
int lastClickBtnState = HIGH;
unsigned long lastClickDebounce = 0;

// ================= SENSITIVITY =================
int sensitivity = 5;
int potMinSeen = 4095;
int potMaxSeen = 0;
const int POT_MIN_SPAN = 64;

int normalizePotToSensitivity(int potRaw) {
  if (potRaw < potMinSeen) potMinSeen = potRaw;
  if (potRaw > potMaxSeen) potMaxSeen = potRaw;

  const int span = potMaxSeen - potMinSeen;
  if (span < POT_MIN_SPAN) return sensitivity;

  const int mapped = map(potRaw, potMinSeen, potMaxSeen, 1, 10);
  return constrain(mapped, 1, 10);
}

// ================= NTP =================
bool ntpBegun   = false;
bool ntpStarted = false;
unsigned long lastNtpAttempt = 0;

// ================= HAPTICS =================
Adafruit_DRV2605 drv;
bool drvReady = false;

#define HAPTIC_TICK      3
#define HAPTIC_CLICK     1
#define HAPTIC_DOUBLE    10
#define HAPTIC_SOFT_BUMP 14
#define HAPTIC_BUZZ      16
#define HAPTIC_RAMP_UP   47
#define HAPTIC_RAMP_DOWN 48
#define HAPTIC_ALERT     58

// =========================================
// PIXEL HELPERS
// =========================================
void showAllPixels(uint32_t color) {
  for (int i = 0; i < STAR_LED_COUNT; i++) {
    pixels.setPixelColor(i, color);
  }
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
  else           clearPixels();
}

void blinkPixelsOneByOne(uint32_t color, int onMs = 85, int offMs = 45) {
  for (int i = 0; i < STAR_LED_COUNT; i++) {
    clearPixels();
    pixels.setPixelColor(i, color);
    pixels.show();
    delay(onMs);
    pixels.setPixelColor(i, 0);
    pixels.show();
    delay(offMs);
  }
}

void sweepPixelsFill(uint32_t color, int stepMs = 55) {
  clearPixels();
  for (int i = 0; i < STAR_LED_COUNT; i++) {
    pixels.setPixelColor(i, color);
    pixels.show();
    delay(stepMs);
  }
}

void applyDrawPixelState(bool isDrawing) {
  const uint32_t animColor   = pixels.Color(90, 60, 30);
  const uint32_t drawOnColor = pixels.Color(180, 0, 120);
  blinkPixelsOneByOne(animColor);
  if (isDrawing) showAllPixels(drawOnColor);
  else           clearPixels();
}

void blinkAllPixelsOnce(uint32_t color, int onMs = 80, int offMs = 80) {
  showAllPixels(color);
  delay(onMs);
  clearPixels();
  delay(offMs);
  restorePixelsFromDrawState();
}

// =========================================
// CHASE HELPERS
// =========================================
void startChase() {
  preChaseDrawState = drawState;

  for (int i = 0; i < 3; i++) {
    showAllPixels(pixels.Color(255, 255, 255));
    delay(150);
    clearPixels();
    delay(150);
  }

  chaseRunning  = true;
  chaseIndex    = 0;
  lastChaseStep = millis();
}

void stopChase() {
  chaseRunning = false;
  clearPixels();
  drawState = preChaseDrawState;
  restorePixelsFromDrawState();
}

void updateChase() {
  if (!chaseRunning) return;

  unsigned long now = millis();
  if (now - lastChaseStep < CHASE_MS) return;
  lastChaseStep = now;

  for (int i = 0; i < STAR_LED_COUNT; i++) {
    pixels.setPixelColor(i, i == chaseIndex ? pixels.Color(0, 200, 255) : 0);
  }
  pixels.show();

  chaseIndex = (chaseIndex + 1) % STAR_LED_COUNT;
}

// =========================================
// HAPTIC HELPERS
// =========================================
void playHaptic(int effect) {
  if (!drvReady) return;
  drv.setWaveform(0, effect);
  drv.setWaveform(1, 0);
  drv.go();
}

void playHaptic2(int effect1, int effect2) {
  if (!drvReady) return;
  drv.setWaveform(0, effect1);
  drv.setWaveform(1, effect2);
  drv.setWaveform(2, 0);
  drv.go();
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
  }
  else if (msg == "click") {
    playHaptic(HAPTIC_CLICK);
  }
  else if (msg == "beat_hit perfect") {
    if (!chaseRunning) {
      playHaptic2(HAPTIC_RAMP_UP, HAPTIC_DOUBLE);
      sweepPixelsFill(pixels.Color(0, 140, 0));
      if (drawState) showAllPixels(pixels.Color(180, 0, 120));
      else           clearPixels();
    } else {
      playHaptic2(HAPTIC_RAMP_UP, HAPTIC_DOUBLE);
    }
  }
  else if (msg == "beat_hit hit" || msg == "beat_hit ok" ||
         (msg.indexOf("\"type\":\"beat_hit\"") >= 0 && 
          (msg.indexOf("\"state\":\"hit\"") >= 0 || msg.indexOf("\"state\":\"ok\"") >= 0))) {
      playHaptic(HAPTIC_TICK);
      sweepPixelsFill(pixels.Color(255, 210, 0));
      restorePixelsFromDrawState();
  }
  // else if (msg == "beat_hit missed" ||
  //          (msg.indexOf("\"type\":\"beat_hit\"") >= 0 && msg.indexOf("\"state\":\"missed\"") >= 0)) {
  //   playHaptic(HAPTIC_SOFT_BUMP);
  // }
}

// =========================================
// DEBUG BLINK
// =========================================
void blinkSuccess() {
  mqttClient.poll();
  setStatusPixel(pixels.Color(0, 0, 180));
  delay(200);
  clearStatusPixel();
  delay(200);
}

void blinkFail() {
  for (int i = 0; i < 5; i++) {
    mqttClient.poll();
    setStatusPixel(pixels.Color(180, 0, 0));
    delay(80);
    clearStatusPixel();
    delay(80);
  }
}

void hangWithBlink(const char* label) {
  Serial.print("COLGADO: ");
  Serial.println(label);
  while (true) { blinkFail(); delay(1000); }
}

// =========================================
// SETUP
// =========================================
void setup() {
  Serial.begin(115200);
  delay(500);

  pinMode(DRAW_BTN_PIN,  INPUT_PULLUP);
  pinMode(CLICK_BTN_PIN, INPUT_PULLUP);

  pixels.begin();
  pixels.setBrightness(55);
  clearPixels();

  bool wifiOk = connectToNetwork();
  wifiOk ? blinkSuccess() : blinkFail();
  if (!wifiOk) hangWithBlink("WiFi");

  udp.begin(localUdpPort);
  Serial.print("Arduino UDP listening on port ");
  Serial.println(localUdpPort);

  uint8_t mac[6];
  WiFi.macAddress(mac);
  for (int i = 0; i < 3; i++) clientID += String(mac[i], HEX);

  mqttClient.setId(clientID);
  mqttClient.setUsernamePassword(SECRET_MQTT_USER, SECRET_MQTT_PASS);
  mqttClient.setKeepAliveInterval(6000);

  bool mqttOk = connectToBroker();
  mqttOk ? blinkSuccess() : blinkFail();
  if (!mqttOk) hangWithBlink("MQTT");

  Wire.begin();  // use board default pins
if (imu.begin()) {
  imuReady = true;
  imu.setAccelerometerRange(MPU6050_RANGE_2_G);
  imu.setGyroRange(MPU6050_RANGE_250_DEG);
  imu.setFilterBandwidth(MPU6050_BAND_21_HZ);
  blinkSuccess();
} else {
  Serial.println("MPU6050 failed — check wiring");
  blinkFail();
  // remove hangWithBlink so it continues without IMU
}


  mqttClient.poll();
  mqttClient.beginMessage("kezia/test");
  mqttClient.print("ok");
  int result = mqttClient.endMessage();

  result == 1 ? blinkSuccess() : blinkFail();
  if (result != 1) hangWithBlink("MQTT send");

  if (!drv.begin()) {
    Serial.println("HAPTICS DRV2605 not found — skipping");
  } else {
    drvReady = true;
    drv.selectLibrary(1);
    drv.setMode(DRV2605_MODE_INTTRIG);
    drv.useERM();
  }
  
  Serial.println("Setup completo.");
  playHaptic(HAPTIC_TICK);
  clearPixels();
}

// =========================================
// LOOP
// =========================================
void loop() {
  mqttClient.poll();
  checkUdpFeedback();

  unsigned long now = millis();

  if (!ntpBegun) {
    timeClient.begin();
    ntpBegun = true;
  }

  if (!mqttClient.connected()) connectToBroker();

  if (!ntpStarted && now - lastNtpAttempt > 10000) {
    lastNtpAttempt = now;
    if (timeClient.forceUpdate()) {
      ntpStarted = true;
      Serial.println("NTP OK");
    }
  }

  // ===== DRAW BUTTON (D1) — also chase toggle =====
  int drawReading = digitalRead(DRAW_BTN_PIN);

  if (drawReading != lastDrawBtnState) lastDrawDebounce = now;

  if (now - lastDrawDebounce > DEBOUNCE_DELAY) {
    if (drawReading != drawBtnState) {
      drawBtnState = drawReading;

      if (drawBtnState == LOW) {
        if (chaseRunning) {
          stopChase();
        } else {
          drawState = !drawState;
          pulseDraw();
          animateLED();
          startChase();
        }
      }
    }
  }

  lastDrawBtnState = drawReading;

  // ===== CLICK BUTTON (D2) =====
  int clickReading = digitalRead(CLICK_BTN_PIN);

  if (clickReading != lastClickBtnState) lastClickDebounce = now;

  if (now - lastClickDebounce > DEBOUNCE_DELAY) {
    if (clickReading != clickBtnState) {
      clickBtnState = clickReading;

      if (clickBtnState == LOW) {
        if (!chaseRunning) blinkAllPixelsOnce(pixels.Color(255, 255, 255));
        pulseClick();
      }
    }
  }

  lastClickBtnState = clickReading;

  // ===== CHASE (non-blocking) =====
  updateChase();

  // ===== SENSOR + UDP SEND =====
  if (now - lastMqttSend >= SEND_INTERVAL) {
    lastMqttSend = now;
    readIMU();
    int potRaw = analogRead(POT_PIN);
    sensitivity = normalizePotToSensitivity(potRaw);
    publishMqtt();
  }

  // Keep draw sync only when chase not running
  if (!chaseRunning && drawState && (now - lastDrawSyncSend >= DRAW_SYNC_INTERVAL)) {
    lastDrawSyncSend = now;
    pulseDraw();
  }
}

// =========================================
// IMU READ
// =========================================
void readIMU() {
  if (!imuReady) return;
  sensors_event_t a, g, temp;
  imu.getEvent(&a, &g, &temp);
  ax = a.acceleration.x / 9.81;
  ay = a.acceleration.y / 9.81;
  az = a.acceleration.z / 9.81;
  gx = g.gyro.x * (180.0 / PI);
  gy = g.gyro.y * (180.0 / PI);
  gz = g.gyro.z * (180.0 / PI);
}

// =========================================
// LED HELPERS
// =========================================
void animateLED() {
  for (int i = 0; i < 3; i++) {
    setStatusPixel(pixels.Color(180, 0, 120)); delay(80);
    clearStatusPixel();                            delay(80);
  }
}

// =========================================
// NETWORK
// =========================================
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

bool connectToBroker() {
  Serial.println("Conectando a broker...");
  mqttClient.beginWill("kezia/imu/power", true, 0);
  mqttClient.print("{\"power\":false}");
  mqttClient.endWill();
  if (!mqttClient.connect(broker, port)) {
    Serial.print("MQTT error: ");
    Serial.println(mqttClient.connectError());
    return false;
  }
  Serial.println("Broker OK");
  return true;
}

// =========================================
// UDP SEND EVENTS
// =========================================
void pulseClick() {
  String msg = "{\"path\":\"kezia/imu/click\",\"data\":true}";
  udp.beginPacket(serverIp, serverUdpPort);
  udp.print(msg);
  udp.endPacket();
  Serial.println("CLICK UDP!");
}

void pulseDraw() {
  String state = drawState ? "start" : "stop";
  String msg = "{\"path\":\"kezia/imu/draw\",\"data\":\"";
  msg += state;
  msg += "\"}";
  udp.beginPacket(serverIp, serverUdpPort);
  udp.print(msg);
  udp.endPacket();
  Serial.print("DRAW UDP: ");
  Serial.println(state);
}

void publishMqtt() {
  String msg = "";
  msg += "{\"path\":\"kezia/imu/data\",\"data\":";
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
  udp.beginPacket(serverIp, serverUdpPort);
  udp.print(msg);
  udp.endPacket();
  Serial.println(msg);
}
