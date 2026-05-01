#include <Wire.h>
#include <Adafruit_MPU6050.h>
#include <Adafruit_Sensor.h>
#include <WiFi.h>
#include <WiFiUdp.h>
#include <NTPClient.h>
#include <ArduinoMqttClient.h>
#include "arduino_secrets.h"
#include "Adafruit_DRV2605.h"
#include <Adafruit_NeoPixel.h>

// ================= PORTABLE PIN FALLBACKS =================
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

// ================= PIN MAP =================
const int POT_PIN       = D0;
const int DRAW_BTN_PIN  = D1;
const int CLICK_BTN_PIN = D2;

// ================= NEOPIXELS =================
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

// ================= MQTT TOPICS =================
const char broker[]          = "public.cloud.shiftr.io";
const int  mqttPort          = 1883;
const char topicData[]       = "kezia/imu/data";
const char topicDraw[]       = "kezia/imu/draw";
const char topicClick[]      = "kezia/imu/click";
const char topicPower[]      = "kezia/imu/power";
const char topicFeedback[]   = "kezia/imu/feedback";
String     clientID          = "keziaIMU_";
const String deviceName      = "kezia";

// ================= TIMING =================
const unsigned long SEND_INTERVAL      = 200;
const unsigned long DEBOUNCE_DELAY     = 50;
const unsigned long DRAW_SYNC_INTERVAL = 1000;
unsigned long lastSendMs               = 0;
unsigned long lastDrawSyncSend         = 0;
unsigned long lastNtpAttempt           = 0;

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

// ================= NTP =================
bool ntpBegun   = false;
bool ntpStarted = false;

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

