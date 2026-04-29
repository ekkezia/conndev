// ===============================
// server_relay.js
// Handles: MQTT → Socket.IO → Firebase
// ===============================

require('dotenv').config();

const { db } = require('./firebase.js');
const { ref, get, set } = require('firebase/database');

const express = require('express');
const http = require('http');
const cors = require('cors');
const { Server } = require('socket.io');
const mqtt = require('mqtt');
const path = require('path');

const app = express();
const port = process.env.PORT || 4000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'dashboard/build')));

// Auto-detect local vs remote based on REACT_APP_SERVER_URL
// const IS_LOCAL = process.env.REACT_APP_SERVER_URL?.includes('localhost') ?? false;
// Problem: the Render server is super slow and laggy
const IS_LOCAL = false;
console.log(
	`🏠 Server mode: ${IS_LOCAL ? 'LOCAL (Firebase writes disabled)' : 'REMOTE (Firebase writes enabled)'}`,
);

let mouseEnabled = false;
let drawState = null; // 'start' | 'stop' | null

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
				data: {},
			};

			sessions.push(newSession);
			await set(ref(db, 'sessions'), sessions);

			console.log(
				`📁 Firebase session started: ${newSession.id} (index: ${currentSessionIndex})`,
			);
		} else {
			// Local mode - just track in memory, no Firebase write
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

		// Broadcast new session to all connected clients with data as array for consistency
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
					// Firebase stores arrays as objects with numeric keys - convert to array
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

			// Broadcast session end to all connected clients
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

	// Optionally update Phillips Hue state based on sensor data
	// updatePhillipsLight(parsed, { x: targetX, y: targetY });

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
app.get('/', (req, res) =>
	res.send({ status: 'ok', message: 'Hello Magic Wand 🪄' }),
);
app.get('/sensor-data', async (req, res) => {
	try {
		const snapshot = await get(ref(db, 'sessions'));
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
lerpIo = io; // give lerp loop access to io

// ===============================
// MQTT CLIENT
// ===============================
const MQTT_BROKER =
	process.env.MQTT_BROKER || 'mqtt://public.cloud.shiftr.io:1883';
const MQTT_TOPIC = 'kezia/imu/';
const MQTT_SUBTOPIC = {
	DATA: 'data',
	DRAW: 'draw',
	CLICK: 'click',
	POWER: 'power',
};
const MQTT_TOPIC_TEST = 'kezia/test';
const MQTT_FEEDBACK_TOPIC =
	process.env.MQTT_FEEDBACK_TOPIC || `${MQTT_TOPIC}feedback`;

const mqttClient = mqtt.connect(MQTT_BROKER, {
	username: process.env.MQTT_USER || 'public',
	password: process.env.MQTT_PASS || 'public',
});

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
			// not JSON; continue with plain-string parsing
		}

		const normalized = trimmed
			.replace(/^['"]+|['"]+$/g, '')
			.trim()
			.toLowerCase();
		if (['start', 'on', 'true', '1', 'down'].includes(normalized)) {
			return 'start';
		}
		if (['stop', 'off', 'false', '0', 'up'].includes(normalized)) {
			return 'stop';
		}
	}

	return null;
}

function sendMqttFeedbackMessage(message, source = 'socket') {
	if (!mqttClient.connected) {
		console.warn(
			`⚠️ MQTT feedback skipped (${message}) - broker connection is offline.`,
		);
		return;
	}

	mqttClient.publish(MQTT_FEEDBACK_TOPIC, message, (err) => {
		if (err) {
			console.error(`❌ Failed to publish MQTT feedback: ${err.message}`);
			return;
		}

		console.log(`📤 MQTT feedback (${source}) -> ${MQTT_FEEDBACK_TOPIC} | ${message}`);
	});
}

function sendBeatFeedbackToWand(state, source = 'socket') {
	sendMqttFeedbackMessage(
		JSON.stringify({
			type: 'beat_hit',
			state,
			source,
			timestamp: Date.now(),
		}),
		source,
	);
}

async function handleSensorEntry(entry, label = 'MQTT') {
	if (!entry) return;

	io.emit('sensor-realtime-receive', entry);

	if (currentSessionIndex !== null && !IS_LOCAL) {
		console.log(`📝 Received ${label} data, writing to session ${currentSessionIndex}`);

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
					const dataLength = Object.keys(sessions[currentSessionIndex].data).length;
					sessions[currentSessionIndex].data[dataLength] = entry;
				} else {
					sessions[currentSessionIndex].data.push(entry);
				}

				await set(ref(db, 'sessions'), sessions)
					.then(() => console.log('   ✅ Data written to Firebase'))
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

mqttClient.on('connect', () => {
	console.log('📡 Connected to MQTT broker:', MQTT_BROKER);
	for (const sub of Object.values(MQTT_SUBTOPIC)) {
		mqttClient.subscribe(MQTT_TOPIC + sub, (err) => {
			if (err) console.error(`MQTT subscribe error (${sub}):`, err);
			else console.log(`📥 Subscribed: ${MQTT_TOPIC + sub}`);
		});
	}
});

mqttClient.on('message', async (topic, message) => {
	// --- sensor data ---
	if (topic === `${MQTT_TOPIC}${MQTT_SUBTOPIC.DATA}`) {
		try {
			const parsed = JSON.parse(message.toString());
			const entry = processSensorData(parsed, 'mqtt');
			await handleSensorEntry(entry, 'MQTT');
		} catch (err) {
			console.error('MQTT data parse error:', err.message);
		}
		return;
	}

	// --- POWER ---
	if (topic === `${MQTT_TOPIC}${MQTT_SUBTOPIC.POWER}`) {
		let parsed;
		try {
			parsed = JSON.parse(message.toString());
		} catch (err) {
			console.error('MQTT power parse error:', err.message);
			return;
		}

		if (parsed?.power !== undefined) {
			const wasEnabled = mouseEnabled;
			mouseEnabled = parsed.power === true;
			console.log(`🖱 Power: ${mouseEnabled ? 'ON' : 'OFF'}`);
			if (!wasEnabled && mouseEnabled) startNewSession();
			else if (wasEnabled && !mouseEnabled) endSession();
		}
		return;
	}

	// --- CONTROL ---
	if (topic === `${MQTT_TOPIC}${MQTT_SUBTOPIC.DRAW}`) {
		const parsedValue = parseDrawValue(message.toString());
		if (!parsedValue) {
			console.warn(`Unknown draw value from MQTT: ${message.toString()}`);
			return;
		}

		drawState = parsedValue;
		io.emit('sensor-draw', { draw: parsedValue, timestamp: Date.now() });
		console.log(`✍🏻 Draw: ${parsedValue}`);
		return;
	}

	// --- CLICK ---
	if (topic === `${MQTT_TOPIC}${MQTT_SUBTOPIC.CLICK}`) {
		try {
			JSON.parse(message.toString());
			io.emit('sensor-click', { timestamp: Date.now() });
			console.log('🖱 Click relayed');
		} catch (err) {
			console.error('MQTT click parse error:', err.message);
			return;
		}
		return;
	}

	if (topic === MQTT_TOPIC_TEST) {
		console.log(`🧪 Test message (${topic}): ${message.toString()}`);
		return;
	}

	console.warn(`Unknown MQTT topic: ${topic}`);
});

mqttClient.on('error', (err) => console.error('MQTT error:', err));

// ===============================
// Socket.IO
// ===============================
io.on('connection', async (socket) => {
	console.log('🔌 Client connected:', socket.id);

	// Always fetch initial sessions from Firebase, regardless of IS_LOCAL
	try {
		const snapshot = await get(ref(db, 'sessions'));
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

		console.log(
			`📦 Fetched ${sessions.length} sessions from Firebase for new client`,
		);
		// Ensure all session.data is an array
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

	// Frontend reports its screen size on connect
	socket.on('screen-size', (size) => {
		clientScreenSize = size;
		console.log(`🖥 Screen size reported: ${size.width}x${size.height}`);
	});

	// Frontend reports current mouse position (for init / sync)
	socket.on('mouse-pos-report', (pos) => {
		if (targetX === null) {
			targetX = pos.x;
			lerpX = pos.x;
			targetY = pos.y;
			lerpY = pos.y;
		}
	});

	// Handle realtime sensor data from clients (e.g. phone remote)
	socket.on('sensor-realtime-send', (parsed) => {
		processSensorData(parsed, 'socket');
	});

	socket.on('beat-hit', (data = {}) => {
		const state = data?.perfect === true ? 'perfect' : 'hit';
		sendBeatFeedbackToWand(state, 'beat-hit');
	});

	socket.on('beat-miss', () => {
		sendBeatFeedbackToWand('missed', 'beat-miss');
	});

	socket.on('ui-hover', () => {
		sendMqttFeedbackMessage(
			JSON.stringify({
				type: 'hover',
				source: 'ui-hover',
				timestamp: Date.now(),
			}),
			'ui-hover',
		);
	});

	socket.on('ui-click', () => {
		sendMqttFeedbackMessage(
			JSON.stringify({
				type: 'click',
				source: 'ui-click',
				timestamp: Date.now(),
			}),
			'ui-click',
		);
	});

	// Handle manual Phillips Hue control from dashboard
	socket.on('hue-control', (data) => {
		// data: { lightNum, change: { bri: 127, on: true, etc. } }
		if (data && data.lightNum) {
			setLight(data.lightNum, data.change);
		}
	});

	socket.on('disconnect', () => console.log('🪫 Disconnected:', socket.id));

});

// ===============================
// Phillips Light API Integration (placeholder)
// ===============================
// IP address of the Hue hub:
let address = process.env.REACT_APP_PHILLIPS_HUE_ADDRESS;
// username on the hub:
let username = process.env.REACT_APP_PHILLIPS_HUE_USERNAME;
// full URL for request:
let requestUrl = 'http://' + address + '/api/' + username + '/';
// light number that you want to change:
let lightNumber = Number(process.env.REACT_APP_PHILLIPS_HUE_LIGHT_NUMBER) || 2;

// JSON with the state of the light:
let lightState = {
	on: true,
	bri: 0,
  hue: 0,
};
let lastPhillipsToggle = 0; // timestamp of last toggle
const PHILLIPS_POWER_GX_THRESHOLD = 100; // phillips hue is powered on / off by turning the magic wand hard

function sendRequest(request, requestMethod, data) {
  // add the requestURL to the front of the request:
  const url = requestUrl + request;
  // set the parameters:
  let params = {
    method: requestMethod, // GET, POST, PUT, DELETE, etc.
    //mode: 'no-cors', // if you need to turn off CORS, use this
    headers: {    // any HTTP headers you want can go here
      'accept': 'application/json'
    }
  }
  // if it's not a GET request and there's data to send,
  // add it:
  if (requestMethod !== 'GET' || data) {
    params.body = JSON.stringify(data); // body data type must match "Content-Type" header
  }
  // make the request:
  fetch(url, params)
    .then(response => response.json())  // convert response to JSON
    .then(data => console.log(data))   // get the body of the response
    .catch(error => console.log(error));// if there is an error
}


function getLights() {
	sendRequest('lights', 'GET');
}

function setLight(lightNum, change) {
	let request = 'lights/' + lightNum + '/state';
	sendRequest(request, 'PUT', change);
}

// get the state of all the lights:
getLights();

// Test call to light 2 as requested:
// setLight(lightNumber, { on: true, bri: 254, hue: 30181 });


function updatePhillipsLight(parsed, mousePos = null) {
  if (!address || !username) {
		console.log('Please enter an address and username');
		return;
	}
	if (!parsed?.sensor) return null;
	const data = parsed.sensor;

	// Phillips Hue power control by hard flick of the wand (gx spike) with debounce
	const now = Date.now();
	if (Math.abs(data.gx) > PHILLIPS_POWER_GX_THRESHOLD) {
		if (now - lastPhillipsToggle > 3000) {
			// 3 seconds debounce
			lightState.on = !lightState.on;
			lastPhillipsToggle = now;
			console.log(
				`💡 Phillips Hue power toggled: ${lightState.on ? 'ON' : 'OFF'} (gx: ${data.gx})`,
			);
			delete lightState.bri; // avoid errors when turning off
      delete lightState.hue;
		}
	}

	// mouse pos x: map to hue, y: map to brightness
	if (mousePos) {
		if (lightState.on) {
			// only change hue & brightness if phillips power is already on
			// hue: 0-65535, bri: 0-254
			lightState.hue = Math.round((mousePos.x / clientScreenSize.width) * 65535);
			lightState.bri = Math.round((1 - mousePos.y / clientScreenSize.height) * 254);
		}
		console.log(`💡 Phillips Hue update: hue=${lightState.hue}, bri=${lightState.bri}`);
	}

	// send the request using refactored setLight:
	setLight(lightNumber, lightState);
}

// ===============================
// START
// ===============================
server.listen(port, () =>
	console.log(`🌎 Server running at ${process.env.REACT_APP_SERVER_URL}`),
);
