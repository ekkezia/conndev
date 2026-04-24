// ===============================
// server_mouse.js with XIAOESP32C6
// Handles: UDP → Socket.IO → Firebase (+ local OS mouse/click via robotjs)
// ===============================

require('dotenv').config();

const { db } = require('./firebase.js');
const { ref, get, set } = require('firebase/database');

const express = require('express');
const http = require('http');
const cors = require('cors');
const { Server } = require('socket.io');
const path = require('path');
const dgram = require('dgram');
let robot = null;

try {
  robot = require('robotjs');
  console.log('🤖 robotjs loaded (real mouse override enabled)');
} catch (err) {
  console.warn(
    '⚠️ robotjs not available (real mouse override disabled):',
    err.message,
  );
}

const app = express();
const port = process.env.PORT || 4000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'dashboard/build')));

// Auto-detect local vs remote based on REACT_APP_SERVER_URL
// const IS_LOCAL = process.env.REACT_APP_SERVER_URL?.includes('localhost') ?? false;
// Problem: the Render server is super slow and laggy
const IS_LOCAL = true;
console.log(
  `🏠 Server mode: ${IS_LOCAL ? 'LOCAL (Firebase writes disabled)' : 'REMOTE (Firebase writes enabled)'}`,
);

let mouseEnabled = false;
let drawState = null; // 'start' | 'stop' | null
let mouseControlEnabled = false; // true while draw/start override is active
const detectedLocalMouseScreenSize =
  robot && typeof robot.getScreenSize === 'function'
    ? robot.getScreenSize()
    : null;
const localMouseScreenSize =
  detectedLocalMouseScreenSize &&
  Number.isFinite(detectedLocalMouseScreenSize.width) &&
  Number.isFinite(detectedLocalMouseScreenSize.height) &&
  detectedLocalMouseScreenSize.width > 1 &&
  detectedLocalMouseScreenSize.height > 1
    ? detectedLocalMouseScreenSize
    : null;

if (localMouseScreenSize) {
  console.log(
    `🖥 Local mouse screen: ${localMouseScreenSize.width}x${localMouseScreenSize.height}`,
  );
} else if (detectedLocalMouseScreenSize) {
  console.warn(
    `⚠️ robotjs reported invalid screen size (${detectedLocalMouseScreenSize.width}x${detectedLocalMouseScreenSize.height}), falling back to client-reported screen size`,
  );
}

function setMouseOverrideEnabled(enabled, reason = 'unknown') {
  const next = enabled === true;
  if (mouseControlEnabled === next) return;

  mouseControlEnabled = next;
  console.log(
    `🖱 Mouse override: ${mouseControlEnabled ? 'ENABLED' : 'DISABLED'} (${reason})`,
  );

  if (typeof io !== 'undefined') {
    io.emit('mouse-override', {
      enabled: mouseControlEnabled,
      reason,
      timestamp: Date.now(),
    });
  }
}

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
      const snapshot = await get(ref(db, 'sessions'));

      if (snapshot.exists()) {
        const data = snapshot.val();
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
        data: {},
      };

      sessions.push(newSession);
      await set(ref(db, 'sessions'), sessions);

      console.log(
        `📁 Firebase session started: ${newSession.id} (index: ${currentSessionIndex})`,
      );
    } else {
      currentSessionIndex = 0;
      sessionStartTimestamp = Date.now();
      newSession = {
        id: `session_local_${sessionStartTimestamp}`,
        startTimestamp: sessionStartTimestamp,
        data: {},
      };
      console.log(
        `📁 Local session started: ${newSession.id} (Firebase writes skipped)`,
      );
    }

    if (typeof io !== 'undefined') {
      io.emit('session-started', { ...newSession, data: [] });
    }
  } catch (err) {
    console.error('startNewSession error:', err.message);
  }
}

