// responds to Arduino requests & responses (via TCP)
const net = require('net');
const { WebSocketServer } = require('ws');

const tcpPort = 3000;

let sensorData = [];

const tcpServer = net.createServer((socket) => {
  console.log('Arduino connected:', socket.remoteAddress + ':' + socket.remotePort);

  socket.on('data', (data) => {
    try {
      const parsed = JSON.parse(data.toString());
    //   console.log('Received data from Arduino:', parsed);
      if (parsed && parsed.sensor !== undefined) {
        sensorData.push({ sensor: parsed.sensor, timestamp: parsed.timestamp || null });
        // broadcast to WebSocket clients
        broadcastSensorData({ sensor: parsed.sensor, timestamp: parsed.timestamp });
        console.log('Received sensor data from Arduino:', sensorData.length);
      }

      // maybe purge sensorData if it reaches 1000 entry to offload the server
        if (sensorData.length > 1000) sensorData = [];
    } catch (e) {
    //   console.error('Error parsing data from Arduino:', e.message || e);
    }
  });

  socket.on('end', () => {
    console.log('Arduino disconnected:', socket.remoteAddress + ':' + socket.remotePort);
  });

  socket.on('error', (err) => {
    console.error('Socket error:', err);
  });
});

tcpServer.listen(tcpPort, () => {
  console.log(`🛜 TCP server for Arduino running at port ${tcpPort}`);
});

// --- BROWSER DASHBOARD SERVER ---
// only responds to HTTP requests (browser), not Arduino
// to serve historical data via REST API to browser client
const express = require('express'); // useful for HTTPS 
const http = require('http');
const cors = require('cors');

const app = express();
const port = 4000;

// enable CORS (development)
app.use(cors());

app.get('/', (req, res) => {
  res.send({ status: 'ok', message: 'Hello!' });
});

// --- (Optional) Get latest sensor data(s) (historical) ---
app.get('/sensor-data', (req, res) => {
  res.json(sensorData);
  console.log('🍟 Latest sensor data(s) to client:', sensorData.length);
});

// --- WEBSOCKET DASHBOARD SERVER ---
// for realtime purposes
const server = http.createServer(app);
const wss = new WebSocketServer({ server }); // attach HTTP server

wss.on('connection', (ws) => {
  console.log('🔌 Dashboard connected via WebSocket');
  ws.send(JSON.stringify(sensorData)); // send latest data upon client connection // todo only send to dashboard

  ws.on('close', () => {
    console.log('🪫 Dashboard disconnected');
  });

  // handle remote's messages
  ws.on('message', (message) => {
    try {
      const parsed = JSON.parse(message.toString());
      if (parsed && parsed.sensor !== undefined) {
        const entry = { sensor: parsed.sensor, timestamp: parsed.timestamp || Date.now() };
        sensorData.push(entry);
        console.log('🎉 Remote Sensor Data:', sensorData.length, sensorData[sensorData.length - 1].sensor.toString());
        broadcastSensorData(entry); // forward to dashboard clients
        // keep sensorData bounded
        if (sensorData.length > 1000) sensorData = [];
      }
    } catch (e) {
      // ignore malformed messages
    }
  });

});

function broadcastSensorData(data) {
  const message = JSON.stringify(data);
  wss.clients.forEach((client) => {
    if (client.readyState === client.OPEN) {
      client.send(message);
    }
  });
}

// Start the server
server.listen(port, () => {
  console.log(`🌎 http/ws & https express running at http://localhost:${port}`);
});
