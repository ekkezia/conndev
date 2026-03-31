// ===============================
// server_relay.js
// Handles: MQTT → Socket.IO → Firebase
// Mouse control with robotjs is handled by server_mouse_local.js running on each user's machine
// ===============================

require('dotenv').config();

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

const robot = require("robotjs");
const { spawn } = require("child_process");

// Auto-detect local vs remote based on REACT_APP_SERVER_URL
// const IS_LOCAL = process.env.REACT_APP_SERVER_URL?.includes('localhost') ?? false;
// Problem: the Render server is super slow and laggy
const IS_LOCAL = true;
console.log(`🏠 Server mode: ${IS_LOCAL ? 'LOCAL (Firebase writes disabled)' : 'REMOTE (Firebase writes enabled)'}`);

let mouseEnabled = false;
let drawState = null; // 'start' | 'stop' | null
let mouseControlEnabled = false; // set to false to disable robotjs mouse movement

// ===============================
// Firebase Session Tracking
// ===============================
let currentSessionIndex = null;
let sessionStartTimestamp = null;

async function startNewSession() {
  console.log('start a new session');
  try {
    let sessions = [];
    let newSession;
    
    if (!IS_LOCAL) {
      const snapshot = await get(ref(db, "sessions"));
      
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
      
      newSession = {
        id: `session_${currentSessionIndex + 1}`,
        startTimestamp: sessionStartTimestamp,
        data: {}
      };
      
      sessions.push(newSession);
      await set(ref(db, "sessions"), sessions);
      
      console.log(`📁 Firebase session started: ${newSession.id} (index: ${currentSessionIndex})`);
    } else {
      // Local mode - just track in memory, no Firebase write
      currentSessionIndex = 0;
      sessionStartTimestamp = Date.now();
      newSession = {
        id: `session_local_${sessionStartTimestamp}`,
        startTimestamp: sessionStartTimestamp,
        data: {}
      };
      console.log(`📁 Local session started: ${newSession.id} (Firebase writes skipped)`);
    }
    
    // Broadcast new session to all connected clients with data as array for consistency
    if (typeof io !== 'undefined') {
      io.emit("session-started", { ...newSession, data: [] });
    }
  } catch (err) {
    console.error("startNewSession error:", err.message);
  }
}

async function endSession() {
  console.log('end session');
  if (currentSessionIndex !== null) {
    try {
      const endTimestamp = Date.now();
      
      if (!IS_LOCAL) {
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
          sessions[currentSessionIndex].endTimestamp = endTimestamp;
          await set(ref(db, "sessions"), sessions);
          console.log(`📁 Firebase session ended: ${sessions[currentSessionIndex].id}`);
        }
      } else {
        console.log(`📁 Local session ended (Firebase writes skipped)`);
      }
      
      // Broadcast session end to all connected clients
      if (typeof io !== 'undefined') {
        io.emit("session-ended", { index: currentSessionIndex, endTimestamp });
      }
    } catch (err) {
      console.error("endSession error:", err.message);
    }
  }
  currentSessionIndex = null;
  sessionStartTimestamp = null;
}

// ===============================
// Client-reported screen + cursor state
// Updated via socket events from the frontend
// ===============================
const DEAD_ZONE = 1.2;
let clientScreenSize = { width: 1920, height: 1080 }; // updated by frontend on connect
let targetX = null;
let targetY = null;
let lerpX = null;
let lerpY = null;

// ===============================
// Sensor Processing
// ===============================
const WAND_CONFIG = {
	x: { axis: 'gz', invert: true }, // left/right yaw
	y: { axis: 'gy', invert: true }, // up/down tilt — swap gy/gx to taste
	deadZone: DEAD_ZONE,
};

let netX = 0; // can go negative (left) or positive (right)
let netZ = 0;
let distX = 0; // always accumulates, never shrinks
let distZ = 0;

function getAxisValue(data, axis, invert) {
	const raw = data[axis] ?? 0;
	return Math.abs(raw) < WAND_CONFIG.deadZone ? 0 : invert ? -raw : raw;
}

