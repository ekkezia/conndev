

#include <Arduino_LSM6DS3.h>
#include <WiFiNINA.h>
#include <WiFiUdp.h>
#include <NTPClient.h>
#include <Wire.h>
#include "arduino_secrets.h"

// ================= WIFI + UDP =================
WiFiUDP udp;
WiFiUDP ntpUDP;
NTPClient timeClient(ntpUDP, "pool.ntp.org", 0, 60000);

// ================= UDP TARGET =================
// Change this to the computer/server IP that will receive the packets
IPAddress udpHost(10, 23, 10, 70);
const unsigned int udpPort = 4210;

// ================= DEBUG UTILS =================
void blinkSuccess(int pin) {
  digitalWrite(pin, HIGH); delay(200);
  digitalWrite(pin, LOW);  delay(200);
}

void blinkFail(int pin) {
  for (int i = 0; i < 5; i++) {
    digitalWrite(pin, HIGH); delay(80);
    digitalWrite(pin, LOW);  delay(80);
  }
}

// ================= LEDs =================
int starLedPins[] = {2, 3, 4, 5, 6};
const int starLedCount = 5;

// ================= DEVICE INFO =================
String clientID = "keziaIMU_";
const String deviceName = "kezia";

// ================= TIMING =================
const int sendInterval = 200;
unsigned long lastUdpSend = 0;
unsigned long debounceDelay = 50;

// ================= SENSORS =================
float ax, ay, az, gx, gy, gz;
int sensitivity;

// ================= BUTTONS =================
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

// ================= LED 4 PULSE =================
unsigned long led4PulseStart = 0;
bool led4Pulsing = false;

// =========================================
// UDP SEND HELPER
// =========================================
bool sendUdpPacket(const String& path, const String& payload) {
  String packet = "{\"path\":\"" + path + "\",\"data\":" + payload + "}";

  if (udp.beginPacket(udpHost, udpPort) != 1) {
    Serial.println("UDP beginPacket failed");
    return false;
  }

  udp.print(packet);

  if (udp.endPacket() != 1) {
    Serial.println("UDP endPacket failed");
    return false;
  }

  Serial.print("UDP sent: ");
  Serial.println(packet);
  return true;
}

// =========================================
void setup() {
  Serial.begin(115200);
  delay(500);

  pinMode(clickBtnPin, INPUT_PULLUP);
  pinMode(drawBtnPin,  INPUT_PULLUP);

  for (int i = 0; i < starLedCount; i++) {
    pinMode(starLedPins[i], OUTPUT);
    digitalWrite(starLedPins[i], LOW);
  }

  // ------ TEST 0: WiFi ------
  bool wifiOk = connectToNetworkDebug();
  wifiOk ? blinkSuccess(starLedPins[0]) : blinkFail(starLedPins[0]);
  if (!wifiOk) { hangWithBlink(0); return; }

  // Start UDP locally
  udp.begin(udpPort);

  byte mac[6];
  WiFi.macAddress(mac);
  for (int i = 0; i < 3; i++) {
    clientID += String(mac[i], HEX);
  }

  // ------ TEST 1: UDP send ------
  bool udpOk = sendUdpPacket("kezia/test", "\"ok\"");
  udpOk ? blinkSuccess(starLedPins[1]) : blinkFail(starLedPins[1]);
  if (!udpOk) { hangWithBlink(1); return; }

  // ------ TEST 2: IMU ------
  IMU.begin();
  delay(50);
  bool imuOk = IMU.accelerationAvailable() || IMU.gyroscopeAvailable();
  imuOk ? blinkSuccess(starLedPins[2]) : blinkFail(starLedPins[2]);
  if (!imuOk) { hangWithBlink(2); return; }

  // ------ TEST 4: UDP send again ------
  digitalWrite(starLedPins[4], HIGH); delay(50);
  digitalWrite(starLedPins[4], LOW);  delay(50);

  if (!sendUdpPacket("kezia/test", "\"setup-complete\"")) {
    blinkFail(starLedPins[4]);
    hangWithBlink(4);
    return;
  }

  blinkSuccess(starLedPins[4]);
  Serial.println("Setup completo.");
}

