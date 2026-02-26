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
let mouseEnabled = true; // toggle here

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
// { ax, ay, az, gx, gy, gz, heading, fwdHeading, calibrated, posX, posY, mag }
// posX/posY = heading direction unit vector [-1, 1] (sin/cos of heading) → direction
// mag       = sqrt(gx² + gy²) gyro speed in deg/s                        → speed
function moveMouseFromIMU(data) {
  if (!mouseEnabled) return;
  console.log("moveMouseFromIMU called with data:", data);
  if (data.posX === undefined || data.posY === undefined || data.mag === undefined) return;

  const sensitivity = 0.15;   // pixels per (deg/s) per tick
  const alpha = 0.25;         // EMA smoothing factor
  const deadZone = 1.5;       // deg/s — ignore small jitter

  const effectiveMag = data.mag < deadZone ? 0 : data.mag;

  // posX = sin(heading) → screen X (right = positive)
  // posY = cos(heading) → negate for screen Y (up = negative screen Y)
  smoothX = smoothX * (1 - alpha) + data.posX * effectiveMag * alpha;
  smoothY = smoothY * (1 - alpha) + (-data.posY) * effectiveMag * alpha;

  const mouse = robot.getMousePos();

  const newX = Math.round(mouse.x + smoothX * sensitivity);
  const newY = Math.round(mouse.y + smoothY * sensitivity);
  robot.moveMouse(newX, newY);

  // Broadcast new mouse position to all dashboard clients
  if (typeof io !== "undefined") {
    io.emit("mouse-pos", { x: newX, y: newY });
  }
}

// Run mock data through moveMouseFromIMU every 50 ms.
// Toggle with the MOCK_MOUSE env var: MOCK_MOUSE=1 node server_mouse.js
const MOCK_MOUSE = false; // 0

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

  // Start mock publishing once connected so the message flows through
  // the real mqttClient.on("message") handler end-to-end.
  if (MOCK_MOUSE) {
    setInterval(() => {
      const sensor = generateMockSensor();
      const payload = JSON.stringify({
        source: "mock-mqtt",
        sensor: {
          ...sensor,
          posX: Math.sin(sensor.heading * Math.PI / 180),
          posY: Math.cos(sensor.heading * Math.PI / 180),
          mag: Math.sqrt(sensor.gx ** 2 + sensor.gy ** 2),
        },
        timestamp: Date.now(),
      });
      mqttClient.publish(MQTT_TOPIC, payload);
      console.log("🧪 Mock MQTT publish:", payload);
    }, 50);
  }
});

mqttClient.on("message", (topic, message) => {
  try {
    const parsed = JSON.parse(message.toString());
    if (!parsed?.sensor) return;

    // 🔥 MOVE MOUSE HERE
    const data = {
      ...parsed.sensor,
      posX: Math.sin(parsed.sensor.heading * Math.PI / 180),
      posY: Math.cos(parsed.sensor.heading * Math.PI / 180),
      mag: Math.sqrt(parsed.sensor.gx ** 2 + parsed.sensor.gy ** 2),
    }
    moveMouseFromIMU(data);

    const entry = {
      sensor: data,
      timestamp: parsed.timestamp || Date.now(),
      source: "mqtt",
    };

    if (sensorData.length >= 1000) sensorData.shift();
    sensorData.push(entry);

    io.emit("sensor-realtime-receive", entry);

    // console.log("📡 Received sensor data from MQTT:", entry);
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
            const data = {
              ...parsed.sensor,
              posX: Math.sin(parsed.sensor.heading * Math.PI / 180),
              posY: Math.cos(parsed.sensor.heading * Math.PI / 180),
              mag: Math.sqrt(parsed.sensor.gx ** 2 + parsed.sensor.gy ** 2),
            };
            moveMouseFromIMU(data);

            const entry = {
              sensor: data,
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

    const sensorData_internal = {
      ...data.sensor,
      posX: Math.sin(data.sensor.heading * Math.PI / 180),
      posY: Math.cos(data.sensor.heading * Math.PI / 180),
      mag: Math.sqrt(data.sensor.gx ** 2 + data.sensor.gy ** 2),
    };
    moveMouseFromIMU(sensorData_internal);

    const entry = {
      ...data,
      sensor: sensorData_internal,
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
