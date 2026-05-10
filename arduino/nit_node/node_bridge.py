#!/usr/bin/env python3
"""
NIT-IN Node Bridge — Linux-side serial relay  (Phase 33 / Phase 32b guard)
============================================================================
Runs on the Linux co-processor (Yún / Portenta / Raspberry Pi) that is
physically connected to the Arduino Uno via USB-Serial.

Responsibilities
----------------
1. Read newline-delimited JSON from the Arduino serial port.
2. On NIT_GENESIS (first boot message):
     a) Check /opt/nit-in/IDENTITY_LOCKED
        • If LOCKED   → use stored instance_id, skip provision relay.
        • If UNLOCKED → store instance_id in the lock file (Phase 32b guard).
3. Forward CAPABILITY_PULSE as fleet heartbeat to NIT-IN.
4. Forward SENSOR_EVENT as fleet heartbeat with sensor extra data.

Identity persistence strategy
------------------------------
The Arduino EEPROM already guarantees the same NIT-XXXX id on every reboot
(magic-byte gate in nit_node.ino).  The lock file is a *second* guard on the
Linux side so that a Linux-only reboot (Arduino powered separately) cannot
accidentally trigger a fresh provisioning handshake.

IDENTITY_LOCKED file format  (/opt/nit-in/IDENTITY_LOCKED)
-----------------------------------------------------------
{
  "instance_id": "NIT-0042",
  "hardware_sig": "hw-A3B2C1D4",
  "locked_at": "2026-05-10T09:00:00Z"
}

Usage
-----
  python3 node_bridge.py --port /dev/ttyACM0 --hub https://nit-in.conversationmine.ai

Environment variables (fallback to .env.local in same directory)
-----------------------------------------------------------------
  NIT_IN_HUB_SECRET   — Bearer token for NIT-IN hub API
  NIT_IN_BASE_URL     — Override hub URL (default: https://nit-in.conversationmine.ai)
  BRIDGE_SERIAL_PORT  — Serial device override
  BRIDGE_BAUD         — Baud rate (default: 9600)
  BRIDGE_LOCK_FILE    — Lock file path (default: /opt/nit-in/IDENTITY_LOCKED)
"""

from __future__ import annotations

import argparse
import json
import logging
import os
import pathlib
import platform
import signal
import subprocess
import sys
import time
import urllib.request
import urllib.error
from datetime import datetime, timezone

# ── Optional: load .env.local from same directory ─────────────────────────────
_ENV_LOCAL = pathlib.Path(__file__).parent / ".env.local"
if _ENV_LOCAL.exists():
    with _ENV_LOCAL.open() as _f:
        for _line in _f:
            _line = _line.strip()
            if _line and not _line.startswith("#") and "=" in _line:
                _k, _, _v = _line.partition("=")
                os.environ.setdefault(_k.strip(), _v.strip())

# ── Optional: pyserial ─────────────────────────────────────────────────────────
try:
    import serial  # type: ignore
    _SERIAL_AVAILABLE = True
except ImportError:
    _SERIAL_AVAILABLE = False

# ── Logging ───────────────────────────────────────────────────────────────────
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s  [%(levelname)s]  %(message)s",
    datefmt="%Y-%m-%dT%H:%M:%S",
)
log = logging.getLogger("node_bridge")

# ── Constants / defaults ───────────────────────────────────────────────────────
_DEFAULT_HUB          = "https://nit-in.conversationmine.ai"
_DEFAULT_PORT         = "/dev/ttyACM0"
_DEFAULT_BAUD         = 9600
_DEFAULT_LOCK_FILE    = "/opt/nit-in/IDENTITY_LOCKED"
_USER_AGENT           = "TWIN-Mesh/1.0"
_DEFAULT_NTP_TIMEOUT  = 120   # seconds to wait for NTP sync
_NTP_POLL_INTERVAL    = 5    # seconds between timedatectl checks

_HEARTBEAT_ENDPOINT = "/api/fleet/heartbeat"

# ── Config ────────────────────────────────────────────────────────────────────
def _cfg(key: str, default: str = "") -> str:
    return os.environ.get(key, default).strip()


# ═══════════════════════════════════════════════════════════════════════════════
# NTP temporal gate
# ═══════════════════════════════════════════════════════════════════════════════

