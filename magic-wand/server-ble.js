// ===============================
// server_ble.js
// Handles: BLE -> Socket.IO -> Firebase
// ===============================

require('dotenv').config();

const noble = require('@abandonware/noble');
const { db } = require('./firebase.js');
const { ref, get, set } = require('firebase/database');

const express = require('express');
const http = require('http');
const cors = require('cors');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const port = process.env.PORT || 4000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'dashboard/build')));

// Auto-detect local vs remote based on REACT_APP_SERVER_URL
const IS_LOCAL = true;
console.log(
  `🏠 Server mode: ${IS_LOCAL ? 'LOCAL (Firebase writes disabled)' : 'REMOTE (Firebase writes enabled)'}`,
);

let mouseEnabled = false;
let drawState = null; // 'start' | 'stop' | null

// ===============================
// BLE CONFIG
// Must match the Arduino BLE sketch UUIDs
// ===============================
const TARGET_DEVICE_NAME = process.env.BLE_DEVICE_NAME || 'KeziaIMU';

const WAND_SERVICE_UUID = '19b10000e8f2537e4f6cd104768a1214';
const IMU_DATA_UUID     = '19b10001e8f2537e4f6cd104768a1214';
const DRAW_UUID         = '19b10002e8f2537e4f6cd104768a1214';
const CLICK_UUID        = '19b10003e8f2537e4f6cd104768a1214';
const STATUS_UUID       = '19b10004e8f2537e4f6cd104768a1214';

let blePeripheral = null;
let bleCharacteristics = {};
let bleConnected = false;
let bleConnecting = false;
let shouldScan = true;

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

