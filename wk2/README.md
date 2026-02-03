# Connected Devices — Week 1 Response

This repository contains a Week 1 response for the Connected Devices class.

Overview
- Arduino reads two analog sensors on pins A0 and A1.
- The Arduino sends sensor values over WiFi using a TCP connection. See the wifi_tcp folder and open the sketch in the Arduino IDE.
- Sensor on A0 drives the X position of the spotlight; sensor on A1 drives the Y position of the spotlight.
- Clicking the canvas toggles between showing the camera feed and loading a random Wikipedia entry.

Usage
1. Open [wifi_tcp/wifi_tcp.ino](wifi_tcp/wifi_tcp.ino) in the Arduino IDE, edit `arduino_secrets.h` with your network credentials, and upload to your board.
2. Open `index.html` in a browser on a machine on the same network as the Arduino/TCP server.
3. Move the sensors connected to A0/A1 to control the spotlight; click the canvas to toggle camera/wiki.

Files
- [index.html](index.html)
- [script.js](script.js)
- [wifi_tcp](wifi_tcp) — Arduino sketch and secrets for the WiFi TCP connection.

Future ideas
- Turn this into a small multiplayer search game where several users on the same network collaborate or compete to find items (a lightweight local multiplayer experience).

Notes
- This project is intended as a simple proof-of-concept for reading analog sensors from an Arduino and streaming/using the values in a web UI over WiFi TCP.