// ===============================
// Sensor Processing
// ===============================
function processSensorData(parsed, source = 'mqtt') {
	if (!parsed?.sensor) return null;
	const data = parsed.sensor;
	const mag = Math.sqrt(data.gx ** 2 + data.gy ** 2);
	const { width: screenW, height: screenH } = clientScreenSize;

	if (targetX === null) {
		targetX = screenW / 2;
		targetY = screenH / 2;
		lerpX = targetX;
		lerpY = targetY;
	}

	const sensitivity = data.sensitivity ?? 5;

	const moveX =
		getAxisValue(data, WAND_CONFIG.x.axis, WAND_CONFIG.x.invert) * sensitivity;
	const moveY =
		getAxisValue(data, WAND_CONFIG.y.axis, WAND_CONFIG.y.invert) * sensitivity;

	targetX = Math.max(0, Math.min(targetX + moveX, screenW - 1));
	targetY = Math.max(0, Math.min(targetY + moveY, screenH - 1));

	// Track displacement
	netX += moveX;
	netZ += moveY;
	distX += Math.abs(moveX);
	distZ += Math.abs(moveY);

	io.emit('sensor-processed-mouse-pos', { x: targetX, y: targetY });

  // robotjs
  if (mouseControlEnabled) {
    try {
      robot.moveMouse(Math.round(targetX), Math.round(targetY));
    } catch (err) {
      console.error('robotjs moveMouse error:', err.message);
    }
  }

	return {
		sensor: {
			...data,
			mag,
			mouseTargetX: targetX,
			mouseTargetY: targetY,
			netX,
			netZ, // net displacement from start
			distX,
			distZ, // total distance traveled
		},
		screenSize: clientScreenSize,
		timestamp: parsed.timestamp || Date.now(),
		source,
		draw: drawState,
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
const MQTT_SUBTOPIC = {
	DATA: 'data',
	DRAW: 'draw',
	CLICK: 'click',
	POWER: 'power',
};


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

        // console.log('📥 Emitting to clients', entry);
        io.emit("sensor-realtime-receive", entry);
        
        // Write directly to Firebase if session is active (skip if local)
        if (currentSessionIndex !== null && !IS_LOCAL) {
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
          
          console.log(`Sessions in DB: ${sessions.length}, Current index: ${currentSessionIndex}`);
          
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
        } else if (currentSessionIndex !== null && IS_LOCAL) {
          console.log(`📡 MQTT data received (local mode - Firebase writes skipped)`);
        } else {
          console.log(`📡 MQTT data received but no active session (power is OFF)`);
        }

        
      } catch (err) {
        console.error("MQTT data parse error:", err.message);
      }
    }

    // --- POWER ---
    if (topic.includes(MQTT_SUBTOPIC.POWER)) {
      let parsed;
      try { parsed = JSON.parse(message.toString()); }
      catch (err) { console.error("MQTT power parse error:", err.message); return; }

      if (parsed.power !== undefined) {
        const wasEnabled = mouseEnabled;
        mouseEnabled = parsed.power === true;
        console.log(`🖱 Power: ${mouseEnabled ? "ON" : "OFF"}`);
        if (!wasEnabled && mouseEnabled) startNewSession();
        else if (wasEnabled && !mouseEnabled) endSession();
      }
    }

    // --- CONTROL ---
		// draw: "start" | "stop"
		if (topic.includes(MQTT_SUBTOPIC.DRAW)) {
			const value = message.toString().replace(/"/g, '').trim(); // strip quotes → "start" or "stop"
			drawState = value;
			io.emit('sensor-draw', { draw: value, timestamp: Date.now() });
			console.log(`✍🏻 Draw: ${value}`);
		}

		// click: true (one-time)
		if (topic.includes(MQTT_SUBTOPIC.CLICK)) {
			let parsed;
			try {
				parsed = JSON.parse(message.toString());
				io.emit('sensor-click', { timestamp: Date.now() });
				console.log('🖱 Click relayed');
        if (mouseControlEnabled) robot.mouseClick();
			} catch (err) {
				console.error('MQTT click parse error:', err.message);
				return;
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

  // Always fetch initial sessions from Firebase, regardless of IS_LOCAL
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

    console.log(`📦 Fetched ${sessions.length} sessions from Firebase for new client`);
    // Ensure all session.data is an array
    sessions = sessions.map(session => ({
      ...session,
      data: Array.isArray(session.data) ? session.data : (session.data && typeof session.data === 'object' ? Object.values(session.data) : [])
    }));
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

  socket.on("disconnect", () => console.log("🪫 Disconnected:", socket.id));
});

// ===============================
// START
// ===============================
server.listen(port, () => console.log(`🌎 Server running at ${process.env.REACT_APP_SERVER_URL}`));
