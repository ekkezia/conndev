// // responds to Arduino requests & responses (via TCP)
const net = require('net');

const tcpPort = 3000;

// server.js
const express = require('express');
const http = require('http');
const cors = require('cors');
const { Server } = require('socket.io');

const app = express();
const port = process.env.PORT || 4000;

// --- Middleware ---
app.use(cors());
app.use(express.json());

// --- In-memory sensor storage ---
let sensorData = [];

// --- REST endpoints (optional) ---
app.get('/', (req, res) => {
  res.send({ status: 'ok', message: 'Hello!' });
});

// get latest data by query
app.get('/sensor-data', (req, res) => {
  res.json(sensorData);
});

// --- HTTP + Socket.IO server ---
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: '*', // allow all for testing; restrict in production
    methods: ['GET', 'POST'],
  },
});

// --- TCP server for Arduino (forward parsed sensor data to socket.io) ---
const tcpServer = net.createServer((socket) => {
  console.log('Arduino connected (TCP):', socket.remoteAddress + ':' + socket.remotePort);

  // Buffer incoming data to handle partial/multiple JSON objects per TCP chunk.
  socket._buffer = '';
  socket.on('data', (data) => {
    try {
      socket._buffer += data.toString();
      let buf = socket._buffer;

      // scan for balanced JSON objects starting at '{'
      let start = buf.indexOf('{');
      while (start !== -1) {
        let depth = 0;
        let end = -1;
        for (let i = start; i < buf.length; i++) {
          const ch = buf[i];
          if (ch === '{') depth++;
          else if (ch === '}') depth--;
          if (depth === 0) { end = i; break; }
        }

        if (end === -1) {
          // incomplete JSON, wait for more data
          break;
        }

        const piece = buf.slice(start, end + 1);
        buf = buf.slice(end + 1);

        try {
          const parsed = JSON.parse(piece);
          if (parsed && parsed.sensor !== undefined) {
            const entry = { sensor: parsed.sensor, timestamp: parsed.timestamp || Date.now() };
            sensorData.push(entry);
            if (sensorData.length > 1000) sensorData.shift();
            io.emit('sensor-realtime-receive', entry);
            console.log('Received sensor data from Arduino (TCP):', sensorData.slice(-1));
          }
        } catch (e) {
          console.warn('Malformed JSON from Arduino TCP, skipping piece:', e.message || e);
        }

        start = buf.indexOf('{');
      }

      socket._buffer = buf;
    } catch (e) {
      console.error('Error processing TCP payload from Arduino:', e.message || e);
    }
  });

  socket.on('end', () => {
    console.log('Arduino (TCP) disconnected:', socket.remoteAddress + ':' + socket.remotePort);
  });

  socket.on('error', (err) => {
    console.error('Arduino (TCP) socket error:', err);
  });
});

tcpServer.listen(tcpPort, () => {
  console.log(`🛜 TCP server for Arduino running at port ${tcpPort}`);
});


// --- Socket.IO namespace for DASHBOARD / REMOTE ---
io.on('connection', (socket) => {
  console.log('🔌 Dashboard connected:', socket.id);
  socket.emit('sensor-initial-data', sensorData); // send latest data to client upon connection
  socket.emit('user', { id: socket.id }); // send user ID
  
  // [CASE] Receiving from mobile phone or Arduino
  // Note: Switch to Render host if using mobile phone because local network can't access gyro/accel
  // on receiving realtime sensor data (sensor-realtime-send) from remote client
  socket.on('sensor-realtime-send', (data) => {
    console.log('🚀 Received from REMOTE', data);
    if (!data?.sensor) return;
    
    const entry = { ...data, timestamp: data.timestamp || Date.now() };
    if (sensorData.length >= 1000) sensorData.shift();
    sensorData.push(entry);
    // then broadcast to all clients
    io.emit('sensor-realtime-receive', entry);
  })

  socket.on('disconnect', () => {
    console.log('🪫 Dashboard disconnected:', socket.id);
  });
});

// --- Start server ---
server.listen(port, () => {
  console.log(`🌎 Server running at http://localhost:${port}`);
});
