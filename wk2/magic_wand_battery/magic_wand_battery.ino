#include <Arduino_LSM6DS3.h>
#include <WiFiNINA.h>
#include <WiFiUdp.h>
#include <NTPClient.h>
#include <ArduinoMqttClient.h>
#include <Wire.h>
#include "arduino_secrets.h"

// ================= WIFI + MQTT =================
WiFiClient wifi;
MqttClient mqttClient(wifi);
WiFiUDP ntpUDP;
NTPClient timeClient(ntpUDP, "pool.ntp.org", 0, 60000);

// ================= DEBUG UTILS =================
void blinkSuccess(int pin) {
  mqttClient.poll();
  digitalWrite(pin, HIGH); delay(200);
  digitalWrite(pin, LOW);  delay(200);
}

void blinkFail(int pin) {
  for (int i = 0; i < 5; i++) {
    mqttClient.poll();
    digitalWrite(pin, HIGH); delay(80);
    digitalWrite(pin, LOW);  delay(80);
  }
}

// ================= LEDs =================
int starLedPins[] = {2, 3, 4, 5, 6};
const int starLedCount = 5;

// ================= MQTT =================
char broker[] = "public.cloud.shiftr.io";
int port = 1883;
char topic[] = "kezia/imu/data";
String clientID = "keziaIMU_";
const String deviceName = "kezia";

// ================= TIMING =================
const int sendInterval = 200;
unsigned long lastMqttSend = 0;
unsigned long debounceDelay = 50;

// ================= SENSORES =================
float ax, ay, az, gx, gy, gz;
int sensitivity;

// ================= BOTONES =================
const int drawBtnPin  = 11;
int drawState = LOW, drawBtnState = HIGH, lastDrawBtnState = HIGH;
unsigned long lastDrawBtnDebounce = 0;

const int clickBtnPin = 12;
int clickState = LOW, clickBtnState = HIGH, lastClickBtnState = HIGH;
unsigned long lastClickBtnDebounce = 0;

// ================= NTP =================
bool ntpStarted = false;
bool ntpBegun = false;
unsigned long lastNtpUpdate = 0;

// =========================================
void setup() {
  Serial.begin(115200);
  delay(500);

  pinMode(clickBtnPin, INPUT_PULLUP);
  pinMode(drawBtnPin,  INPUT_PULLUP);
  for (int i = 0; i < starLedCount; i++)
    pinMode(starLedPins[i], OUTPUT);

  // ------ TEST 0: WiFi ------
  bool wifiOk = connectToNetworkDebug();
  wifiOk ? blinkSuccess(starLedPins[0]) : blinkFail(starLedPins[0]);
  if (!wifiOk) { hangWithBlink(0); return; }

  byte mac[6];
  WiFi.macAddress(mac);
  for (int i = 0; i < 3; i++)
    clientID += String(mac[i], HEX);

  // ------ TEST 1: MQTT ------
  mqttClient.setId(clientID);
  mqttClient.setUsernamePassword(SECRET_MQTT_USER, SECRET_MQTT_PASS);
  mqttClient.setKeepAliveInterval(6000);

  bool mqttOk = connectToBrokerDebug();
  mqttOk ? blinkSuccess(starLedPins[1]) : blinkFail(starLedPins[1]);
  if (!mqttOk) { hangWithBlink(1); return; }

  // ------ TEST 2: IMU ------
  mqttClient.poll();
  IMU.begin();
  delay(50);
  bool imuOk = IMU.accelerationAvailable() || IMU.gyroscopeAvailable();
  imuOk ? blinkSuccess(starLedPins[2]) : blinkFail(starLedPins[2]);
  if (!imuOk) { hangWithBlink(2); return; }

  // ------ TEST 4: Envío MQTT ------
  mqttClient.poll();
  delay(50);

  digitalWrite(starLedPins[4], HIGH); delay(50);
  digitalWrite(starLedPins[4], LOW);  delay(50);

  if (!mqttClient.connected()) {
    blinkFail(starLedPins[4]);
    hangWithBlink(4);
    return;
  }

  mqttClient.poll();
  mqttClient.beginMessage("kezia/test");
  mqttClient.print("ok");
  int endResult = mqttClient.endMessage();

  if (endResult != 1) {
    blinkFail(starLedPins[4]);
    hangWithBlink(4);
    return;
  }

  blinkSuccess(starLedPins[4]);
  Serial.println("Setup completo.");
}

