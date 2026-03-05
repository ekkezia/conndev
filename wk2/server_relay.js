// ===============================
// server_relay.js
// Handles: MQTT → Socket.IO → Firebase
// Mouse control with robotjs is handled by server_mouse_local.js running on each user's machine
// ===============================

const { db } = require("./firebase.js");
const { ref, get, set } = require("firebase/database");

const express = require("express");
const http = require("http");
const cors = require("cors");
const { Server } = require("socket.io");
const mqtt = require("mqtt");
const path = require("path");

const app = express();
const port = process.env.PORT || 4000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'dashboard/build')));

let mouseEnabled = false;

// ===============================
// Firebase Session Tracking
// ===============================
let currentSessionIndex = null;
let sessionStartTimestamp = null;

async function startNewSession() {
  try {
    const snapshot = await get(ref(db, "sessions"));
    let sessions = [];
    
    if (snapshot.exists()) {
      const data = snapshot.val();
      // Firebase stores arrays as objects with numeric keys - convert to array
      if (typeof data === 'object' && !Array.isArray(data)) {
        sessions = Object.values(data);
      } else if (Array.isArray(data)) {
        sessions = data;
      }
    }
    
    currentSessionIndex = sessions.length;
    sessionStartTimestamp = Date.now();
    
    const newSession = {
      id: `session_${currentSessionIndex + 1}`,
      startTimestamp: sessionStartTimestamp,
      data: {}
    };
    
    sessions.push(newSession);
    await set(ref(db, "sessions"), sessions);
    
    // Broadcast new session to all connected clients with data as array for consistency
    if (typeof io !== 'undefined') {
      io.emit("session-started", { ...newSession, data: [] });
    }
    
    console.log(`📁 Firebase session started: ${newSession.id} (index: ${currentSessionIndex})`);
  } catch (err) {
    console.error("Firebase startNewSession error:", err.message);
  }
}

async function endSession() {
  if (currentSessionIndex !== null) {
    try {
      const snapshot = await get(ref(db, "sessions"));
      let sessions = [];
      
      if (snapshot.exists()) {
        const data = snapshot.val();
        // Firebase stores arrays as objects with numeric keys - convert to array
        if (typeof data === 'object' && !Array.isArray(data)) {
          sessions = Object.values(data);
        } else if (Array.isArray(data)) {
          sessions = data;
        }
      }
      
      if (sessions[currentSessionIndex]) {
        sessions[currentSessionIndex].endTimestamp = Date.now();
        await set(ref(db, "sessions"), sessions);
        
        // Broadcast session end to all connected clients
        if (typeof io !== 'undefined') {
          io.emit("session-ended", { index: currentSessionIndex, endTimestamp: sessions[currentSessionIndex].endTimestamp });
        }
        
        console.log(`📁 Firebase session ended: ${sessions[currentSessionIndex].id}`);
      }
    } catch (err) {
      console.error("Firebase endSession error:", err.message);
    }
  }
  currentSessionIndex = null;
  sessionStartTimestamp = null;
}

// ===============================
// Client-reported screen + cursor state
// Updated via socket events from the frontend
// ===============================
const ROT_GAIN = 0.35;
const TILT_GAIN = 3.5;
const DEAD_ZONE = 1.2;
let lastPitch = null;
let clientScreenSize = { width: 1920, height: 1080 }; // updated by frontend on connect
let targetX = null;
let targetY = null;
let lerpX = null;
let lerpY = null;

// Lerp loop — runs at ~60fps, sends computed cursor pos to all dashboard clients
let lerpIo = null; // set once io is created
setInterval(() => {
  if (!mouseEnabled || targetX === null || !lerpIo) return;
  const t = 0.12;
  lerpX = lerpX + (targetX - lerpX) * t;
  lerpY = lerpY + (targetY - lerpY) * t;
  lerpIo.emit('mouse-pos', { x: Math.round(lerpX), y: Math.round(lerpY) });
}, 1000 / 60);

