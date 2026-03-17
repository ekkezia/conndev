#include <Arduino_LSM6DS3.h>
#include <Adafruit_LSM303_U.h>
#include <Adafruit_Sensor.h>
#include <WiFiNINA.h>
#include <WiFiUdp.h>
#include <NTPClient.h>
#include <ArduinoMqttClient.h>
#include <Wire.h>
#include "arduino_secrets.h"
#include <DFRobotDFPlayerMini.h>
// #include <SoftwareSerial.h>

// SoftwareSerial dfSerial(10, 11); // RX, TX for DFPlayer Mini
// DFRobotDFPlayerMini dfplayer;
// bool dfplayerAvailable = false;

unsigned long debounceDelay = 50;

// ================= WIFI =================
WiFiClient wifi;
MqttClient mqttClient(wifi);
WiFiUDP ntpUDP;
NTPClient timeClient(ntpUDP, "pool.ntp.org", 0, 60000);

// ================= MQTT =================
char broker[] = "public.cloud.shiftr.io";
int port = 1883;
char topic[] = "kezia/imu/data";
String clientID = "keziaIMU_";
const String deviceName = "kezia";

// ================= TIMING =================
const int sendInterval = 200;
unsigned long lastMqttSend = 0;

// ================= IMU + Mag Sensor =================
float ax, ay, az, gx, gy, gz, pitch, roll, heading;
Adafruit_LSM303_Mag_Unified mag(12345);
int sensitivity; // defined by A3

// LED indicators on star
int starLedPins[] = {2, 3, 4, 5, 6};
const int starLedCount = 5;
// DRAW START/STOP
const int drawBtnPin = 11;
int drawState = LOW; // also acts as drawState | LOW = stop, HIGH = start
int drawBtnState = HIGH;
int lastDrawBtnState = HIGH;
unsigned long lastDrawBtnDebounce = 0;
//
// CLICK
const int clickBtnPin = 12;
int clickState = LOW;
int clickBtnState = HIGH;
int lastClickBtnState = HIGH;
unsigned long lastClickBtnDebounce = 0;
int mqttClick = false; // state for mqtt toggle purpose
//

void setup()
{
  Serial.begin(115200);
  while (!Serial); // just add this

  // LED Initialization
  pinMode(clickBtnPin, INPUT_PULLUP);
  pinMode(drawBtnPin, INPUT_PULLUP);

  for (int i = 0; i < starLedCount; i++)
    pinMode(starLedPins[i], OUTPUT);

  // WiFi Network
  connectToNetwork();
  byte mac[6];
  WiFi.macAddress(mac);
  for (int i = 0; i < 3; i++)
    clientID += String(mac[i], HEX);

  // MQTT
  mqttClient.setId(clientID);
  mqttClient.setUsernamePassword(
      SECRET_MQTT_USER,
      SECRET_MQTT_PASS);
  mqttClient.setKeepAliveInterval(1500); // send last will after 1.5s of being disconnected

  // IMU + Mag
  IMU.begin();
  mag.begin();
  mag.enableAutoRange(true);
  timeClient.begin();

  // dfSerial.begin(9600);
  // if (dfplayer.begin(dfSerial))
  // {
  //   dfplayerAvailable = true;
  //   dfplayer.volume(20); // Set volume (0-30)
  //   Serial.println("DFPlayer Mini detected.");
  // }
  // else
  // {
  //   dfplayerAvailable = false;
  //   Serial.println("DFPlayer Mini not detected, using buzzer.");
  // }

  publishPower(true); // publish power whenever it is turned on
}

void loop()
{

  // Connect to WiFi + MQTT
  mqttClient.poll();
  unsigned long now = millis();

  if (!mqttClient.connected())
    connectToBroker();

  // ====== DRAW START/STOP ============
  int drawBtnReading = digitalRead(drawBtnPin);

  if (drawBtnReading != lastDrawBtnState)
  {
    lastDrawBtnDebounce = millis();
  }

  if ((millis() - lastDrawBtnDebounce) > debounceDelay)
  {

    if (drawBtnReading != drawBtnState)
    {

      drawBtnState = drawBtnReading;

      if (drawBtnState == LOW)
      { // pressed
        drawState = !drawState;
        animateStarLEDs();
      }

      // perform mqtt draw
      pulseDraw();
      // play sound
      // makeDrawSound();
    }
  }

  for (int i = 0; i < starLedCount; i++)
    digitalWrite(starLedPins[i], drawState);

  lastDrawBtnState = drawBtnReading;

  // ================================
  // ============ CLICK =============
  // only performs 'click' if the drawState is HIGH / 'start'
  if (drawState)
  {
    int clickBtnReading = digitalRead(clickBtnPin);

    if (clickBtnReading != lastClickBtnState)
    {
      lastClickBtnDebounce = millis();
    }

    if ((millis() - lastClickBtnDebounce) > debounceDelay)
    {

      if (clickBtnReading != clickBtnState)
      { // click btn is clicked (track by state changes)
        clickBtnState = clickBtnReading;
        if (clickBtnState == LOW)
        { // only trigger when state changes from HIGH -> LOW
          blinkAllStars();
          // performs mqtt click
          pulseClick();
          // plays sound
          // makeClickSound();
        }
      }
    }
    lastClickBtnState = clickBtnReading;
  }

  // ======= NON-INTERACTIONAL LED STATES ============
  // takes from the drawing state: start/stop
  for (int i = 0; i < starLedCount; i++)
    digitalWrite(starLedPins[i], drawState);
  // ====================================

  // if (!drawState)
  //   return; // do not read and send mqtt sensor msg if drawState is LOW / 'stop'

  // ================= SENSOR UPDATE =================
  // sends every x sendInterval
  if (now - lastMqttSend >= sendInterval)
  {

    lastMqttSend = now;

    // ---------- READ ACCEL ----------
    if (IMU.accelerationAvailable())
      IMU.readAcceleration(ax, ay, az);

    // ---------- GYRO ----------
    if (IMU.gyroscopeAvailable())
      IMU.readGyroscope(gx, gy, gz);

    // ---------- SENSITIVITY ----------
    int sensitivityReading = analogRead(A3);
    sensitivity = floor(map(sensitivityReading, 0, 1023, 1, 10));

    // // ---------- NORMALIZATION ----------
    // sensors_event_t event;
    // mag.getEvent(&event);

    // roll = atan2(ay, az) * 180.0 / PI;
    // pitch = atan(-ax / sqrt(ay * ay + az * az)) * 180.0 / PI;
    // heading = atan2(event.magnetic.y, event.magnetic.x) * 180.0 / PI;
    // // Convert -180 → 180 into 0 → 360
    // if (heading < 0) {
    //   heading += 360.0;
    // }

    // ================= MQTT =================

    if (mqttClient.connected())
    { // todo: stop sending when drawState 'stop'
      publishMqtt();
    }
  }
}

