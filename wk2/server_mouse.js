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

// === Mouse Control ===
// Run mock data through moveMouseFromIMU every 50 ms.
// Toggle with the MOCK_MOUSE env var: MOCK_MOUSE=1 node server_mouse.js
const MOCK_MOUSE = false; // 0
let mouseEnabled = true; // toggle here

// Toggle mouseEnabled with spacebar in the terminal
const readline = require("readline");
readline.emitKeypressEvents(process.stdin);
if (process.stdin.isTTY) process.stdin.setRawMode(true);
process.stdin.on("keypress", (str, key) => {
  if (key.name === "space") {
    mouseEnabled = !mouseEnabled;
    console.log(`🖱 Mouse control: ${mouseEnabled ? "ENABLED" : "DISABLED"}`);
  }
  if (key.ctrl && key.name === "c") process.exit();
});

// lerp target (absolute screen coords)
let targetX = null;
let targetY = null; 
let lerpX = null;
let lerpY = null;

// Lerp loop — runs at ~60fps, slides cursor toward target
setInterval(() => {
  if (!mouseEnabled || targetX === null) return;
  const t = 0.12; // lerp factor: 0 = no movement, 1 = instant
  lerpX = lerpX + (targetX - lerpX) * t;
  lerpY = lerpY + (targetY - lerpY) * t;
  const nx = Math.round(lerpX);
  const ny = Math.round(lerpY);
  try { robot.moveMouse(nx, ny); } catch (e) {}
  if (typeof io !== "undefined") io.emit("mouse-pos", { x: nx, y: ny });
}, 1000 / 60);

const SENSITIVITY = 6;   // pixels per unit — tune this
const DEAD_ZONE = 1.5;   // deg/s — ignore small jitter

// Processes raw sensor payload, updates mouse lerp target, and returns a
// structured entry ready to be stored and emitted to clients.
// Returns null if the payload has no sensor field.
function processSensorData(parsed, source = "mqtt") {
  if (!parsed?.sensor) return null;

  const data = parsed.sensor;

  // derive movement fields from raw sensor
  const posX = Math.sin(data.heading * Math.PI / 180);
  const posY = Math.cos(data.heading * Math.PI / 180);
  const mag  = Math.sqrt(data.gx ** 2 + data.gy ** 2);
  const effectiveMag = mag < DEAD_ZONE ? 0 : mag;

  const { width: screenW, height: screenH } = robot.getScreenSize();

  // init lerp at current cursor position on first call
  if (lerpX === null) {
    const mouse = robot.getMousePos();
    lerpX = mouse.x;
    lerpY = mouse.y;
    targetX = mouse.x;
    targetY = mouse.y;
  }

  // advance target by sensor delta and clamp to screen bounds
  targetX = Math.max(0, Math.min(targetX + posX * effectiveMag * SENSITIVITY * 0.1, screenW - 1));
  targetY = Math.max(0, Math.min(targetY - posY * effectiveMag * SENSITIVITY * 0.1, screenH - 1));

  // Sensor Data Shape from Arduino will be just ...data
  // We process the rest here in the server
  return {
    sensor: {
      ...data,          // gx, gy, ax, ay, heading, fwdHeading, calibrated
      posX,             // sin(heading) — direction X
      posY,             // cos(heading) — direction Y
      mag,              // gyro speed magnitude
      mouseTargetX: targetX,  // absolute mouse target X in screen coords
      mouseTargetY: targetY,  // absolute mouse target Y in screen coords
    },
    screenSize: { width: screenW, height: screenH },
    timestamp: parsed.timestamp || Date.now(),
    source,
  };
}

