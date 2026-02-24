// ===============================
// TCP (Arduino direct connection)
// ===============================
const net = require("net");
const tcpPort = 3000;

// ===============================
// Express + Socket.IO
// ===============================
const express = require("express");
const http = require("http");
const cors = require("cors");
const { Server } = require("socket.io");
const robot = require("robotjs");

const app = express();
const port = process.env.PORT || 4000;

app.use(cors());
app.use(express.json());

let sensorData = [];

// ===============================
// MOUSE CONTROL
// ===============================
let mouseEnabled = false;

let smoothX = 0;
let smoothY = 0;

// Generates mock sensor data matching the Arduino message format
function generateMockSensor() {
  const t = Date.now() / 1000;
  return {
    ax: (Math.sin(t * 0.7) * 2).toFixed(2) * 1,
    ay: (Math.cos(t * 0.5) * 2).toFixed(2) * 1,
    az: (9.8 + Math.sin(t * 0.3) * 0.2).toFixed(2) * 1,
    gx: (Math.sin(t * 1.2) * 30).toFixed(2) * 1,   // deg/s — drives mouseY
    gy: (Math.cos(t * 0.9) * 30).toFixed(2) * 1,   // deg/s — drives mouseX
    gz: (Math.sin(t * 0.4) * 10).toFixed(2) * 1,
    heading: ((t * 20) % 360).toFixed(1) * 1,
    fwdHeading: ((t * 20) % 360).toFixed(1) * 1,
    calibrated: true,
  };
}

// Accepts sensor data in Arduino format:
// { ax, ay, az, gx, gy, gz, heading, fwdHeading, calibrated }
// Direction comes from fwdHeading; magnitude from sqrt(gx² + gy²).
function moveMouseFromIMU(sensor) {
  if (!mouseEnabled) return;
  if (sensor.gx === undefined || sensor.gy === undefined || sensor.fwdHeading === undefined) return;

  const sensitivity = 0.15; // pixels per (deg/s) per tick
  const alpha = 0.25;       // EMA smoothing factor
  const threshold = 1.5;     // deg/s — ignore small jitter

  // Magnitude: total angular velocity from gyroscope
  const magnitude = Math.sqrt(sensor.gx ** 2 + sensor.gy ** 2);
  const effectiveMag = magnitude < threshold ? 0 : magnitude;

  // Direction: unit vector from fwdHeading (degrees, 0 = up/north)
  const headingRad = (sensor.fwdHeading * Math.PI) / 180;
  const dirX = Math.sin(headingRad);   // screen right when heading = 90
  const dirY = -Math.cos(headingRad);  // screen up   when heading = 0 (inverted Y)

  smoothX = smoothX * (1 - alpha) + dirX * effectiveMag * alpha;
  smoothY = smoothY * (1 - alpha) + dirY * effectiveMag * alpha;

  const mouse = robot.getMousePos();

  robot.moveMouse(
    Math.round(mouse.x + smoothX * sensitivity),
    Math.round(mouse.y + smoothY * sensitivity)
  );
}

// Run mock data through moveMouseFromIMU every 50 ms.
// Toggle with the MOCK_MOUSE env var: MOCK_MOUSE=1 node server_mouse.js
const MOCK_MOUSE = "1";
if (MOCK_MOUSE === "1") {
  mouseEnabled = true;
  console.log("🧪 Mock mouse mode ENABLED — sending fake IMU data every 50 ms");
  setInterval(() => {
    const sensor = generateMockSensor();
    console.log("🧪 Mock sensor:", sensor);
    moveMouseFromIMU(sensor);
  }, 50);
}

// ===============================
// REST
// ===============================
app.get("/", (req, res) => {
  res.send({ status: "ok", message: "Hello!" });
});

app.get("/sensor-data", (req, res) => {
  res.json(sensorData);
});

// ===============================
// HTTP + SOCKET.IO
// ===============================
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] },
});

// ===============================
// MQTT CLIENT
// ===============================
const mqtt = require("mqtt");

const MQTT_BROKER =
  process.env.MQTT_BROKER || "mqtt://public.cloud.shiftr.io:1883";
const MQTT_TOPIC = "kezia/imu/data";

const mqttClient = mqtt.connect(MQTT_BROKER, {
  username: process.env.MQTT_USER || "public",
  password: process.env.MQTT_PASS || "public",
});

