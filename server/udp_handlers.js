// server/udp_handlers.js
const dgram = require("dgram");
const protobuf = require("protobufjs");
const path = require("path");
const { broadcast } = require("./websocket");
const { setLatestPvt, updateLatestObservables } = require("./state");


const UDP_PORT_OBS = 1112; // Monitor.udp_port
const UDP_PORT_PVT = 1111; // PVT.monitor_udp_port

let ObservablesMsg = null;
let MonitorPvtMsg  = null;

async function loadProtobufs() {
  try {
    const root = await protobuf.load([
      path.join(__dirname, "..", "protos", "gnss_synchro.proto"),
      path.join(__dirname, "..", "protos", "monitor_pvt.proto")
    ]);
    ObservablesMsg = root.lookupType("gnss_sdr.Observables");
    MonitorPvtMsg  = root.lookupType("gnss_sdr.MonitorPvt");
    console.log("✅ Loaded protobuf types gnss_sdr.Observables and gnss_sdr.MonitorPvt");
  } catch (err) {
    console.error("❌ Error loading .proto files:", err.message);
    console.error("Ensure 'gnss_synchro.proto' and 'monitor_pvt.proto' are in protos/.");
    process.exit(1);
  }
}

function handleObsUdp(buf) {
  if (!ObservablesMsg) return;

  let obs;
  try {
    obs = ObservablesMsg.decode(buf);
  } catch (e) {
    console.error("OBS decode error:", e.message);
    return;
  }

  const now = new Date().toISOString();

  const samples = (obs.observable || [])
    .filter((s) => s.fs !== 0)
    .map((s) => ({
      type: "observables",
      timestamp: now,
      system: s.system,
      signal: s.signal,
      channel_id: s.channelId,
      prn: s.prn,
      cn0_db_hz: s.cn0DbHz,
      doppler_hz: s.carrierDopplerHz
    }));

  if (samples.length) {
  updateLatestObservables(samples);
  broadcast(samples);
}

}

function handlePvtUdp(buf) {
  if (!MonitorPvtMsg) return;

  let pvt;
  try {
    pvt = MonitorPvtMsg.decode(buf);
  } catch (e) {
    console.error("PVT decode error:", e.message);
    return;
  }

  const now = new Date().toISOString();

  const msg = {
    type: "pvt",
    timestamp: now,
    week: pvt.week,
    tow_ms: pvt.towAtCurrentSymbolMs,
    rx_time: pvt.rxTime,
    lat: pvt.latitude,
    lon: pvt.longitude,
    height: pvt.height,
    pos_x: pvt.posX,
    pos_y: pvt.posY,
    pos_z: pvt.posZ,
    vel_x: pvt.velX,
    vel_y: pvt.velY,
    vel_z: pvt.velZ,
    vel_e: pvt.velE,
    vel_n: pvt.velN,
    vel_u: pvt.velU,
    valid_sats: pvt.validSats,
    solution_status: pvt.solutionStatus,
    solution_type: pvt.solutionType,
    gdop: pvt.gdop,
    pdop: pvt.pdop,
    hdop: pvt.hdop,
    vdop: pvt.vdop
  };

  setLatestPvt(msg);
  broadcast(msg);

}

async function initUdpReceivers() {
  await loadProtobufs();

  const udpObs = dgram.createSocket("udp4");
  udpObs
    .on("listening", () => {
      const a = udpObs.address();
      console.log(`📡 Observables UDP listening on ${a.address}:${a.port}`);
    })
    .on("message", handleObsUdp)
    .on("error", (e) => console.error("❌ Observables UDP Error:", e.message));

  const udpPvt = dgram.createSocket("udp4");
  udpPvt
    .on("listening", () => {
      const a = udpPvt.address();
      console.log(`📡 PVT UDP listening on ${a.address}:${a.port}`);
    })
    .on("message", handlePvtUdp)
    .on("error", (e) => console.error("❌ PVT UDP Error:", e.message));

  try {
    udpObs.bind(UDP_PORT_OBS);
    udpPvt.bind(UDP_PORT_PVT);
  } catch (e) {
    console.error("❌ Failed to bind UDP sockets:", e.message);
    process.exit(1);
  }
}

module.exports = {
  initUdpReceivers
};
