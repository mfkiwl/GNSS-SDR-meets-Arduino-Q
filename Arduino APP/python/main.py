#!/usr/bin/env python3
# SPDX-License-Identifier: MPL-2.0

import json
import os
import time
import threading
import urllib.request
import urllib.error
import math
from typing import Optional, List, Any, Dict

# Arduino Bridge environment
from arduino.app_utils import *

# ---------------------------- config ----------------------------
NODE_PORT = int(os.getenv("NODE_PORT", "8080"))
POLL_HZ = float(os.getenv("POLL_HZ", "2"))
MAX_BARS = int(os.getenv("MAX_BARS", "6"))
PRINT_EVERY_S = float(os.getenv("PRINT_EVERY_S", "1.0"))
ENABLE_CONSOLE = os.getenv("ENABLE_CONSOLE", "1") == "1"

# Use 127.0.0.1 for local, 172.17.0.1 for Docker host gateway
NODE_BASE_URL = os.getenv("NODE_BASE_URL", f"http://172.17.0.1:{NODE_PORT}")

# ---------------------------- shared state ----------------------------
_lock = threading.Lock()

# Values sent to MCU
GNSS_PVT = 0           # 0=blink (no PVT), 2=solid (PVT ok)
GNSS_SATS = 0          # Sat count shown on dashboard
GNSS_AGE = 99.0
GNSS_HEADING = 0.0
GNSS_SPEED = 0.0
GNSS_CN0: List[float] = []

# High-precision values for Console
CURR_LAT, CURR_LON, CURR_ALT = 0.0, 0.0, 0.0
CURR_VEL = {"N": 0.0, "E": 0.0, "U": 0.0}

_last_pvt_rx_time: Optional[float] = None
_last_print_time = 0.0
_last_http_log_t = 0.0

# ---------------------------- helpers ----------------------------
def _finite(x: Any, default: float = 0.0) -> float:
    try:
        v = float(x)
        return v if math.isfinite(v) else default
    except Exception:
        return default

def _get_first(d: Dict[str, Any], keys: List[str], default: Any = 0.0) -> Any:
    for k in keys:
        if k in d and d.get(k) is not None:
            return d.get(k)
    return default

def http_get_json(url: str) -> Optional[Any]:
    """
    Robust JSON GET:
      - Returns parsed JSON if body is valid JSON
      - Returns None for empty body / non-JSON body
      - Rate-limited debug printing on errors
    """
    global _last_http_log_t
    try:
        with urllib.request.urlopen(url, timeout=1.0) as resp:
            raw = resp.read()
            if not raw or len(raw.strip()) == 0:
                return None
            try:
                return json.loads(raw.decode("utf-8", errors="replace"))
            except json.JSONDecodeError:
                now = time.time()
                if now - _last_http_log_t > 5.0:
                    _last_http_log_t = now
                    ctype = resp.headers.get("Content-Type", "")
                    preview = raw[:200].decode("utf-8", errors="replace")
                    print(f"[PY] Non-JSON body from {url} (ctype={ctype}). Preview: {preview!r}")
                return None
    except urllib.error.HTTPError as e:
        now = time.time()
        if now - _last_http_log_t > 5.0:
            _last_http_log_t = now
            body = b""
            try:
                body = e.read()
            except Exception:
                pass
            preview = body[:200].decode("utf-8", errors="replace")
            print(f"[PY] HTTPError {e.code} on {url}. Preview: {preview!r}")
        return None
    except Exception as e:
        now = time.time()
        if now - _last_http_log_t > 5.0:
            _last_http_log_t = now
            print(f"[PY] HTTP error on {url}: {type(e).__name__}: {e}")
        return None

def clear_pvt_fields_when_stale() -> None:
    global CURR_LAT, CURR_LON, CURR_ALT, CURR_VEL, GNSS_HEADING, GNSS_SPEED
    CURR_LAT = CURR_LON = CURR_ALT = 0.0
    CURR_VEL["N"] = CURR_VEL["E"] = CURR_VEL["U"] = 0.0
    GNSS_HEADING = 0.0
    GNSS_SPEED = 0.0

def update_from_pvt(pvt: Dict[str, Any]) -> None:
    """
    PVT keys as produced by your Node udp_handlers.js:
      lat, lon, height, vel_e, vel_n, vel_u, valid_sats, solution_status
    Also tolerates common alternates (latitude/longitude, velE/velN/velU, etc.)
    """
    global GNSS_PVT, GNSS_SATS, GNSS_AGE, GNSS_HEADING, GNSS_SPEED
    global CURR_LAT, CURR_LON, CURR_ALT, CURR_VEL, _last_pvt_rx_time

    _last_pvt_rx_time = time.time()

    sol = _get_first(pvt, ["solution_status", "solutionStatus"], 0)
    try:
        sol_int = int(sol) if sol is not None else 0
    except Exception:
        sol_int = 0
    GNSS_PVT = 2 if sol_int >= 4 else 0

    GNSS_SATS = int(_get_first(pvt, ["valid_sats", "validSats", "num_sats", "sats"], 0) or 0)

    # Age: prefer pvt['age'] if you ever add it; else derive from receipt time
    GNSS_AGE = _finite(_get_first(pvt, ["age", "pvt_age", "age_s"], 0.0), 0.0)

    # Heading/speed: your Node PVT does not include these currently; keep 0 unless present
    GNSS_HEADING = _finite(_get_first(pvt, ["heading", "track", "course", "cog"], 0.0), 0.0) % 360.0
    GNSS_SPEED = _finite(_get_first(pvt, ["ground_speed", "speed", "speed_mps", "sog"], 0.0), 0.0)

    # Position
    CURR_LAT = _finite(_get_first(pvt, ["lat", "latitude"], 0.0), 0.0)
    CURR_LON = _finite(_get_first(pvt, ["lon", "longitude"], 0.0), 0.0)
    CURR_ALT = _finite(_get_first(pvt, ["height", "alt", "altitude"], 0.0), 0.0)

    # Velocity ENU (Node: vel_e, vel_n, vel_u)
    CURR_VEL["E"] = _finite(_get_first(pvt, ["vel_e", "velE", "velocity_e", "vel_e_mps"], 0.0), 0.0)
    CURR_VEL["N"] = _finite(_get_first(pvt, ["vel_n", "velN", "velocity_n", "vel_n_mps"], 0.0), 0.0)
    CURR_VEL["U"] = _finite(_get_first(pvt, ["vel_u", "velU", "velocity_u", "vel_u_mps"], 0.0), 0.0)