class NtpGate:
    """
    Phase 32b — Temporal Gate.

    The Arduino Uno Q has no battery-backed RTC.  On power-on the Linux core
    clock often starts at 1970-01-01 until NTP sync completes.  If the first
    heartbeat is sent with an unsynchronised system clock, TWIN's Phase 40.0
    zone timer may receive a corrupted epoch, producing a massive negative
    zone_duration_s and crashing the MTTS Slope Analyzer.

    Strategy
    --------
    1. Call `timedatectl show --property=NTPSynchronized` (systemd) or
       fall back to parsing `timedatectl status` for systems that do not
       support the `show` sub-command.
    2. If the system is not systemd-based (macOS / BSD), check whether the
       current year >= 2024 as a lightweight proxy.
    3. Retry every _NTP_POLL_INTERVAL seconds until timeout.
    4. After timeout, emit a WARNING and allow the heartbeat through so a
       single flaky NTP server does not block the whole fleet.
    """

    def __init__(self, timeout_s: int = _DEFAULT_NTP_TIMEOUT, skip: bool = False):
        self._timeout = timeout_s
        self._skip    = skip

    def wait(self) -> bool:
        """
        Block until NTP is synchronised (or timeout).
        Returns True if sync confirmed, False if timed out.
        """
        if self._skip:
            log.info("[NTP] Gate disabled (--skip-ntp-gate) — proceeding immediately")
            return True

        log.info("[NTP] Temporal gate armed — waiting for clock sync (timeout=%ds)", self._timeout)
        deadline = time.monotonic() + self._timeout

        while time.monotonic() < deadline:
            synced = self._is_synced()
            if synced:
                log.info("[NTP] System clock synchronised ✓  — temporal gate cleared")
                return True
            remaining = int(deadline - time.monotonic())
            log.info("[NTP] Clock not yet synced — retrying in %ds  (%ds remaining)",
                     _NTP_POLL_INTERVAL, remaining)
            time.sleep(_NTP_POLL_INTERVAL)

        log.warning(
            "[NTP] Timed out after %ds — system clock may still be unsynchronised. "
            "Proceeding with heartbeat anyway (MTTS epoch integrity not guaranteed).",
            self._timeout,
        )
        return False

    @staticmethod
    def _is_synced() -> bool:
        """Return True when the OS reports the clock is NTP-synced."""
        # ── Strategy 1: systemd timedatectl show (most Linux distros) ──────
        try:
            result = subprocess.run(
                ["timedatectl", "show", "--property=NTPSynchronized"],
                capture_output=True, text=True, timeout=5,
            )
            # Output: "NTPSynchronized=yes\n"
            if "NTPSynchronized=yes" in result.stdout:
                return True
            if "NTPSynchronized=no" in result.stdout:
                return False
        except (FileNotFoundError, subprocess.TimeoutExpired):
            pass

        # ── Strategy 2: timedatectl status (older systemd) ─────────────────
        try:
            result = subprocess.run(
                ["timedatectl", "status"],
                capture_output=True, text=True, timeout=5,
            )
            if "System clock synchronized: yes" in result.stdout:
                return True
            if "System clock synchronized: no" in result.stdout:
                return False
        except (FileNotFoundError, subprocess.TimeoutExpired):
            pass

        # ── Strategy 3: macOS / BSD — check sntp / system year ────────────
        try:
            # On macOS, timedatectl is absent.  Use current year as proxy:
            # if the year >= 2024 the clock was set (either RTC or NTP).
            current_year = datetime.now(timezone.utc).year
            if current_year >= 2024:
                log.debug("[NTP] Non-systemd host, year=%d — treating as synced", current_year)
                return True
        except Exception:  # noqa: BLE001
            pass

        return False


# ═══════════════════════════════════════════════════════════════════════════════
# Identity lock
# ═══════════════════════════════════════════════════════════════════════════════

