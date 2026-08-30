#!/usr/bin/env python3
"""
Hand Gesture Control — local key-press server.

Listens on a local WebSocket, receives small JSON messages from the browser
extension (extension/detector.js) describing a key action, and simulates the
matching keyboard event on the system.

Message format sent by the extension:
    {"action": "keydown" | "keyup", "key": "<key id>", "ts": 173...}

`key id` values match extension/config.js KEY_OPTIONS — keep the KEY_MAP
tables below in sync with that file if you add new keys there.

--- Why there are two backends -----------------------------------------
There is no single API that injects keystrokes on every OS/display server:

  - Windows / macOS / Linux+X11: `pynput` works well (SendInput / CGEvent /
    the X11 XTest extension).
  - Linux + Wayland: XTest events generally do NOT reach native Wayland
    windows (this is a compositor security boundary, not a bug), so
    `pynput` silently does nothing there. The fix is `ydotool`, which
    injects events at the kernel `uinput` level instead of through the
    display server, so it works under any compositor.

This script detects which situation it's in (OS + $XDG_SESSION_TYPE) and
picks the matching backend automatically; you can also force one with
--backend.

Run:
    pip install -r requirements.txt
    python server.py                     # auto-detect backend, port 8765
    python server.py --port 9000         # custom port
    python server.py --backend ydotool   # force a backend
    python server.py --test-keys         # type "abc" after a 3s countdown,
                                          # to sanity-check the backend on
                                          # its own, with no browser involved

Linux + Wayland one-time setup (skip this on Windows/macOS/X11):
    sudo apt install ydotool             # or your distro's equivalent
    sudo ydotoold &                      # start the daemon (needs uinput
                                          # access — run as root, or set up
                                          # a udev rule granting your user
                                          # access to /dev/uinput)
    python server.py                     # will auto-detect and use it
"""

import argparse
import asyncio
import json
import logging
import os
import platform
import shutil
import subprocess
import sys
import time

try:
    import websockets
except ImportError:
    print("Missing dependency. Run: pip install -r requirements.txt", file=sys.stderr)
    raise

logging.basicConfig(level=logging.INFO, format="%(asctime)s  %(message)s", datefmt="%H:%M:%S")
log = logging.getLogger("gesture-server")


# =========================================================================
# Backends
# =========================================================================

class KeyBackend:
    """Common interface both backends implement.

    press()/release() may return False to signal that the event was NOT
    delivered; None/True is treated as success."""
    name = "base"

    def press(self, key_id):
        raise NotImplementedError

    def release(self, key_id):
        raise NotImplementedError

    def is_known(self, key_id):
        raise NotImplementedError


class PynputBackend(KeyBackend):
    """Windows, macOS, and Linux+X11. Uses SendInput / CGEvent / XTest."""
    name = "pynput"

    def __init__(self):
        from pynput.keyboard import Controller, Key
        self._controller = Controller()
        self._Key = Key
        self._map = {
            "enter": Key.enter, "space": Key.space, "escape": Key.esc,
            "tab": Key.tab, "backspace": Key.backspace,
            "arrowup": Key.up, "arrowdown": Key.down,
            "arrowleft": Key.left, "arrowright": Key.right,
            "pageup": Key.page_up, "pagedown": Key.page_down,
        }
        for ch in "abcdefghijklmnopqrstuvwxyz0123456789":
            self._map[ch] = ch

    def is_known(self, key_id):
        return key_id in self._map

    def press(self, key_id):
        self._controller.press(self._map[key_id])

    def release(self, key_id):
        self._controller.release(self._map[key_id])


