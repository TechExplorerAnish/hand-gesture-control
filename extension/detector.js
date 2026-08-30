const MODE = new URLSearchParams(location.search).get("mode") === "gaming" ? "gaming" : "general";
const CANVAS_W = MODE === "gaming" ? 480 : 320;
const CANVAS_H = MODE === "gaming" ? 360 : 240;

let settings = null;
let handPose;
let video;
let hands = [];
let modelReady = false;

let ws = null;
let wsReady = false;
let wsReconnectTimer = null;

// General-mode state
let history = [];          // recent raw classifications, for stability
let activeGesture = null;  // currently "held down" gesture (hold mode)
let lastEnabledAt = 0;     // timestamp a gesture was last confidently seen (hold grace)
let tapLastGesture = null; // gesture the last tap fired for — must be cleanly released before another tap arms
let tapPendingGesture = null; // gesture currently in its dwell window (waiting to be confirmed)
let tapPendingSince = 0;   // when the current dwell started
let lastAnyTapAt = 0;      // global refractory: timestamp of the last tap of ANY gesture
let releaseSince = 0;      // when the pose was last seen continuously absent (release quiet period)
const tapTimers = {};      // gestureId -> pending keyup timer, so a new tap can't be cut short by an old one


const pinchState = {};          // control name -> { latched, lastSent, lastSentAt }
let pinchReleaseGraceUntil = 0; // suppress pose taps briefly after letting go, so the open palm doesn't fire its mapped key

const SWIPE_WINDOW_MS = 280;   // a swipe must complete within this window
const swipeTrail = [];         // recent hand-center positions {x, y, t}
let swipeArmed = true;         // re-armed once the hand settles after a swipe

// Gaming-mode state
let smoothedAngleDeg = 0;
let baselineAngleDeg = 0;            // neutral wheel angle; auto-centers while inside the release band
let hasWheel = false;                // true once a valid two-hand frame has been processed
let handsLostAt = 0;                 // timestamp when tracking dropped below two hands (0 = tracking fine)
let steerState = "straight";         // "straight" | "left" | "right" (hysteresis state machine)
const smoothedCenters = new Map();   // stable per-hand identity -> EMA-smoothed hand center
const gamingHeld = { left: false, right: false, accelerate: false, brake: false, horn: false, nitro: false };

const steady = {
  brake: { held: false, count: 0 },
  horn: { held: false, count: 0 },
  nitro: { held: false, count: 0 },
};

const wsPill = document.getElementById("wsPill");
const modePill = document.getElementById("modePill");
const gesturePill = document.getElementById("gesturePill");
const modelStatus = document.getElementById("modelStatus");

modePill.textContent = MODE === "gaming" ? "Gaming mode" : "General mode";
document.title = MODE === "gaming" ? "Hand Gesture Control — Gaming" : "Hand Gesture Control — General";

// ---------- WebSocket ----------

function connectWs() {
  clearTimeout(wsReconnectTimer);
  try {
    ws = new WebSocket(settings.serverUrl);
  } catch (e) {
    scheduleReconnect();
    return;
  }
  ws.onopen = () => {
    wsReady = true;
    wsPill.textContent = "Server: connected";
    wsPill.className = "pill pill-ok";
  };
  ws.onclose = () => {
    wsReady = false;
    wsPill.textContent = "Server: disconnected";
    wsPill.className = "pill pill-fail";
    scheduleReconnect();
  };
  ws.onerror = () => {
    try { ws.close(); } catch (e) { }
  };
}

function scheduleReconnect() {
  clearTimeout(wsReconnectTimer);
  wsReconnectTimer = setTimeout(connectWs, 1500);
}

function sendAction(action, keyId, value) {
  if (!wsReady) return;
  if (action === "adjust") {
    // System control message: {"action":"adjust","control":"volume|brightness","value":0-100}
    if (value == null) return;
    ws.send(JSON.stringify({ action, control: keyId, value, ts: Date.now() }));
    return;
  }
  if (!keyId || keyId === "none") return;
  ws.send(JSON.stringify({ action, key: keyId, ts: Date.now() }));
}

// ---------- Settings live-reload ----------

onSettingsChanged((newSettings) => {
  const oldUrl = settings ? settings.serverUrl : null;
  settings = newSettings;
  if (oldUrl !== null && oldUrl !== newSettings.serverUrl) {
    try { ws && ws.close(); } catch (e) { }
    connectWs();
  }
});