function processSensorData(parsed, source = 'ble') {
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
  res.send({ status: 'ok', message: 'Hello Magic Wand BLE 🪄' }),
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
// BLE HELPERS
// ===============================
function safeJsonParse(str) {
  try {
    return JSON.parse(str);
  } catch (err) {
    return null;
  }
}

async function handleSensorEntry(entry, label = 'BLE') {
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

function onBleImuData(buffer) {
  const raw = buffer.toString('utf8').trim();
  const packetData = safeJsonParse(raw);

  if (!packetData) {
    console.warn('BLE IMU JSON parse failed:', raw);
    return;
  }

  const entry = processSensorData(packetData, 'ble');
  handleSensorEntry(entry, 'BLE').catch((err) => {
    console.error('BLE data handling error:', err.message);
  });
}

function onBleDrawData(buffer) {
  const value = buffer.toString('utf8').trim();
  drawState = value;
  io.emit('sensor-draw', { draw: value, timestamp: Date.now() });
  console.log(`✍🏻 Draw: ${value}`);

  // optional: use draw as implicit power/session toggle
  const wasEnabled = mouseEnabled;
  mouseEnabled = value === 'start';

  if (!wasEnabled && mouseEnabled) startNewSession();
  else if (wasEnabled && !mouseEnabled) endSession();
}

function onBleClickData(buffer) {
  const value = buffer.toString('utf8').trim();
  if (!value) return;

  io.emit('sensor-click', { timestamp: Date.now() });
  console.log('🖱 Click relayed');
}

function onBleStatusData(buffer) {
  const value = buffer.toString('utf8').trim();
  console.log(`📶 BLE status: ${value}`);
}

function subscribeToCharacteristic(characteristic, handler, label) {
  characteristic.on('data', (data) => {
    try {
      handler(data);
    } catch (err) {
      console.error(`${label} notify handler error:`, err.message);
    }
  });

  characteristic.subscribe((err) => {
    if (err) {
      console.error(`Failed to subscribe to ${label}:`, err.message);
      return;
    }
    console.log(`✅ Subscribed to ${label}`);
  });
}

function discoverAndSubscribe(peripheral) {
  peripheral.discoverSomeServicesAndCharacteristics(
    [WAND_SERVICE_UUID],
    [IMU_DATA_UUID, DRAW_UUID, CLICK_UUID, STATUS_UUID],
    (err, services, characteristics) => {
      if (err) {
        console.error('BLE discover error:', err.message);
        peripheral.disconnect();
        return;
      }

      bleCharacteristics = {};
      for (const ch of characteristics) {
        bleCharacteristics[ch.uuid] = ch;
      }

      if (bleCharacteristics[IMU_DATA_UUID]) {
        subscribeToCharacteristic(
          bleCharacteristics[IMU_DATA_UUID],
          onBleImuData,
          'IMU'
        );
      } else {
        console.warn('IMU characteristic not found');
      }

      if (bleCharacteristics[DRAW_UUID]) {
        subscribeToCharacteristic(
          bleCharacteristics[DRAW_UUID],
          onBleDrawData,
          'DRAW'
        );
      } else {
        console.warn('DRAW characteristic not found');
      }

      if (bleCharacteristics[CLICK_UUID]) {
        subscribeToCharacteristic(
          bleCharacteristics[CLICK_UUID],
          onBleClickData,
          'CLICK'
        );
      } else {
        console.warn('CLICK characteristic not found');
      }

      if (bleCharacteristics[STATUS_UUID]) {
        subscribeToCharacteristic(
          bleCharacteristics[STATUS_UUID],
          onBleStatusData,
          'STATUS'
        );
      }

      console.log('🎯 BLE setup complete');
      io.emit('ble-state', {
        connected: true,
        device: TARGET_DEVICE_NAME,
      });
    }
  );
}

function connectPeripheral(peripheral) {
  if (bleConnecting || bleConnected) return;

  bleConnecting = true;
  blePeripheral = peripheral;

  console.log(`🔗 Connecting to ${peripheral.advertisement.localName || peripheral.id} ...`);

  noble.stopScanning();

  peripheral.connect((err) => {
    bleConnecting = false;

    if (err) {
      console.error('BLE connect error:', err.message);
      blePeripheral = null;
      if (shouldScan) startBleScan();
      return;
    }

    bleConnected = true;
    console.log(`✅ BLE connected: ${peripheral.advertisement.localName || peripheral.id}`);

    peripheral.once('disconnect', () => {
      console.log('🪫 BLE peripheral disconnected');
      bleConnected = false;
      bleConnecting = false;
      blePeripheral = null;
      bleCharacteristics = {};
      io.emit('ble-state', { connected: false, device: TARGET_DEVICE_NAME });

      if (shouldScan) {
        setTimeout(startBleScan, 1000);
      }
    });

    discoverAndSubscribe(peripheral);
  });
}

function startBleScan() {
  if (noble.state !== 'poweredOn') {
    console.log(`BLE adapter state: ${noble.state}`);
    return;
  }

  console.log(`🔎 Scanning for BLE device: ${TARGET_DEVICE_NAME}`);
  noble.startScanning([WAND_SERVICE_UUID], false, (err) => {
    if (err) {
      console.error('BLE scan error:', err.message);
    }
  });
}

// ===============================
// BLE CENTRAL
// ===============================
noble.on('stateChange', (state) => {
  console.log(`📶 Noble state: ${state}`);

  if (state === 'poweredOn') {
    startBleScan();
  } else {
    noble.stopScanning();
    bleConnected = false;
    bleConnecting = false;
    blePeripheral = null;
  }
});

noble.on('discover', (peripheral) => {
  const name = peripheral.advertisement.localName || '';
  const uuids = peripheral.advertisement.serviceUuids || [];

  console.log(
    `👀 Discovered: ${name || '(no name)'} | ${peripheral.id} | services=${uuids.join(',')}`
  );

  const nameMatch = name === TARGET_DEVICE_NAME;
  const serviceMatch = uuids.includes(WAND_SERVICE_UUID);

  if (!nameMatch && !serviceMatch) return;

  console.log(`🎯 Target BLE peripheral found: ${name || peripheral.id}`);
  connectPeripheral(peripheral);
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
  socket.emit('ble-state', {
    connected: bleConnected,
    device: TARGET_DEVICE_NAME,
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
  console.log(`📡 BLE target device: ${TARGET_DEVICE_NAME}`);
});