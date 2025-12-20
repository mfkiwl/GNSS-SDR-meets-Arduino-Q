// --- DOM Elements ---
const wsStatus    = document.getElementById('ws-status');
const pvtAge      = document.getElementById('pvt-age');
const pvtLat      = document.getElementById('pvt-lat');
const pvtLon      = document.getElementById('pvt-lon');
const pvtH        = document.getElementById('pvt-height');
const pvtVE       = document.getElementById('pvt-vel-e');
const pvtVN       = document.getElementById('pvt-vel-n');
const pvtVU       = document.getElementById('pvt-vel-u');
const pvtDops     = document.getElementById('pvt-dops');
const pvtSats     = document.getElementById('pvt-sats');
const pvtWeekTow  = document.getElementById('pvt-weektow');
const pvtTimeRx   = document.getElementById('pvt-time-rx');
const pvtDot      = document.querySelector('.status-dot');
const pvtSolStatus= document.getElementById('pvt-sol-status');
const footerLog   = document.getElementById('footer-log');
const tbody       = document.getElementById('channels-body');

const altCanvas   = document.getElementById('alt-canvas');
const cn0Canvas   = document.getElementById('cn0-canvas');
const dopCanvas   = document.getElementById('dop-canvas');

const maxPointsSlider       = document.getElementById('max-points-slider');
const maxPointsLabelInline1 = document.getElementById('max-points-label-inline');
const maxPointsLabelInline2 = document.getElementById('max-points-label-inline-2');

// GNSS-SDR buttons
const btnGnssStart  = document.getElementById('btn-gnss-start');
const btnGnssStart2 = document.getElementById('btn-gnss-start-2');
const btnGnssStart3 = document.getElementById('btn-gnss-start-3');
const btnGnssStop   = document.getElementById('btn-gnss-stop');
const gnssStatus    = document.getElementById('gnss-status');

// Initial max points, user-adjustable via slider
let maxPoints = (typeof window.INIT_MAX_POINTS === 'number' ? window.INIT_MAX_POINTS : 300);
if (maxPointsSlider) maxPointsSlider.value = maxPoints;
if (maxPointsLabelInline1) maxPointsLabelInline1.textContent = String(maxPoints);
if (maxPointsLabelInline2) maxPointsLabelInline2.textContent = String(maxPoints);

const channelRows = new Map();
let lastPvtTime   = null;
let t0            = Date.now();

// --- Leaflet map state ---
let map = null;
let mapMarker = null;
let mapTrack = null;
const mapTrackCoords = [];
const MAX_TRACK_POINTS = 200;
let lastMapUpdateMs = 0;
const MAP_UPDATE_MIN_MS = 500; // ms, limit map updates

// --- Chart state + throttling flags ---
const CHART_COLORS = [
  'rgb(34, 197, 94)',  'rgb(56, 189, 248)', 'rgb(234, 179, 8)',
  'rgb(249, 115, 22)', 'rgb(168, 85, 247)', 'rgb(244, 114, 182)',
  'rgb(45, 212, 191)', 'rgb(74, 222, 128)', 'rgb(96, 165, 250)',
  'rgb(251, 113, 133)'
];

const plotData = {
  alt: { labels: [], data: [] },
  cn0: { datasets: new Map() },
  dop: { datasets: new Map() }
};

let altChart, cn0Chart, dopChart;
let needsAltUpdate = false;
let needsCn0Update = false;
let needsDopUpdate = false;
let renderScheduled = false;

// ---- GNSS-SDR control helpers ----
function setGnssUi(running, msg) {
  if (btnGnssStart)  btnGnssStart.disabled  = running;
  if (btnGnssStart2) btnGnssStart2.disabled = running;
  if (btnGnssStart3) btnGnssStart3.disabled = running;
  if (btnGnssStop)   btnGnssStop.disabled   = !running;
  if (gnssStatus)    gnssStatus.textContent = "Status: " + (msg || (running ? "running" : "stopped"));
}

async function fetchGnssStatus() {
  try {
    const res = await fetch("/api/gnss/status");
    if (!res.ok) {
      setGnssUi(false, "status unknown");
      return;
    }
    const data = await res.json();
    if (data && data.ok) {
      setGnssUi(!!data.running, data.message || (data.running ? "running" : "stopped"));
    } else {
      setGnssUi(false, "status unknown");
    }
  } catch (e) {
    console.error("GNSS status API error", e);
    setGnssUi(false, "status unknown");
  }
}

async function callGnssApi(path) {
  try {
    const res = await fetch(path, { method: "POST" });
    const data = await res.json().catch(() => ({}));
    if (res.ok && data.ok) {
      setGnssUi(data.running, data.message || "");
    } else {
      setGnssUi(false, data.error || "error");
    }
  } catch (e) {
    console.error("GNSS API error", e);
    setGnssUi(false, "API error");
  }
}