// ---------- Geometry helpers ----------

function ptDist(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function centroid(points) {
  let sx = 0, sy = 0;
  for (const p of points) { sx += p.x; sy += p.y; }
  return { x: sx / points.length, y: sy / points.length };
}

// Raw camera-space point -> the point's on-screen position, given the
// display is mirrored horizontally for the user's comfort or not.
function toVisual(p) {
  return settings.mirror ? { x: CANVAS_W - p.x, y: p.y } : { x: p.x, y: p.y };
}

// ---------- Pose classifier (used by both modes: general poses, and the
// gaming "both fists = brake" check) ----------

function classify(hand) {
  const kp = hand.keypoints;
  const wrist = kp[0];
  const thumbTip = kp[4], thumbIp = kp[3];
  const indexTip = kp[8], indexPip = kp[6], indexMcp = kp[5];
  const middleTip = kp[12], middlePip = kp[10], middleMcp = kp[9];
  const ringTip = kp[16], ringPip = kp[14];
  const pinkyTip = kp[20], pinkyPip = kp[18];

  const handSize = ptDist(wrist, middleMcp) || 1;

  const extended = (tip, pip) => ptDist(wrist, tip) > ptDist(wrist, pip) * 1.05;
  const index = extended(indexTip, indexPip);
  const middle = extended(middleTip, middlePip);
  const ring = extended(ringTip, ringPip);
  const pinky = extended(pinkyTip, pinkyPip);
  const thumb = ptDist(wrist, thumbTip) > ptDist(wrist, thumbIp) * 1.1;

  const pinchDist = ptDist(thumbTip, indexTip) / handSize;

  if (pinchDist < 0.4 && middle && ring && pinky) return "ok_sign";
  if (thumb && !index && !middle && !ring && !pinky) return "thumbs_up";
  if (!thumb && !index && !middle && !ring && !pinky) return "fist";
  if (thumb && index && middle && ring && pinky) return "open_palm";
  if (!thumb && index && middle && !ring && !pinky) return "peace";
  if (!thumb && index && !middle && !ring && !pinky) return "pointing";
  if (!thumb && index && middle && ring && !pinky) return "three_fingers";
  if (!thumb && index && !middle && !ring && pinky) return "rock_on";
  return null;
}

function gestureLabel(id) {
  const g = GESTURES.find((x) => x.id === id);
  return g ? g.label : "—";
}

// ================= GENERAL MODE =================

function stableGesture(raw) {
  history.push(raw);
  const n = settings.stableFrames || 5;
  if (history.length > n) history.shift();
  if (history.length < 2) return null;
  const counts = {};
  for (const g of history) if (g) counts[g] = (counts[g] || 0) + 1;
  const need = Math.max(2, Math.ceil(history.length * 0.6));
  let best = null, bestCount = 0;
  for (const [g, c] of Object.entries(counts)) {
    if (c > bestCount) { best = g; bestCount = c; }
  }
  return bestCount >= need ? best : null;
}

function handleGesture(stable) {
  const enabled = stable && settings.enabled[stable] ? stable : null;
  const now = Date.now();

  if (settings.holdMode) {
    if (enabled) lastEnabledAt = now;
    if (enabled === activeGesture) return;
    if (activeGesture && !enabled && now - lastEnabledAt < (settings.holdGraceMs ?? 250)) return;
    if (activeGesture) sendAction("keyup", settings.mapping[activeGesture]);
    if (enabled) sendAction("keydown", settings.mapping[enabled]);
    activeGesture = enabled;
  } else {
    handleTap(enabled);
  }

  gesturePill.textContent = enabled ? gestureLabel(enabled) : "—";
  gesturePill.className = "pill " + (enabled ? "pill-active" : "pill-idle");
}

function handleTap(enabled) {
  const now = performance.now();
  const dwellMs = settings.tapDwellMs ?? 150;
  const refractoryMs = settings.tapRefractoryMs ?? 600;
  const quietMs = settings.releaseQuietMs ?? 120;

  if (!enabled) {
    tapPendingGesture = null;
    if (tapLastGesture) {
      if (releaseSince === 0) releaseSince = now;
      if (now - releaseSince >= quietMs) {
        tapLastGesture = null; // clean release: re-arm
        releaseSince = 0;
      }
    }
    return;
  }
  releaseSince = 0;

  if (tapLastGesture) return;                    // waiting for the current pose to be released
  if (now - lastAnyTapAt < refractoryMs) return; // global spacing between taps

  if (enabled !== tapPendingGesture) {           // new pose: start its dwell window
    tapPendingGesture = enabled;
    tapPendingSince = now;
    return;
  }
  if (now - tapPendingSince < dwellMs) return;   // not held steadily long enough yet

  // Confirmed: fire exactly one tap.
  tapLastGesture = enabled;
  tapPendingGesture = null;
  fireTap(enabled);
}

// Send one key tap (keydown + short keyup) for a gesture, gated by the global
// refractory so pose taps and swipes share the same anti-chain protection.
function fireTap(gestureId) {
  const now = performance.now();
  if (!settings.enabled[gestureId]) return false;
  if (now - lastAnyTapAt < (settings.tapRefractoryMs ?? 600)) return false;
  lastAnyTapAt = now;
  sendAction("keydown", settings.mapping[gestureId]);
  clearTimeout(tapTimers[gestureId]);
  tapTimers[gestureId] = setTimeout(
    () => sendAction("keyup", settings.mapping[gestureId]),
    settings.tapHoldMs ?? 110,
  );
  return true;
}

function detectSwipe(center) {
  const now = performance.now();
  swipeTrail.push({ x: center.x, y: center.y, t: now });
  while (swipeTrail.length && now - swipeTrail[0].t > SWIPE_WINDOW_MS) swipeTrail.shift();

  const sensitivity = Math.min(0.6, Math.max(0.08, (settings.swipeSensitivity ?? 25) / 100));
  const minDist = sensitivity * CANVAS_W;

  const dx = center.x - swipeTrail[0].x;
  const dy = center.y - swipeTrail[0].y;
  const moved = Math.hypot(dx, dy);

  if (!swipeArmed) {
    if (moved < minDist * 0.35) swipeArmed = true; // hand settled: ready again
    return null;
  }

  if (moved < minDist) return null;

  let id = null;
  if (Math.abs(dx) >= 2 * Math.abs(dy)) {
    const dir = settings.mirror ? 1 : -1;
    id = dx * dir > 0 ? "swipe_right" : "swipe_left";
  } else if (Math.abs(dy) >= 2 * Math.abs(dx)) {
    id = dy > 0 ? "swipe_down" : "swipe_up";
  }

  if (id) {
    swipeArmed = false; // one swipe per motion
    swipeTrail.length = 0;
  }
  return id;
}

function handleSwipe(id) {
  if (fireTap(id)) {
    gesturePill.textContent = gestureLabel(id);
    gesturePill.className = "pill pill-active";
  }
}


const PINCH_LATCH_DIST = 0.3; // fingertip distance (hand-size normalized) that starts control
const PINCH_MIN = 0.12;       // distance mapped to 0%
const PINCH_MAX = 0.6;       // distance mapped to 100%
const PINCH_SEND_MS = 80;     // min gap between two adjust messages per channel

function pinchDistance(hand) {
  const kp = hand.keypoints;
  const handSize = ptDist(kp[0], kp[9]) || 1; // wrist -> middle knuckle
  return ptDist(kp[4], kp[8]) / handSize;     // thumb tip <-> index tip
}

function pinchChannelEnabled(channel) {
  return !settings.pinch || settings.pinch[channel] !== false;
}

function handlePinchControls() {
  let anyLatched = false;
  const seen = new Set();

  for (const hand of hands) {
    const channel = PINCH_CONTROLS[hand.handedness];
    if (!channel || !pinchChannelEnabled(channel)) continue;
    seen.add(hand.handedness);

    const st = pinchState[channel] || (pinchState[channel] = { latched: false, lastSent: -1, lastSentAt: 0 });
    const dist = pinchDistance(hand);

    if (!st.latched) {
      if (dist < PINCH_LATCH_DIST) {
        st.latched = true; // grab the knob
        st.lastSent = -1;
      }
      continue;
    }

    // Release: full open palm (all five fingers extended) = put the knob down.
    if (classify(hand) === "open_palm") {
      st.latched = false;
      pinchReleaseGraceUntil = performance.now() + 500;
      continue;
    }

    const value = Math.round(
      Math.max(0, Math.min(100, ((dist - PINCH_MIN) / (PINCH_MAX - PINCH_MIN)) * 100))
    );
    const now = performance.now();
    if (value !== st.lastSent && now - st.lastSentAt > PINCH_SEND_MS) {
      st.lastSent = value;
      st.lastSentAt = now;
      sendAction("adjust", channel, value);
    }
    anyLatched = true;
    gesturePill.textContent = `${channel === "volume" ? "Volume" : "Brightness"} ${value}%`;
    gesturePill.className = "pill pill-active";
  }

  // Hand left the frame, or its channel was just disabled: release the
  // channel (the level stays where it was).
  for (const [handedness, channel] of Object.entries(PINCH_CONTROLS)) {
    const st = pinchState[channel];
    if (st && st.latched && (!seen.has(handedness) || !pinchChannelEnabled(channel))) {
      st.latched = false;
    }
  }
  return anyLatched;
}

function drawGeneralFrame() {
  if (video) {
    if (settings.mirror) {
      push(); translate(width, 0); scale(-1, 1);
      image(video, 0, 0, width, height);
      pop();
    } else {
      image(video, 0, 0, width, height);
    }
  }

  if (!modelReady) {
    noStroke(); fill(230); textAlign(CENTER, CENTER); textSize(12);
    text("Loading hand-pose model…", width / 2, height / 2);
    return;
  }

  let raw = null;
  let swipeGesture = null;
  if (hands.length > 0) {
    raw = classify(hands[0]);
    swipeGesture = detectSwipe(toVisual(centroid(hands[0].keypoints)));
    if (settings.showSkeleton) {
      noStroke(); fill(0, 229, 199);
      for (const kp of hands[0].keypoints) {
        const v = toVisual(kp);
        circle(v.x, v.y, 6);
      }
    }
  } else {
    history = [];
    swipeTrail.length = 0;
  }

  // Pinch sliders take priority: while a pinch is latched (or just
  // released), static poses and swipes are suppressed so adjusting the
  // level can't tap space or skip slides.
  const pinchActive = handlePinchControls();
  if (pinchActive) {
    history = []; // stale pose frames shouldn't fire when the pinch ends
    return;
  }
  if (performance.now() < pinchReleaseGraceUntil) return;

  const stable = stableGesture(raw);
  handleGesture(stable);
  if (swipeGesture) handleSwipe(swipeGesture);
}

// ================= GAMING MODE =================

function releaseGamingKey(name, keyId) {
  if (!keyId || keyId === "none") return;
  if (gamingHeld[name]) {
    sendAction("keyup", keyId);
    gamingHeld[name] = false;
  }
}

function holdGamingKey(name, keyId) {
  if (!keyId || keyId === "none") return;
  if (!gamingHeld[name]) {
    sendAction("keydown", keyId);
    gamingHeld[name] = true;
  }
}

// Toggle a binary action only after `frames` consecutive frames agree on the
// new state; while undecided, the key just stays where it is.
function steadyToggle(name, want, frames, keyId) {
  const st = steady[name];
  if (want === st.held) {
    st.count = 0;
  } else if (++st.count >= Math.max(1, frames)) {
    st.held = want;
    st.count = 0;
  }
  if (st.held) holdGamingKey(name, keyId);
  else releaseGamingKey(name, keyId);
}


function updateSmoothedCenters(handsList) {
  const seenIds = new Set();
  const seenCounts = new Map();
  const out = [];
  for (const h of handsList) {
    let id = h.handedness || "hand";
    const n = seenCounts.get(id) || 0;
    seenCounts.set(id, n + 1);
    if (n > 0) id = `${id}#${n}`; // same label twice: disambiguate
    seenIds.add(id);
    const raw = toVisual(centroid(h.keypoints));
    const prev = smoothedCenters.get(id);
    const center = prev
      ? { x: prev.x * 0.6 + raw.x * 0.4, y: prev.y * 0.6 + raw.y * 0.4 }
      : raw;
    smoothedCenters.set(id, center);
    out.push({ hand: h, center });
  }
  for (const id of [...smoothedCenters.keys()]) {
    if (!seenIds.has(id)) smoothedCenters.delete(id);
  }
  return out;
}

function resetWheelState() {
  smoothedCenters.clear();
  hasWheel = false;
  steerState = "straight";
}

function releaseAllGamingKeys() {
  const g = settings.gaming;
  releaseGamingKey("left", g.steerLeftKey);
  releaseGamingKey("right", g.steerRightKey);
  releaseGamingKey("accelerate", g.accelerateKey);
  releaseGamingKey("brake", g.brakeKey);
  // release horn/nitro keys if held
  releaseGamingKey("horn", g.hornKey);
  releaseGamingKey("nitro", g.nitroKey);
  // resync the debouncers so they don't think keys are still down
  for (const name of Object.keys(steady)) steady[name] = { held: false, count: 0 };
}

function drawSteeringWheel(centerA, centerB) {
  const mid = { x: (centerA.x + centerB.x) / 2, y: (centerA.y + centerB.y) / 2 };
  const radius = Math.max(30, ptDist(centerA, centerB) / 2);
  // Spokes echo the *control* angle (measured tilt minus the neutral
  // baseline), which is what actually drives the keys.
  const controlDeg = hasWheel ? smoothedAngleDeg - baselineAngleDeg : 0;
  const clampedRad = (Math.max(-settings.gaming.maxAngleDeg, Math.min(settings.gaming.maxAngleDeg, controlDeg)) * Math.PI) / 180;

  push();
  translate(mid.x, mid.y);
  noFill();
  stroke(0, 229, 199);
  strokeWeight(3);
  circle(0, 0, radius * 2);

  // Spokes rotate with the (clamped) wheel angle, echoing the real tilt.
  rotate(clampedRad);
  stroke(255, 176, 32);
  strokeWeight(3);
  line(-radius, 0, radius, 0);
  line(0, -radius, 0, radius);
  pop();

  // Raw hand-to-hand line (the actual measured slope, unclamped).
  stroke(230, 230, 235, 160);
  strokeWeight(2);
  line(centerA.x, centerA.y, centerB.x, centerB.y);
  noStroke();
  fill(0, 229, 199);
  circle(centerA.x, centerA.y, 10);
  circle(centerB.x, centerB.y, 10);
}

function drawGamingFrame() {
  if (video) {
    if (settings.mirror) {
      push(); translate(width, 0); scale(-1, 1);
      image(video, 0, 0, width, height);
      pop();
    } else {
      image(video, 0, 0, width, height);
    }
  }

  if (!modelReady) {
    noStroke(); fill(230); textAlign(CENTER, CENTER); textSize(12);
    text("Loading hand-pose model…", width / 2, height / 2);
    return;
  }

  const g = settings.gaming;

  if (hands.length < 2) {
    const now = performance.now();
    if (handsLostAt === 0) handsLostAt = now;
    if (now - handsLostAt < (g.handLostGraceMs ?? 400)) {
      gesturePill.textContent = "Tracking lost — holding…";
      gesturePill.className = "pill pill-idle";
      return;
    }
    // Lost for longer than the grace period: let go of everything (including
    // the gas) — same as taking your hands off the wheel in a real car.
    releaseAllGamingKeys();
    resetWheelState();
    gesturePill.textContent = hands.length === 1 ? "Show your other hand" : "No hands detected";
    gesturePill.className = "pill pill-idle";
    return;
  }
  if (handsLostAt !== 0 || !hasWheel) {
    handsLostAt = 0;
    resetWheelState();
  }

  // Smoothed centers, then order them left-to-right as the user sees them.
  const two = updateSmoothedCenters(hands.slice(0, 2));
  two.sort((a, b) => a.center.x - b.center.x);
  const leftHand = two[0].hand;
  const rightHand = two[1].hand;
  const leftCenter = two[0].center;
  const rightCenter = two[1].center;

  if (settings.showSkeleton) {
    noStroke(); fill(0, 229, 199, 140);
    for (const h of hands.slice(0, 2)) {
      for (const kp of h.keypoints) {
        const v = toVisual(kp);
        circle(v.x, v.y, 4);
      }
    }
  }

  // Slope of the line between the (smoothed) hand centers -> steering angle.
  // A real wheel: turning right drops the right hand and raises the left one.
  const dx = rightCenter.x - leftCenter.x;
  const dy = rightCenter.y - leftCenter.y;
  const rawAngleDeg = (Math.atan2(dy, dx) * 180) / Math.PI;

  if (!hasWheel) {
    smoothedAngleDeg = rawAngleDeg;
    baselineAngleDeg = rawAngleDeg;
    hasWheel = true;
  } else {
    const a = Math.min(1, Math.max(0.05, g.smoothing ?? 0.25));
    smoothedAngleDeg = smoothedAngleDeg * (1 - a) + rawAngleDeg * a;
  }
  const dead = g.deadzoneDeg ?? 8;
  const rel = Math.min(g.steerReleaseDeg ?? 5, dead);
  const offset = smoothedAngleDeg - baselineAngleDeg;
  if (Math.abs(offset) < rel) {
    baselineAngleDeg += offset * 0.02;
  }

  drawSteeringWheel(leftCenter, rightCenter);

  if (steerState === "straight") {
    if (offset > dead) steerState = "right";
    else if (offset < -dead) steerState = "left";
  } else if (steerState === "left") {
    if (offset > -rel) steerState = offset > dead ? "right" : "straight";
  } else { // right
    if (offset < rel) steerState = offset < -dead ? "left" : "straight";
  }
  if (steerState === "left") {
    releaseGamingKey("right", g.steerRightKey);
    holdGamingKey("left", g.steerLeftKey);
  } else if (steerState === "right") {
    releaseGamingKey("left", g.steerLeftKey);
    holdGamingKey("right", g.steerRightKey);
  } else {
    releaseGamingKey("left", g.steerLeftKey);
    releaseGamingKey("right", g.steerRightKey);
  }

  // Brake: both hands making a fist — debounced over a few frames so a single
  // misread (one hand briefly classified as something else) doesn't pump it.
  let braking = false;
  if (g.brakeOnBothFists) {
    braking = hands.slice(0, 2).every((h) => classify(h) === "fist");
  }
  steadyToggle("brake", braking, g.brakeStableFrames ?? 3, g.brakeKey);

  // Accelerate: hold gas whenever both hands are on the wheel and not braking.
  if (g.autoAccelerate && !steady.brake.held) {
    holdGamingKey("accelerate", g.accelerateKey);
  } else {
    releaseGamingKey("accelerate", g.accelerateKey);
  }

  const leftClass = classify(leftHand);
  const rightClass = classify(rightHand);

  // Palm-based actions: nitro (both open palms) and horn (right open palm),
  // also debounced so a flickering classification can't machine-gun them.
  const bothPalms = leftClass === "open_palm" && rightClass === "open_palm";
  steadyToggle("nitro", bothPalms, 2, g.nitroKey);
  steadyToggle("horn", rightClass === "open_palm" && !steady.nitro.held, 2, g.hornKey);

  const activeKeys = [];
  if (gamingHeld.left) activeKeys.push(g.steerLeftKey.toUpperCase());
  if (gamingHeld.right) activeKeys.push(g.steerRightKey.toUpperCase());
  if (gamingHeld.accelerate) activeKeys.push(g.accelerateKey.toUpperCase());
  if (gamingHeld.brake) activeKeys.push(g.brakeKey.toUpperCase());
  if (gamingHeld.horn && g.hornKey && g.hornKey !== "none") activeKeys.push(g.hornKey.toUpperCase());
  if (gamingHeld.nitro && g.nitroKey && g.nitroKey !== "none") activeKeys.push(g.nitroKey.toUpperCase());
  gesturePill.textContent = `${offset.toFixed(0)}°  →  ${activeKeys.join(" ") || "—"}`;
  gesturePill.className = "pill " + (activeKeys.length ? "pill-active" : "pill-idle");
}

// ================= p5 / ml5 bootstrap =================

function gotHands(results) {
  hands = results;
}

const settingsLoaded = loadSettings().then((s) => { settings = s; });

function setup() {
  const canvas = createCanvas(CANVAS_W, CANVAS_H);
  canvas.parent("canvasHolder");
  video = createCapture(VIDEO);
  video.size(CANVAS_W, CANVAS_H);
  video.hide();
  settingsLoaded.then(initModel);
}

function initModel() {
  handPose = ml5.handPose({ maxHands: 2 }, () => {
    modelReady = true;
    modelStatus.textContent = MODE === "gaming"
      ? "Model ready — hold up both hands like gripping a wheel"
      : "Model ready — show a hand pose to the camera";
    handPose.detectStart(video, gotHands);
  });
  connectWs();
}

function draw() {
  if (!settings) return;
  background(11, 14, 17);
  if (MODE === "gaming") {
    drawGamingFrame();
  } else {
    drawGeneralFrame();
  }
}

window.addEventListener("beforeunload", () => {
  // Don't leave a game holding a key down if the window is just closed.
  if (MODE === "gaming" && settings) releaseAllGamingKeys();
  if (MODE === "general" && settings && activeGesture) {
    sendAction("keyup", settings.mapping[activeGesture]);
  }
});