def update_from_observables(obs_list: List[Dict[str, Any]]) -> None:
    """
    Observables keys as produced by your Node udp_handlers.js:
      channel_id, prn, cn0_db_hz, doppler_hz, system, signal
    FIX: drive GNSS_SATS from tracked channels when GNSS_PVT == 0 (no PVT solution yet).
    """
    global GNSS_CN0, GNSS_SATS, GNSS_PVT

    vals: List[float] = []
    tracked_channels = set()

    for item in obs_list:
        if not isinstance(item, dict):
            continue

        cn0 = item.get("cn0_db_hz")
        ch = item.get("channel_id")

        if isinstance(cn0, (int, float)) and cn0 > 0:
            vals.append(float(cn0))
            if isinstance(ch, int):
                tracked_channels.add(ch)

    vals.sort(reverse=True)
    GNSS_CN0 = vals[:MAX_BARS]

    tracked = len(tracked_channels)
    if GNSS_PVT == 0:
        GNSS_SATS = min(12, tracked)
    else:
        GNSS_SATS = max(GNSS_SATS, min(12, tracked))

# ---------------------------- main loop ----------------------------
def gnss_loop() -> None:
    global GNSS_PVT, GNSS_AGE, _last_print_time

    pvt_url = f"{NODE_BASE_URL}/api/latest/pvt"
    obs_url = f"{NODE_BASE_URL}/api/latest/observables?limit=64"

    print(f"[PY] GNSS Poller Started. Polling {NODE_BASE_URL} at {POLL_HZ}Hz")

    while True:
        pvt_data = http_get_json(pvt_url)
        obs_data = http_get_json(obs_url)

        with _lock:
            # --- PVT endpoint contract (AFTER YOU FIXED NODE): { ok:true, pvt:<obj|null> } ---
            pvt_obj = None
            if isinstance(pvt_data, dict):
                pvt_obj = pvt_data.get("pvt", None)

            if isinstance(pvt_obj, dict):
                update_from_pvt(pvt_obj)
            else:
                GNSS_PVT = 0
                if _last_pvt_rx_time is not None:
                    GNSS_AGE = time.time() - _last_pvt_rx_time
                else:
                    GNSS_AGE = 99.0
                clear_pvt_fields_when_stale()

            # --- Observables endpoint contract: { ok:true, meta:{...}, observables:[...] } ---
            obs_list = None
            if isinstance(obs_data, dict):
                obs_list = obs_data.get("observables")

            if isinstance(obs_list, list):
                update_from_observables(obs_list)

            # --- Console dashboard ---
            if ENABLE_CONSOLE:
                now = time.time()
                if now - _last_print_time >= PRINT_EVERY_S:
                    _last_print_time = now
                    print("\033[H\033[J")  # Clear terminal screen
                    print(f"=== GNSS MONITOR [{time.strftime('%H:%M:%S')}] ===")
                    print(f" POS: {CURR_LAT:>10.6f}, {CURR_LON:>10.6f} | Alt: {CURR_ALT:.1f}m")
                    print(f" VEL: N:{CURR_VEL['N']:>6.2f} E:{CURR_VEL['E']:>6.2f} U:{CURR_VEL['U']:>6.2f} m/s")
                    print(f" DASH: P={GNSS_PVT} S={GNSS_SATS} Age={GNSS_AGE:.1f}s Hdg={GNSS_HEADING:.1f}° Spd={GNSS_SPEED:.2f}m/s")
                    print(f" CN0: {', '.join(f'{v:.1f}' for v in GNSS_CN0) if GNSS_CN0 else '(searching...)'}")
                    print("=" * 60)

        time.sleep(1.0 / POLL_HZ)

# Run poller in background
threading.Thread(target=gnss_loop, daemon=True).start()

# ---------------------------- bridge ----------------------------
def get_gnss_status() -> str:
    """Serialized status string to Arduino."""
    with _lock:
        c_str = ",".join(f"{v:.1f}" for v in GNSS_CN0)
        # Contract: P=;S=;A=;H=;V=;C=;
        return (
            f"P={GNSS_PVT};"
            f"S={GNSS_SATS};"
            f"A={GNSS_AGE:.1f};"
            f"H={GNSS_HEADING:.1f};"
            f"V={GNSS_SPEED:.2f};"
            f"C={c_str};"
        )

Bridge.provide("get_gnss_status", get_gnss_status)

# Start Application
if __name__ == "__main__":
    App.run()
