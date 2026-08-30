const GESTURES = [
  { id: "thumbs_up", label: "Thumbs Up" },
  { id: "fist", label: "Fist" },
  { id: "open_palm", label: "Open Palm" },
  { id: "peace", label: "Two Fingers (Peace)" },
  { id: "pointing", label: "Pointing (Index)" },
  { id: "three_fingers", label: "Three Fingers" },
  { id: "rock_on", label: "Rock On (Index + Pinky)" },
  { id: "ok_sign", label: "OK Sign" },
  { id: "swipe_left", label: "Swipe Left" },
  { id: "swipe_right", label: "Swipe Right" },
  { id: "swipe_up", label: "Swipe Up" },
  { id: "swipe_down", label: "Swipe Down" }
];

const KEY_OPTIONS = [
  { id: "none", label: "— No action —" },
  { id: "enter", label: "Enter" },
  { id: "space", label: "Space" },
  { id: "escape", label: "Escape" },
  { id: "tab", label: "Tab" },
  { id: "backspace", label: "Backspace" },
  { id: "arrowup", label: "Arrow Up" },
  { id: "arrowdown", label: "Arrow Down" },
  { id: "arrowleft", label: "Arrow Left" },
  { id: "arrowright", label: "Arrow Right" },
  { id: "pageup", label: "Page Up" },
  { id: "pagedown", label: "Page Down" },
  { id: "w", label: "W" }, { id: "a", label: "A" },
  { id: "s", label: "S" }, { id: "d", label: "D" },
  { id: "e", label: "E" }, { id: "n", label: "N" },
  { id: "f", label: "F  (fullscreen toggle - YouTube etc.)" },
  { id: "k", label: "K  (play/pause - YouTube etc.)" },
  { id: "1", label: "1" }, { id: "2", label: "2" }, { id: "3", label: "3" }
];

const STEER_KEY_OPTIONS = KEY_OPTIONS.filter((k) => k.id !== "none");

const DEFAULT_MAPPING = {
  thumbs_up: "enter",
  fist: "arrowdown",
  open_palm: "space",
  peace: "arrowup",
  pointing: "arrowright",
  three_fingers: "tab",
  rock_on: "arrowleft",
  ok_sign: "escape",
  swipe_right: "arrowright",
  swipe_left: "arrowleft",
  swipe_up: "pageup",
  swipe_down: "pagedown"
};

const DEFAULT_GAMING = {
  steerLeftKey: "a",
  steerRightKey: "d",
  accelerateKey: "w",
  brakeKey: "s",
  hornKey: "none",
  nitroKey: "none",
  deadzoneDeg: 8,     // wheel tilt past this angle starts steering
  steerReleaseDeg: 5, // steering keeps going until tilt falls back inside this angle (hysteresis — stops left/right flicker at the deadzone edge)
  maxAngleDeg: 45,    // wheel tilt is visually clamped to this for the drawing
  smoothing: 0.25,    // steering angle smoothing, 0..1 (lower = smoother but laggier)
  handLostGraceMs: 400, // keep current keys held this long when hands briefly drop out of the camera view
  brakeStableFrames: 3, // consecutive frames the both-fists state must persist before brake toggles
  autoAccelerate: true,   // hold the accelerate key whenever both hands are on the wheel
  brakeOnBothFists: true  // hold the brake key whenever both hands are making a fist
};

const PINCH_CONTROLS = {
  Left: "brightness",   // left hand pinch distance -> screen brightness
  Right: "volume",      // right hand pinch distance -> speaker volume
};

const DEFAULT_SETTINGS = {
  serverUrl: "ws://localhost:8765",
  mapping: DEFAULT_MAPPING,
  enabled: {
    thumbs_up: true, fist: true, open_palm: true, peace: true,
    pointing: true, three_fingers: false, rock_on: false, ok_sign: false,
    swipe_left: true, swipe_right: true,   // presentation next/previous slide
    swipe_up: false, swipe_down: false     // off by default: vertical swipes conflict with feed scrolling
  },
  holdMode: true,        // send keydown while gesture is held, keyup on release (for game movement)
  holdGraceMs: 250,      // keep a held key down this long when recognition briefly drops (stops key chatter)
  tapHoldMs: 110,        // how long a tap-mode key stays "down" (a realistic key tap)
  tapDwellMs: 150,       // a pose must be held steadily this long before its tap fires — filters hand-motion transitions
  tapRefractoryMs: 600,  // after any tap, NO other tap can fire for this long — stops pause+skip / double-skip chains
  releaseQuietMs: 120,   // the pose must be fully absent this long before another tap can arm
  swipeSensitivity: 25,  // swipe distance that triggers, as % of canvas width (lower = more sensitive)
  cooldownMs: 350,       // min gap between two taps of the *same* gesture in tap mode
  stableFrames: 5,       // consecutive frames required before a gesture is accepted
  mirror: true,
  showSkeleton: true,
  gaming: DEFAULT_GAMING
};

const STORAGE_KEY = "handGestureControlSettings";

function loadSettings() {
  return new Promise((resolve) => {
    chrome.storage.local.get([STORAGE_KEY], (res) => {
      const stored = res[STORAGE_KEY] || {};
      resolve({
        ...DEFAULT_SETTINGS,
        ...stored,
        mapping: { ...DEFAULT_SETTINGS.mapping, ...(stored.mapping || {}) },
        enabled: { ...DEFAULT_SETTINGS.enabled, ...(stored.enabled || {}) },
        gaming: { ...DEFAULT_SETTINGS.gaming, ...(stored.gaming || {}) }
      });
    });
  });
}

function saveSettings(settings) {
  return new Promise((resolve) => {
    chrome.storage.local.set({ [STORAGE_KEY]: settings }, resolve);
  });
}

function onSettingsChanged(callback) {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes[STORAGE_KEY]) {
      callback(changes[STORAGE_KEY].newValue);
    }
  });
}