async function endSession() {
  console.log('end session');
  if (currentSessionIndex !== null) {
    try {
      const endTimestamp = Date.now();

      if (!IS_LOCAL) {
        const snapshot = await get(ref(db, 'sessions'));
        let sessions = [];

        if (snapshot.exists()) {
          const data = snapshot.val();
          if (typeof data === 'object' && !Array.isArray(data)) {
            sessions = Object.values(data);
          } else if (Array.isArray(data)) {
            sessions = data;
          }
        }

        if (sessions[currentSessionIndex]) {
          sessions[currentSessionIndex].endTimestamp = endTimestamp;
          await set(ref(db, 'sessions'), sessions);
          console.log(
            `📁 Firebase session ended: ${sessions[currentSessionIndex].id}`,
          );
        }
      } else {
        console.log(`📁 Local session ended (Firebase writes skipped)`);
      }

      if (typeof io !== 'undefined') {
        io.emit('session-ended', { index: currentSessionIndex, endTimestamp });
      }
    } catch (err) {
      console.error('endSession error:', err.message);
    }
  }
  currentSessionIndex = null;
  sessionStartTimestamp = null;
}

// ===============================
// Client-reported screen + cursor state
// ===============================
const DEAD_ZONE = 1.2;
let clientScreenSize = { width: 1920, height: 1080 };
let targetX = null;
let targetY = null;
let lerpX = null;
let lerpY = null;

// ===============================
// Sensor Processing
// ===============================
const WAND_CONFIG = {
  x: { axis: 'gz', invert: true },
  y: { axis: 'gy', invert: true },
  deadZone: DEAD_ZONE,
};

let netX = 0;
let netZ = 0;
let distX = 0;
let distZ = 0;

function getAxisValue(data, axis, invert) {
  const raw = data[axis] ?? 0;
  return Math.abs(raw) < WAND_CONFIG.deadZone ? 0 : invert ? -raw : raw;
}