class YdotoolBackend(KeyBackend):
    """Linux+Wayland (also works under X11). Injects via /dev/uinput through
    the `ydotool` CLI + `ydotoold` daemon, bypassing the display server
    entirely, so compositor-level restrictions on synthetic input don't
    apply."""
    name = "ydotool"

    # evdev keycodes, from linux/input-event-codes.h — only the ones this
    # project's KEY_OPTIONS can produce. Extend this if you add more keys
    # to extension/config.js.
    _CODES = {
        "escape": 1, "1": 2, "2": 3, "3": 4, "4": 5, "5": 6, "6": 7, "7": 8,
        "8": 9, "9": 10, "0": 11, "backspace": 14, "tab": 15,
        "q": 16, "w": 17, "e": 18, "r": 19, "t": 20, "y": 21, "u": 22,
        "i": 23, "o": 24, "p": 25, "enter": 28,
        "a": 30, "s": 31, "d": 32, "f": 33, "g": 34, "h": 35, "j": 36,
        "k": 37, "l": 38,
        "z": 44, "x": 45, "c": 46, "v": 47, "b": 48, "n": 49, "m": 50,
        "space": 57,
        "pageup": 104, "arrowleft": 105, "arrowright": 106,
        "arrowup": 103, "arrowdown": 108, "pagedown": 109,
    }

    # Places ydotoold's socket is commonly found, in probe order.
    _SOCKET_CANDIDATES = (
        "/tmp/.ydotool_socket",           # ydotool < 1.0.5 default
        "/run/ydotoold/socket",           # systemd unit default
        "/run/ydotoold.socket",
    )

    def __init__(self):
        if shutil.which("ydotool") is None:
            raise RuntimeError(
                "ydotool is not installed. On Debian/Kali/Ubuntu: sudo apt install ydotool"
            )
        self._socket = self._find_socket()
        if self._socket:
            log.info("ydotoold socket found: %s", self._socket)
        else:
            log.warning(
                "ydotoold socket not found — key presses will fail until it is. "
                "Start the daemon with: sudo ydotoold &"
            )
        self._last_warn = 0.0

    @staticmethod
    def _find_socket():
        """Locate a running ydotoold socket. ydotoold may be started with a
        custom --socket-path while the ydotool CLI looks in a different
        default place; this probe bridges that mismatch."""
        candidates = []
        env_socket = os.environ.get("YDOTOOL_SOCKET")
        if env_socket:
            candidates.append(env_socket)
        runtime_dir = os.environ.get("XDG_RUNTIME_DIR")
        if runtime_dir:
            candidates.append(os.path.join(runtime_dir, ".ydotool_socket"))
        candidates.extend(YdotoolBackend._SOCKET_CANDIDATES)
        for path in candidates:
            if os.path.exists(path):
                return path
        return None

    def is_known(self, key_id):
        return key_id in self._CODES

    def _warn_throttled(self, msg, *args):
        """Log a warning at most once every 30s, so a dead daemon floods
        neither the console nor the log file."""
        now = time.monotonic()
        if now - self._last_warn >= 30:
            self._last_warn = now
            log.warning(msg, *args)

    def _run(self, arg):
        """Returns True if ydotool accepted the event, False otherwise."""
        env = os.environ.copy()
        if self._socket:
            env["YDOTOOL_SOCKET"] = self._socket
        try:
            result = subprocess.run(
                ["ydotool", "key", arg],
                capture_output=True, text=True, timeout=2, env=env,
            )
            if result.returncode != 0:
                self._warn_throttled(
                    "ydotool call failed (rc=%s): %s\n"
                    "  Is ydotoold running? Try: sudo ydotoold &\n"
                    "  Permission denied on the socket/uinput? Try running "
                    "this server with sudo, or set up a udev rule for "
                    "/dev/uinput for your user.",
                    result.returncode, result.stderr.strip(),
                )
                return False
            return True
        except FileNotFoundError:
            self._warn_throttled("ydotool disappeared from PATH mid-run.")
        except subprocess.TimeoutExpired:
            self._warn_throttled("ydotool call timed out — is ydotoold running?")
        return False

    def press(self, key_id):
        return self._run(f"{self._CODES[key_id]}:1")

    def release(self, key_id):
        return self._run(f"{self._CODES[key_id]}:0")


def detect_backend_name():
    if platform.system() == "Linux" and os.environ.get("XDG_SESSION_TYPE", "").lower() == "wayland":
        return "ydotool"
    return "pynput"


