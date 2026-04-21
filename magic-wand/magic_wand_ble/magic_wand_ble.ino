#include <ArduinoBLE.h>
#include <Arduino_LSM6DS3.h>
#include <Wire.h>

// ================= LEDs =================
int starLedPins[] = {2, 3, 4, 5, 6};
const int starLedCount = 5;

// ================= DEVICE INFO =================
const char* deviceName = "KeziaIMU";

// ================= TIMING =================
const int sendInterval = 200;
unsigned long lastBleSend = 0;
unsigned long debounceDelay = 50;

// ================= SENSORS =================
float ax, ay, az, gx, gy, gz;
int sensitivity;

// ================= BUTTONS =================
const int drawBtnPin  = 11;
int drawState = LOW, drawBtnState = HIGH, lastDrawBtnState = HIGH;
unsigned long lastDrawBtnDebounce = 0;

const int clickBtnPin = 12;
int clickBtnState = HIGH, lastClickBtnState = HIGH;
unsigned long lastClickBtnDebounce = 0;

// ================= LED 4 PULSE =================
unsigned long led4PulseStart = 0;
bool led4Pulsing = false;

// ================= BLE =================
// Custom service + characteristics
// You can keep these UUIDs fixed and use them on the laptop side.
BLEService wandService("19B10000-E8F2-537E-4F6C-D104768A1214");

// Notify latest IMU packet as JSON
BLEStringCharacteristic imuDataChar(
  "19B10001-E8F2-537E-4F6C-D104768A1214",
  BLERead | BLENotify,
  220
);

// Notify draw state changes: "start" / "stop"
BLEStringCharacteristic drawChar(
  "19B10002-E8F2-537E-4F6C-D104768A1214",
  BLERead | BLENotify,
  16
);

// Notify click pulses: "click"
BLEStringCharacteristic clickChar(
  "19B10003-E8F2-537E-4F6C-D104768A1214",
  BLERead | BLENotify,
  16
);

// Optional power/status characteristic
BLEStringCharacteristic statusChar(
  "19B10004-E8F2-537E-4F6C-D104768A1214",
  BLERead | BLENotify,
  32
);

// =========================================
// DEBUG UTILS
// =========================================
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
// BLE HELPERS
// =========================================
bool publishImuData() {
  String payload = "{\"device\":\"";
  payload += deviceName;
  payload += "\",\"sensor\":{";
  payload += "\"ax\":" + String(ax, 6) + ",";
  payload += "\"ay\":" + String(ay, 6) + ",";
  payload += "\"az\":" + String(az, 6) + ",";
  payload += "\"gx\":" + String(gx, 6) + ",";
  payload += "\"gy\":" + String(gy, 6) + ",";
  payload += "\"gz\":" + String(gz, 6) + ",";
  payload += "\"sensitivity\":" + String(sensitivity) + ",";
  payload += "\"timestamp\":" + String(millis());
  payload += "}}";

  imuDataChar.writeValue(payload);
  Serial.print("BLE imu: ");
  Serial.println(payload);
  return true;
}

void publishDrawState() {
  String value = drawState ? "start" : "stop";
  drawChar.writeValue(value);
  Serial.print("BLE draw: ");
  Serial.println(value);
}

void pulseClick() {
  clickChar.writeValue("click");
  Serial.println("BLE CLICK!");
}

void publishStatus(const String& s) {
  statusChar.writeValue(s);
  Serial.print("BLE status: ");
  Serial.println(s);
}

// =========================================
// SETUP
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

  // ------ TEST 0: BLE ------
  if (!BLE.begin()) {
    Serial.println("BLE start failed");
    blinkFail(starLedPins[0]);
    hangWithBlink(0);
    return;
  }
  blinkSuccess(starLedPins[0]);

  // ------ TEST 1: IMU ------
  if (!IMU.begin()) {
    Serial.println("IMU start failed");
    blinkFail(starLedPins[1]);
    hangWithBlink(1);
    return;
  }
  blinkSuccess(starLedPins[1]);

  // BLE peripheral config
  BLE.setLocalName(deviceName);
  BLE.setDeviceName(deviceName);
  BLE.setAdvertisedService(wandService);

  wandService.addCharacteristic(imuDataChar);
  wandService.addCharacteristic(drawChar);
  wandService.addCharacteristic(clickChar);
  wandService.addCharacteristic(statusChar);

  BLE.addService(wandService);

  imuDataChar.writeValue("{\"boot\":\"ready\"}");
  drawChar.writeValue("stop");
  clickChar.writeValue("idle");
  statusChar.writeValue("setup-complete");

  BLE.advertise();

  blinkSuccess(starLedPins[2]);
  Serial.println("BLE advertising as KeziaIMU");
}

// =========================================
// LOOP
// =========================================
void loop() {
  unsigned long now = millis();

  // Keep BLE stack responsive
  BLEDevice central = BLE.central();

  if (central) {
    Serial.print("Connected to central: ");
    Serial.println(central.address());
    publishStatus("connected");

    while (central.connected()) {
      unsigned long loopNow = millis();

      // ====== DRAW START/STOP ======
      int drawBtnReading = digitalRead(drawBtnPin);
      if (drawBtnReading != lastDrawBtnState) {
        lastDrawBtnDebounce = loopNow;
      }

      if ((loopNow - lastDrawBtnDebounce) > debounceDelay) {
        if (drawBtnReading != drawBtnState) {
          drawBtnState = drawBtnReading;
          if (drawBtnState == LOW) {
            drawState = !drawState;
            animateStarLEDs();
            publishDrawState();
          }
        }
      }
      lastDrawBtnState = drawBtnReading;

      // ====== CLICK ======
      if (drawState) {
        int clickBtnReading = digitalRead(clickBtnPin);
        if (clickBtnReading != lastClickBtnState) {
          lastClickBtnDebounce = loopNow;
        }

        if ((loopNow - lastClickBtnDebounce) > debounceDelay) {
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

      // ====== SENSOR + BLE ======
      if (loopNow - lastBleSend >= sendInterval) {
        lastBleSend = loopNow;

        if (IMU.accelerationAvailable()) IMU.readAcceleration(ax, ay, az);
        if (IMU.gyroscopeAvailable())    IMU.readGyroscope(gx, gy, gz);

        sensitivity = 5; // same fallback as your current code
        publishImuData();

        digitalWrite(starLedPins[4], HIGH);
        led4PulseStart = loopNow;
        led4Pulsing = true;
      }

      // restore LED 4 after pulse
      if (led4Pulsing && (loopNow - led4PulseStart >= 30)) {
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

      BLE.poll();
    }

    Serial.println("Central disconnected");
    publishStatus("disconnected");
  } else {
    // idle advertising animation/state
    for (int i = 0; i < starLedCount; i++) {
      digitalWrite(starLedPins[i], LOW);
    }
    BLE.poll();
  }
}