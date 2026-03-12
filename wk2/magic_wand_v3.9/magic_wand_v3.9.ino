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
int starLedPins[] = {2,3,4,5,6};
const int starLedCount = 5;
int clickBtnPin = 12;
const int drawBtnPin = 11;  // the pin that the pushbutton is attached to

// ================= IMU =================
float ax,ay,az,gx,gy,gz;
Adafruit_LSM303_Mag_Unified mag(12345);

// ================ DRAW BUTTON ===============
int drawBtnPushCounter = 0;  // counter for the number of button presses
int drawBtnState = 0;        // current state of the button
int lastDrawBtnState = 0;    // previous state of the button

void setup() {
  // initialize the button pin as a input:
  pinMode(clickBtnPin,INPUT_PULLUP);
  pinMode(drawBtnPin,INPUT_PULLUP);

  // initialize the LED as an output:
  for(int i=0;i<starLedCount;i++)
    pinMode(starLedPins[i],OUTPUT);

  // IMU
  IMU.begin();
  mag.begin();
  mag.enableAutoRange(true);

  // initialize serial communication:
  Serial.begin(9600);
}


void loop() {
  // ===== CLICK BUTTON =====
  // read the pushbutton input pin:
  drawBtnState = digitalRead(drawBtnPin);

  // compare the buttonState to its previous state
  if (drawBtnState != lastDrawBtnState) {
    // if the state has changed, increment the counter
    if (drawBtnState == HIGH) {
      // if the current state is HIGH then the button went from off to on:
      drawBtnPushCounter++;
      Serial.println("on");
      Serial.print("number of button pushes: ");
      Serial.println(drawBtnPushCounter);
    } else {
      // if the current state is LOW then the button went from on to off:
      Serial.println("off");
    }
    // Delay a little bit to avoid bouncing
    delay(50);
  }
  // save the current state as the last state, for next time through the loop
  lastDrawBtnState = drawBtnState;

  // turns on the LED every four button pushes by checking the modulo of the
  // button push counter. the modulo function gives you the remainder of the
  // division of two numbers:
  animateStarLEDs(); // animate LED first, then...
  allStars(drawBtnPushCounter % 2);
}

// =================================================
// LED ANIMATION
// =================================================

void animateStarLEDs(){

  for(int i=0;i<starLedCount;i++){
    digitalWrite(starLedPins[i],HIGH);
    delay(80);
    digitalWrite(starLedPins[i],LOW);
  }

  for(int i=starLedCount-2;i>0;i--){
    digitalWrite(starLedPins[i],HIGH);
    delay(80);
    digitalWrite(starLedPins[i],LOW);
  }
}

void blinkAllStars(){

  for(int j=0;j<3;j++){

    for(int i=0;i<starLedCount;i++)
      digitalWrite(starLedPins[i],HIGH);

    delay(120);

    for(int i=0;i<starLedCount;i++)
      digitalWrite(starLedPins[i],LOW);

    delay(120);
  }
}

void allStars(int state) {
  for(int i=0;i<starLedCount;i++){
    digitalWrite(starLedPins[i], state == 0 ? 1 : 0);
  }
}