function processSensorData(parsed, source = 'udp') {
  if (!parsed?.sensor) return null;

  const data = parsed.sensor;
  const mag = Math.sqrt((data.gx ?? 0) ** 2 + (data.gy ?? 0) ** 2);
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

  netX += moveX;
  netZ += moveY;
  distX += Math.abs(moveX);
  distZ += Math.abs(moveY);

  io.emit('sensor-processed-mouse-pos', { x: targetX, y: targetY });

  if (mouseEnabled && mouseControlEnabled && robot) {
    try {
      const localScreenW = localMouseScreenSize?.width ?? screenW;
      const localScreenH = localMouseScreenSize?.height ?? screenH;
      const mappedX = Math.round(
        (targetX / Math.max(screenW - 1, 1)) * Math.max(localScreenW - 1, 0),
      );
      const mappedY = Math.round(
        (targetY / Math.max(screenH - 1, 1)) * Math.max(localScreenH - 1, 0),
      );
      robot.moveMouse(mappedX, mappedY);
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
      netZ,
      distX,
      distZ,
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
app.get('/', (req, res) =>
  res.send({ status: 'ok', message: 'Hello Magic Wand 🪄' }),
);

app.get('/sensor-data', async (req, res) => {
  try {
    const snapshot = await get(ref(db, 'sessions'));
    let sessions = [];

    if (snapshot.exists()) {
      const data = snapshot.val();
      if (typeof data === 'object' && !Array.isArray(data)) {
        sessions = Object.values(data);
      } else if (Array.isArray(data)) {
        sessions = data;
      }
    }

    res.json(sessions);
  } catch (err) {
    console.error('GET /sensor-data error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ===============================
// HTTP + Socket.IO
// ===============================
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
});
lerpIo = io;

// ===============================
// UDP SERVER
// ===============================
const UDP_PORT = Number(process.env.UDP_PORT) || 4210;
const udpServer = dgram.createSocket('udp4');

async function handleSensorEntry(entry, label = 'UDP') {
  if (!entry) return;

  io.emit('sensor-realtime-receive', entry);

  if (currentSessionIndex !== null && !IS_LOCAL) {
    console.log(
      `📝 Received ${label} data, writing to session ${currentSessionIndex}`,
    );

    try {
      const snapshot = await get(ref(db, 'sessions'));
      let sessions = [];

      if (snapshot.exists()) {
        const data = snapshot.val();
        if (typeof data === 'object' && !Array.isArray(data)) {
          sessions = Object.values(data);
        } else if (Array.isArray(data)) {
          sessions = data;
        }
      }

      console.log(
        `Sessions in DB: ${sessions.length}, Current index: ${currentSessionIndex}`,
      );

      if (sessions[currentSessionIndex]) {
        console.log(`   Session found: ${sessions[currentSessionIndex].id}`);

        if (!sessions[currentSessionIndex].data) {
          sessions[currentSessionIndex].data = {};
        }

        if (
          typeof sessions[currentSessionIndex].data === 'object' &&
          !Array.isArray(sessions[currentSessionIndex].data)
        ) {
          const dataLength = Object.keys(
            sessions[currentSessionIndex].data,
          ).length;
          sessions[currentSessionIndex].data[dataLength] = entry;
        } else {
          sessions[currentSessionIndex].data.push(entry);
        }

        await set(ref(db, 'sessions'), sessions)
          .then(() => console.log(`   ✅ Data written to Firebase`))
          .catch((err) =>
            console.error(`   ❌ Firebase write error: ${err.message}`),
          );
      } else {
        console.warn(
          `⚠️ Session ${currentSessionIndex} not found in DB (${sessions.length} sessions exist)`,
        );
      }
    } catch (err) {
      console.error(`${label} Firebase write error:`, err.message);
    }
  } else if (currentSessionIndex !== null && IS_LOCAL) {
    console.log(`📡 ${label} data received (local mode - Firebase writes skipped)`);
  } else {
    console.log(`📡 ${label} data received but no active session (power is OFF)`);
  }
}

udpServer.on('listening', () => {
  const address = udpServer.address();
  console.log(`📡 UDP listening on ${address.address}:${address.port}`);
});

udpServer.on('error', (err) => {
  console.error('UDP server error:', err);
});

udpServer.on('message', async (msg, rinfo) => {
  let packet;

  try {
    packet = JSON.parse(msg.toString());
  } catch (err) {
    console.error('UDP packet parse error:', err.message);
    return;
  }

  const packetPath = packet?.path;
  const packetData = packet?.data;

  if (!packetPath) {
    console.warn('UDP packet missing path');
    return;
  }

  // --- sensor data ---
  if (packetPath === 'kezia/imu/data') {
    try {
      const entry = processSensorData(packetData, 'udp');
      await handleSensorEntry(entry, 'UDP');
    } catch (err) {
      console.error('UDP data handling error:', err.message);
    }
    return;
  }

  // --- POWER ---
  if (packetPath === 'kezia/imu/power') {
    try {
      if (packetData?.power !== undefined) {
        const wasEnabled = mouseEnabled;
        mouseEnabled = packetData.power === true;
        console.log(`🖱 Power: ${mouseEnabled ? 'ON' : 'OFF'}`);

        if (!wasEnabled && mouseEnabled) startNewSession();
        else if (wasEnabled && !mouseEnabled) {
          endSession();
          setMouseOverrideEnabled(false, 'power-off');
        }
      }
    } catch (err) {
      console.error('UDP power handling error:', err.message);
    }
    return;
  }

  // --- CONTROL ---
  if (packetPath === 'kezia/imu/draw') {
    try {
      const value = (
        typeof packetData === 'string' ? packetData.trim() : String(packetData)
      ).toLowerCase();
      drawState = value;
      io.emit('sensor-draw', { draw: value, timestamp: Date.now() });
      if (value === 'start') setMouseOverrideEnabled(true, 'draw-start');
      if (value === 'stop') setMouseOverrideEnabled(false, 'draw-stop');
      console.log(`✍🏻 Draw: ${value}`);
    } catch (err) {
      console.error('UDP draw handling error:', err.message);
    }
    return;
  }

  // --- CLICK ---
  if (packetPath === 'kezia/imu/click') {
    try {
      io.emit('sensor-click', { timestamp: Date.now() });
      if (mouseEnabled && mouseControlEnabled && robot) {
        robot.mouseClick();
        console.log('🖱 Click relayed + real mouse click');
      } else {
        console.log('🖱 Click relayed');
      }
    } catch (err) {
      console.error('UDP click handling error:', err.message);
    }
    return;
  }

  // --- TEST ---
  if (packetPath === 'kezia/test') {
    console.log(`🧪 Test packet from ${rinfo.address}:${rinfo.port}`, packetData);
    return;
  }

  console.warn(`Unknown UDP path: ${packetPath}`);
});

// ===============================
// Socket.IO
// ===============================
io.on('connection', async (socket) => {
  console.log('🔌 Client connected:', socket.id);

  try {
    const snapshot = await get(ref(db, 'sessions'));
    let sessions = [];

    if (snapshot.exists()) {
      const data = snapshot.val();
      if (typeof data === 'object' && !Array.isArray(data)) {
        sessions = Object.values(data);
      } else if (Array.isArray(data)) {
        sessions = data;
      }
    }

    console.log(
      `📦 Fetched ${sessions.length} sessions from Firebase for new client`,
    );

    sessions = sessions.map((session) => ({
      ...session,
      data: Array.isArray(session.data)
        ? session.data
        : session.data && typeof session.data === 'object'
          ? Object.values(session.data)
          : [],
    }));

    socket.emit('sensor-initial-data', sessions);
  } catch (err) {
    console.error('Socket initial data fetch error:', err.message);
    socket.emit('sensor-initial-data', []);
  }

  socket.emit('user', { id: socket.id });
  socket.emit('mouse-override', {
    enabled: mouseControlEnabled,
    reason: 'sync',
    timestamp: Date.now(),
  });

  socket.on('screen-size', (size) => {
    clientScreenSize = size;
    console.log(`🖥 Screen size reported: ${size.width}x${size.height}`);
  });

  socket.on('mouse-pos-report', (pos) => {
    if (targetX === null) {
      targetX = pos.x;
      lerpX = pos.x;
      targetY = pos.y;
      lerpY = pos.y;
    }
  });

  socket.on('sensor-realtime-send', (parsed) => {
    processSensorData(parsed, 'socket');
  });

  socket.on('hue-control', (data) => {
    if (data && data.lightNum) {
      setLight(data.lightNum, data.change);
    }
  });

  socket.on('disconnect', () => console.log('🪫 Disconnected:', socket.id));
});

// ===============================
// Phillips Light API Integration
// ===============================
let address = process.env.REACT_APP_PHILLIPS_HUE_ADDRESS;
let username = process.env.REACT_APP_PHILLIPS_HUE_USERNAME;
let requestUrl = 'http://' + address + '/api/' + username + '/';
let lightNumber = Number(process.env.REACT_APP_PHILLIPS_HUE_LIGHT_NUMBER) || 2;

let lightState = {
  on: true,
  bri: 0,
  hue: 0,
};

let lastPhillipsToggle = 0;
const PHILLIPS_POWER_GX_THRESHOLD = 100;

function sendRequest(request, requestMethod, data) {
  const url = requestUrl + request;
  const params = {
    method: requestMethod,
    headers: {
      accept: 'application/json',
    },
  };

  if (requestMethod !== 'GET' || data) {
    params.body = JSON.stringify(data);
  }

  fetch(url, params)
    .then((response) => response.json())
    .then((data) => console.log(data))
    .catch((error) => console.log(error));
}

function getLights() {
  sendRequest('lights', 'GET');
}

function setLight(lightNum, change) {
  const request = 'lights/' + lightNum + '/state';
  sendRequest(request, 'PUT', change);
}

getLights();

function updatePhillipsLight(parsed, mousePos = null) {
  if (!address || !username) {
    console.log('Please enter an address and username');
    return;
  }
  if (!parsed?.sensor) return null;

  const data = parsed.sensor;
  const now = Date.now();

  if (Math.abs(data.gx) > PHILLIPS_POWER_GX_THRESHOLD) {
    if (now - lastPhillipsToggle > 3000) {
      lightState.on = !lightState.on;
      lastPhillipsToggle = now;
      console.log(
        `💡 Phillips Hue power toggled: ${lightState.on ? 'ON' : 'OFF'} (gx: ${data.gx})`,
      );
      delete lightState.bri;
      delete lightState.hue;
    }
  }

  if (mousePos) {
    if (lightState.on) {
      lightState.hue = Math.round(
        (mousePos.x / clientScreenSize.width) * 65535,
      );
      lightState.bri = Math.round(
        (1 - mousePos.y / clientScreenSize.height) * 254,
      );
    }
    console.log(
      `💡 Phillips Hue update: hue=${lightState.hue}, bri=${lightState.bri}`,
    );
  }

  setLight(lightNumber, lightState);
}

// ===============================
// START
// ===============================
server.listen(port, () => {
  console.log(`🌎 Server running at ${process.env.REACT_APP_SERVER_URL}`);
});

udpServer.bind(UDP_PORT, '0.0.0.0');