mqttClient.on("connect", () => {
  console.log("📡 Connected to MQTT broker:", MQTT_BROKER);

  mqttClient.subscribe(MQTT_TOPIC, (err) => {
    if (err) {
      console.error("MQTT Subscribe error:", err);
    } else {
      console.log("📥 Subscribed to topic:", MQTT_TOPIC);
    }
  });
});

mqttClient.on("message", (topic, message) => {
  try {
    const parsed = JSON.parse(message.toString());
    if (!parsed?.sensor) return;

    // 🔥 MOVE MOUSE HERE
    moveMouseFromIMU(parsed.sensor);

    const entry = {
      sensor: parsed.sensor,
      timestamp: parsed.timestamp || Date.now(),
      source: "mqtt",
    };

    if (sensorData.length >= 1000) sensorData.shift();
    sensorData.push(entry);

    io.emit("sensor-realtime-receive", entry);

    console.log("📡 Received sensor data from MQTT:", entry);
  } catch (err) {
    console.error("MQTT message parse error:", err.message);
  }
});

mqttClient.on("error", (err) => {
  console.error("MQTT error:", err);
});

// ===============================
// TCP SERVER
// ===============================
const tcpServer = net.createServer((socket) => {
  console.log(
    "Arduino connected (TCP):",
    socket.remoteAddress + ":" + socket.remotePort
  );

  socket._buffer = "";

  socket.on("data", (data) => {
    try {
      socket._buffer += data.toString();
      let buf = socket._buffer;

      let start = buf.indexOf("{");

      while (start !== -1) {
        let depth = 0;
        let end = -1;

        for (let i = start; i < buf.length; i++) {
          const ch = buf[i];
          if (ch === "{") depth++;
          else if (ch === "}") depth--;

          if (depth === 0) {
            end = i;
            break;
          }
        }

        if (end === -1) break;

        const piece = buf.slice(start, end + 1);
        buf = buf.slice(end + 1);

        try {
          const parsed = JSON.parse(piece);

          if (parsed?.sensor) {

            // 🔥 MOVE MOUSE HERE
            moveMouseFromIMU(parsed.sensor);

            const entry = {
              sensor: parsed.sensor,
              timestamp: parsed.timestamp || Date.now(),
              source: "tcp",
            };

            if (sensorData.length >= 1000) sensorData.shift();
            sensorData.push(entry);

            io.emit("sensor-realtime-receive", entry);

            console.log("🛜 TCP sensor data:", entry);
          }
        } catch (e) {
          console.warn("Malformed TCP JSON:", e.message);
        }

        start = buf.indexOf("{");
      }

      socket._buffer = buf;
    } catch (e) {
      console.error("TCP processing error:", e.message);
    }
  });

  socket.on("end", () => {
    console.log("Arduino (TCP) disconnected");
  });

  socket.on("error", (err) => {
    console.error("TCP socket error:", err);
  });
});

tcpServer.listen(tcpPort, () => {
  console.log(`🛜 TCP server running on port ${tcpPort}`);
});

// ===============================
// SOCKET.IO CLIENT HANDLING
// ===============================
io.on("connection", (socket) => {
  console.log("🔌 Dashboard connected:", socket.id);

  socket.emit("sensor-initial-data", sensorData);
  socket.emit("user", { id: socket.id });

  // 🔥 TOGGLE MOUSE CONTROL
  socket.on("toggle-mouse", () => {
    mouseEnabled = !mouseEnabled;
    console.log("🖱 Mouse control:", mouseEnabled ? "ENABLED" : "DISABLED");
  });

  socket.on("sensor-realtime-send", (data) => {
    if (!data?.sensor) return;

    moveMouseFromIMU(data.sensor);

    const entry = {
      ...data,
      timestamp: data.timestamp || Date.now(),
      source: "socket",
    };

    if (sensorData.length >= 1000) sensorData.shift();
    sensorData.push(entry);

    io.emit("sensor-realtime-receive", entry);
  });

  socket.on("disconnect", () => {
    console.log("🪫 Dashboard disconnected:", socket.id);
  });
});

// ===============================
// START SERVER
// ===============================
server.listen(port, () => {
  console.log(`🌎 Server running at http://localhost:${port}`);
});