// ===============================
// REST
// ===============================
app.get("/", (req, res) => {
  res.send({ status: "ok", message: "Hello Magic Wand 🪄" });
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
const MQTT_TOPIC = "kezia/imu/"; // subtopic = data or power
const MQTT_SUBTOPIC = {
  DATA: "data",
  POWER: "power",
}

const mqttClient = mqtt.connect(MQTT_BROKER, {
  username: process.env.MQTT_USER || "public",
  password: process.env.MQTT_PASS || "public",
});

mqttClient.on("connect", () => {
  console.log("📡 Connected to MQTT broker:", MQTT_BROKER);

  for (const [_, sub] of Object.entries(MQTT_SUBTOPIC)) {
    mqttClient.subscribe(MQTT_TOPIC + sub, (err) => {
      if (err) {
        console.error(`MQTT Subscribe error for ${sub}:`, err);
      } else {
        console.log(`📥 Subscribed to topic: ${MQTT_TOPIC + sub}`);
      }
    });
  }

  mqttClient.on("message", (topic, message) => {
    // Subtopic = data
    if (topic.includes(MQTT_SUBTOPIC.DATA)) {
      try {
      const parsed = JSON.parse(message.toString());
      const entry = processSensorData(parsed, "mqtt");
      if (!entry) return;

      if (sensorData.length >= 1000) sensorData.shift();
      sensorData.push(entry);

      console.log("📡 MQTT sensor data:", entry);

      // emit to socket so frontend can update in real time
      io.emit("sensor-realtime-receive", entry);
      } catch (err) {
        console.error("MQTT message parse error:", err.message);
      }
    }

    // Subtopic = power
    if (topic.includes(MQTT_SUBTOPIC.POWER)) {
      const powerMsg = message.toString();
      console.log("⚡ MQTT power message:", powerMsg);
      try {
        const parsed = JSON.parse(powerMsg);
        if (parsed.power === false) {
          mouseEnabled = false;
          console.log("🖱 Mouse control: DISABLED (power off)");
        } else if (parsed.power === true) {
          mouseEnabled = true;
          console.log("🖱 Mouse control: ENABLED (power on)");
        }
        io.emit("sensor-power", { power: mouseEnabled, timestamp: Date.now() });
      } catch (err)  {
        // plain string fallback
        if (powerMsg === "false") {
          mouseEnabled = false;
          console.log("🖱 Mouse control: DISABLED (power off)");
        } else if (powerMsg === "true") {
          mouseEnabled = true;
          console.log("🖱 Mouse control: ENABLED (power on)");
        }
        io.emit("sensor-power", { power: mouseEnabled, timestamp: Date.now() });
      }
    }
  });

  mqttClient.on("error", (err) => {
    console.error("MQTT error:", err);
  });

  // ==== MOCK DATA PUBLISHING ===
  // Start mock publishing once connected so the message flows through
  // the real mqttClient.on("message") handler end-to-end.
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

  if (mouseEnabled && MOCK_MOUSE) {
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

// ===============================
// TCP SERVER [deprecated]
// ===============================
// const tcpServer = net.createServer((socket) => {
//   console.log(
//     "Arduino connected (TCP):",
//     socket.remoteAddress + ":" + socket.remotePort
//   );

//   socket._buffer = "";

//   socket.on("data", (data) => {
//     try {
//       socket._buffer += data.toString();
//       let buf = socket._buffer;

//       let start = buf.indexOf("{");

//       while (start !== -1) {
//         let depth = 0;
//         let end = -1;

//         for (let i = start; i < buf.length; i++) {
//           const ch = buf[i];
//           if (ch === "{") depth++;
//           else if (ch === "}") depth--;

//           if (depth === 0) {
//             end = i;
//             break;
//           }
//         }

//         if (end === -1) break;

//         const piece = buf.slice(start, end + 1);
//         buf = buf.slice(end + 1);

//         try {
//           const parsed = JSON.parse(piece);

//           if (parsed?.sensor) {

//             // 🔥 MOVE MOUSE HERE
//             const data = {
//               ...parsed.sensor,
//               posX: Math.sin(parsed.sensor.heading * Math.PI / 180),
//               posY: Math.cos(parsed.sensor.heading * Math.PI / 180),
//               mag: Math.sqrt(parsed.sensor.gx ** 2 + parsed.sensor.gy ** 2),
//             };
//             const mouseTarget = moveMouseFromIMU(data);

//             const entry = {
//               sensor: { ...data, ...mouseTarget },
//               timestamp: parsed.timestamp || Date.now(),
//               source: "tcp",
//             };

//             if (sensorData.length >= 1000) sensorData.shift();
//             sensorData.push(entry);

//             io.emit("sensor-realtime-receive", entry);

//             console.log("🛜 TCP sensor data:", entry);
//           }
//         } catch (e) {
//           console.warn("Malformed TCP JSON:", e.message);
//         }

//         start = buf.indexOf("{");
//       }

//       socket._buffer = buf;
//     } catch (e) {
//       console.error("TCP processing error:", e.message);
//     }
//   });

//   socket.on("end", () => {
//     console.log("Arduino (TCP) disconnected");
//   });

//   socket.on("error", (err) => {
//     console.error("TCP socket error:", err);
//   });
// });

// tcpServer.listen(tcpPort, () => {
//   console.log(`🛜 TCP server running on port ${tcpPort}`);
// });

// ===============================
// SOCKET.IO CLIENT HANDLING
// ===============================
io.on("connection", (socket) => {
  console.log("🔌 Dashboard connected:", socket.id);

  // update user with the most latest sensor data history on connect
  socket.emit("sensor-initial-data", sensorData); 

  // user id info
  socket.emit("user", { id: socket.id });

  // toggle mouse control from dashboard (optional)
  socket.on("toggle-mouse", () => {
    mouseEnabled = !mouseEnabled;
    console.log("🖱 Mouse control:", mouseEnabled ? "ENABLED" : "DISABLED");
  });

  // disconnect
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
