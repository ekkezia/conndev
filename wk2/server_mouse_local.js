// ===============================
// server_mouse_local.js  —  LOCAL ONLY (requires display/macOS)
// Connects to the relay server and controls the mouse on this machine.
// Run with: node server_mouse_local.js
// ===============================

const robot = require("robotjs");
const { spawn } = require("child_process");
const { io: ioClient } = require("socket.io-client");

// Point this at your deployed relay (or localhost for dev)
const RELAY_URL = process.env.REACT_APP_SERVER_URL || "http://localhost:4000";

const socket = ioClient(RELAY_URL);

// ===============================
// Calibration (two-point: TL → BR)
// ===============================
const ROT_GAIN = 0.35;
const TILT_GAIN = 3.5;
const DEAD_ZONE = 1.2;
let lastPitch = null;

let calibState = 0; // 0 = none, 1 = TL captured, 2 = calibrated
let calib = { tl: null, br: null };
let lastHeading = null;
let lastPitchCalib = null;

// ===============================
// Lerp state
// ===============================
let mouseEnabled = false;
let targetX = null;
let targetY = null;
let lerpX = null;
let lerpY = null;

// Lerp loop ~60fps
setInterval(() => {
  if (!mouseEnabled || targetX === null) return;
  const t = 0.12;
  lerpX = lerpX + (targetX - lerpX) * t;
  lerpY = lerpY + (targetY - lerpY) * t;
  const nx = Math.round(lerpX);
  const ny = Math.round(lerpY);
  try { robot.moveMouse(nx, ny); } catch (e) {}
  socket.emit("mouse-pos", { x: nx, y: ny });
}, 1000 / 60);

// ===============================
// Keyboard controls (local terminal)
// ===============================
const readline = require("readline");
readline.emitKeypressEvents(process.stdin);
if (process.stdin.isTTY) process.stdin.setRawMode(true);
process.stdin.on("keypress", (str, key) => {
  if (key.name === "space") {
    mouseEnabled = !mouseEnabled;
    console.log(`🖱 Mouse: ${mouseEnabled ? "ENABLED" : "DISABLED"}`);
  }
  if (key.name === "c") {
    if (calibState === 0 || calibState === 2) {
      calib.tl = { heading: lastHeading, pitch: lastPitchCalib };
      calib.br = null;
      calibState = 1;
      console.log(`🎯 [1/2] TL captured — heading ${lastHeading?.toFixed(1)}°  pitch ${lastPitchCalib?.toFixed(1)}°`);
      console.log(`        Aim at BOTTOM-RIGHT and press 'c'`);
    } else if (calibState === 1) {
      calib.br = { heading: lastHeading, pitch: lastPitchCalib };
      calibState = 2;
      console.log(`✅ [2/2] BR captured`);
      console.log(`        X: ${calib.tl.heading?.toFixed(1)}° → ${calib.br.heading?.toFixed(1)}°`);
      console.log(`        Y: ${calib.tl.pitch?.toFixed(1)}° → ${calib.br.pitch?.toFixed(1)}°`);
    }
  }
  if (key.ctrl && key.name === "c") process.exit();
});

// ===============================
// Process sensor entry from relay
// ===============================
function handleEntry(entry) {
  if (!mouseEnabled) return;
  const data = entry?.sensor;
  if (!data) return;

  const { width: screenW, height: screenH } = robot.getScreenSize();

  if (lerpX === null) {
    const mouse = robot.getMousePos();
    lerpX = mouse.x; lerpY = mouse.y;
    targetX = mouse.x; targetY = mouse.y;
  }

  // Absolute pitch from accelerometer
  const pitch = Math.atan2(data.ax, Math.sqrt(data.ay ** 2 + data.az ** 2)) * 180 / Math.PI;
  lastHeading = data.heading;
  lastPitchCalib = pitch;

  if (calibState === 2) {
    const { tl, br } = calib;

    const hRange = br.heading - tl.heading;
    const hNorm = hRange !== 0 ? (data.heading - tl.heading) / hRange : 0.5;
    targetX = Math.round(Math.max(0, Math.min(1, hNorm)) * (screenW - 1));

    const pRange = br.pitch - tl.pitch;
    const pNorm = pRange !== 0 ? (pitch - tl.pitch) / pRange : 0.5;
    targetY = Math.round(Math.max(0, Math.min(1, 1 - pNorm)) * (screenH - 1)); // inverted: up = lower Y
  } else {
    // Fallback: delta mode
    const moveX = Math.abs(data.gz) < DEAD_ZONE ? 0 : -data.gz * ROT_GAIN;
    const moveY = Math.abs(data.gx) < DEAD_ZONE ? 0 : -data.gx * ROT_GAIN;
    targetX = Math.max(0, Math.min(targetX + moveX, screenW - 1));
    targetY = Math.max(0, Math.min(targetY + moveY, screenH - 1));
  }
}

// ===============================
// Socket events from relay
// ===============================
socket.on("connect", () => console.log("🔌 Connected to relay:", RELAY_URL));
socket.on("disconnect", () => console.log("🪫 Disconnected from relay"));

socket.on("sensor-realtime-receive", handleEntry);

socket.on("sensor-power", (data) => {
  mouseEnabled = data.power;
  console.log(`🖱 Power from relay: ${mouseEnabled ? "ON" : "OFF"}`);
});

socket.on("mouse-click", () => {
  try {
    robot.mouseClick();
    spawn("afplay", ["/System/Library/Sounds/Tink.aiff"], { detached: true, stdio: "ignore" }).unref();
    console.log("🖱 Click");
  } catch (e) {
    console.error("Click error:", e.message);
  }
});

console.log(`🖱 Local mouse agent starting — connecting to ${RELAY_URL}`);
console.log(`   Space = toggle mouse | c = calibrate | Ctrl+C = quit`);
