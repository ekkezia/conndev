// Simple local server for Electron
const express = require('express');
const app = express();
const port = 3000;

app.use(express.static(__dirname));

app.get('/api/ping', (req, res) => {
  res.json({ status: 'ok' });
});

app.listen(port, () => {
  console.log(`Local server running at http://localhost:${port}`);
});
