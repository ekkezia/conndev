#include <Arduino_LSM6DS3.h>
#include <MadgwickAHRS.h>
#include <WiFiNINA.h>
#include <WiFiUdp.h>
#include <NTPClient.h>
#include "arduino_secrets.h"

// --- Madgwick filter ---
Madgwick filter;

// --- WiFi + NTP ---
WiFiClient client;
WiFiUDP ntpUDP;
NTPClient timeClient(ntpUDP, "pool.ntp.org", 0, 60000);

// --- Server ---
const char* serverIP = SERVER_IP_ADDRESS; // define in arduino_secrets.h
const int portNum = 3000;
const String deviceName = "kezia";

// --- Timing ---
const int sendInterval = 20;  // 20ms → ~50Hz
unsigned long lastSend = 0;
unsigned long lastNTPUpdate = 0;

// --- IMU readings ---
float ax, ay, az;
float gx, gy, gz;
float roll, pitch, yaw;

void setup() {
  Serial.begin(9600);
  while (!Serial) {}

  // IMU init
  if (!IMU.begin()) {
    Serial.println("Failed to initialize IMU!");
    while (1);
  }

  filter.begin(50); // Madgwick filter at 50Hz

  // Connect WiFi
  WiFi.begin(SECRET_SSID, SECRET_PASS);
  Serial.print("Connecting to WiFi");
  while (WiFi.status() != WL_CONNECTED) {
    delay(500);
    Serial.print(".");
  }
  Serial.println("\nWiFi connected");

  // NTP
  timeClient.begin();
  timeClient.update();
}

void loop() {
  unsigned long now = millis();

  // --- Update NTP every second ---
  if (now - lastNTPUpdate >= 1000) {
    timeClient.update();
    lastNTPUpdate = now;
  }

  // --- Send IMU data at ~50Hz ---
  if (now - lastSend >= sendInterval) {
    lastSend = now;

    if (IMU.accelerationAvailable() && IMU.gyroscopeAvailable()) {
      // read IMU
      IMU.readAcceleration(ax, ay, az);
      IMU.readGyroscope(gx, gy, gz); // degrees/sec

      // Madgwick filter expects radians/sec for gyro
      filter.updateIMU(gx * DEG_TO_RAD, gy * DEG_TO_RAD, gz * DEG_TO_RAD, ax, ay, az);

      // Euler angles (radians)
      roll = filter.getRoll();
      pitch = filter.getPitch();
      yaw = filter.getYaw();
      if (yaw < 0) yaw += 2 * PI; // wrap 0–2PI

      // --- Ensure TCP is connected ---
      if (!client.connected()) {
        client.stop();
        if (!client.connect(serverIP, portNum)) {
          Serial.println("Failed to connect to server. Will retry...");
          return; // skip sending this iteration
        }
      }

      // --- Build JSON message ---
      String message = "{\"device\":\"" + deviceName + "\",\"sensor\":{";
      message += "\"ax\":" + String(ax) + ",";
      message += "\"ay\":" + String(ay) + ",";
      message += "\"az\":" + String(az) + ",";
      message += "\"gx\":" + String(gx) + ",";
      message += "\"gy\":" + String(gy) + ",";
      message += "\"gz\":" + String(gz) + ",";
      message += "\"roll\":" + String(roll) + ",";
      message += "\"pitch\":" + String(pitch) + ",";
      message += "\"yaw\":" + String(yaw);
      message += "},\"timestamp\":" + String(timeClient.getEpochTime()) + "}";

      // send
      client.println(message);

      // debug
      Serial.println(message);
    }
  }
}
