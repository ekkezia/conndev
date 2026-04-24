# Magic Wand

Overview
- Arduino reads Nano 33 IoT's internal IMU and LSM303D magnetometer sensor
- The Arduino code sends sensor values as message over WiFi using a MQTT connection. 

Usage
1. Open [magic_wand_v3.5](magic_wand_udp) in the Arduino IDE, edit `arduino_secrets.h` with your network credentials, and upload to your board.
2. Go to [dashboard](dashboard), install `npm install` and run `npm start`
3. Running the server:
a. Deployed:
   - Create `env` and specify `SERVER_URL` with your server url. Mine is deployed on Render (contact me for details).
b. Local:
   -  Run UDP relay with `node server-udp.js` (or `npm run start:udp`)
   -  Run real local mouse override with `node server-mouse.js` (or `npm run start:mouse`). Install `robotjs` first. This is local-only and not suitable for remote deployment.


Files
- [index.html](index.html)
- [script.js](script.js)
- [wifi_tcp](wifi_tcp) — Arduino sketch and secrets for the WiFi TCP connection.

Future ideas
- Turn this into a small multiplayer search game where several users on the same network collaborate or compete to find items (a lightweight local multiplayer experience).

Notes
- This project is intended as a simple proof-of-concept for reading analog sensors from an Arduino and streaming/using the values in a web UI over WiFi TCP.
