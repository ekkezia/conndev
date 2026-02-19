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

const app = express();
const port = process.env.PORT || 4000;

app.use(cors());
app.use(express.json());

let sensorData = [];

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
// MQTT CLIENT (NEW)
// ===============================
const mqtt = require("mqtt");

// Change to your broker
const MQTT_BROKER = process.env.MQTT_BROKER || "mqtt://broker.hivemq.com";
const MQTT_TOPIC = process.env.MQTT_TOPIC || "imu/sensor";

const mqttClient = mqtt.connect(MQTT_BROKER);

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
// TCP SERVER (UNCHANGED)
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

  socket.on("sensor-realtime-send", (data) => {
    if (!data?.sensor) return;

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