// =================================================
// LED ANIMATION
// =================================================

void animateStarLEDs()
{

  for (int i = 0; i < starLedCount; i++)
  {
    digitalWrite(starLedPins[i], HIGH);
    delay(80);
    digitalWrite(starLedPins[i], LOW);
  }

  for (int i = starLedCount - 2; i > 0; i--)
  {
    digitalWrite(starLedPins[i], HIGH);
    delay(80);
    digitalWrite(starLedPins[i], LOW);
  }
}

void blinkAllStars()
{

  for (int j = 0; j < 3; j++)
  {

    for (int i = 0; i < starLedCount; i++)
      digitalWrite(starLedPins[i], HIGH);

    delay(80);

    for (int i = 0; i < starLedCount; i++)
      digitalWrite(starLedPins[i], LOW);

    delay(80);
  }
}
// ========================================

// ============== NETWORK =================
void connectToNetwork()
{
  while (WiFi.status() != WL_CONNECTED)
  {
    Serial.println("Connecting to WiFi...");
    WiFi.begin(SECRET_SSID, SECRET_PASS);
    delay(1000);
  }
}
// ========================================

// ============== MQTT =================
boolean connectToBroker()
{
  Serial.println("Connecting to broker...");

  // last will must be set BEFORE connect()
  mqttClient.beginWill("kezia/imu/power", true, 0);
  mqttClient.print("{\"power\": false}");
  mqttClient.endWill();

  if (!mqttClient.connect(broker, port))
  {
    Serial.print("MQTT connection failed! Error: ");
    Serial.println(mqttClient.connectError());
    return false;
  }

  Serial.println("Broker connected.");
  publishPower(true); // Only send power ON once after connect
  publishControl();   // Optionally send initial control state
  return true;
}
// ========================================

// ============== Sound Util Fn =================
// void makeClickSound()
// {
//   if (dfplayerAvailable)
//   {
//     dfplayer.play(2); // Play 0002.mp3 for click
//   }
// }

// void makeDrawSound()
// {
//   if (dfplayerAvailable)
//   {
//     if (drawState)
//       dfplayer.play(1); // Play 0001.mp3 for draw start
//     else
//       dfplayer.play(3); // Play 0003.mp3 for draw stop (optional)
//   }
// }

// ============== MQTT Util Fn =================
void pulseClick()
{
  if (!mqttClient.connected()) return;
  mqttClient.beginMessage("kezia/imu/click");
  mqttClient.print(true);
  mqttClient.endMessage();
  Serial.println("CLICK!");
}

void pulseDraw()
{
  Serial.println(drawState ? "START" : "STOP");
  publishControl();
}

void publishControl()
{
  if (!mqttClient.connected())
    return;
  mqttClient.beginMessage("kezia/imu/draw");
  mqttClient.print(drawState ? "\"start\"" : "\"stop\"");
  mqttClient.endMessage();
}

void publishPower(bool on)
{
  if (!mqttClient.connected())
    return;
  mqttClient.beginMessage("kezia/imu/power");
  mqttClient.print("{");
  mqttClient.print("\"power\":");
  mqttClient.print(on ? "true" : "false");
  mqttClient.print("}");
  mqttClient.endMessage();
}

void publishMqtt()
{
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

  mqttClient.print("\"sensitivity\":");
  mqttClient.print(sensitivity);
  mqttClient.print(",");

  mqttClient.print("\"timestamp\":"); // ms
  unsigned long long tsMs =
      (unsigned long long)timeClient.getEpochTime() * 1000ULL +
      (millis() % 1000);

  mqttClient.print((unsigned long long)tsMs);
  mqttClient.print("}}");

  mqttClient.endMessage();
}

// NOTE
// There are some delays that may cause side effect
// Open for improvement
