// server/state.js
// Enhanced GNSS State Manager with TTL (Time-To-Live) and Statistics

const TTL_MS = 5000; // Data older than 5s is considered "stale"

const latest = {
  pvt: null,
  pvt_timestamp: 0,
  
  // Store last sample per channel_id
  obs_by_channel: new Map(),
  obs_last_update_ms: 0
};

/**
 * Updates PVT and records receipt time for staleness checks
 */
function setLatestPvt(msg) {
  latest.pvt = msg;
  latest.pvt_timestamp = Date.now();
}

/**
 * Processes incoming observables and updates the map
 */
function updateLatestObservables(samples) {
  const now = Date.now();
  if (!Array.isArray(samples)) return;

  for (const s of samples) {
    if (s && typeof s.channel_id === "number") {
      // Store sample with a local arrival timestamp
      latest.obs_by_channel.set(s.channel_id, {
        ...s,
        _received_at: now
      });
    }
  }
  latest.obs_last_update_ms = now;
}

/**
 * Returns PVT only if it hasn't expired
 */
function getLatestPvt() {
  if (!latest.pvt || (Date.now() - latest.pvt_timestamp > TTL_MS)) {
    return null; 
  }
  return latest.pvt;
}

/**
 * Returns active observables, filtering out channels that haven't 
 * reported in the last TTL window.
 */
function getLatestObservables({ limit = 64 } = {}) {
  const now = Date.now();
  const activeObs = [];

  for (const [id, s] of latest.obs_by_channel) {
    // Only include if reported recently
    if (now - s._received_at < TTL_MS) {
      activeObs.push(s);
    } else {
      // Housekeeping: remove dead channels from the map
      latest.obs_by_channel.delete(id);
    }
  }

  // Sort by CN0 descending (useful for the Python dashboard)
  activeObs.sort((a, b) => (b.cn0_db_hz ?? 0) - (a.cn0_db_hz ?? 0));
  
  return limit ? activeObs.slice(0, limit) : activeObs;
}

/**
 * Provides health metadata about the GNSS stream
 */
function getLatestObservablesMeta() {
  const now = Date.now();
  return {
    count: latest.obs_by_channel.size,
    pvt_age_ms: now - latest.pvt_timestamp,
    obs_age_ms: now - latest.obs_last_update_ms,
    is_live: (now - latest.pvt_timestamp < TTL_MS)
  };
}

module.exports = {
  setLatestPvt,
  updateLatestObservables,
  getLatestPvt,
  getLatestObservables,
  getLatestObservablesMeta
};