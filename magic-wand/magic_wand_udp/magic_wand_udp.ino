#include <Wire.h>
#include <MPU6050.h>          // by Electronic Cats (or jrowberg) — install via Library Manager
#include <WiFi.h>
#include <WiFiUdp.h>
#include <NTPClient.h>
#include <ArduinoMqttClient.h>
#include "arduino_secrets.h"
WiFiUDP udp;

IPAddress serverIp(10, 23, 10, 70);  // your computer IP
const unsigned int serverUdpPort = 4210;

// ================= PIN MAP (Xiao ESP32-C6) =================
// D0  → Potentiometer wiper (analog sensitivity)
// D1  → Draw button  (INPUT_PULLUP, active LOW)
// D2  → Click button (INPUT_PULLUP, active LOW)
// D3  → Optional status LED (or INT from IMU)
// D4  → IMU SDA (I2C)
// D5  → IMU SCL (I2C)

const int POT_PIN       = D0;
const int DRAW_BTN_PIN  = D1;
const int CLICK_BTN_PIN = D2;
const int STATUS_LED    = D3;   // wire an LED + 330Ω to GND, or remove if unused

// ================= WIFI + MQTT =================
WiFiClient wifiClient;
MqttClient mqttClient(wifiClient);
WiFiUDP    ntpUDP;
NTPClient  timeClient(ntpUDP, "pool.ntp.org", 0, 60000);

// ================= IMU =================
MPU6050 imu;
float ax, ay, az, gx, gy, gz;

// ================= MQTT =================
const char broker[]        = "public.cloud.shiftr.io";
const int  port            = 1883;
const char topic[]         = "kezia/imu/data";
String     clientID        = "keziaIMU_";
const String deviceName    = "kezia";

// ================= TIMING =================
const unsigned long SEND_INTERVAL  = 200;
const unsigned long DEBOUNCE_DELAY = 50;
unsigned long lastMqttSend         = 0;

// ================= BUTTONS =================
int  drawState         = LOW;
int  drawBtnState      = HIGH, lastDrawBtnState = HIGH;
unsigned long lastDrawDebounce = 0;

int  clickBtnState     = HIGH, lastClickBtnState = HIGH;
unsigned long lastClickDebounce = 0;

// ================= SENSITIVITY =================
int sensitivity = 5;

// ================= NTP =================
bool ntpBegun   = false;
bool ntpStarted = false;
unsigned long lastNtpAttempt = 0;

// =========================================
// DEBUG BLINK (single LED on D3)
// =========================================
void blinkSuccess() {
  mqttClient.poll();
  digitalWrite(STATUS_LED, HIGH); delay(200);
  digitalWrite(STATUS_LED, LOW);  delay(200);
}

void blinkFail() {
  for (int i = 0; i < 5; i++) {
    mqttClient.poll();
    digitalWrite(STATUS_LED, HIGH); delay(80);
    digitalWrite(STATUS_LED, LOW);  delay(80);
  }
}

