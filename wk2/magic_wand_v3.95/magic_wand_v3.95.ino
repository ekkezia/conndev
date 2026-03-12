unsigned long debounceDelay = 50;

// LED indicators on star
int starLedPins[] = {2,3,4,5,6};
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

void setup() {

  pinMode(drawBtnPin, INPUT_PULLUP);

  for(int i=0;i<starLedCount;i++)
    pinMode(starLedPins[i], OUTPUT);
}

void loop() {

  // ====== DRAW START/STOP ============
  int drawBtnReading = digitalRead(drawBtnPin);

  if (drawBtnReading != lastDrawBtnState) {
    lastDrawBtnDebounce = millis();
  }

  if ((millis() - lastDrawBtnDebounce) > debounceDelay) {
    
    if (drawBtnReading != drawBtnState) {
    
      drawBtnState = drawBtnReading;

      if (drawBtnState == LOW) {  // pressed
        drawState = !drawState;
        animateStarLEDs();
      }

      // perform mqtt draw
      pulseDraw();
    }
  }

  for(int i=0;i<starLedCount;i++)
    digitalWrite(starLedPins[i], drawState);

  
  lastDrawBtnState = drawBtnReading;

  // ================================
  // ============ CLICK =============
  // only performs 'click' if the drawState is HIGH / 'start'
  if (drawState) {
    int clickBtnReading = digitalRead(clickBtnPin);

    if (clickBtnReading != lastClickBtnState) {
      lastClickBtnDebounce = millis();
    }

    if ((millis() - lastClickBtnDebounce) > debounceDelay) {
      
      if (clickBtnReading != clickBtnState) { // click btn is clicked (track by state changes)
        clickBtnState = clickBtnReading;
        if (clickBtnState == LOW) {   // only trigger when state changes from HIGH -> LOW
          blinkAllStars();
          // performs mqtt click
          pulseClick();
        }
      }
    }
    lastClickBtnState = clickBtnReading;
  }

  // ======= NON-INTERACTIONAL LED STATES ============
  // takes from the drawing state: start/stop
  for(int i=0;i<starLedCount;i++)
    digitalWrite(starLedPins[i], drawState);
  // ====================================

  if (!drawBtnState) return; // do not read and send mqtt sensor msg if drawState is LOW / 'stop'

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
// ========================================

// ============== NETWORK =================
// void connectToNetwork(){
//   while(WiFi.status()!=WL_CONNECTED){
//     WiFi.begin(SECRET_SSID,SECRET_PASS);
//     delay(4000);
//   }
// }

// boolean connectToBroker(){
//   return mqttClient.connect(broker,port);
// }
// ========================================

// ============== MQTT Util Fn =================
void pulseClick(){
    mqttClick = true;
    // publishControl();
    mqttClick = false; // toggle back to false immediately
    // publishControl();
    Serial.println("CLICK!");
}

void pulseDraw() {
  Serial.println(drawState == HIGH ? "START" : "STOP");
//   publishControl();
}

// void publishControl() {

//   if (!mqttClient.connected()) return;

//   mqttClient.beginMessage("kezia/imu/control");

//   mqttClient.print(",\"click\":");
//   mqttClient.print(mqttClick ? "true":"false");
//   mqttClient.print(",\"draw\":");
//   mqttClient.print(drawState); // start, stop
//   mqttClient.print("}");

//   mqttClient.endMessage();
// }
// ========================================

