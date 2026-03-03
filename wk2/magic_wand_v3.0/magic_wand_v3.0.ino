

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

int calibrateLedPin = 6;
int powerLedPin = 8;

const unsigned long longPressTime = 1000;
const unsigned long shortPressTime = 50; // 10-110 ms

unsigned long calPressStart = 0;
bool calPressed = false;
bool calibrateTriggered = false;

unsigned long resetPressStart = 0;
bool resetPressed = false;
bool resetTriggered = false;

bool systemPaused = false;

// ================= CALIBRATION =================
bool calibrationRunning = false;
bool ledState = false;

// ================ CONTROL
bool ctrlPower = false;
bool ctrlClick = false;
bool ctrlClear = false;

// ================= WIFI + MQTT =================
WiFiClient wifi;
MqttClient mqttClient(wifi);
WiFiUDP ntpUDP;
NTPClient timeClient(ntpUDP,"pool.ntp.org",0,60000);

char broker[]="public.cloud.shiftr.io";
int port=1883;
char topic[]="kezia/imu/data";

String clientID="keziaIMU_";
const String deviceName="kezia";

// ================= TIMING =================
const int sendInterval=200;
unsigned long lastSend=0;

// ================= IMU =================
float ax,ay,az,gx,gy,gz;
Adafruit_LSM303_Mag_Unified mag(12345);

bool isCalibrated=false;

// =================================================

void setup(){

  Serial.begin(115200);

  pinMode(calibrateButtonPin,INPUT_PULLUP); // yellow
  pinMode(resetButtonPin,INPUT_PULLUP); // red

  pinMode(calibrateLedPin,OUTPUT); // red
  pinMode(powerLedPin,OUTPUT); // white

  connectToNetwork();

  IMU.begin();
  mag.begin();
  mag.enableAutoRange(true);

  timeClient.begin();

  byte mac[6];
  WiFi.macAddress(mac);
  for(int i=0;i<3;i++)
    clientID+=String(mac[i],HEX);

  mqttClient.setId(clientID);
  mqttClient.setUsernamePassword(
    SECRET_MQTT_USER,
    SECRET_MQTT_PASS);
}

// =================================================

