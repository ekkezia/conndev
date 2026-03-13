#include <Arduino_LSM6DS3.h>
#include <Adafruit_LSM303_U.h>
#include <Adafruit_Sensor.h>
#include <WiFiNINA.h>
#include <WiFiUdp.h>
#include <NTPClient.h>
#include <ArduinoMqttClient.h>
#include <Wire.h>
#include "arduino_secrets.h"

// ================= BUTTONS =================
int calibrateButtonPin = 12;
int resetButtonPin = 11;

int calibrateLedPin = 8;  // serbaguna: power, calibration
int powerLedPin = 6;

const unsigned long longPressTime = 1000;
const unsigned long shortPressTime = 50;  // 10-110 ms


// ================= POWER =================
unsigned long resetPressStart = 0;
bool resetPressed = false;
bool isOn = false;

// ================= CALIBRATION =================
unsigned long calPressStart = 0;
bool calPressed = false;
bool calibrationMode = false;
bool isCalibrated = false;
bool isCalibratedTopLeft = false;
bool isCalibratedBottomRight = false;
float calibratedTopLeftRoll, calibratedTopLeftPitch, calibratedTopLeftHeading, calibratedBottomRightRoll, calibratedBottomRightPitch, calibratedBottomRightHeading;  // gyro values

// ================ CONTROL
bool ctrlPower = false;
bool ctrlClick = false;
bool ctrlClear = false;

// ================= WIFI + MQTT =================
WiFiClient wifi;
MqttClient mqttClient(wifi);
WiFiUDP ntpUDP;
NTPClient timeClient(ntpUDP, "pool.ntp.org", 0, 60000);

char broker[] = "public.cloud.shiftr.io";
int port = 1883;
char topic[] = "kezia/imu/data";

String clientID = "keziaIMU_";
const String deviceName = "kezia";

// ================= TIMING =================
const int sendInterval = 200;
unsigned long lastSend = 0;

// ================= IMU =================
float ax, ay, az, gx, gy, gz;

Adafruit_LSM303_Mag_Unified mag(12345);


// =================================================

void setup() {
  Serial.begin(115200);

  pinMode(calibrateButtonPin, INPUT_PULLUP);  // yellow
  pinMode(resetButtonPin, INPUT_PULLUP);      // red

  pinMode(calibrateLedPin, OUTPUT);  // red
  pinMode(powerLedPin, OUTPUT);      // white

  connectToNetwork();

  IMU.begin();
  mag.begin();
  mag.enableAutoRange(true);

  timeClient.begin();

  byte mac[6];
  WiFi.macAddress(mac);
  for (int i = 0; i < 3; i++)
    clientID += String(mac[i], HEX);

  mqttClient.setId(clientID);
  mqttClient.setUsernamePassword(
    SECRET_MQTT_USER,
    SECRET_MQTT_PASS);
}

// =================================================

