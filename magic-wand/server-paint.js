// ===============================
// server_udp.js
// Handles: UDP → Socket.IO → Firebase
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

const app = express();
const port = process.env.PORT || 4000;
const serveDashboard = process.env.SERVE_DASHBOARD === 'true';

app.use(cors());
app.use(express.json());
if (serveDashboard) {
  app.use(express.static(path.join(__dirname, 'dashboard/build')));
}

let mouseEnabled = true;
let drawState = null; // 'start' | 'stop' | null
const CLICK_DEBOUNCE_MS = Math.max(
  0,
  Number(process.env.WAND_CLICK_DEBOUNCE_MS) || 180,
);
let lastClickAtMs = 0;
let lastSensorPacket = null;
let lastSensorColorRgb = [255, 255, 255];
let lastSensorColorHsv = [0, 0, 100];

function parseDrawValue(raw) {
  if (raw == null) return null;

  if (typeof raw === 'object') {
    if ('draw' in raw) return parseDrawValue(raw.draw);
    if ('state' in raw) return parseDrawValue(raw.state);
    if ('value' in raw) return parseDrawValue(raw.value);
    return null;
  }

  if (typeof raw === 'boolean') return raw ? 'start' : 'stop';
  if (typeof raw === 'number') return raw === 0 ? 'stop' : 'start';

  if (typeof raw === 'string') {
    const trimmed = raw.trim();

    try {
      const parsed = JSON.parse(trimmed);
      if (parsed !== raw) {
        const nested = parseDrawValue(parsed);
        if (nested) return nested;
      }
    } catch {
      // not JSON; continue
    }

    const normalized = trimmed
      .replace(/^['"]+|['"]+$/g, '')
      .trim()
      .toLowerCase();

    if (['start', 'on', 'true', '1', 'down'].includes(normalized)) return 'start';
    if (['stop', 'off', 'false', '0', 'up'].includes(normalized)) return 'stop';
  }

  return null;
}

function applyDrawState(nextDraw, source = 'udp-draw') {
  if (!nextDraw || (nextDraw !== 'start' && nextDraw !== 'stop')) return false;
  if (drawState === nextDraw) return false;

  drawState = nextDraw;
  io.emit('sensor-draw', { draw: nextDraw, timestamp: Date.now() });
  console.log(`✍🏻 Draw: ${nextDraw} (${source})`);

  return true;
}

function clampNumber(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function normalizeRgbParts(rRaw, gRaw, bRaw) {
  const rNum = Number(rRaw);
  const gNum = Number(gRaw);
  const bNum = Number(bRaw);
  if (!Number.isFinite(rNum) || !Number.isFinite(gNum) || !Number.isFinite(bNum)) {
    return null;
  }
  return [
    clampNumber(Math.round(rNum), 0, 255),
    clampNumber(Math.round(gNum), 0, 255),
    clampNumber(Math.round(bNum), 0, 255),
  ];
}

function parseRgbColor(raw, fallback = null) {
  if (raw == null) return fallback;

  if (Array.isArray(raw)) {
    if (raw.length < 3) return fallback;
    return normalizeRgbParts(raw[0], raw[1], raw[2]) || fallback;
  }

  if (typeof raw === 'object') {
    const r = raw.r ?? raw.red ?? raw[0];
    const g = raw.g ?? raw.green ?? raw[1];
    const b = raw.b ?? raw.blue ?? raw[2];
    return normalizeRgbParts(r, g, b) || fallback;
  }

  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed !== raw) {
        return parseRgbColor(parsed, fallback);
      }
    } catch {
      // continue
    }
  }

  return fallback;
}