// ===============================
// Sensor Processing (no robot.js — uses client-reported screen/mouse)
// ===============================
function processSensorData(parsed, source = "mqtt") {
  if (!parsed?.sensor) return null;
  const data = parsed.sensor;
  const mag = Math.sqrt(data.gx ** 2 + data.gy ** 2); // Custom magnitude for stroke weight
  const { width: screenW, height: screenH } = clientScreenSize;

  // Init to screen center on first entry
  if (targetX === null) {
    targetX = screenW / 2;
    targetY = screenH / 2;
    lerpX = targetX;
    lerpY = targetY;
  }

  // Absolute pitch from accelerometer
  const pitch = Math.atan2(data.ax, Math.sqrt(data.ay ** 2 + data.az ** 2)) * 180 / Math.PI;
  let sensitivity = data.sensitivity; // range: 0-10

  const moveX = Math.abs(data.gz) < DEAD_ZONE ? 0 : -data.gz * sensitivity;
  const moveY = Math.abs(data.gx) < DEAD_ZONE ? 0 : -data.gx * sensitivity;

  targetX = Math.max(0, Math.min(targetX + moveX, screenW - 1));
  targetY = Math.max(0, Math.min(targetY + moveY, screenH - 1));

  return {
    sensor: { ...data, mag, mouseTargetX: targetX, mouseTargetY: targetY },
    screenSize: clientScreenSize,
    // Arduino now sends epoch milliseconds
    timestamp: parsed.timestamp || Date.now(),
    source,
  };
}

// ===============================
// REST
// ===============================
app.get("/", (req, res) => res.send({ status: "ok", message: "Hello Magic Wand 🪄" }));
app.get("/sensor-data", async (req, res) => {
  try {
    const snapshot = await get(ref(db, "sessions"));
    let sessions = [];
    
    if (snapshot.exists()) {
      const data = snapshot.val();
      // Firebase stores arrays as objects with numeric keys - convert to array
      if (typeof data === 'object' && !Array.isArray(data)) {
        sessions = Object.values(data);
      } else if (Array.isArray(data)) {
        sessions = data;
      }
    }
    
    res.json(sessions);
  } catch (err) {
    console.error("GET /sensor-data error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ===============================
// HTTP + Socket.IO
// ===============================
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] },
});
lerpIo = io; // give lerp loop access to io

// ===============================
// MQTT CLIENT
// ===============================
const MQTT_BROKER = process.env.MQTT_BROKER || "mqtt://public.cloud.shiftr.io:1883";
const MQTT_TOPIC = "kezia/imu/";
const MQTT_SUBTOPIC = { DATA: "data", CONTROL: "control" };

const mqttClient = mqtt.connect(MQTT_BROKER, {
  username: process.env.MQTT_USER || "public",
  password: process.env.MQTT_PASS || "public",
});