void loop(){
  mqttClient.poll();
  unsigned long now=millis();

  if(!mqttClient.connected())
    connectToBroker();

  // ===== CALIBRATE BUTTON =====
  if(digitalRead(calibrateButtonPin)==LOW){ // calibrate button is pressed
    if(!calPressed){
      calPressStart=millis();
      calPressed=true;
      calibrateTriggered=false;
    }

    if(!calibrateTriggered &&
       millis()-calPressStart>=longPressTime){

      Serial.println("CALIBRATION START");

      systemPaused=false;
      isCalibrated=false;

      calibrationRunning=true;
      calibrateTriggered=true;

      digitalWrite(calibrateLedPin, HIGH);
      digitalWrite(powerLedPin, LOW);

      setPower(true);
    }

  } else calPressed=false;

  // ===== RESET BUTTON ===== 
  if(digitalRead(resetButtonPin)==LOW){

    if(!resetPressed){
      resetPressStart=millis();
      resetPressed=true;
      resetTriggered=false;
    }

    if(!resetTriggered &&
       millis()-resetPressStart>=longPressTime){

      Serial.println("SYSTEM RESET");

      digitalWrite(calibrateLedPin,LOW);
      digitalWrite(powerLedPin,LOW);
      systemPaused=true; // pause sensor readings

      setPower(false);

      resetTriggered=true;
    }
  } else resetPressed=false;

  if(systemPaused) return;

  // ================= SENSOR UPDATE =================
  if(now-lastSend>=sendInterval){

    lastSend=now;

    // ---------- READ ACCEL ----------
    if (IMU.accelerationAvailable())
      IMU.readAcceleration(ax, ay, az);

    // ---------- GYRO ----------
    if(IMU.gyroscopeAvailable())
      IMU.readGyroscope(gx,gy,gz);
    
    // ---------- NORMALIZATION ----------
    sensors_event_t event;
    mag.getEvent(&event);

    float roll = atan2(ay, az) * 180.0 / PI;
    float pitch = atan(-ax / sqrt(ay * ay + az * az)) * 180.0 / PI;
    float heading = atan2(event.magnetic.y, event.magnetic.x) * 180.0 / PI;
    // Convert -180 → 180 into 0 → 360
    if (heading < 0) {
      heading += 360.0;
    }

    // ===== CALIBRATION =====
    // TODO: change CALIBRATION to POWER
    if(calibrationRunning){

      calibrationRunning=false;
      isCalibrated=true;

      digitalWrite(calibrateLedPin,LOW);
      digitalWrite(powerLedPin, HIGH); // turn "power" high to signify calibration is done and user can start drawing

      Serial.println("CALIBRATION DONE");

    }

    if(isCalibrated) {
      // CONTROL: Calibrate Top Left & Bottom Right
      if(millis()-calPressStart>=shortPressTime && millis()-calPressStart<shortPressTime+100){

      Serial.print("[CALIBRATE POINT]"); // only allow clicking after calibration (whe power is fully ON)
      Serial.println("Top Left");

      digitalWrite(powerLedPin, LOW); // for now we make it go low->high bcs the power indicator is always ON usually (if user is on and done calibrating)
      delay(50);
      digitalWrite(powerLedPin, HIGH);

      pulseClick();
    }

    // CONTROL: Click
    if(millis()-resetPressStart>=shortPressTime && millis()-resetPressStart<shortPressTime+100){
      Serial.println("[CLICK]");

      digitalWrite(calibrateLedPin, HIGH); // for now we make it go low->high bcs the power indicator is always ON usually (if user is on and done calibrating)
      delay(50);
      digitalWrite(calibrateLedPin, LOW);

      pulseClear();
    }
  }

    // ================= MQTT =================
    if(mqttClient.connected() && isCalibrated){

      mqttClient.beginMessage(topic);

      mqttClient.print("{\"device\":\"");
      mqttClient.print(deviceName);
      mqttClient.print("\",\"sensor\":{");

      mqttClient.print("\"ax\":");mqttClient.print(ax);mqttClient.print(",");
      mqttClient.print("\"ay\":");mqttClient.print(ay);mqttClient.print(",");
      mqttClient.print("\"az\":");mqttClient.print(az);mqttClient.print(",");

      mqttClient.print("\"gx\":");mqttClient.print(gx);mqttClient.print(",");
      mqttClient.print("\"gy\":");mqttClient.print(gy);mqttClient.print(",");
      mqttClient.print("\"gz\":");mqttClient.print(gz);mqttClient.print(",");

      mqttClient.print("\"pitch\":");
      mqttClient.print(pitch);
      mqttClient.print(",");

      mqttClient.print("\"roll\":");
      mqttClient.print(roll);
      mqttClient.print(",");

      mqttClient.print("\"heading\":");
      mqttClient.print(heading);
      mqttClient.print(",");

      mqttClient.print("\"calibrated\":true}");

      mqttClient.print(",\"timestamp\":");
      mqttClient.print(timeClient.getEpochTime());
      mqttClient.print("}");

      mqttClient.endMessage();
    }
  }

    // Serial.println(heading);

}

// =================================================

void connectToNetwork(){
  while(WiFi.status()!=WL_CONNECTED){
    WiFi.begin(SECRET_SSID,SECRET_PASS);
    delay(4000);
  }
}

boolean connectToBroker(){
  return mqttClient.connect(broker,port);
}

// MQTT Configs
void pulseClick() {
  ctrlClick = true;
  publishControl();
  ctrlClick = false; // toggle back to false
  publishControl();
}

void pulseClear() {
  ctrlClear = true;
  publishControl();
  ctrlClear = false; // toggle back to false
  publishControl();
}

void setPower(bool state) {
  ctrlPower = state;
  publishControl();
}

void publishControl() {

  if (!mqttClient.connected()) return;

  mqttClient.beginMessage("kezia/imu/control");

  mqttClient.print("{\"power\":");
  mqttClient.print(ctrlPower ? "true":"false");
  mqttClient.print(",\"click\":");
  mqttClient.print(ctrlClick ? "true":"false");
  mqttClient.print(",\"clear\":");
  mqttClient.print(ctrlClear ? "true":"false");
  mqttClient.print("}");

  mqttClient.endMessage();

    // delay(10);
}