// =========================================
// INBOUND MQTT FEEDBACK
// =========================================
void handleFeedbackMessage(const String& msgRaw) {
  String msg = msgRaw;
  msg.trim();
  msg.toLowerCase();

  if (msg == "hover" || msg.indexOf("\"type\":\"hover\"") >= 0) {
    playHaptic(HAPTIC_TICK);
  }
  else if (msg == "click" || msg.indexOf("\"type\":\"click\"") >= 0) {
    playHaptic(HAPTIC_CLICK);
  }
  else if (msg == "beat_hit perfect" ||
           (msg.indexOf("\"type\":\"beat_hit\"") >= 0 && msg.indexOf("\"state\":\"perfect\"") >= 0)) {
    if (!chaseRunning) {
      playHaptic2(HAPTIC_RAMP_UP, HAPTIC_DOUBLE);
      sweepPixelsFill(pixels.Color(0, 140, 0));
      restorePixelsFromDrawState();
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

void handleInboundMqtt() {
  int messageSize = mqttClient.parseMessage();
  if (messageSize <= 0) return;

  String topicName = mqttClient.messageTopic();
  String payload = "";
  while (mqttClient.available()) payload += (char)mqttClient.read();

  Serial.print("MQTT in [");
  Serial.print(topicName);
  Serial.print("]: ");
  Serial.println(payload);

  if (topicName == String(topicFeedback)) {
    handleFeedbackMessage(payload);
  }
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
// NETWORK
// =========================================
bool connectToNetwork() {
  WiFi.mode(WIFI_STA);
  WiFi.setSleep(false);
  WiFi.begin(SECRET_SSID, SECRET_PASS);
  int attempts = 0;
  while (WiFi.status() != WL_CONNECTED && attempts < 20) {
    Serial.println("WiFi intentando...");
    delay(1000);
    attempts++;
  }
  if (WiFi.status() == WL_CONNECTED) {
    Serial.println("WiFi OK");
    Serial.print("IP: ");
    Serial.println(WiFi.localIP());
    return true;
  }
  Serial.println("WiFi FALLO");
  return false;
}

bool connectToBroker() {
  Serial.println("Conectando a broker...");
  mqttClient.setId(clientID);
  mqttClient.setUsernamePassword(SECRET_MQTT_USER, SECRET_MQTT_PASS);
  mqttClient.setKeepAliveInterval(6000);

  mqttClient.beginWill(topicPower, true, 0);
  mqttClient.print("{\"power\":false}");
  mqttClient.endWill();

  if (!mqttClient.connect(broker, mqttPort)) {
    Serial.print("MQTT error: ");
    Serial.println(mqttClient.connectError());
    return false;
  }
  Serial.println("Broker OK");

  if (!mqttClient.subscribe(topicFeedback)) {
    Serial.println("Feedback subscribe failed");
  } else {
    Serial.println("Feedback subscribe OK");
  }
  return true;
}

// =========================================
// MQTT PUBLISH HELPERS
// =========================================
void publishPower(bool on) {
  if (!mqttClient.connected()) return;
  mqttClient.beginMessage(topicPower);
  mqttClient.print(on ? "{\"power\":true}" : "{\"power\":false}");
  mqttClient.endMessage();
}

void pulseClick() {
  if (!mqttClient.connected()) return;
  mqttClient.beginMessage(topicClick);
  mqttClient.print("true");
  mqttClient.endMessage();
  Serial.println("CLICK MQTT!");
}

void pulseDraw() {
  if (!mqttClient.connected()) return;
  mqttClient.beginMessage(topicDraw);
  mqttClient.print(drawState ? "\"start\"" : "\"stop\"");
  mqttClient.endMessage();
  Serial.print("DRAW MQTT: ");
  Serial.println(drawState ? "start" : "stop");
}

void publishMqtt() {
  if (!mqttClient.connected()) return;

  mqttClient.beginMessage(topicData);
  mqttClient.print("{\"device\":\"");
  mqttClient.print(deviceName);
  mqttClient.print("\",\"draw\":\"");
  mqttClient.print(drawState ? "start" : "stop");
  mqttClient.print("\",\"sensor\":{");
  mqttClient.print("\"ax\":"); mqttClient.print(ax, 4); mqttClient.print(",");
  mqttClient.print("\"ay\":"); mqttClient.print(ay, 4); mqttClient.print(",");
  mqttClient.print("\"az\":"); mqttClient.print(az, 4); mqttClient.print(",");
  mqttClient.print("\"gx\":"); mqttClient.print(gx, 4); mqttClient.print(",");
  mqttClient.print("\"gy\":"); mqttClient.print(gy, 4); mqttClient.print(",");
  mqttClient.print("\"gz\":"); mqttClient.print(gz, 4); mqttClient.print(",");
  mqttClient.print("\"sensitivity\":"); mqttClient.print(sensitivity);
  mqttClient.print(",\"timestamp\":");
  if (ntpStarted) {
    unsigned long long tsMs =
      (unsigned long long)timeClient.getEpochTime() * 1000ULL + (millis() % 1000);
    mqttClient.print((unsigned long)tsMs);
  } else {
    mqttClient.print(millis());
  }
  mqttClient.print("}}");
  mqttClient.endMessage();
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
    clearStatusPixel();                        delay(80);
  }
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

  uint8_t mac[6];
  WiFi.macAddress(mac);
  for (int i = 0; i < 3; i++) clientID += String(mac[i], HEX);

  bool mqttOk = connectToBroker();
  mqttOk ? blinkSuccess() : blinkFail();
  if (!mqttOk) hangWithBlink("MQTT");

  Wire.begin();
  if (imu.begin()) {
    imuReady = true;
    imu.setAccelerometerRange(MPU6050_RANGE_2_G);
    imu.setGyroRange(MPU6050_RANGE_250_DEG);
    imu.setFilterBandwidth(MPU6050_BAND_21_HZ);
    Serial.println("MPU6050 OK");
    blinkSuccess();
  } else {
    Serial.println("MPU6050 failed — continuing without IMU");
    blinkFail();
  }

  if (!drv.begin()) {
    Serial.println("DRV2605 not found — skipping haptics");
  } else {
    drvReady = true;
    drv.selectLibrary(1);
    drv.setMode(DRV2605_MODE_INTTRIG);
    drv.useERM();
    Serial.println("DRV2605 OK");
  }

  publishPower(true);
  pulseDraw();

  Serial.println("Setup completo.");
  playHaptic(HAPTIC_TICK);
  clearPixels();
}

// =========================================
// LOOP
// =========================================
void loop() {
  mqttClient.poll();
  handleInboundMqtt();

  unsigned long now = millis();

  if (!ntpBegun) {
    timeClient.begin();
    ntpBegun = true;
  }

  if (!mqttClient.connected()) {
    if (connectToBroker()) {
      publishPower(true);
      pulseDraw();
    }
  }

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

  // ===== SENSOR + MQTT SEND =====
  if (now - lastSendMs >= SEND_INTERVAL) {
    lastSendMs = now;
    readIMU();
    int potRaw = analogRead(POT_PIN);
    sensitivity = map(potRaw, 0, 4095, 1, 10);
    publishMqtt();
  }

  // Keep draw sync only when chase not running
  if (!chaseRunning && drawState && (now - lastDrawSyncSend >= DRAW_SYNC_INTERVAL)) {
    lastDrawSyncSend = now;
    pulseDraw();
  }
}