if (btnGnssStart) {
  btnGnssStart.addEventListener("click", () => {
    callGnssApi("/api/gnss/start");
  });
}
if (btnGnssStart2) {
  btnGnssStart2.addEventListener("click", () => {
    callGnssApi("/api/gnss/start-alt");
  });
}
if (btnGnssStart3) {
  btnGnssStart3.addEventListener("click", () => {
    callGnssApi("/api/gnss/start-leo");
  });
}
if (btnGnssStop) {
  btnGnssStop.addEventListener("click", () => {
    callGnssApi("/api/gnss/stop");
  });
}

// ---- Chart helpers ----
function scheduleChartRender() {
  if (renderScheduled) return;
  renderScheduled = true;
  requestAnimationFrame(() => {
    if (altChart && needsAltUpdate) altChart.update('none');
    if (cn0Chart && needsCn0Update) cn0Chart.update('none');
    if (dopChart && needsDopUpdate) dopChart.update('none');
    needsAltUpdate = needsCn0Update = needsDopUpdate = false;
    renderScheduled = false;
  });
}

function trimChartDataToMaxPoints() {
  const altData = plotData.alt;
  while (altData.labels.length > maxPoints) altData.labels.shift();
  while (altData.data.length   > maxPoints) altData.data.shift();

  for (const ds of plotData.cn0.datasets.values()) {
    while (ds.data.length > maxPoints) ds.data.shift();
  }
  for (const ds of plotData.dop.datasets.values()) {
    while (ds.data.length > maxPoints) ds.data.shift();
  }

  needsAltUpdate = needsCn0Update = needsDopUpdate = true;
  scheduleChartRender();
}

if (maxPointsSlider) {
  maxPointsSlider.addEventListener('input', () => {
    const val = parseInt(maxPointsSlider.value, 10);
    if (!isNaN(val) && val > 0) {
      maxPoints = val;
      if (maxPointsLabelInline1) maxPointsLabelInline1.textContent = String(maxPoints);
      if (maxPointsLabelInline2) maxPointsLabelInline2.textContent = String(maxPoints);
      trimChartDataToMaxPoints();
    }
  });
}

function getChartConfig(title, yLabel, yMin, yMax, isSingleSeries) {
  return {
    type: 'line',
    data: {
      labels: isSingleSeries ? plotData.alt.labels : [],
      datasets: isSingleSeries ? [{
        label: title,
        data: plotData.alt.data,
        borderColor: CHART_COLORS[0],
        borderWidth: 1.5,
        pointRadius: 0,
        fill: false,
        tension: 0.1
      }] : Array.from(plotData.cn0.datasets.values()),
    },
    options: {
      animation: false,
      responsive: true,
      maintainAspectRatio: false,
      scales: {
        x: {
          type: 'linear',
          title: { display: true, text: 'Time since start [s]' },
          ticks: { callback: (val) => Number(val).toFixed(1) }
        },
        y: {
          title: { display: true, text: yLabel },
          suggestedMin: yMin,
          suggestedMax: yMax
        }
      },
      plugins: {
        legend: { display: !isSingleSeries, position: 'top', labels: { boxWidth: 10 } },
        tooltip: { mode: 'index', intersect: false }
      }
    }
  };
}

function initCharts() {
  altChart = new Chart(altCanvas, getChartConfig('Altitude', 'Height (m)', null, null, true));
  cn0Chart = new Chart(cn0Canvas, getChartConfig('C/N₀ per PRN', 'C/N₀ (dB-Hz)', 20, 55, false));
  dopChart = new Chart(dopCanvas, getChartConfig('Doppler per PRN', 'Doppler (Hz)', null, null, false));

  cn0Chart.data.datasets = Array.from(plotData.cn0.datasets.values());
  dopChart.data.datasets = Array.from(plotData.dop.datasets.values());
}

function initMap() {
  const mapDiv = document.getElementById('map');
  if (!mapDiv || typeof L === 'undefined') {
    console.warn('Leaflet map could not be initialized.');
    return;
  }

  map = L.map('map');
  map.setView([40.0, 0.0], 4);

  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; OpenStreetMap contributors'
  }).addTo(map);

  mapMarker = L.marker([40.0, 0.0]).addTo(map);

  mapTrack = L.polyline([], {
    weight: 3,
    color: '#f97316',
    opacity: 0.9
  }).addTo(map);
}