class SystemControl:
    """OS-level volume/brightness percentage control for 'adjust' messages.

    Each platform resolves its own commands at startup; missing tooling
    degrades to a one-time warning instead of an error:
      - Linux:      pactl/amixer/wpctl for volume, brightnessctl/ddcutil
                    for brightness (brightnessctl uses logind, so a normal
                    user in the `video` group works without root)
      - Windows:    pycaw (Core Audio) for volume, WMI for brightness
      - macOS:      osascript for volume, the `brightness` CLI if installed
    """
    name = "system-control"

    def __init__(self):
        self._last = {}          # control -> last value sent (dedupe)
        self._warned = set()     # controls already warned about
        self._last_warn = 0.0    # throttling for command failures
        system = platform.system()

        self._volume = None
        self._brightness = None
        if system == "Linux":
            if shutil.which("pactl"):
                self._volume = lambda v: self._run(
                    ["pactl", "set-sink-volume", "@DEFAULT_SINK@", f"{v}%"])
            elif shutil.which("amixer"):
                self._volume = lambda v: self._run(
                    ["amixer", "-D", "pulse", "sset", "Master", f"{v}%"])
            elif shutil.which("wpctl"):
                self._volume = lambda v: self._run(
                    ["wpctl", "set-volume", "@DEFAULT_AUDIO_SINK@", f"{v / 100:.2f}"])
            if shutil.which("brightnessctl"):
                self._brightness = lambda v: self._run(["brightnessctl", "set", f"{v}%"])
            elif shutil.which("ddcutil"):
                # External monitors over DDC/CI — slow (~1s per call).
                self._brightness = lambda v: self._run(["ddcutil", "setvcp", "10", str(v)])
        elif system == "Darwin":
            self._volume = lambda v: self._run(
                ["osascript", "-e", f"set volume output volume {v}"])
            if shutil.which("brightness"):
                self._brightness = lambda v: self._run(["brightness", f"{v / 100:.2f}"])
        elif system == "Windows":
            self._volume = self._windows_volume_setter()
            self._brightness = lambda v: self._run([
                "powershell", "-NoProfile", "-Command",
                f"(Get-WmiObject -Namespace root/WMI -Class "
                f"WmiMonitorBrightnessMethods).WmiSetBrightness(1,{v})",
            ])

        for channel, fn in (("volume", self._volume), ("brightness", self._brightness)):
            if fn is None:
                log.warning(
                    "'%s' pinch control unavailable on this system (%s) — "
                    "gestures mapped to it will be ignored.", channel, system)

    @staticmethod
    def _windows_volume_setter():
        try:
            from comtypes import CLSCTX_ALL
            from pycaw.pycaw import AudioUtilities, IAudioEndpointVolume
            device = AudioUtilities.GetSpeakers()
            interface = device.Activate(IAudioEndpointVolume._iid_, CLSCTX_ALL, None)
            endpoint = interface.QueryInterface(IAudioEndpointVolume)
            return lambda v: endpoint.SetMasterVolumeLevelScalar(v / 100.0, None)
        except Exception:
            return None

    def _run(self, cmd):
        """Run one control command; returns True only if it exited 0."""
        try:
            result = subprocess.run(cmd, capture_output=True, text=True, timeout=3)
        except Exception as e:
            self._warn_once(f"adjust command {' '.join(cmd[:2])} crashed: {e}")
            return False
        if result.returncode != 0:
            self._warn_once(
                "adjust command failed (rc=%s): %s\n  %s\n"
                "  Hint: don't run this server with sudo — audio/brightness "
                "tools must run inside your desktop session to reach your "
                "user's devices.",
                result.returncode, " ".join(cmd), result.stderr.strip(),
            )
            return False
        return True

    def _warn_once(self, msg, *args):
        """Same message throttled to once every 30s so slider updates don't
        flood the console."""
        now = time.monotonic()
        if now - self._last_warn >= 30:
            self._last_warn = now
            log.warning(msg, *args)

    def adjust(self, control, value):
        """Set 'volume' or 'brightness' to value (0-100). Returns True on success."""
        if control not in ("volume", "brightness"):
            return False
        fn = self._volume if control == "volume" else self._brightness
        if fn is None:
            if control not in self._warned:
                self._warned.add(control)
                log.warning("No %s control available — ignored.", control)
            return False
        value = max(0, min(100, round(value)))
        if self._last.get(control) == value:
            return True  # dedupe: nothing changed
        self._last[control] = value
        ok = fn(value)
        if ok:
            log.info("%-12s %s%%", control, value)
        return ok


def build_backend(requested):
    name = requested if requested != "auto" else detect_backend_name()
    try:
        if name == "ydotool":
            backend = YdotoolBackend()
        else:
            backend = PynputBackend()
        log.info("Using input backend: %s", backend.name)
        return backend
    except Exception as e:
        log.error("Could not start '%s' backend: %s", name, e)
        if name == "ydotool":
            log.error(
                "Falling back to pynput — it will very likely NOT deliver "
                "keys under Wayland, but at least the server will start. "
                "Install/start ydotool as described at the top of server.py."
            )
            return PynputBackend()
        raise


