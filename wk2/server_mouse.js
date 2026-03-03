const { db } = require("./firebase.js");
const { ref, push } = require("firebase/database");

// Throttle Firebase writes — at most once every N ms (Arduino sends at 50Hz = 20/s)
const FIREBASE_WRITE_INTERVAL = 3000; // ms — 1 write/sec
let lastFirebaseWrite = 0;

// ===============================
// Express + Socket.IO
// ===============================
const express = require("express");
const http = require("http");
const cors = require("cors");
const { Server } = require("socket.io");
const robot = require("robotjs");
const { spawn } = require("child_process");

function playClickSound() {
  spawn("afplay", ["/System/Library/Sounds/Tink.aiff"], { detached: true, stdio: "ignore" }).unref();
}

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

  const ROT_GAIN = 5;
  const TILT_GAIN = 3.5;
  const DEAD_ZONE = 3;

// lerp target (absolute screen coords)
let targetX = null;
let targetY = null; 
let lerpX = null;
let lerpY = null;

let calibration = null;

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

// Processes raw sensor payload, updates mouse lerp target, and returns a
// structured entry ready to be stored and emitted to clients.
// Returns null if the payload has no sensor field.
function processSensorData(parsed, source = "mqtt") {
  if (!parsed?.sensor) return null;

  const data = parsed.sensor;

  const { width: screenW, height: screenH } = robot.getScreenSize();

  // init lerp at current cursor position on first call
  if (lerpX === null) {
    const mouse = robot.getMousePos();
    lerpX = mouse.x;
    lerpY = mouse.y;
    targetX = mouse.x;
    targetY = mouse.y;
  }

  // horizontal motion from rotation speed
  // ===== MOTION =====

  // Wand is moving parallel to ground

  // ===== ABSOLUTE ANGLE COMPUTATION =====
  // heading  → X axis (from magnetometer, already on data)
  // pitch    → Y axis (derived from accelerometer: angle of tilt up/down)
  // roll    → not used for mouse control but could be mapped to something else (e.g. scroll, buttons) in the future
  lastHeading = data.heading;
  lastPitch = data.pitch;

  if (calibration.calibrated) {

    // ===== X from heading =====
    const hRange = angleDiff(
      calibration.bottomRightHeading,
      calibration.topLeftHeading
    );

    const hDelta = angleDiff(
      data.heading,
      calibration.topLeftHeading
    );

    const hNorm = hRange !== 0 ? hDelta / hRange : 0.5;

    targetX = Math.round(
      Math.max(0, Math.min(1, hNorm)) * (screenW - 1)
    );

    // ===== Y from pitch =====
    const pRange =
      calibration.bottomRightPitch - calibration.topLeftPitch;

    const pNorm =
      pRange !== 0
        ? (data.pitch - calibration.topLeftPitch) / pRange
        : 0.5;

    targetY = Math.round(
      Math.max(0, Math.min(1, 1 - pNorm)) * (screenH - 1)
    );
  } else {
    // ===== FALLBACK: delta mode until calibrated =====
    const moveX = Math.abs(data.gz) < DEAD_ZONE ? 0 : -data.gz * ROT_GAIN;
    const moveY = Math.abs(data.gx) < DEAD_ZONE ? 0 : data.gx * ROT_GAIN; // negated: wand up → cursor up
    targetX = Math.max(0, Math.min(targetX + moveX, screenW - 1));
    targetY = Math.max(0, Math.min(targetY + moveY, screenH - 1));
  }

  // Sensor Data Shape from Arduino will be just ...data
  // We process the rest here in the server
  return {
    sensor: {
      ...data,          // gx, gy, ax, ay, heading, fwdHeading, pitch, roll
      mouseTargetX: targetX,  // absolute mouse target X in screen coords
      mouseTargetY: targetY,  // absolute mouse target Y in screen coords
    },
    screenSize: { width: screenW, height: screenH },
    timestamp: parsed.timestamp || Date.now(),
    // attach calibraiton
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
  CONTROL: "control", // power, clear, click
  CALIBRATION: "calibration"
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

      // Throttled Firebase write — skips writes that come in too fast
      const now = Date.now();
      if (now - lastFirebaseWrite >= FIREBASE_WRITE_INTERVAL) {
        lastFirebaseWrite = now;
        // push(ref(db, "sensorData"), entry).catch((err) => console.error("Firebase push error:", err.message));
        // push with calibration data
      }

      console.log("📡 MQTT sensor data:", entry.sensor.pitch);

      // emit to socket so frontend can update in real time
      io.emit("sensor-realtime-receive", entry);
      } catch (err) {
        console.error("MQTT message parse error:", err.message);
      }
    }

    // Subtopic = control
    if (topic.includes(MQTT_SUBTOPIC.CONTROL)) {
      let parsed;
      try {
        parsed = JSON.parse(message.toString());
        console.log("🎮 MQTT control message:", parsed);
      } catch (err) {
        console.error("Control message parse error:", err.message);
        return;
      }

      // --- power ---
      if (parsed.power !== undefined) { 
        mouseEnabled = parsed.power === true;
        io.emit("sensor-power", { power: mouseEnabled, timestamp: Date.now() });
      }

      // --- click ---
      if (parsed.click === true) {
        try {
          robot.mouseClick();
          playClickSound();
          console.log("🖱 Mouse click");
        } catch (e) {
          console.error("robotjs click error:", e.message);
        }
      }
    }

    // Subtopic = calibration
    if (topic.includes(MQTT_SUBTOPIC.CALIBRATION)) {
      let parsed;
      try {
        parsed = JSON.parse(message.toString());
        calibration = parsed;
      } catch (err) {
        console.error("Calibration message parse error:", err.message);
        return;
      }

      console.log(`📐 Calibration update = ${parsed.topLeftRoll}`, parsed.topLeftPitch, parsed.bottomLeftRoll, parsed.bottomLeftPitch); 
      io.emit("sensor-calibration", { data: { topLeftRoll: parsed.topLeftRoll, topLeftPitch: parsed.topLeftPitch, bottomLeftRoll: parsed.bottomLeftRoll, bottomLeftPitch: parsed.bottomLeftPitch}, timestamp: Date.now() });
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
      // heading: ((t * 20) % 360).toFixed(1) * 1,
      // fwdHeading: ((t * 20) % 360).toFixed(1) * 1,
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
          // posX: Math.sin(sensor.heading * Math.PI / 180),
          // posY: Math.cos(sensor.heading * Math.PI / 180),
          // mag: Math.sqrt(sensor.gx ** 2 + sensor.gy ** 2),
        },
        timestamp: Date.now(),
      });
      mqttClient.publish(MQTT_TOPIC, payload);
      console.log("🧪 Mock MQTT publish:", payload);
    }, 50);
  }
});

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


function angleDiff(a, b) {
  let diff = a - b;
  while (diff > 180) diff -= 360;
  while (diff < -180) diff += 360;
  return diff;
}