function cn0Class(cn0) {
  if (cn0 >= 45) return 'cn0-good';
  if (cn0 >= 35) return 'cn0-mid';
  if (cn0 >= 25) return 'cn0-bad';
  return 'cn0-terrible';
}

function fmt(v, digits, unit) {
  if (v == null || isNaN(v)) return '–';
  return Number(v).toFixed(digits) + (unit || '');
}

function gpsToUtcDate(week, tow_ms) {
  if (week == null || tow_ms == null) return null;
  var GPS_EPOCH_MS = Date.UTC(1980, 0, 6, 0, 0, 0);
  var SECONDS_PER_WEEK = 604800;
  var GPS_UTC_OFFSET = 18;
  var gpsMs = GPS_EPOCH_MS + week * SECONDS_PER_WEEK * 1000 + tow_ms;
  var utcMs = gpsMs - GPS_UTC_OFFSET * 1000;
  return new Date(utcMs);
}

// -------- PVT handling ----------
function updatePvt(msg) {
  const now = Date.now();
  const t   = (now - t0) / 1000.0;

  lastPvtTime = new Date(msg.timestamp || now);

  pvtLat.textContent = 'Lat: ' + fmt(msg.lat, 6, ' °');
  pvtLon.textContent = 'Lon: ' + fmt(msg.lon, 6, ' °');
  pvtH.textContent   = 'Alt: ' + fmt(msg.height, 2, ' m');

  pvtVE.textContent  = 'E: ' + fmt(msg.vel_e, 2);
  pvtVN.textContent  = 'N: ' + fmt(msg.vel_n, 2);
  pvtVU.textContent  = 'U: ' + fmt(msg.vel_u, 2);

  const g = fmt(msg.gdop, 1);
  const p = fmt(msg.pdop, 1);
  const h = fmt(msg.hdop, 1);
  const v = fmt(msg.vdop, 1);
  pvtDops.textContent = 'GDOP ' + g + '  |  PDOP ' + p + '  |  HDOP ' + h + '  |  VDOP ' + v;

  pvtSats.textContent = 'Sats: ' + (msg.valid_sats != null ? msg.valid_sats : '–');

  pvtWeekTow.textContent =
    'Week ' + (msg.week != null ? msg.week : '–') +
    '  |  TOW ' + (msg.tow_ms != null ? fmt(msg.tow_ms / 1000.0, 3, ' s') : '–');

  var utc = gpsToUtcDate(msg.week, msg.tow_ms);
  if (utc) {
    pvtTimeRx.textContent = 'UTC Time: ' +
      utc.toISOString().replace('T', ' ').replace('Z', ' UTC');
  } else {
    pvtTimeRx.textContent = 'UTC Time: –';
  }

  var status = (msg.solution_status != null ? msg.solution_status : 0);
  var sats   = (typeof msg.valid_sats === 'number' ? msg.valid_sats : 0);
  var hasSol = status !== 0 && sats >= 4;

  pvtDot.id = hasSol ? 'pvt-dot-ok' : 'pvt-dot-bad';

  if (hasSol) {
    var typeText = (msg.solution_type != null ? msg.solution_type : '–');
    pvtSolStatus.textContent =
      'Solution status ' + status + ' (sats: ' + sats + ', type=' + typeText + ')';
  } else {
    pvtSolStatus.textContent =
      'No valid solution (status=' + status + ', sats=' + sats + ')';
  }

  pvtAge.textContent = 'Last PVT: just now';

  if (map && typeof msg.lat === 'number' && typeof msg.lon === 'number' &&
      !isNaN(msg.lat) && !isNaN(msg.lon)) {
    const nowMs = Date.now();
    if (nowMs - lastMapUpdateMs > MAP_UPDATE_MIN_MS) {
      const latlng = [msg.lat, msg.lon];

      if (mapMarker) {
        mapMarker.setLatLng(latlng);
      }

      mapTrackCoords.push(latlng);
      if (mapTrackCoords.length > MAX_TRACK_POINTS) {
        mapTrackCoords.shift();
      }
      if (mapTrack) {
        mapTrack.setLatLngs(mapTrackCoords);
      }

      if (!map.getBounds().contains(latlng)) {
        map.panTo(latlng);
      }

      lastMapUpdateMs = nowMs;
    }
  }

  if (!isNaN(msg.height)) {
    const altData = plotData.alt;
    altData.labels.push(t);
    altData.data.push(msg.height);
    if (altData.labels.length > maxPoints) {
      altData.labels.shift();
      altData.data.shift();
    }
    needsAltUpdate = true;
    scheduleChartRender();
  }
}

