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

function moveMouseFromIMU(sensor) {
  if (!mouseEnabled) return;
  if (sensor.pitch === undefined || sensor.roll === undefined) return;

  const sensitivity = 8;
  const alpha = 0.2;     // smoothing factor
  const deadZone = 0.5;  // ignore tiny jitter

  const roll = Math.abs(sensor.roll) < deadZone ? 0 : sensor.roll;
  const pitch = Math.abs(sensor.pitch) < deadZone ? 0 : sensor.pitch;

  smoothX = smoothX * (1 - alpha) + roll * alpha;
  smoothY = smoothY * (1 - alpha) + pitch * alpha;

  const mouse = robot.getMousePos();

  robot.moveMouse(
    mouse.x + smoothX * sensitivity,
    mouse.y + smoothY * sensitivity
  );
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