// =========================================
void loop() {
  unsigned long now = millis();

  // NTP: start once
  if (!ntpBegun) {
    timeClient.begin();
    ntpBegun = true;
  }

  // NTP: sync every 10 sec until success
  if (!ntpStarted && now - lastNtpUpdate > 10000) {
    lastNtpUpdate = now;
    if (timeClient.forceUpdate()) {
      ntpStarted = true;
      Serial.println("NTP OK");
    }
  }

  // ====== DRAW START/STOP ======
  int drawBtnReading = digitalRead(drawBtnPin);
  if (drawBtnReading != lastDrawBtnState) {
    lastDrawBtnDebounce = millis();
  }

  if ((millis() - lastDrawBtnDebounce) > debounceDelay) {
    if (drawBtnReading != drawBtnState) {
      drawBtnState = drawBtnReading;
      if (drawBtnState == LOW) {
        drawState = !drawState;
        animateStarLEDs();
        pulseDraw();
      }
    }
  }
  lastDrawBtnState = drawBtnReading;

  // ====== CLICK ======
  if (drawState) {
    int clickBtnReading = digitalRead(clickBtnPin);
    if (clickBtnReading != lastClickBtnState) {
      lastClickBtnDebounce = millis();
    }

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

  // ====== SENSOR + UDP ======
  if (now - lastUdpSend >= sendInterval) {
    lastUdpSend = now;

    if (IMU.accelerationAvailable()) IMU.readAcceleration(ax, ay, az);
    if (IMU.gyroscopeAvailable())    IMU.readGyroscope(gx, gy, gz);

    sensitivity = 5; // fallback default on Nano 33 IoT if no pot is connected

    // If you actually have a potentiometer on A3 and it is wired properly,
    // uncomment this line and comment out the one above:
    // sensitivity = floor(map(analogRead(A3), 0, 1023, 1, 10));

    bool ok = publishUdpData();
    if (ok) {
      digitalWrite(starLedPins[4], HIGH);
      led4PulseStart = now;
      led4Pulsing = true;
    }
  }

  // restore LED 4 after pulse
  if (led4Pulsing && (now - led4PulseStart >= 30)) {
    led4Pulsing = false;
  }

  // draw LED state
  for (int i = 0; i < starLedCount; i++) {
    if (i == 4 && led4Pulsing) {
      digitalWrite(starLedPins[i], HIGH);
    } else {
      digitalWrite(starLedPins[i], drawState ? HIGH : LOW);
    }
  }
}

// =========================================
// NETWORK
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
    Serial.print("IP local: ");
    Serial.println(WiFi.localIP());
    return true;
  }

  Serial.println("WiFi FALLO");
  return false;
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
// UDP SENDERS
// =========================================
void pulseClick() {
  sendUdpPacket("kezia/imu/click", "true");
  Serial.println("CLICK!");
}

void pulseDraw() {
  Serial.println(drawState ? "START" : "STOP");
  publishControl();
}

void publishControl() {
  sendUdpPacket("kezia/imu/draw", drawState ? "\"start\"" : "\"stop\"");
}

void publishPower(bool on) {
  sendUdpPacket("kezia/imu/power", on ? "{\"power\":true}" : "{\"power\":false}");
}

bool publishUdpData() {
  String payload = "{\"device\":\"" + deviceName + "\",\"sensor\":{";
  payload += "\"ax\":" + String(ax, 6) + ",";
  payload += "\"ay\":" + String(ay, 6) + ",";
  payload += "\"az\":" + String(az, 6) + ",";
  payload += "\"gx\":" + String(gx, 6) + ",";
  payload += "\"gy\":" + String(gy, 6) + ",";
  payload += "\"gz\":" + String(gz, 6) + ",";
  payload += "\"sensitivity\":" + String(sensitivity) + ",";
  payload += "\"timestamp\":";

  if (ntpStarted) {
    unsigned long long tsMs =
      (unsigned long long)timeClient.getEpochTime() * 1000ULL +
      (millis() % 1000);
    payload += String((unsigned long)(tsMs & 0xFFFFFFFF));
  } else {
    payload += String(millis());
  }

  payload += "}}";

  return sendUdpPacket("kezia/imu/data", payload);
}
