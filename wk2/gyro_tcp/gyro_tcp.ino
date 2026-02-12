#include <Arduino_LSM6DS3.h>
#include <Adafruit_LSM303_U.h>
#include <Adafruit_Sensor.h>
#include <MadgwickAHRS.h>
#include <WiFiNINA.h>
#include <WiFiUdp.h>
#include <NTPClient.h>
#include "arduino_secrets.h"
#include <Wire.h>


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
const int sendInterval = 50;  // 20ms → ~50Hz
unsigned long lastSend = 0;
unsigned long lastNTPUpdate = 0;

// --- IMU readings ---
float ax, ay, az;
float gx, gy, gz;
// --- Magnetometer from LSM303 ---
Adafruit_LSM303_Mag_Unified mag = Adafruit_LSM303_Mag_Unified(12345);
float forwardHeading = 0;
float heading;
bool isCalibrated;
float firstMagReadingMs = 0;

// Gyro Thresholds
int minThresh = 30;
int maxThresh = 500;

void setup() {
  Serial.begin(115200);
  while (!Serial) {}

  // Connect WiFi
  WiFi.begin(SECRET_SSID, SECRET_PASS);
  Serial.print("Connecting to WiFi");
  while (WiFi.status() != WL_CONNECTED) {
    delay(500);
    Serial.print(".");
  }
  Serial.println("\nWiFi connected");

  // IMU init
  if (!IMU.begin()) {
    Serial.println("Failed to initialize IMU!");
    while (1);
  }
  // magnetometer begin
  if (!mag.begin()) {
    Serial.println("LSM303 magnetometer not found");
    while (1);
  }
  mag.enableAutoRange(true);

  filter.begin(50); // Madgwick filter at 50Hz

  Wire.begin();
  Wire.setTimeout(10);   

  // NTP
  timeClient.begin();
  timeClient.update();
}

void loop() {
  if (!client.connected()) {
    if (client.connect(serverIP, portNum)) {
      Serial.println("Connected to Server");
    } else {
      delay(1000);
      return; 
    }
  }

  unsigned long now = millis();

  // Update NTP
  if (now - lastNTPUpdate >= 60000) {   // once per minute
    timeClient.update();
    lastNTPUpdate = now;
  }

  // Send IMU data at ~50Hz
  if (now - lastSend >= sendInterval) {
    lastSend = now;

    // 1. Get Magnetometer Data
    sensors_event_t event;
    mag.getEvent(&event);
    heading = atan2(event.magnetic.y, event.magnetic.x) * 180 / M_PI;
    
    // give an interval to allow user to calibrate by pointing up in the air (on z axis)
    
    if (heading) {
      if (firstMagReadingMs == 0) firstMagReadingMs = now;
      if (now - firstMagReadingMs >= 1000 && !isCalibrated) {
            forwardHeading = heading;
            isCalibrated = true;
        }
      heading -= forwardHeading; // heading is -180 -> 180
    }
    
    // 2. Get Gyroscope Data
    if (IMU.gyroscopeAvailable() && IMU.accelerationAvailable()) {
      IMU.readAcceleration(ax, ay, az);
      IMU.readGyroscope(gx, gy, gz);
    }

    // 3. Calculate Intensities
    int speedY = 0;
    int speedX = 0;
    if (abs(gy) > minThresh)
      speedY = map(constrain(abs(gy), minThresh, maxThresh), minThresh, maxThresh, 0, 100);
    if (abs(gx) > minThresh)
      speedX = map(constrain(abs(gx), minThresh, maxThresh), minThresh, maxThresh, 0, 100);

    // 4. Determine Direction
    // String dir = "FRONT";
    // if (heading >= 45 && heading < 135) dir = "RIGHT";
    // else if (heading >= 135 && heading < 225) dir = "BACK";
    // else if (heading >= 225 && heading < 315) dir = "LEFT";

    // 5. Build JSON
    String message = "{\"device\":\"" + deviceName + "\",\"sensor\":{";
    message += "\"ax\":" + String(ax) + ",";
    message += "\"ay\":" + String(ay) + ",";
    message += "\"az\":" + String(az) + ",";
    message += "\"gx\":" + String(gx) + ",";
    message += "\"gy\":" + String(gy) + ",";
    message += "\"gz\":" + String(gz) + ",";
    message += "\"heading\":" + String(heading); // because i have to fit in the compass in my bb by rotating it -90deg
    // message += "\forwardHeading\":" + String(forwardHeading) + ",";
    // message += "\calibrated\":" + String(isCalibrated);
    message += "},\"timestamp\":" + String(timeClient.getEpochTime()) + "}";

    client.println(message);
    Serial.println(message);
  } 
} 
