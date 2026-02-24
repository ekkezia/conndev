#include <Arduino_LSM6DS3.h>
#include <Adafruit_LSM303_U.h>
#include <Adafruit_Sensor.h>
#include <WiFiNINA.h>
#include <WiFiUdp.h>
#include <NTPClient.h>
#include <ArduinoMqttClient.h>
#include <Wire.h>
#include "arduino_secrets.h"

// --- WiFi + MQTT ---
WiFiClient wifi;
MqttClient mqttClient(wifi);
WiFiUDP ntpUDP;
NTPClient timeClient(ntpUDP, "pool.ntp.org", 0, 60000);

// --- MQTT Settings ---
char broker[] = "public.cloud.shiftr.io";
int port = 1883;
char topic[] = "kezia/imu/data"; // Updated to a unique topic
String clientID = "keziaIMU_";

// --- Server/Device Info ---
const String deviceName = "kezia";

// --- Timing ---
const int sendInterval = 50;  
unsigned long lastSend = 0;
unsigned long lastNTPUpdate = 0;

// --- IMU readings ---
float ax, ay, az, gx, gy, gz;
Adafruit_LSM303_Mag_Unified mag = Adafruit_LSM303_Mag_Unified(12345);
float forwardHeading = 0;
float heading;
bool isCalibrated = false;
float firstMagReadingMs = 0;

void setup() {
  Serial.begin(115200);
  while (!Serial && millis() < 5000);
  
  // 1. Connect WiFi
  connectToNetwork();

  // 2. Initialize Sensors
  if (!IMU.begin()) { Serial.println("LSM6DS3 Error"); while (1); }
  if (!mag.begin()) { Serial.println("LSM303 Error"); while (1); }
  mag.enableAutoRange(true);
  Wire.begin();

  // 3. NTP & MQTT Setup
  timeClient.begin();
  
  // Unique Client ID
  byte mac[6];
  WiFi.macAddress(mac);
  for (int i = 0; i < 3; i++) clientID += String(mac[i], HEX);
  
  mqttClient.setId(clientID);
  mqttClient.setUsernamePassword(SECRET_MQTT_USER, SECRET_MQTT_PASS);
}

void loop() {
  // Ensure we stay connected
  if (WiFi.status() != WL_CONNECTED) {
    connectToNetwork();
    return;
  }

  if (!mqttClient.connected()) {
    connectToBroker();
  }

  // Poll for incoming MQTT messages (if any)
  mqttClient.poll();
  unsigned long now = millis();

  // Update NTP (once/min)
  if (now - lastNTPUpdate >= 60000) {
    timeClient.update();
    lastNTPUpdate = now;
  }

  // Send Data at 50Hz
  if (now - lastSend >= sendInterval) {
    lastSend = now;

    // Get Magnetometer
    sensors_event_t event;
    mag.getEvent(&event);
    heading = atan2(event.magnetic.y, event.magnetic.x) * 180 / M_PI;
    
    if (firstMagReadingMs == 0) firstMagReadingMs = now;
    if (now - firstMagReadingMs >= 1000 && !isCalibrated) {
        forwardHeading = heading;
        isCalibrated = true;
    }
    heading -= forwardHeading;

    // Get Accel/Gyro
    if (IMU.gyroscopeAvailable() && IMU.accelerationAvailable()) {
      IMU.readAcceleration(ax, ay, az);
      IMU.readGyroscope(gx, gy, gz);
    }

    // Build JSON Message
    String message = "{\"device\":\"" + deviceName + "\",\"sensor\":{";
    message += "\"ax\":" + String(ax) + ",";
    message += "\"ay\":" + String(ay) + ",";
    message += "\"az\":" + String(az) + ",";
    message += "\"gx\":" + String(gx) + ",";
    message += "\"gy\":" + String(gy) + ",";
    message += "\"gz\":" + String(gz) + ",";
    message += "\"heading\":" + String(heading) + ",";
    message += "\"fwdHeading\":" + String(forwardHeading) + ",";
    message += "\"calibrated\":" + String(isCalibrated);
    message += "},\"timestamp\":" + String(timeClient.getEpochTime()) + "}";

    // Publish to MQTT
    if (mqttClient.connected()) {
      mqttClient.beginMessage(topic);
      mqttClient.print(message);
      mqttClient.endMessage();
      // Serial.println("Published: " + message); // Uncomment for debugging
    }
  }
}

void connectToNetwork() {
  while (WiFi.status() != WL_CONNECTED) {
    Serial.print("Connecting to WiFi...");
    WiFi.begin(SECRET_SSID, SECRET_PASS);
    delay(4000);
  }
  Serial.println("\nConnected to IP: " + WiFi.localIP().toString());
}

boolean connectToBroker() {
  Serial.print("Attempting MQTT connection...");
  if (!mqttClient.connect(broker, port)) {
    Serial.print("Failed. Error code: ");
    Serial.println(mqttClient.connectError());
    return false;
  }
  Serial.println("Connected to Broker.");
  
  // Optional: subscribe to a control topic
  mqttClient.subscribe(topic); 
  return true;
}
