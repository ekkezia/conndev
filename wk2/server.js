// server.js
const net = require('net');
const express = require('express');
const http = require('http');
const cors = require('cors');
const { WebSocketServer } = require('ws');

const tcpPort = 3000;
const httpPort = 4000;
let sensorData = [];

// --- TCP SERVER FOR ARDUINO ---
const tcpServer = net.createServer((socket) => {
  console.log('Arduino connected:', socket.remoteAddress + ':' + socket.remotePort);

  socket.on('data', (data) => {
  const str = data.toString().trim();
  
  // quick sanity check: JSON must start with { or [
  if (!str.startsWith('{') && !str.startsWith('[')) {
    console.warn('Non-JSON data received on Arduino TCP port:', str);
    return;
  }

  try {
    const parsed = JSON.parse(str);
    if (parsed && parsed.sensor !== undefined) {
      const entry = {
        sensor: parsed.sensor,
        timestamp: parsed.timestamp || Date.now(),
        source: 'arduino'
      };
      sensorData.push(entry);
      broadcastSensorData(entry);
      if (sensorData.length > 1000) sensorData = [];
    }
  } catch (e) {
    console.error('Error parsing Arduino data:', e.message);
  }
});


  socket.on('end', () => console.log('Arduino disconnected:', socket.remoteAddress));
  socket.on('error', (err) => console.error('Arduino socket error:', err));
});

tcpServer.listen(tcpPort, () => console.log(`🛜 TCP server running on port ${tcpPort}`));

// --- EXPRESS HTTP SERVER ---
const app = express();
app.use(cors());

app.get('/', (req, res) => res.send({ status: 'ok', message: 'Hello!' }));

// Historical sensor data
app.get('/sensor-data', (req, res) => {
  res.json(sensorData);
  console.log('🍟 Sent historical sensor data. Total:', sensorData.length);
});

const server = http.createServer(app);

// --- WEBSOCKET SERVER (MERGED) ---
const wss = new WebSocketServer({ server }); // single path for all clients

wss.on('connection', (ws, req) => {
  console.log('🔌 WebSocket client connected:', req.socket.remoteAddress);

  // Send all current sensorData on connection
  ws.send(JSON.stringify(sensorData));

  ws.on('message', (message) => {
    try {
      const parsed = JSON.parse(message.toString());
      if (parsed && parsed.sensor !== undefined) {
        const entry = {
          sensor: parsed.sensor,
          timestamp: parsed.timestamp || Date.now(),
          source: 'remote' // tag as remote
        };
        sensorData.push(entry);
        broadcastSensorData(entry);
        if (sensorData.length > 1000) sensorData = [];
        console.log('📱 Remote data received. Total entries:', sensorData.length);
      }
    } catch (e) {
      console.warn('Malformed message from client, ignored.');
    }
  });

  ws.on('close', () => console.log('🪫 WebSocket client disconnected'));
});

function broadcastSensorData(data) {
  const message = JSON.stringify(data);
  wss.clients.forEach((client) => {
    if (client.readyState === client.OPEN) {
      client.send(message);
    }
  });
}

server.listen(httpPort, () => console.log(`🌎 HTTP/WebSocket server running at http://localhost:${httpPort}`));
