# Connected Devices — Week 1 Response

This repository contains a Week 1 response for the Connected Devices class.

Overview
- Arduino reads Nano 33 IoT's internal IMU and LSM303D magnetometer sensor
- The Arduino code sends sensor values as message over WiFi using a MQTT connection. 
- Sensor on A0 drives the X position of the spotlight; sensor on A1 drives the Y position of the spotlight.
- Clicking the canvas toggles between showing the camera feed and loading a random Wikipedia entry.

Usage
1. Open [magic_wand_v3.5](magic_wand_3.5) in the Arduino IDE, edit `arduino_secrets.h` with your network credentials, and upload to your board.
2. Go to [dashboard](dashboard), install `npm install` and run `npm start`
3. Running the server:
a. Deployed:
   - Create `env` and specify `SERVER_URL` with your server url. Mine is deployed on Render (contact me for details).
b. Local:
   -  Run locally with `node server_relay.js`
   -  A version that enables mouse control is available by running `node mouse.js`. Install `robotjs` before using this. Mind that this version cannot be deployed to production because you can only control your mouse locally.


Files
- [index.html](index.html)
- [script.js](script.js)
- [wifi_tcp](wifi_tcp) — Arduino sketch and secrets for the WiFi TCP connection.

Future ideas
- Turn this into a small multiplayer search game where several users on the same network collaborate or compete to find items (a lightweight local multiplayer experience).

Notes
- This project is intended as a simple proof-of-concept for reading analog sensors from an Arduino and streaming/using the values in a web UI over WiFi TCP.