void loop() {

  mqttClient.poll();
  unsigned long now = millis();

// ---- WIFI CHECK ----
if (WiFi.status() != WL_CONNECTED) {
  Serial.println("WiFi lost. Reconnecting...");
  WiFi.disconnect();
  delay(1000);
  WiFi.begin(SECRET_SSID, SECRET_PASS);
  delay(5000);
  return;  // stop loop this cycle
}

  if (!mqttClient.connected()) {
  Serial.println("Attempting MQTT connection...");
  if (mqttClient.connect(broker, port)) {
    Serial.println("MQTT reconnected");
  } else {
    Serial.print("Failed, rc=");
    Serial.println(mqttClient.connectError());
    delay(2000);
  }
}
    
  // IMU
  if (IMU.accelerationAvailable())
    IMU.readAcceleration(ax, ay, az);

  if (IMU.gyroscopeAvailable())
    IMU.readGyroscope(gx, gy, gz);

  sensors_event_t event;
  mag.getEvent(&event);

  float roll = atan2(ay, az) * 180.0 / PI;
  float pitch = atan(-ax / sqrt(ay * ay + az * az)) * 180.0 / PI;
  float heading = atan2(event.magnetic.y, event.magnetic.x) * 180.0 / PI;
  // Convert -180 → 180 into 0 → 360
  if (heading < 0) {
    heading += 360.0;
  }

  // =================================================
  // =============== POWER BUTTON ====================
  // =================================================

  bool currentReset = digitalRead(resetButtonPin);

  // press start
  if (currentReset == LOW && !resetPressed) {
    resetPressed = true;
    resetPressStart = millis();
  }

  // release
  if (currentReset == HIGH && resetPressed) {

    unsigned long duration = millis() - resetPressStart;

    if (duration >= longPressTime) {

      isOn = !isOn;

      if (isOn) {
        Serial.println("SYSTEM ON");
        digitalWrite(powerLedPin, HIGH);
        setPower(true);
      } else {
        Serial.println("SYSTEM OFF");
        digitalWrite(powerLedPin, LOW);
        digitalWrite(calibrateLedPin, LOW);

        // reset calibration value to null
        isCalibrated = false;
        isCalibratedTopLeft = false;
        isCalibratedBottomRight = false;
        setPower(false);
      }
    } else if (duration >= shortPressTime) {
      Serial.println("[CLICK]");
      digitalWrite(powerLedPin, LOW);
      delay(50);
      digitalWrite(powerLedPin, HIGH);
      delay(50);
      pulseClick();
    }

    resetPressed = false;
  }

  // If system is OFF, stop here
  if (!isOn) return;

  // =================================================
  // ============= CALIBRATE BUTTON ==================
  // =================================================

  bool currentCal = digitalRead(calibrateButtonPin);

  // press start
  if (currentCal == LOW && !calPressed) {
    calPressed = true;
    calPressStart = millis();
  }

  // release
  if (currentCal == HIGH && calPressed) {

    unsigned long duration = millis() - calPressStart;

    if (duration >= longPressTime) {
      calibrationMode = true;
      Serial.println("[START CALIBRATING]");
      digitalWrite(calibrateLedPin, HIGH);
      isCalibrated = false;
      isCalibratedTopLeft = false;
      isCalibratedBottomRight = false;
    } else if (duration >= shortPressTime) {

      if (calibrationMode) {

        digitalWrite(calibrateLedPin, LOW);
        delay(50);
        digitalWrite(calibrateLedPin, HIGH);
        delay(50);

        if (!isCalibratedTopLeft) {
          calibratedTopLeftRoll = roll;
          calibratedTopLeftPitch = pitch;
          calibratedTopLeftHeading = heading;
          isCalibratedTopLeft = true;
        } else if (!isCalibratedBottomRight) {
          calibratedBottomRightRoll = roll;
          calibratedBottomRightPitch = pitch;
          calibratedBottomRightHeading = heading;
          isCalibratedBottomRight = true;
        }

        if (isCalibratedTopLeft && isCalibratedBottomRight) {
          isCalibrated = true;
          calibrationMode = false;
          digitalWrite(calibrateLedPin, LOW);  // turn off led after calibration done
        }

        publishCalibration(
          calibratedTopLeftRoll,
          calibratedTopLeftPitch,
          calibratedTopLeftHeading,
          calibratedBottomRightRoll,
          calibratedBottomRightPitch,
          calibratedBottomRightHeading);
      }
    }

    calPressed = false;
  }

  // =================================================
  // ================= SENSOR UPDATE =================
  // =================================================

  if (now - lastSend >= sendInterval) {

    lastSend = now;

    // =================================================
    // ================= MQTT SEND =====================
    // =================================================

    if (mqttClient.connected() && isCalibrated) {

      mqttClient.beginMessage(topic);

      mqttClient.print("{\"device\":\"");
      mqttClient.print(deviceName);
      mqttClient.print("\",\"sensor\":{");

      mqttClient.print("\"ax\":");
      mqttClient.print(ax);
      mqttClient.print(",");
      mqttClient.print("\"ay\":");
      mqttClient.print(ay);
      mqttClient.print(",");
      mqttClient.print("\"az\":");
      mqttClient.print(az);
      mqttClient.print(",");

      mqttClient.print("\"gx\":");
      mqttClient.print(gx);
      mqttClient.print(",");
      mqttClient.print("\"gy\":");
      mqttClient.print(gy);
      mqttClient.print(",");
      mqttClient.print("\"gz\":");
      mqttClient.print(gz);
      mqttClient.print(",");

      mqttClient.print("\"pitch\":");
      mqttClient.print(pitch);
      mqttClient.print(",");
      mqttClient.print("\"roll\":");
      mqttClient.print(roll);
      mqttClient.print(",");
      mqttClient.print("\"heading\":");
      mqttClient.print(heading);
      mqttClient.print(",");

      mqttClient.print("\"timestamp\":");
      mqttClient.print(timeClient.getEpochTime());
      mqttClient.print("}}");

      mqttClient.endMessage();
    }
  }
}

// =================================================

void connectToNetwork() {
  while (WiFi.status() != WL_CONNECTED) {
    WiFi.begin(SECRET_SSID, SECRET_PASS);
    delay(4000);
  }
}

boolean connectToBroker() {
  return mqttClient.connect(broker, port);
}

// MQTT Configs
void pulseClick() {
  ctrlClick = true;
  publishControl();
  ctrlClick = false;  // toggle back to false
  publishControl();
}

void pulseClear() {
  ctrlClear = true;
  publishControl();
  ctrlClear = false;  // toggle back to false
  publishControl();
}

void setPower(bool state) {
  ctrlPower = state;
  publishControl();
}

void publishCalibration(float roll0, float pitch0, float heading0, float roll1, float pitch1, float heading1) {
  if (!mqttClient.connected()) return;

  mqttClient.beginMessage("kezia/imu/calibration");

  mqttClient.print("{");

  mqttClient.print("\"calibrated\":");
  mqttClient.print(isCalibrated ? "true" : "false");
  mqttClient.print(",");

  mqttClient.print("\"topLeftRoll\":");
  mqttClient.print(roll0, 4);
  mqttClient.print(",");

  mqttClient.print("\"topLeftPitch\":");
  mqttClient.print(pitch0, 4);
  mqttClient.print(",");

  mqttClient.print("\"topLeftHeading\":");
  mqttClient.print(heading0, 4);
  mqttClient.print(",");

  mqttClient.print("\"bottomRightRoll\":");
  mqttClient.print(roll1, 4);
  mqttClient.print(",");

  mqttClient.print("\"bottomRightPitch\":");
  mqttClient.print(pitch1, 4);
  mqttClient.print(",");

  mqttClient.print("\"bottomRightHeading\":");
  mqttClient.print(heading0, 4);

  mqttClient.print("}");

  mqttClient.endMessage();
}

void publishControl() {

  if (!mqttClient.connected()) return;

  mqttClient.beginMessage("kezia/imu/control");

  mqttClient.print("{\"power\":");
  mqttClient.print(ctrlPower ? "true" : "false");
  mqttClient.print(",\"click\":");
  mqttClient.print(ctrlClick ? "true" : "false");
  mqttClient.print(",\"clear\":");
  mqttClient.print(ctrlClear ? "true" : "false");
  mqttClient.print("}");

  mqttClient.endMessage();

  // delay(10);
}