mqttClient.on("connect", () => {
  console.log("📡 Connected to MQTT broker:", MQTT_BROKER);
  for (const sub of Object.values(MQTT_SUBTOPIC)) {
    mqttClient.subscribe(MQTT_TOPIC + sub, (err) => {
      if (err) console.error(`MQTT subscribe error (${sub}):`, err);
      else console.log(`📥 Subscribed: ${MQTT_TOPIC + sub}`);
    });
  }

  mqttClient.on("message", async (topic, message) => {
    // --- sensor data ---
    if (topic.includes(MQTT_SUBTOPIC.DATA)) {
      try {
        const parsed = JSON.parse(message.toString());
        const entry = processSensorData(parsed, "mqtt");
        if (!entry) return;

        // Write directly to Firebase if session is active
        if (currentSessionIndex !== null) {
          console.log(`📝 Received MQTT data, writing to session ${currentSessionIndex}`);
          const snapshot = await get(ref(db, "sessions"));
          let sessions = [];
          
          if (snapshot.exists()) {
            const data = snapshot.val();
            // Firebase stores arrays as objects with numeric keys - convert to array
            if (typeof data === 'object' && !Array.isArray(data)) {
              sessions = Object.values(data);
            } else if (Array.isArray(data)) {
              sessions = data;
            }
          }
          
          console.log(`   Sessions in DB: ${sessions.length}, Current index: ${currentSessionIndex}`);
          
          if (sessions[currentSessionIndex]) {
            console.log(`   Session found: ${sessions[currentSessionIndex].id}`);
            if (!sessions[currentSessionIndex].data) {
              sessions[currentSessionIndex].data = {};
            }
            // Firebase converts objects with numeric keys to/from arrays
            if (typeof sessions[currentSessionIndex].data === 'object' && !Array.isArray(sessions[currentSessionIndex].data)) {
              // It's a Firebase object - add entry with auto-generated key
              const dataLength = Object.keys(sessions[currentSessionIndex].data).length;
              sessions[currentSessionIndex].data[dataLength] = entry;
            } else {
              // It's an array - push normally
              sessions[currentSessionIndex].data.push(entry);
            }
            
            await set(ref(db, "sessions"), sessions)
              .then(() => console.log(`   ✅ Data written to Firebase`))
              .catch((err) => console.error(`   ❌ Firebase write error: ${err.message}`));
          } else {
            console.warn(`⚠️ Session ${currentSessionIndex} not found in DB (${sessions.length} sessions exist)`);
          }
        } else {
          console.log(`📡 MQTT data received but no active session (power is OFF)`);
        }

        console.log('📥 Emitting to clients');
        io.emit("sensor-realtime-receive", entry);
      } catch (err) {
        console.error("MQTT data parse error:", err.message);
      }
    }

    // --- control ---
    if (topic.includes(MQTT_SUBTOPIC.CONTROL)) {
      let parsed;
      try { parsed = JSON.parse(message.toString()); }
      catch (err) { console.error("MQTT control parse error:", err.message); return; }

      console.log("🎮 Control:", parsed);

      if (parsed.power !== undefined) {
        const wasEnabled = mouseEnabled;
        mouseEnabled = parsed.power === true;
        io.emit("sensor-power", { power: mouseEnabled, timestamp: Date.now() });
        console.log(`🖱 Power: ${mouseEnabled ? "ON" : "OFF"}`);

        if (!wasEnabled && mouseEnabled) startNewSession();
        else if (wasEnabled && !mouseEnabled) endSession();
      }

      if (parsed.click === true) {
        // relay click to local mouse agent(s)
        io.emit("mouse-click");
        console.log("🖱 Click relayed");
      }

      if (parsed.clear === true) {
        io.emit("sensor-clear", { timestamp: Date.now() });
        console.log("🧹 Clear relayed");
      }
    }
  });

  mqttClient.on("error", (err) => console.error("MQTT error:", err));
});

// ===============================
// Socket.IO
// ===============================
io.on("connection", async (socket) => {
  console.log("🔌 Client connected:", socket.id);

  // Fetch initial sessions from Firebase
  try {
    const snapshot = await get(ref(db, "sessions"));
    let sessions = [];
    
    if (snapshot.exists()) {
      const data = snapshot.val();
      // Firebase stores arrays as objects with numeric keys - convert to array
      if (typeof data === 'object' && !Array.isArray(data)) {
        sessions = Object.values(data);
      } else if (Array.isArray(data)) {
        sessions = data;
      }
    }
    
    socket.emit("sensor-initial-data", sessions);
  } catch (err) {
    console.error("Socket initial data fetch error:", err.message);
    socket.emit("sensor-initial-data", []);
  }
  
  socket.emit("user", { id: socket.id });

  // Frontend reports its screen size on connect
  socket.on("screen-size", (size) => {
    clientScreenSize = size;
    console.log(`🖥 Screen size reported: ${size.width}x${size.height}`);
  });

  // Frontend reports current mouse position (for init / sync)
  socket.on("mouse-pos-report", (pos) => {
    if (targetX === null) {
      targetX = pos.x; lerpX = pos.x;
      targetY = pos.y; lerpY = pos.y;
    }
  });

  // Local mouse agent reports cursor position → forward to dashboard clients
  socket.on("mouse-pos", (pos) => {
    socket.broadcast.emit("mouse-pos", pos);
  });

  socket.on("disconnect", () => console.log("🪫 Disconnected:", socket.id));
});

// ===============================
// START
// ===============================
server.listen(port, () => console.log(`🌎 Relay server running at http://localhost:${port}`));