class IdentityLock:
    """
    Phase 32b persistence guard.

    Reads/writes the IDENTITY_LOCKED sentinel file on the Linux filesystem.
    Prevents double-registration if the Linux side reboots independently of
    the Arduino.
    """

    def __init__(self, path: str):
        self._path = pathlib.Path(path)

    # ── public ────────────────────────────────────────────────────────────────

    @property
    def is_locked(self) -> bool:
        return self._path.exists()

    def read(self) -> dict:
        """Return the locked identity record.  Raises if not locked."""
        if not self.is_locked:
            raise RuntimeError("IDENTITY_LOCKED file does not exist")
        with self._path.open() as f:
            return json.load(f)

    def write(self, instance_id: str, hardware_sig: str) -> None:
        """
        Atomically write the lock file.
        Creates parent directories as needed.
        Raises RuntimeError if the file already exists with a *different*
        instance_id (signals an EEPROM anomaly — operator intervention required).
        """
        if self.is_locked:
            existing = self.read()
            if existing.get("instance_id") != instance_id:
                raise RuntimeError(
                    f"IDENTITY_LOCKED mismatch: stored={existing['instance_id']!r} "
                    f"but Arduino sent={instance_id!r}.  Operator intervention required."
                )
            # Same id — already locked, nothing to do
            return

        self._path.parent.mkdir(parents=True, exist_ok=True)
        record = {
            "instance_id":  instance_id,
            "hardware_sig": hardware_sig,
            "locked_at":    datetime.now(timezone.utc).isoformat(),
            "host":         platform.node(),
        }
        # Write to a temp file then rename → atomic on Linux
        tmp = self._path.with_suffix(".tmp")
        tmp.write_text(json.dumps(record, indent=2))
        tmp.rename(self._path)
        log.info("[LOCK] IDENTITY_LOCKED written → %s  instance_id=%s", self._path, instance_id)


# ═══════════════════════════════════════════════════════════════════════════════
# NIT-IN API client
# ═══════════════════════════════════════════════════════════════════════════════

class NitInClient:
    """Minimal urllib-based client for NIT-IN fleet API."""

    def __init__(self, base_url: str, hub_secret: str):
        self._base    = base_url.rstrip("/")
        self._secret  = hub_secret

    def _headers(self) -> dict:
        return {
            "Content-Type":  "application/json",
            "Authorization": f"Bearer {self._secret}",
            "User-Agent":    _USER_AGENT,
        }

    def heartbeat(self, payload: dict) -> dict:
        """POST /api/fleet/heartbeat — idempotent, update-only."""
        url  = self._base + _HEARTBEAT_ENDPOINT
        body = json.dumps(payload).encode()
        req  = urllib.request.Request(url, data=body, headers=self._headers(), method="POST")
        try:
            with urllib.request.urlopen(req, timeout=10) as resp:
                return json.loads(resp.read())
        except urllib.error.HTTPError as e:
            body_text = e.read().decode(errors="replace")[:200]
            log.error("[HB] HTTP %s from NIT-IN: %s", e.code, body_text)
            return {"ok": False, "error": body_text}
        except urllib.error.URLError as e:
            log.error("[HB] Network error: %s", e.reason)
            return {"ok": False, "error": str(e.reason)}


# ═══════════════════════════════════════════════════════════════════════════════
# Serial reader
# ═══════════════════════════════════════════════════════════════════════════════

class SerialReader:
    """
    Wraps pyserial with a stdin fallback for testing.
    `python node_bridge.py --port STDIN` reads JSON lines from stdin.
    """

    def __init__(self, port: str, baud: int):
        self._port = port
        self._baud = baud
        self._ser  = None  # type: ignore

    def open(self) -> None:
        if self._port.upper() == "STDIN":
            log.info("[SERIAL] Reading from stdin (test mode)")
            return
        if not _SERIAL_AVAILABLE:
            raise RuntimeError(
                "pyserial not installed.  Run: pip install pyserial\n"
                "Or use --port STDIN for testing."
            )
        self._ser = serial.Serial(self._port, self._baud, timeout=2.0)
        log.info("[SERIAL] Opened %s @ %d baud", self._port, self._baud)

    def readline(self) -> str | None:
        """Return the next non-empty line, or None on timeout."""
        if self._ser is None:
            # stdin mode
            line = sys.stdin.readline()
            return line.strip() if line else None
        try:
            raw = self._ser.readline()
            return raw.decode(errors="replace").strip() if raw else None
        except Exception as exc:  # noqa: BLE001
            log.warning("[SERIAL] Read error: %s", exc)
            return None

    def close(self) -> None:
        if self._ser is not None:
            self._ser.close()


# ═══════════════════════════════════════════════════════════════════════════════
# Message dispatcher
# ═══════════════════════════════════════════════════════════════════════════════