void hangWithBlink(const char* label) {
  Serial.print("COLGADO: "); Serial.println(label);
  while (true) {
    blinkFail();
    delay(1000);
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
  pinMode(STATUS_LED,    OUTPUT);
  digitalWrite(STATUS_LED, LOW);

  // ------ TEST 0: WiFi ------
  bool wifiOk = connectToNetwork();
  wifiOk ? blinkSuccess() : blinkFail();
  if (!wifiOk) hangWithBlink("WiFi");

  // Build unique client ID from MAC
  uint8_t mac[6];
  WiFi.macAddress(mac);
  for (int i = 0; i < 3; i++) clientID += String(mac[i], HEX);

  // ------ TEST 1: MQTT ------
  mqttClient.setId(clientID);
  mqttClient.setUsernamePassword(SECRET_MQTT_USER, SECRET_MQTT_PASS);
  mqttClient.setKeepAliveInterval(6000);

  bool mqttOk = connectToBroker();
  mqttOk ? blinkSuccess() : blinkFail();
  if (!mqttOk) hangWithBlink("MQTT");

  // ------ TEST 2: IMU ------
  // ESP32-C6 default I2C: SDA=D4, SCL=D5
  Wire.begin(D4, D5);
  imu.initialize();

  bool imuOk = imu.testConnection();
  imuOk ? blinkSuccess() : blinkFail();
  if (!imuOk) hangWithBlink("IMU");

  // ------ TEST 3: MQTT send test ------
  mqttClient.poll();
  mqttClient.beginMessage("kezia/test");
  mqttClient.print("ok");
  int result = mqttClient.endMessage();

  result == 1 ? blinkSuccess() : blinkFail();
  if (result != 1) hangWithBlink("MQTT send");

  Serial.println("Setup completo.");
}

// =========================================
// LOOP
// =========================================
void loop() {
  mqttClient.poll();
  unsigned long now = millis();

  // NTP: start once
  if (!ntpBegun) {
    timeClient.begin();
    ntpBegun = true;
  }

  // MQTT: reconnect if dropped
  if (!mqttClient.connected()) {
    connectToBroker();
  }

  // NTP: sync every 10 s until successful
  if (!ntpStarted && now - lastNtpAttempt > 10000) {
    lastNtpAttempt = now;
    if (timeClient.forceUpdate()) {
      ntpStarted = true;
      Serial.println("NTP OK");
    }
  }

  // ====== DRAW BUTTON ======
  int drawReading = digitalRead(DRAW_BTN_PIN);
  if (drawReading != lastDrawBtnState) lastDrawDebounce = now;

  if (now - lastDrawDebounce > DEBOUNCE_DELAY) {
    if (drawReading != drawBtnState) {
      drawBtnState = drawReading;
      if (drawBtnState == LOW) {          // pressed
        drawState = !drawState;
        animateLED();
        pulseDraw();
      }
    }
  }
  lastDrawBtnState = drawReading;

  // Status LED mirrors draw state
  digitalWrite(STATUS_LED, drawState);

  // ====== CLICK BUTTON (only when drawing) ======
  if (drawState) {
    int clickReading = digitalRead(CLICK_BTN_PIN);
    if (clickReading != lastClickBtnState) lastClickDebounce = now;

    if (now - lastClickDebounce > DEBOUNCE_DELAY) {
      if (clickReading != clickBtnState) {
        clickBtnState = clickReading;
        if (clickBtnState == LOW) {       // pressed
          blinkLED(3);
          pulseClick();
        }
      }
    }
    lastClickBtnState = clickReading;
  }

  // ====== SENSOR + MQTT ======
  if (now - lastMqttSend >= SEND_INTERVAL) {
    lastMqttSend = now;

    readIMU();

    // Potentiometer: 12-bit (0–4095) → sensitivity 1–10
    int potRaw = analogRead(POT_PIN);
    sensitivity = map(potRaw, 0, 4095, 1, 10);

    if (mqttClient.connected()) {
      publishMqtt();
      // Quick status flash without blocking
      digitalWrite(STATUS_LED, HIGH);
      static unsigned long ledOnAt = 0;
      ledOnAt = now;
      // Turn off after 30 ms on next loop pass
      if (now - ledOnAt > 30) digitalWrite(STATUS_LED, drawState);
    }
  }
}

// =========================================
// IMU READ
// =========================================
void readIMU() {
  int16_t rawAx, rawAy, rawAz, rawGx, rawGy, rawGz;
  imu.getMotion6(&rawAx, &rawAy, &rawAz, &rawGx, &rawGy, &rawGz);

  // Convert to g (±2g range, 16384 LSB/g) and °/s (±250°/s, 131 LSB/°/s)
  ax = rawAx / 16384.0f;
  ay = rawAy / 16384.0f;
  az = rawAz / 16384.0f;
  gx = rawGx / 131.0f;
  gy = rawGy / 131.0f;
  gz = rawGz / 131.0f;
}

// =========================================
// LED HELPERS
// =========================================
void animateLED() {
  for (int i = 0; i < 3; i++) {
    digitalWrite(STATUS_LED, HIGH); delay(80);
    digitalWrite(STATUS_LED, LOW);  delay(80);
  }
}

void blinkLED(int times) {
  for (int i = 0; i < times; i++) {
    digitalWrite(STATUS_LED, HIGH); delay(80);
    digitalWrite(STATUS_LED, LOW);  delay(80);
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
// MQTT PUBLISH
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

// replace fn with publishMessage
void publishMqtt() {
  String msg = "";

  msg += "{\"path\":\"kezia/imu/data\",\"data\":";
  msg += "{\"device\":\"";
  msg += deviceName;
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