function rgbToHsv(rgb) {
  if (!rgb || rgb.length < 3) return null;
  const r = clampNumber(Number(rgb[0]), 0, 255) / 255;
  const g = clampNumber(Number(rgb[1]), 0, 255) / 255;
  const b = clampNumber(Number(rgb[2]), 0, 255) / 255;

  const cMax = Math.max(r, g, b);
  const cMin = Math.min(r, g, b);
  const delta = cMax - cMin;

  let hue = 0;
  if (delta !== 0) {
    if (cMax === r) hue = 60 * (((g - b) / delta) % 6);
    else if (cMax === g) hue = 60 * (((b - r) / delta) + 2);
    else hue = 60 * (((r - g) / delta) + 4);
  }
  if (hue < 0) hue += 360;

  const sat = cMax === 0 ? 0 : delta / cMax;
  const val = cMax;

  return [
    clampNumber(Math.round(hue), 0, 360),
    clampNumber(Math.round(sat * 100), 0, 100),
    clampNumber(Math.round(val * 100), 0, 100),
  ];
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
  const normalizedColorRgb = parseRgbColor(data.color, lastSensorColorRgb);
  if (normalizedColorRgb) lastSensorColorRgb = normalizedColorRgb;
  const sampledColorHsv = rgbToHsv(normalizedColorRgb ?? lastSensorColorRgb) ?? lastSensorColorHsv;

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

  // DRAW ON CLIENT
  io.emit('sensor-processed-mouse-pos', { x: targetX, y: targetY });

  // PHILIPS HUE UPDATE
  updatePhillipsLight(parsed, { x: targetX, y: targetY }, null);

  lastSensorPacket = parsed;

  return {
    sensor: {
      ...data,
      colorRgb: normalizedColorRgb,
      pickedColor: lastSensorColorHsv, // active color (changes only on click)
      realtimeColor: sampledColorHsv,
      // Backward-compatible aliases:
      color: lastSensorColorHsv,
      sampledColorHsv,
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
  res.send({ status: 'ok', message: 'Hello Magic Paint 🪄' }),
);

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
const configuredArduinoFeedbackHost =
  process.env.ARDUINO_FEEDBACK_HOST?.trim() || null;
const configuredArduinoFeedbackPort = Number(process.env.ARDUINO_FEEDBACK_PORT);
let lastArduinoUdpClient = null;

function rememberArduinoUdpClient(packetPath, rinfo) {
  if (!packetPath?.startsWith('kezia/imu/')) return;
  if (!rinfo?.address || !Number.isFinite(rinfo?.port) || rinfo.port <= 0) return;
  lastArduinoUdpClient = { address: rinfo.address, port: rinfo.port };
}

function getArduinoFeedbackTarget() {
  if (
    configuredArduinoFeedbackHost &&
    Number.isFinite(configuredArduinoFeedbackPort) &&
    configuredArduinoFeedbackPort > 0
  ) {
    return {
      address: configuredArduinoFeedbackHost,
      port: configuredArduinoFeedbackPort,
    };
  }
  return lastArduinoUdpClient;
}

function sendArduinoFeedbackMessage(message, source = 'socket') {
  const target = getArduinoFeedbackTarget();
  if (!target) {
    console.warn(
      `⚠️ Arduino feedback skipped (${message}) - no UDP target. Set ARDUINO_FEEDBACK_HOST/ARDUINO_FEEDBACK_PORT or wait for a kezia/imu/* packet.`,
    );
    return;
  }

  udpServer.send(message, target.port, target.address, (err) => {
    if (err) {
      console.error(`❌ Failed to send Arduino feedback: ${err.message}`);
      return;
    }
    console.log(
      `📤 Arduino feedback (${source}) -> ${target.address}:${target.port} | ${message}`,
    );
  });
}

async function handleSensorEntry(entry, label = 'UDP') {
  if (!entry) return;

  io.emit('sensor-realtime-receive', entry);
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
  rememberArduinoUdpClient(packetPath, rinfo);

  // --- sensor data ---
  if (packetPath === 'kezia/imu/data') {
    try {
      const drawFromData = parseDrawValue(packetData?.draw);
      applyDrawState(drawFromData, 'udp-data-draw');
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
        mouseEnabled = packetData.power === true;
        console.log(`🖱 Power: ${mouseEnabled ? 'ON' : 'OFF'}`);
      }
    } catch (err) {
      console.error('UDP power handling error:', err.message);
    }
    return;
  }

  // --- CONTROL ---
  if (packetPath === 'kezia/imu/draw') {
    try {
      const value = parseDrawValue(packetData);
      if (!value) {
        console.warn('⚠️ Ignoring unknown draw payload:', packetData);
        return;
      }
      applyDrawState(value, 'udp-draw');
    } catch (err) {
      console.error('UDP draw handling error:', err.message);
    }
    return;
  }

  // --- CLICK ---
  if (packetPath === 'kezia/imu/click') {
    try {
      const now = Date.now();
      if (now - lastClickAtMs < CLICK_DEBOUNCE_MS) {
        console.log(`🖱 Click ignored (debounced ${now - lastClickAtMs}ms)`);
        return;
      }
      lastClickAtMs = now;
      io.emit('sensor-click', { timestamp: Date.now() });
      const clickColorRgb = parseRgbColor(packetData?.color, lastSensorColorRgb);
      if (clickColorRgb) lastSensorColorRgb = clickColorRgb;
      const clickColorHsv = rgbToHsv(clickColorRgb ?? lastSensorColorRgb) ?? lastSensorColorHsv;
      if (clickColorHsv) lastSensorColorHsv = clickColorHsv;
      updatePhillipsLight(lastSensorPacket, null, clickColorHsv);
      console.log('🖱 Click relayed');
    } catch (err) {
      console.error('UDP click handling error:', err.message);
    }
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

  socket.on('ui-hover', () => {
    sendArduinoFeedbackMessage('hover', 'ui-hover');
  });

  socket.on('ui-click', () => {
    sendArduinoFeedbackMessage('click', 'ui-click');
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
const hasHueConfig = Boolean(
  address &&
  username &&
  address !== 'undefined' &&
  username !== 'undefined',
);
let requestUrl = hasHueConfig ? 'http://' + address + '/api/' + username + '/' : null;
let lightNumber = Number(process.env.REACT_APP_PHILLIPS_HUE_LIGHT_NUMBER) || 2;

let lightState = {
  on: true,
  bri: 0,
  hue: 0,
};

let lastPhillipsToggle = 0;
const PHILLIPS_POWER_GX_THRESHOLD = 100;

function sendRequest(request, requestMethod, data) {
  if (!requestUrl) return;
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

if (hasHueConfig) {
  getLights();
} else {
  console.log('⚠️ Hue disabled: set REACT_APP_PHILLIPS_HUE_ADDRESS and REACT_APP_PHILLIPS_HUE_USERNAME');
}

function updatePhillipsLight(parsed, mousePos = null, color = null) {
  if (!hasHueConfig) {
    console.log('Please enter an address and username');
    return;
  }
  const data = parsed?.sensor ?? null;
  const now = Date.now();

  // Switch on/off Phillips Hue if wand is turned around
  if (data && Math.abs(data.gx) > PHILLIPS_POWER_GX_THRESHOLD) {
    if (now - lastPhillipsToggle > 3000) {
      lightState.on = !lightState.on;
      lastPhillipsToggle = now;
      console.log(
        `💡 Phillips Hue power toggled: ${lightState.on ? 'ON' : 'OFF'} (gx: ${data.gx})`,
      );
      delete lightState.bri;
      delete lightState.hue;
      delete lightState.sat;
    }
  }

  const hsvColor = Array.isArray(color) && color.length >= 3 ? color : null;
  if (hsvColor && lightState.on) {
    lastSensorColorHsv = hsvColor;
    lightState.hue = Math.round((hsvColor[0] / 360) * 65535);
    lightState.sat = Math.round((hsvColor[1] / 100) * 254);
    lightState.bri = Math.round((hsvColor[2] / 100) * 254);
    console.log(
      `💡 Phillips Hue color update: hsv=${hsvColor.join(',')} -> hue=${lightState.hue}, sat=${lightState.sat}, bri=${lightState.bri}`,
    );
  } else if (mousePos) {
    if (lightState.on) {
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
  const publicUrl = process.env.REACT_APP_SERVER_URL || `http://localhost:${port}`;
  console.log(`🌎 Server running at ${publicUrl}`);
});

udpServer.bind(UDP_PORT, '0.0.0.0');
