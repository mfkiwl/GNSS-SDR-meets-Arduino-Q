// server/server.js
const path = require("path");
const express = require("express");
const http = require("http");

const { initWebSocket } = require("./websocket");
const { initUdpReceivers } = require("./udp_handlers");
const { startGnssSdr, stopGnssSdr, getStatus } = require("./gnss_control");
const { getLatestPvt, getLatestObservables, getLatestObservablesMeta } = require("./state");

const HTTP_PORT = 8080;

const app = express();
const server = http.createServer(app);

// Static files
app.use(express.static(path.join(__dirname, "..", "public")));
app.use(express.json());

app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  next();

});

// Latest PVT (single object)
app.get("/api/latest/pvt", (req, res) => {
  const pvt = getLatestPvt();
  res.json({
    ok: true,
    pvt: pvt   // null when not available
  });
});

// Latest observables snapshot (array)
app.get("/api/latest/observables", (req, res) => {
  const limit = Number(req.query.limit ?? 64);
  const obs = getLatestObservables({ limit: Number.isFinite(limit) ? limit : 64 });
  const meta = getLatestObservablesMeta();
  res.json({ ok: true, meta, observables: obs });
});


// GNSS API
app.post("/api/gnss/start", (req, res) => {
  const result = startGnssSdr("conf1");
  res.status(result.ok ? 200 : 500).json(result);
});

app.post("/api/gnss/start-alt", (req, res) => {
  const result = startGnssSdr("conf2");
  res.status(result.ok ? 200 : 500).json(result);
});

app.post("/api/gnss/start-leo", (req, res) => {
  const result = startGnssSdr("conf3");
  res.status(result.ok ? 200 : 500).json(result);
});

app.post("/api/gnss/stop", (req, res) => {
  const result = stopGnssSdr();
  res.status(result.ok ? 200 : 500).json(result);
});

app.get("/api/gnss/status", (req, res) => {
  const result = getStatus();
  res.status(200).json(result);
});

// Initialize WebSocket + UDP
initWebSocket(server);
initUdpReceivers();

// Start server
server.listen(HTTP_PORT, () => {
  console.log(`🌐 Web server running at http://localhost:${HTTP_PORT}`);
  console.log("Waiting for UDP data from GNSS-SDR...");
  console.log("Use the web UI to start/stop gnss-sdr.");
});
