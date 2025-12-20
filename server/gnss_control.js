// server/gnss_control.js
const { spawn } = require("child_process");

// --- GNSS-SDR command (adjust if needed) ---
const GNSS_CMD = "gnss-sdr";

// Configuration files (edit paths to your needs)
const GNSS_CONFIGS = {
  conf1: "/home/arduino/gnss-sdr/conf/File_input/file_GPS_L1_alta_dinamica.conf",
  conf2: "/home/arduino/gnss-sdr/conf/RealTime_input/all_bands_rtl_realtime.conf",
  conf3: "/home/arduino/gnss-sdr/conf/File_input/cubesat_GPS.conf"
};

let gnssProcess = null;
let currentConfigKey = null; // track which config is running

function startGnssSdr(configKey = "conf1") {
  if (gnssProcess) {
    return {
      ok: false,
      error: "GNSS-SDR already running",
      running: true,
      config: currentConfigKey
    };
  }
  try {
    const cfgPath = GNSS_CONFIGS[configKey] || GNSS_CONFIGS.conf1;
    const args = ["-c", cfgPath];

    gnssProcess = spawn(GNSS_CMD, args, {
      stdio: ["ignore", "pipe", "pipe"]
    });
    currentConfigKey = configKey;

    console.log(`🚀 Started GNSS-SDR: ${GNSS_CMD} ${args.join(" ")}`);

    gnssProcess.stdout.on("data", (data) => {
      console.log("[gnss-sdr stdout]", data.toString().trim());
    });
    gnssProcess.stderr.on("data", (data) => {
      console.error("[gnss-sdr stderr]", data.toString().trim());
    });
    gnssProcess.on("exit", (code, signal) => {
      console.log(`🔚 GNSS-SDR exited (code=${code}, signal=${signal})`);
      gnssProcess = null;
      currentConfigKey = null;
    });

    return {
      ok: true,
      running: true,
      config: currentConfigKey,
      message: `GNSS-SDR started (${configKey})`
    };
  } catch (e) {
    console.error("❌ Failed to start gnss-sdr:", e.message);
    gnssProcess = null;
    currentConfigKey = null;
    return { ok: false, error: e.message, running: false, config: null };
  }
}

function stopGnssSdr() {
  if (!gnssProcess) {
    return {
      ok: false,
      error: "GNSS-SDR is not running",
      running: false,
      config: currentConfigKey
    };
  }
  try {
    gnssProcess.kill("SIGTERM");
    console.log("🛑 Sent SIGTERM to GNSS-SDR");
    return {
      ok: true,
      running: false,
      config: currentConfigKey,
      message: "GNSS-SDR stopping"
    };
  } catch (e) {
    console.error("❌ Failed to stop gnss-sdr:", e.message);
    return {
      ok: false,
      error: e.message,
      running: !!gnssProcess,
      config: currentConfigKey
    };
  }
}

function getStatus() {
  const running = !!gnssProcess;
  const message = running
    ? `running${currentConfigKey ? " (" + currentConfigKey + ")" : ""}`
    : "stopped";
  return {
    ok: true,
    running,
    config: currentConfigKey,
    message
  };
}

module.exports = {
  startGnssSdr,
  stopGnssSdr,
  getStatus
};