class NodeBridge:
    """
    Ties together serial, lock, and NIT-IN client.
    Dispatches Arduino JSON messages to appropriate actions.
    """

    def __init__(
        self,
        serial_reader: SerialReader,
        lock: IdentityLock,
        client: NitInClient,
        ntp_gate: NtpGate,
    ):
        self._serial   = serial_reader
        self._lock     = lock
        self._client   = client
        self._ntp_gate = ntp_gate
        self._iid: str | None = None  # resolved instance_id
        self._ntp_cleared: bool = False  # set True once gate passes
        self._running  = True

    # ── bootstrap ─────────────────────────────────────────────────────────────

    def _resolve_identity(self, msg: dict) -> str:
        """
        Phase 32b: resolve instance_id from NIT_GENESIS.

        If IDENTITY_LOCKED exists:
          • Use stored instance_id (Linux reboot path).
        Else:
          • Use the id from the Arduino NIT_GENESIS message.
          • Write the lock file.

        Returns the canonical instance_id.
        """
        arduino_id  = msg.get("node_id", "")
        arduino_sig = msg.get("hardware_sig", "")

        if self._lock.is_locked:
            stored = self._lock.read()
            stored_id = stored["instance_id"]
            if stored_id != arduino_id:
                log.warning(
                    "[LOCK] IDENTITY_LOCKED has %r but Arduino sent %r — "
                    "using locked id (Arduino EEPROM anomaly — verify hardware)",
                    stored_id, arduino_id,
                )
                # Trust the lock file, not the fresh Arduino boot — operator
                # should inspect both before overriding.
            else:
                log.info("[LOCK] Identity confirmed from lock file: %s", stored_id)
            return stored_id
        else:
            if not arduino_id:
                raise ValueError("NIT_GENESIS missing node_id — cannot lock identity")
            self._lock.write(arduino_id, arduino_sig)
            log.info("[LOCK] First boot — identity locked: %s", arduino_id)
            return arduino_id

    # ── message handlers ──────────────────────────────────────────────────────

    def _handle_genesis(self, msg: dict) -> None:
        iid = self._resolve_identity(msg)
        self._iid = iid

        # ── NTP Temporal Gate ──────────────────────────────────────────────
        # Must clear before the very first heartbeat POST.  This prevents a
        # 1970-epoch timestamp from corrupting TWIN's Phase 40.0 zone timer
        # and crashing the MTTS Slope Analyzer.
        if not self._ntp_cleared:
            self._ntp_cleared = self._ntp_gate.wait()

        # Emit first heartbeat so the fleet banner appears immediately
        caps = msg.get("capabilities", {})
        result = self._client.heartbeat({
            "instance_id":      iid,
            "label":            iid,
            "cpu_pct":          0,
            "temp_c":           None,
            "mem_pct":          0,
            "dms_status":       "ACTIVE",
            "uptime_s":         0,
            "firmware_version": "nit_node-v1",
            "self_test_passed": True,
            "extra": {
                "genesis":      True,
                "hardware_sig": msg.get("hardware_sig"),
                "sram_bytes":   caps.get("sram_bytes"),
                "sensors":      caps.get("sensors", []),
                "birth_rights": msg.get("birth_rights"),
            },
        })
        if result.get("ok"):
            log.info("[HB] GENESIS heartbeat accepted → instance_id=%s", iid)
        else:
            log.warning("[HB] GENESIS heartbeat rejected: %s", result)

    def _handle_pulse(self, msg: dict) -> None:
        if not self._iid:
            log.warning("[PULSE] instance_id not resolved yet — dropping pulse")
            return

        result = self._client.heartbeat({
            "instance_id":      self._iid,
            "label":            self._iid,
            "cpu_pct":          0,
            "temp_c":           None,
            "mem_pct":          round(
                                    100 * (1 - msg.get("free_mem", 2048) / 2048), 1
                                ),
            "dms_status":       "ACTIVE",
            "uptime_s":         msg.get("uptime", 0),
            "firmware_version": "nit_node-v1",
            "self_test_passed": True,
            "extra":            {"free_mem": msg.get("free_mem")},
        })
        ok = result.get("ok", False)
        log.info(
            "[HB] PULSE %s | uptime=%ss | ok=%s",
            self._iid, msg.get("uptime", "?"), ok,
        )

    def _handle_sensor(self, msg: dict) -> None:
        if not self._iid:
            log.warning("[SENSOR] instance_id not resolved — dropping event")
            return

        result = self._client.heartbeat({
            "instance_id":      self._iid,
            "label":            self._iid,
            "cpu_pct":          0,
            "temp_c":           msg.get("value") if msg.get("sensor") == "temperature" else None,
            "mem_pct":          0,
            "dms_status":       "ACTIVE",
            "uptime_s":         0,
            "firmware_version": "nit_node-v1",
            "self_test_passed": True,
            "extra": {
                "sensor":     msg.get("sensor"),
                "value":      msg.get("value"),
                "confidence": msg.get("confidence"),
            },
        })
        ok = result.get("ok", False)
        log.debug(
            "[SENSOR] %s sensor=%s value=%.2f ok=%s",
            self._iid, msg.get("sensor"), msg.get("value", 0), ok,
        )

    # ── main loop ─────────────────────────────────────────────────────────────

    def run(self) -> None:
        self._serial.open()
        log.info("[BRIDGE] Node bridge running.  Ctrl-C to stop.")

        while self._running:
            line = self._serial.readline()
            if not line:
                continue
            try:
                msg = json.loads(line)
            except json.JSONDecodeError:
                log.debug("[SERIAL] Non-JSON line: %r", line[:80])
                continue

            msg_type = msg.get("type", "")

            if msg_type == "NIT_GENESIS":
                self._handle_genesis(msg)
            elif msg_type == "CAPABILITY_PULSE":
                self._handle_pulse(msg)
            elif msg_type == "SENSOR_EVENT":
                self._handle_sensor(msg)
            else:
                log.debug("[MSG] Unknown type %r — ignored", msg_type)

        self._serial.close()
        log.info("[BRIDGE] Stopped.")

    def stop(self) -> None:
        self._running = False