# =========================================================================
# Key-state tracking + websocket handling (backend-agnostic from here down)
# =========================================================================

backend: KeyBackend = None        # set in main()
system_control: SystemControl = None  # set in main()

# Tracks which key-ids are currently held down, so we never send a duplicate
# keydown or an orphan keyup (also guards against a malformed/duplicated
# message from the extension leaving a key stuck down).
_held = set()


def press_down(key_id):
    if not backend.is_known(key_id):
        log.warning("Unknown key id: %s", key_id)
        return
    if key_id in _held:
        return
    if backend.press(key_id) is False:
        log.info("keydown  %-12s  (NOT delivered — backend reported failure)", key_id)
        return
    _held.add(key_id)
    log.info("keydown  %-12s", key_id)


def press_up(key_id):
    if not backend.is_known(key_id):
        return
    if key_id not in _held:
        return
    if backend.release(key_id) is False:
        _held.discard(key_id)
        log.info("keyup    %-12s  (NOT delivered — backend reported failure)", key_id)
        return
    _held.discard(key_id)
    log.info("keyup    %-12s", key_id)


def release_all():
    for key_id in list(_held):
        press_up(key_id)


async def handle_client(websocket):
    peer = getattr(websocket, "remote_address", "unknown")
    log.info("Extension connected from %s", peer)
    try:
        async for raw in websocket:
            try:
                msg = json.loads(raw)
            except json.JSONDecodeError:
                log.warning("Ignoring non-JSON message: %r", raw)
                continue

            action = msg.get("action")
            key_id = msg.get("key")

            if action == "keydown":
                press_down(key_id)
            elif action == "keyup":
                press_up(key_id)
            elif action == "adjust":
                control = msg.get("control")
                value = msg.get("value")
                if system_control is None:
                    continue
                if control not in ("volume", "brightness") or not isinstance(value, (int, float)):
                    log.warning("Ignoring bad adjust message: %r", msg)
                    continue
                # Run the OS command off the event loop — some commands
                # (ddcutil especially) can take a second or more.
                loop = asyncio.get_running_loop()
                await loop.run_in_executor(None, system_control.adjust, control, value)
            else:
                log.warning("Unknown action: %r", action)
    except websockets.exceptions.ConnectionClosed:
        pass
    finally:
        log.info("Extension disconnected from %s — releasing any held keys", peer)
        release_all()


def test_keys():
    """Type 'abc' after a countdown, bypassing the extension/websocket
    entirely — the fastest way to confirm the chosen backend actually
    reaches your OS before troubleshooting anything upstream."""
    log.info("Backend: %s — testing in 3 seconds, focus a text editor…", backend.name)
    time.sleep(3)
    failed = 0
    for ch in ["a", "b", "c"]:
        if backend.press(ch) is False or backend.release(ch) is False:
            failed += 1
            log.error("Pressing '%s' FAILED — see warnings above.", ch)
        else:
            log.info("Pressed %s", ch)
        time.sleep(0.2)
    if failed:
        log.info("Test finished with %d/%d failures — the backend is NOT reaching the OS.", failed, 3)
    else:
        log.info("Test complete — check if 'abc' appeared in your editor.")


async def main():
    global backend, system_control

    parser = argparse.ArgumentParser(description="Hand Gesture Control key-press server")
    parser.add_argument("--host", default="localhost", help="bind host (default: localhost)")
    parser.add_argument("--port", type=int, default=8765, help="bind port (default: 8765)")
    parser.add_argument(
        "--backend", choices=["auto", "pynput", "ydotool"], default="auto",
        help="input backend; 'auto' picks ydotool on Linux+Wayland and pynput everywhere else",
    )
    parser.add_argument("--test-keys", action="store_true", help="test key simulation and exit")
    args = parser.parse_args()

    backend = build_backend(args.backend)
    system_control = SystemControl()

    if args.test_keys:
        test_keys()
        return

    async with websockets.serve(handle_client, args.host, args.port):
        log.info("Listening on ws://%s:%s — waiting for the extension to connect…", args.host, args.port)
        log.info("Set this same address as 'Server' in the extension popup.")
        await asyncio.Future()  # run forever


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        release_all()
        print("\nStopped.")