// =========================================
void loop() {
  mqttClient.poll();
  unsigned long now = millis();

  // NTP: iniciar una vez
  if (!ntpBegun) {
    timeClient.begin();
    ntpBegun = true;
  }

  // MQTT: reconectar si se cae
  if (!mqttClient.connected()) {
    connectToBrokerDebug();
  }

  // NTP: sincronizar cada 10 segundos hasta lograrlo
  if (!ntpStarted && now - lastNtpUpdate > 10000) {
    lastNtpUpdate = now;
    if (timeClient.forceUpdate()) {
      ntpStarted = true;
      Serial.println("NTP OK");
    }
  }

  // ====== DRAW START/STOP ======
  int drawBtnReading = digitalRead(drawBtnPin);
  if (drawBtnReading != lastDrawBtnState)
    lastDrawBtnDebounce = millis();

  if ((millis() - lastDrawBtnDebounce) > debounceDelay) {
    if (drawBtnReading != drawBtnState) {
      drawBtnState = drawBtnReading;
      if (drawBtnState == LOW) {
        drawState = !drawState;
        animateStarLEDs();
      }
      pulseDraw();
    }
  }
  for (int i = 0; i < starLedCount; i++)
    digitalWrite(starLedPins[i], drawState);
  lastDrawBtnState = drawBtnReading;

  // ====== CLICK ======
  if (drawState) {
    int clickBtnReading = digitalRead(clickBtnPin);
    if (clickBtnReading != lastClickBtnState)
      lastClickBtnDebounce = millis();

    if ((millis() - lastClickBtnDebounce) > debounceDelay) {
      if (clickBtnReading != clickBtnState) {
        clickBtnState = clickBtnReading;
        if (clickBtnState == LOW) {
          blinkAllStars();
          pulseClick();
        }
      }
    }
    lastClickBtnState = clickBtnReading;
  }

  for (int i = 0; i < starLedCount; i++)
    digitalWrite(starLedPins[i], drawState);

  // ====== SENSOR + MQTT ======
  if (now - lastMqttSend >= sendInterval) {
    lastMqttSend = now;

    if (IMU.accelerationAvailable()) IMU.readAcceleration(ax, ay, az);
    if (IMU.gyroscopeAvailable())    IMU.readGyroscope(gx, gy, gz);

    int sensitivityReading = analogRead(A3);
    sensitivity = floor(map(sensitivityReading, 0, 1023, 1, 10));

    if (mqttClient.connected()) {
      publishMqtt();
      digitalWrite(starLedPins[4], HIGH);
    } else {
      digitalWrite(starLedPins[4], drawState);
    }
  }

  // Apagar LED 4 después de 30ms sin usar delay
  static unsigned long led4On = 0;
  if (digitalRead(starLedPins[4]) == HIGH && now - led4On > 30) {
    digitalWrite(starLedPins[4], drawState);
    led4On = now;
  }

} // fin loop()

// =========================================
// FUNCIONES DE RED
// =========================================
bool connectToNetworkDebug() {
  int attempts = 0;
  while (WiFi.status() != WL_CONNECTED && attempts < 20) {
    Serial.println("WiFi intentando...");
    WiFi.begin(SECRET_SSID, SECRET_PASS);
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

bool connectToBrokerDebug() {
  Serial.println("Intentando conectar a broker...");
  mqttClient.beginWill("kezia/imu/power", true, 0);
  mqttClient.print("{\"power\": false}");
  mqttClient.endWill();

  if (!mqttClient.connect(broker, port)) {
    Serial.print("MQTT error code: ");
    Serial.println(mqttClient.connectError());
    return false;
  }
  Serial.println("Broker OK");
  return true;
}

void hangWithBlink(int ledIndex) {
  Serial.print("COLGADO en paso ");
  Serial.println(ledIndex);
  while (true) {
    blinkFail(starLedPins[ledIndex]);
    delay(1000);
  }
}

// =========================================
// LED ANIMATIONS
// =========================================
void animateStarLEDs() {
  for (int i = 0; i < starLedCount; i++) {
    digitalWrite(starLedPins[i], HIGH); delay(80);
    digitalWrite(starLedPins[i], LOW);
  }
  for (int i = starLedCount - 2; i > 0; i--) {
    digitalWrite(starLedPins[i], HIGH); delay(80);
    digitalWrite(starLedPins[i], LOW);
  }
}

void blinkAllStars() {
  for (int j = 0; j < 3; j++) {
    for (int i = 0; i < starLedCount; i++) digitalWrite(starLedPins[i], HIGH);
    delay(80);
    for (int i = 0; i < starLedCount; i++) digitalWrite(starLedPins[i], LOW);
    delay(80);
  }
}

// =========================================
// MQTT PUBLISH
// =========================================
void connectToNetwork() { connectToNetworkDebug(); }
boolean connectToBroker() { return connectToBrokerDebug(); }

void pulseClick() {
  if (!mqttClient.connected()) return;
  mqttClient.beginMessage("kezia/imu/click");
  mqttClient.print(true);
  mqttClient.endMessage();
  Serial.println("CLICK!");
}

void pulseDraw() {
  Serial.println(drawState ? "START" : "STOP");
  publishControl();
}

void publishControl() {
  if (!mqttClient.connected()) return;
  mqttClient.beginMessage("kezia/imu/draw");
  mqttClient.print(drawState ? "\"start\"" : "\"stop\"");
  mqttClient.endMessage();
}

void publishPower(bool on) {
  if (!mqttClient.connected()) return;
  mqttClient.beginMessage("kezia/imu/power");
  mqttClient.print("{\"power\":");
  mqttClient.print(on ? "true" : "false");
  mqttClient.print("}");
  mqttClient.endMessage();
}

void publishMqtt() {
  mqttClient.beginMessage(topic);
  mqttClient.print("{\"device\":\""); mqttClient.print(deviceName);
  mqttClient.print("\",\"sensor\":{");
  mqttClient.print("\"ax\":"); mqttClient.print(ax); mqttClient.print(",");
  mqttClient.print("\"ay\":"); mqttClient.print(ay); mqttClient.print(",");
  mqttClient.print("\"az\":"); mqttClient.print(az); mqttClient.print(",");
  mqttClient.print("\"gx\":"); mqttClient.print(gx); mqttClient.print(",");
  mqttClient.print("\"gy\":"); mqttClient.print(gy); mqttClient.print(",");
  mqttClient.print("\"gz\":"); mqttClient.print(gz); mqttClient.print(",");
  mqttClient.print("\"sensitivity\":"); mqttClient.print(sensitivity); mqttClient.print(",");
  mqttClient.print("\"timestamp\":");
  if (ntpStarted) {
    unsigned long long tsMs = (unsigned long long)timeClient.getEpochTime() * 1000ULL + (millis() % 1000);
    mqttClient.print((unsigned long long)tsMs);
  } else {
    mqttClient.print(millis());
  }
  mqttClient.print("}}");
  mqttClient.endMessage();
}