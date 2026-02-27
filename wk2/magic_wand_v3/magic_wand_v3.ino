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

const unsigned long holdTime = 1000;

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

float heading;
float forwardHeading=0;
bool isCalibrated=false;

float lastHeading=0;
float continuousHeading=0;
bool firstHeading=true;

// =================================================

void setup(){

  Serial.begin(115200);

  pinMode(calibrateButtonPin,INPUT_PULLUP);
  pinMode(resetButtonPin,INPUT_PULLUP);

  pinMode(calibrateLedPin,OUTPUT);
  pinMode(powerLedPin,OUTPUT);

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
  if(digitalRead(calibrateButtonPin)==LOW){

    if(!calPressed){
      calPressStart=millis();
      calPressed=true;
      calibrateTriggered=false;
    }

    if(!calibrateTriggered &&
       millis()-calPressStart>=holdTime){

      Serial.println("CALIBRATION START");

      systemPaused=false;
      isCalibrated=false;
      firstHeading=true;

      calibrationRunning=true;
      calibrateTriggered=true;

      digitalWrite(calibrateLedPin, HIGH);
      digitalWrite(powerLedPin, LOW);

      mqttClient.beginMessage("kezia/imu/power");
      mqttClient.print("{\"power\":true}");
      mqttClient.endMessage();
    }

  }else calPressed=false;

  // ===== RESET BUTTON =====
  if(digitalRead(resetButtonPin)==LOW){

    if(!resetPressed){
      resetPressStart=millis();
      resetPressed=true;
      resetTriggered=false;
    }

    if(!resetTriggered &&
       millis()-resetPressStart>=holdTime){

      Serial.println("SYSTEM RESET");

      digitalWrite(calibrateLedPin,LOW);
      digitalWrite(powerLedPin,LOW);
      systemPaused=true;

      mqttClient.beginMessage("kezia/imu/power");
      mqttClient.print("{\"power\":false}");
      mqttClient.endMessage();

      resetTriggered=true;
    }

  }else resetPressed=false;

  if(systemPaused) return;

  // ================= SENSOR UPDATE =================
  if(now-lastSend>=sendInterval){

    lastSend=now;

    // ---------- MAG ----------
    sensors_event_t event;
    mag.getEvent(&event);

    heading=
      atan2(event.magnetic.y,
            event.magnetic.x)*180/M_PI;

    // ===== CALIBRATION =====
    if(calibrationRunning){

      digitalWrite(powerLedPin, HIGH);

      forwardHeading=heading;

      calibrationRunning=false;
      isCalibrated=true;

      digitalWrite(calibrateLedPin,LOW);
      digitalWrite(powerLedPin, HIGH);

      Serial.println("CALIBRATION DONE");
    }

    if(isCalibrated)
      heading-=forwardHeading;

    if(heading>180) heading-=360;
    if(heading<-180) heading+=360;

    // ===== CONTINUOUS HEADING =====
    if(firstHeading){
      lastHeading=heading;
      continuousHeading=heading;
      firstHeading=false;
    }else{
      float delta=heading-lastHeading;
      if(delta>180) delta-=360;
      if(delta<-180) delta+=360;

      continuousHeading+=delta;
      lastHeading=heading;
    }

    // ---------- ACCEL ----------
    if(IMU.accelerationAvailable())
      IMU.readAcceleration(ax,ay,az);

    // ---------- GYRO ----------
    if(IMU.gyroscopeAvailable())
      IMU.readGyroscope(gx,gy,gz);

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

      mqttClient.print("\"heading\":");
      mqttClient.print(continuousHeading);
      mqttClient.print(",");

      mqttClient.print("\"calibrated\":true}");

      mqttClient.print(",\"timestamp\":");
      mqttClient.print(timeClient.getEpochTime());
      mqttClient.print("}");

      mqttClient.endMessage();
    }
  }
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