# Magic Wand Dashboard

A magic wand, made possible with Arduino Nano 33 IoT & IMU that tracks your hand movement 

## Frontend: ReactJS

In the project directory, you can run:

### `npm start`

Runs the app in the development mode.\
Open [http://localhost:3000](http://localhost:3000) to view it in your browser.

## Arduino
Look at 1 folder up to `gyro_tcp.ino` and upload the code to your Arduino.

## Server
Look at 1 folder up to find `server.js`
Run:
`node server.js`

## Flow of Data
1. Arduino sends data via TCP (to be changed to MQTT) in the form of:
`{
  sensor: {
    ax: // accelerometer
    ay:
    gx: // gyrometer
    gy:
    heading: // direction of compass or magnetometer
  },
  timestamp: 
}`
2. Server has a TCP opening and **receives** Arduino data, **preprocess** it, **append** it to an store array, then **send** to Socket.io for real-time updates
3. Socket.io broadcasts to frontend client

## Dashboard Features
### Sketchpad
The sketch line is made out of an array of points.
- `heading` : radians of heading controls the direction of x & y of the points
- `gx, gy, ax, ay`: square root of both magnitudes control the pressure of the ink

### Timeline
Click on the bottom right circular button to activate timeline mode.
It will pause the current sketching and only show the drawing up until the timestamp when you have paused. 

### Graph
Click on the bottom left circular button to look at the graph.
Toggle between acceleromter, gyrometer, and magnetometer view.


