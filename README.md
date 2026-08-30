# Hand Gesture Control

Control your keyboard with hand poses seen through your webcam — play
browser games, drive slide decks, scroll pages, and more.

It has two halves that talk over a local WebSocket:

1. **Browser extension** (`extension/`) — a Chrome/Edge (Manifest V3)
   extension. It opens a small camera window that runs **p5.js** (canvas +
   webcam) and **ml5.js** (`handPose`, on-device hand landmark detection) to
   classify your hand into one of several poses, then sends the mapped key
   over WebSocket. The popup lets you edit the pose → key mapping.
2. **Python server** (`server/server.py`) — a tiny local WebSocket server that
   receives `{"action": "keydown"/"keyup", "key": "..."}` messages and
   simulates the real keypress on your system, so any app in
   focus (a game, a slide viewer, a video call) reacts to it. It picks the
   right input backend for your OS automatically:
   - **Windows / macOS / Linux + X11** → `pynput` (SendInput / CGEvent / XTest)
   - **Linux + Wayland** → `ydotool` (kernel-level uinput injection; see the
     [Linux + Wayland setup](#linux--wayland) below — this is the one case
     that needs a one-time daemon setup)

Detection runs entirely in the browser (no video ever leaves your machine);
only short JSON key-events go to the local server.

## Two modes

The popup has two tabs, and each opens its own separate camera window —
open one, both, or switch between them any time (both talk to the same
Python server):

### General tab — one-hand poses

For everyday use: browsing, presentations, media playback. One hand, one
pose, one key. See the pose table below.

### Gaming tab — two-hand virtual steering wheel

For driving/racing games (or anything you'd rather steer than tap keys for).
Hold both hands up in front of the camera like you're gripping a wheel:

- **Steering** — the line between your two hands is treated like a wheel
  spoke. Its slope (angle from horizontal) decides direction: tilt so your
  right hand drops and left hand rises → steer right; the opposite → steer
  left. Default keys: **A** / **D** (both hands' keys are configurable —
  arrow keys work too).
- **Accelerate** — held automatically as long as both hands are on the
  "wheel" (default key **W**); let go with a hand and it releases, just like
  taking a hand off a real wheel.
- **Brake** — make a fist with both hands to brake (default key **S**);
  this also releases the accelerate key. Toggle this behavior off in the
  popup if you'd rather brake be always-off.
- A **deadzone** (default 8°) ignores small, involuntary tilts so you're not
  fighting jitter to go straight, and a **max wheel angle** (default 45°)
  just clamps how far the drawn wheel visually rotates.

The camera window draws the wheel — a circle at the midpoint of your two
hands, rotated spokes showing the (clamped) tilt, plus the raw line between
your hands and its angle in degrees — so you can see exactly what's being
measured while you calibrate your grip.

## Poses and swipes recognized in General mode

Static poses:

| Pose                      | Default key   |
|---------------------------|---------------|
| 👍 Thumbs up               | Enter         |
| ✌️ Two fingers (peace)     | Arrow Up      |
| ✊ Fist                     | Arrow Down    |
| 🖐️ Open palm                | Space         |
| ☝️ Pointing (index only)   | Arrow Right   |
| 🤟 Rock on (index + pinky) | Arrow Left    |
| Three fingers              | Tab           |
| 👌 OK sign                 | Escape        |

Swipe gestures (fast directed hand motion — great for presentations):

| Swipe        | Default key  | Enabled by default |
|--------------|--------------|--------------------|
| Swipe Right  | Arrow Right  | yes (next slide)   |
| Swipe Left   | Arrow Left   | yes (previous)     |
| Swipe Up     | Page Up      | no                 |
| Swipe Down   | Page Down    | no                 |

A swipe is detected when your hand center travels fast (within ~0.3 s) and
mostly in one direction; one continuous motion fires at most once, and swipes
respect the same anti-double-fire spacing as pose taps. Swipe direction
follows the mirror setting, so "swipe right" always means your hand physically
moving right.

Every mapping, plus which poses/swipes are active, is editable from the
extension popup — nothing is hard-coded past the defaults.

### Pinch controls — brightness and volume

In General mode each hand becomes a continuous slider via its thumb-index
pinch (no key mapping needed — these drive the system directly):

- **Left hand pinch** → screen **brightness**
- **Right hand pinch** → speaker **volume**

How to use: pinch thumb and index together to "grab" the control, then the
distance between the fingertips is the level — fingers together = 0%,
spread apart = 100%. Open the full palm (or move the hand out of frame) to
release; the level stays where you left it. While a pinch is latched, pose
taps and swipes are suppressed, and for half a second after release so the
open palm doesn't fire its own mapped key. The pill shows the live level
(`Volume 43%`). To swap hands, edit `PINCH_CONTROLS` in
`extension/config.js`.

Each slider can be turned on/off independently from the popup's
**General → Pinch controls** section (Brightness / Volume checkboxes) —
disabled channels ignore that hand's pinch completely.

The server executes these with the best tool available per OS — no extra
setup on Windows (pycaw/WMI) and macOS (osascript). On **Linux** install
`brightnessctl` for brightness (uses logind — no root needed for users in
the `video` group); volume works out of the box via `pactl`/`amixer`/`wpctl`.

## 1. Set up the Python server

### Windows

```bash
cd server
pip install -r requirements.txt
python server.py
```

That's it — `pynput` injects keys via the Win32 `SendInput` API and needs no
extra permissions or daemons.

### macOS

```bash
cd server
pip install -r requirements.txt
python server.py
```

One-time permission: the terminal (or IDE) running `server.py` needs
**Accessibility** access — System Settings → Privacy & Security →
Accessibility → add/enable your terminal app. Without it, macOS silently
ignores synthetic keystrokes.

### Linux

`pip install -r requirements.txt` as above, then:

**X11 sessions** — `python server.py` just works via `pynput` (XTest).

**Wayland sessions** (most modern distros' default) — <a id="linux--wayland"></a>
Wayland deliberately blocks apps from injecting input through the display
server, so `pynput` silently does nothing. The server therefore uses
`ydotool`, which injects at the kernel `uinput` level. `uinput` is a
root-only device, so a small daemon (`ydotoold`) must run with permission to
use it:

Optional, for the pinch-brightness control: `sudo apt install brightnessctl`.
Volume works out of the box via PulseAudio/PipeWire tools already installed.

One-time durable setup (recommended — survives reboots, no sudo at runtime):

```bash
sudo apt install ydotool          # Debian/Kali/Ubuntu
sudo usermod -aG input $USER      # allow your user to access /dev/uinput
# log out and back in so the group change applies, then:
mkdir -p ~/.config/systemd/user
cat > ~/.config/systemd/user/ydotoold.service <<'EOF'
[Unit]
Description=ydotool - synthetic input daemon (uinput)

[Service]
ExecStart=/usr/bin/ydotoold
Restart=on-failure
RestartSec=2

[Install]
WantedBy=default.target
EOF
systemctl --user enable --now ydotoold
systemctl --user status ydotoold   # should say: active (running)
```

Quick manual alternative (works immediately, but dies when the session ends
— this is the usual reason keys "suddenly stop working"):

```bash
sudo ydotoold --socket-path=/tmp/.ydotool_socket --socket-own=$UID:$GID &
```

The server auto-discovers the daemon socket (default paths plus
`/tmp/.ydotool_socket`), so no extra configuration is needed either way.
Verify the backend alone, before involving the browser:

```bash
python server.py --test-keys     # types "abc" into the focused window
```

By default it listens on `ws://localhost:8765`. Leave this terminal open —
it prints a line every time a key is pressed/released, which is the easiest
way to confirm gestures are being recognized.

Options:
```bash
python server.py --port 9000        # use a different port
python server.py --host 0.0.0.0     # listen on all interfaces (advanced)
python server.py --backend pynput   # force a backend (auto|pynput|ydotool)
python server.py --test-keys        # test key simulation and exit
```

> `pynput` needs a real desktop session to simulate key presses. It won't do
> anything useful inside a headless container or CI environment.

## 2. Load the extension

1. Open `chrome://extensions` (or `edge://extensions`).
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked** and select the `extension/` folder.
4. Pin the "Hand Gesture Control" icon to your toolbar.

## 3. Configure and run

1. Click the extension icon to open the popup.
2. Confirm **Server** matches what `server.py` printed (default
   `ws://localhost:8765`), then click **Test connection**.
3. Pick a tab:
   - **General** — enable/disable poses and pick the key each one sends,
     then click **Open Hand Camera**.
   - **Gaming** — set your steering/accelerate/brake keys and steering feel,
     then click **Open Gaming Camera**.
4. A small window appears with your webcam feed and a live overlay (pose
   name in General, the wheel + angle in Gaming). Grant camera permission
   when Chrome asks. Keep this window open — off to the side, or on a
   second monitor — while you play/present. You can open both camera
   windows at once if you want, e.g. one to drive with and one to hit Enter
   on a paused menu.
5. In General mode, the pill at the top names the recognized pose; in
   Gaming mode it shows the current wheel angle and which keys are held.
   The terminal running `server.py` logs every keypress either way.

### Behavior settings (General tab)

- **Hold key while gesture is held** — on (default): the key is held down
  for as long as the pose is shown, and released the moment it changes.
  Best for movement in games (hold a fist to walk, etc.).
  Off (tap mode): one deliberate tap per pose — best for Shorts/feeds and
  slides. In tap mode, holding a pose does *not* repeat the key: lower your
  hand and re-show the pose to fire again.
- **Recognition steadiness** — how many recent camera frames must agree
  (majority) before a pose counts as recognized. Higher = fewer accidental
  triggers, a touch more latency.
- **Tap dwell** — (tap mode only) a pose must be held steadily this long
  before its tap fires; transitions between poses never trigger keys.
- **Min gap between taps** — (tap mode only) after any tap, no other tap can
  fire for this long, so one hand motion can't chain into pause+skip or
  skip 2–3 reels.
- **Swipe sensitivity** — how far your hand must travel for a swipe to
  register (as % of the camera view). Lower = more sensitive.
- **Tap cooldown** — (tap mode only) minimum time between two taps of the
  *same* pose.
- **Mirror camera preview** — flips the preview so it feels like a mirror;
  detection itself is unaffected either way.
- **Pinch controls** — enable/disable the brightness (left hand) and volume
  (right hand) pinch sliders independently.

## How the pose classifier works

`extension/detector.js` reads the 21 hand landmarks ml5's `handPose` model
returns per hand and works out, per finger, whether it's extended (tip
farther from the wrist than the middle knuckle) or curled, plus a
thumb-to-index pinch distance for the OK sign. Combinations of those
booleans map to the named poses above. It's a lightweight geometric
classifier (no extra training needed) — good enough for a handful of
clearly-distinct poses, though very unusual hand angles can occasionally
confuse it. If you want to add a new pose, extend the `classify()` function
in `detector.js` and add its id/label to `GESTURES` in `config.js` (keep
`server/server.py`'s `KEY_MAP` in sync if you also add new key ids).

## Project layout

```
hand-gesture-control/
├── extension/
│   ├── manifest.json      # MV3 manifest
│   ├── popup.html/js/css  # settings UI — gesture → key mapping
│   ├── detector.html/js/css  # camera window — p5 + ml5 + websocket client
│   ├── config.js          # shared gesture list, defaults, storage helpers
│   ├── lib/               # local p5.js + ml5.js bundles (no CDN needed)
│   └── icons/
└── server/
    ├── server.py          # websocket → key press/release (pynput or ydotool, auto-picked)
    └── requirements.txt
```

## Troubleshooting

- **"Server: disconnected" in the camera window** — make sure `server.py`
  is running and the popup's Server URL matches its host/port exactly.
- **`keydown <key> (NOT delivered — backend reported failure)` in the server
  console** — the key never reached the OS. On Linux+Wayland this almost
  always means `ydotoold` is not running (or died — e.g. it was started
  manually in a terminal that has since closed). Check with
  `systemctl --user status ydotoold` (or restart the manual `sudo ydotoold…`
  command), then verify with `python server.py --test-keys`.
- **No camera picture** — check Chrome's site permissions for the extension
  and that no other app is holding the webcam.
- **Poses feel jumpy or misfire** — raise "Recognition steadiness" a
  couple of notches, and make sure your hand is well lit and fully in frame.
- **Shorts/feeds skip more than one item per gesture** — use tap mode
  (Hold key off) and raise "Min gap between taps"; also raise "Tap dwell" a
  little so transition flashes between poses can't fire.
- **Keys aren't reaching the game/app** — click into that app/window first
  so it has OS focus; simulated keys go to whatever window is focused, same
  as a real keyboard.
