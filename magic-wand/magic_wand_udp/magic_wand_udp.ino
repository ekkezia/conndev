#include <Wire.h>
#include <MPU6050.h>
#include <WiFi.h>
#include <WiFiUdp.h>
#include <NTPClient.h>
#include <ArduinoMqttClient.h>
#include "arduino_secrets.h"
#include "Adafruit_DRV2605.h"

// ================= UDP =================
WiFiUDP udp;

IPAddress serverIp(10, 23, 10, 70);   // your computer IP
const unsigned int serverUdpPort = 4210;
const unsigned int localUdpPort  = 4211; // Arduino listens here for beat feedback

char incomingPacket[80];

// ================= PIN MAP =================
const int POT_PIN       = D0;
const int DRAW_BTN_PIN  = D1;
const int CLICK_BTN_PIN = D2;
const int STATUS_LED    = D3;

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
int drawState = LOW;

int drawBtnState = HIGH;
int lastDrawBtnState = HIGH;
unsigned long lastDrawDebounce = 0;

int clickBtnState = HIGH;
int lastClickBtnState = HIGH;
unsigned long lastClickDebounce = 0;

// ================= SENSITIVITY =================
int sensitivity = 5;

// ================= NTP =================
bool ntpBegun = false;
bool ntpStarted = false;
unsigned long lastNtpAttempt = 0;

// ================= HAPTICS =================
Adafruit_DRV2605 drv;

#define HAPTIC_TICK       3
#define HAPTIC_CLICK      1
#define HAPTIC_DOUBLE     10
#define HAPTIC_SOFT_BUMP  14
#define HAPTIC_BUZZ       16
#define HAPTIC_RAMP_UP    47
#define HAPTIC_RAMP_DOWN  48
#define HAPTIC_ALERT      58

// =========================================
// HAPTIC HELPERS
// =========================================
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
    playHaptic2(HAPTIC_RAMP_UP, HAPTIC_DOUBLE);
  }
  else if (msg == "beat_hit hit") {
    playHaptic(HAPTIC_TICK);
  }
  // else if (msg == "beat_hit missed") {
  //   playHaptic(HAPTIC_SOFT_BUMP); 
  //}
}

// =========================================
// DEBUG BLINK
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
  Serial.print("COLGADO: ");
  Serial.println(label);

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

  pinMode(DRAW_BTN_PIN, INPUT_PULLUP);
  pinMode(CLICK_BTN_PIN, INPUT_PULLUP);
  pinMode(STATUS_LED, OUTPUT);
  digitalWrite(STATUS_LED, LOW);

  bool wifiOk = connectToNetwork();
  wifiOk ? blinkSuccess() : blinkFail();
  if (!wifiOk) hangWithBlink("WiFi");

  // Start UDP listener after WiFi
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

  Wire.begin(D4, D5);
  imu.initialize();

  bool imuOk = imu.testConnection();
  imuOk ? blinkSuccess() : blinkFail();
  if (!imuOk) hangWithBlink("IMU");

  mqttClient.poll();
  mqttClient.beginMessage("kezia/test");
  mqttClient.print("ok");
  int result = mqttClient.endMessage();

  result == 1 ? blinkSuccess() : blinkFail();
  if (result != 1) hangWithBlink("MQTT send");

  if (!drv.begin()) {
    Serial.println("HAPTICS DRV2605 not found");
    while (1);
  }

  drv.selectLibrary(1);
  drv.setMode(DRV2605_MODE_INTTRIG);
  drv.useERM(); // use this for normal coin vibration motor

  Serial.println("Setup completo.");

  playHaptic(HAPTIC_TICK);
}

// =========================================
// LOOP
// =========================================
void loop() {
  mqttClient.poll();

  // Listen for server feedback: beat_hit perfect / hit / missed
  checkUdpFeedback();

  unsigned long now = millis();

  if (!ntpBegun) {
    timeClient.begin();
    ntpBegun = true;
  }

  if (!mqttClient.connected()) {
    connectToBroker();
    // no reconnect buzz
  }

  if (!ntpStarted && now - lastNtpAttempt > 10000) {
    lastNtpAttempt = now;

    if (timeClient.forceUpdate()) {
      ntpStarted = true;
      Serial.println("NTP OK");
    }
  }

  // ===== DRAW BUTTON =====
  int drawReading = digitalRead(DRAW_BTN_PIN);

  if (drawReading != lastDrawBtnState) {
    lastDrawDebounce = now;
  }

  if (now - lastDrawDebounce > DEBOUNCE_DELAY) {
    if (drawReading != drawBtnState) {
      drawBtnState = drawReading;

      if (drawBtnState == LOW) {
        drawState = !drawState;
        animateLED();
        pulseDraw();
      }
    }
  }

  lastDrawBtnState = drawReading;

  digitalWrite(STATUS_LED, drawState);

  // ===== CLICK BUTTON ONLY WHEN DRAWING =====
  if (drawState) {
    int clickReading = digitalRead(CLICK_BTN_PIN);

    if (clickReading != lastClickBtnState) {
      lastClickDebounce = now;
    }

    if (now - lastClickDebounce > DEBOUNCE_DELAY) {
      if (clickReading != clickBtnState) {
        clickBtnState = clickReading;

        if (clickBtnState == LOW) {
          blinkLED(3);
          pulseClick();
        }
      }
    }

    lastClickBtnState = clickReading;
  } else {
    // no buzz when clicking while not drawing
    lastClickBtnState = digitalRead(CLICK_BTN_PIN);
    clickBtnState = lastClickBtnState;
  }

  // ===== SENSOR + UDP SEND =====
  if (now - lastMqttSend >= SEND_INTERVAL) {
    lastMqttSend = now;

    readIMU();

    int potRaw = analogRead(POT_PIN);
    sensitivity = map(potRaw, 0, 4095, 1, 10);

    if (mqttClient.connected()) {
      publishMqtt();
    }
  }
}

// =========================================
// IMU READ
// =========================================
void readIMU() {
  int16_t rawAx, rawAy, rawAz, rawGx, rawGy, rawGz;

  imu.getMotion6(&rawAx, &rawAy, &rawAz, &rawGx, &rawGy, &rawGz);

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

// This still sends over UDP even though the function name says MQTT.
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