// -------- Channel handling ----------
function updateChannel(sample) {
  const id   = sample.channel_id;
  const now  = Date.now();
  const t    = (now - t0) / 1000.0;
  const prnKey = (sample.system || 'UNK') + String(sample.prn != null ? sample.prn : id);

  let tr = channelRows.get(id);
  if (!tr) {
    tr = document.createElement('tr');
    tr.innerHTML =
      '<td class="num ch"></td>' +
      '<td class="num prn"></td>' +
      '<td class="sys"></td>'  +
      '<td class="sig"></td>'  +
      '<td class="num cn0"></td>' +
      '<td class="num dop"></td>' +
      '<td class="time"></td>';
    channelRows.set(id, tr);
    tbody.appendChild(tr);
  }

  tr.querySelector('.ch').textContent  = id;
  tr.querySelector('.prn').textContent = (sample.prn != null ? sample.prn : '–');
  tr.querySelector('.sys').textContent = sample.system || '';
  tr.querySelector('.sig').textContent = sample.signal || '';

  const cn0Cell = tr.querySelector('.cn0');
  if (typeof sample.cn0_db_hz === 'number') {
    cn0Cell.textContent = sample.cn0_db_hz.toFixed(1);
    cn0Cell.className   = 'num cn0 ' + cn0Class(sample.cn0_db_hz);
  } else {
    cn0Cell.textContent = '–';
    cn0Cell.className   = 'num cn0';
  }

  tr.querySelector('.dop').textContent =
    (typeof sample.doppler_hz === 'number' ? sample.doppler_hz.toFixed(1) : '–');

  const tt = new Date(sample.timestamp || Date.now());
  tr.querySelector('.time').textContent = tt.toLocaleTimeString();

  updateMultiSeriesPlot(plotData.cn0, cn0Chart, prnKey, t, sample.cn0_db_hz, 'C/N₀', id);
  updateMultiSeriesPlot(plotData.dop, dopChart, prnKey, t, sample.doppler_hz, 'Doppler', id);
}

function updateMultiSeriesPlot(plotObj, chart, key, t, y, labelPrefix, chId) {
  if (typeof y !== 'number' || isNaN(y)) return;

  let dataset = plotObj.datasets.get(key);
  if (!dataset) {
    const colorIndex = plotObj.datasets.size % CHART_COLORS.length;
    dataset = {
      label: labelPrefix + ' ' + key + ' (Ch ' + chId + ')',
      data: [],
      borderColor: CHART_COLORS[colorIndex],
      borderWidth: 1.5,
      pointRadius: 1.5,
      fill: false,
      tension: 0.1,
      parsing: false
    };
    plotObj.datasets.set(key, dataset);
    if (chart) {
      chart.data.datasets = Array.from(plotObj.datasets.values());
    }
  }

  dataset.data.push({ x: t, y: y });
  if (dataset.data.length > maxPoints) dataset.data.shift();

  if (chart === cn0Chart) {
    needsCn0Update = true;
  } else if (chart === dopChart) {
    needsDopUpdate = true;
  }
  scheduleChartRender();
}

function handleMessage(msg) {
  if (Array.isArray(msg)) {
    msg.forEach(handleMessage);
    return;
  }

  if (msg.type === 'pvt') {
    updatePvt(msg);
    footerLog.textContent = 'Last PVT: ' + JSON.stringify(msg).slice(0, 260) + '...';
  } else if (msg.type === 'observables') {
    updateChannel(msg);
  }
}

function connectWS() {
  const proto = (location.protocol === 'https:') ? 'wss://' : 'ws://';
  const ws    = new WebSocket(proto + location.host + '/ws');

  ws.onopen = function() {
    wsStatus.textContent = 'WebSocket: connected';
    wsStatus.className   = 'ws-ok';
  };

  ws.onclose = function() {
    wsStatus.textContent = 'WebSocket: disconnected (retrying…)';
    wsStatus.className   = 'ws-bad';
    setTimeout(connectWS, 2000);
  };

  ws.onerror = function(err) {
    wsStatus.textContent = 'WebSocket error';
    wsStatus.className   = 'ws-bad';
    console.error('WS Error:', err);
  };

  ws.onmessage = function(ev) {
    try {
      const data = JSON.parse(ev.data);
      handleMessage(data);
    } catch (err) {
      console.error('Bad JSON from server', err);
    }
  };
}

setInterval(function() {
  if (!lastPvtTime) return;
  const now = Date.now();
  const dt  = Math.round((now - lastPvtTime.getTime()) / 1000);
  if (dt <= 1) {
    pvtAge.textContent = 'Last PVT: just now';
  } else {
    pvtAge.textContent = 'Last PVT: ' + dt + ' s ago';
  }
}, 1000);

// Init on load
initCharts();
initMap();
connectWS();
fetchGnssStatus();