# ═══════════════════════════════════════════════════════════════════════════════
# Entry point
# ═══════════════════════════════════════════════════════════════════════════════

def _parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(
        description="NIT-IN node bridge — serial relay with Phase 32b identity lock"
    )
    p.add_argument(
        "--port",
        default=_cfg("BRIDGE_SERIAL_PORT", _DEFAULT_PORT),
        help="Serial port (default: /dev/ttyACM0) or STDIN for testing",
    )
    p.add_argument(
        "--baud",
        type=int,
        default=int(_cfg("BRIDGE_BAUD", str(_DEFAULT_BAUD))),
        help="Baud rate (default: 9600)",
    )
    p.add_argument(
        "--hub",
        default=_cfg("NIT_IN_BASE_URL", _DEFAULT_HUB),
        help="NIT-IN hub base URL",
    )
    p.add_argument(
        "--secret",
        default=_cfg("NIT_IN_HUB_SECRET"),
        help="NIT-IN HUB_SECRET (Bearer token)",
    )
    p.add_argument(
        "--lock-file",
        default=_cfg("BRIDGE_LOCK_FILE", _DEFAULT_LOCK_FILE),
        help="IDENTITY_LOCKED file path (default: /opt/nit-in/IDENTITY_LOCKED)",
    )
    p.add_argument(
        "--ntp-timeout",
        type=int,
        default=int(_cfg("BRIDGE_NTP_TIMEOUT", str(_DEFAULT_NTP_TIMEOUT))),
        help="Seconds to wait for NTP sync before first heartbeat (default: 120)",
    )
    p.add_argument(
        "--skip-ntp-gate",
        action="store_true",
        default=(_cfg("BRIDGE_SKIP_NTP", "false").lower() == "true"),
        help="Bypass NTP temporal gate (use for testing or macOS dev)",
    )
    return p.parse_args()


def main() -> None:
    args = _parse_args()

    if not args.secret:
        log.error(
            "NIT_IN_HUB_SECRET not set.  Pass --secret or set env var."
        )
        sys.exit(1)

    lock     = IdentityLock(args.lock_file)
    client   = NitInClient(args.hub, args.secret)
    reader   = SerialReader(args.port, args.baud)
    ntp_gate = NtpGate(timeout_s=args.ntp_timeout, skip=args.skip_ntp_gate)
    bridge   = NodeBridge(reader, lock, client, ntp_gate)

    # Graceful shutdown on SIGTERM / SIGINT
    def _shutdown(sig, _frame):  # noqa: ANN001
        log.info("[BRIDGE] Signal %s received — shutting down …", sig)
        bridge.stop()

    signal.signal(signal.SIGTERM, _shutdown)
    signal.signal(signal.SIGINT,  _shutdown)

    if lock.is_locked:
        stored = lock.read()
        log.info(
            "[BRIDGE] IDENTITY_LOCKED present → %s (locked at %s)",
            stored["instance_id"], stored.get("locked_at", "?"),
        )
    else:
        log.info("[BRIDGE] No IDENTITY_LOCKED found — will lock on first NIT_GENESIS")

    bridge.run()


if __name__ == "__main__":
    main()
