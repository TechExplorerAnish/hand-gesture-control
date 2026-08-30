let currentSettings = null;
let saveTimer = null;

const els = {
  serverUrl: document.getElementById("serverUrl"),
  testBtn: document.getElementById("testBtn"),
  statusPill: document.getElementById("statusPill"),

  tabBtnGeneral: document.getElementById("tabBtnGeneral"),
  tabBtnGaming: document.getElementById("tabBtnGaming"),
  tabGeneral: document.getElementById("tabGeneral"),
  tabGaming: document.getElementById("tabGaming"),

  openCameraBtn: document.getElementById("openCameraBtn"),
  gestureList: document.getElementById("gestureList"),
  holdMode: document.getElementById("holdMode"),
  mirror: document.getElementById("mirror"),
  showSkeleton: document.getElementById("showSkeleton"),
  stableFrames: document.getElementById("stableFrames"),
  stableFramesVal: document.getElementById("stableFramesVal"),
  cooldownMs: document.getElementById("cooldownMs"),
  cooldownMsVal: document.getElementById("cooldownMsVal"),
  tapDwellMs: document.getElementById("tapDwellMs"),
  tapDwellMsVal: document.getElementById("tapDwellMsVal"),
  tapRefractoryMs: document.getElementById("tapRefractoryMs"),
  tapRefractoryMsVal: document.getElementById("tapRefractoryMsVal"),
  swipeSensitivity: document.getElementById("swipeSensitivity"),
  swipeSensitivityVal: document.getElementById("swipeSensitivityVal"),

  openGamingBtn: document.getElementById("openGamingBtn"),
  steerLeftKey: document.getElementById("steerLeftKey"),
  steerRightKey: document.getElementById("steerRightKey"),
  accelerateKey: document.getElementById("accelerateKey"),
  brakeKey: document.getElementById("brakeKey"),
  hornKey: document.getElementById("hornKey"),
  nitroKey: document.getElementById("nitroKey"),
  deadzoneDeg: document.getElementById("deadzoneDeg"),
  deadzoneDegVal: document.getElementById("deadzoneDegVal"),
  steerReleaseDeg: document.getElementById("steerReleaseDeg"),
  steerReleaseDegVal: document.getElementById("steerReleaseDegVal"),
  steerSmoothing: document.getElementById("steerSmoothing"),
  steerSmoothingVal: document.getElementById("steerSmoothingVal"),
  maxAngleDeg: document.getElementById("maxAngleDeg"),
  maxAngleDegVal: document.getElementById("maxAngleDegVal"),
  autoAccelerate: document.getElementById("autoAccelerate"),
  brakeOnBothFists: document.getElementById("brakeOnBothFists"),

  resetBtn: document.getElementById("resetBtn"),
  savedNote: document.getElementById("savedNote")
};

// ---------- Tabs ----------

function selectTab(name) {
  const isGeneral = name === "general";
  els.tabBtnGeneral.classList.toggle("active", isGeneral);
  els.tabBtnGaming.classList.toggle("active", !isGeneral);
  els.tabBtnGeneral.setAttribute("aria-selected", String(isGeneral));
  els.tabBtnGaming.setAttribute("aria-selected", String(!isGeneral));
  els.tabGeneral.classList.toggle("active", isGeneral);
  els.tabGaming.classList.toggle("active", !isGeneral);
}

// ---------- General tab: gesture map ----------

function buildKeyOptionsHtml(options, selectedId) {
  return options.map(
    (k) => `<option value="${k.id}" ${k.id === selectedId ? "selected" : ""}>${k.label}</option>`
  ).join("");
}

function keyIdToLabel(id) {
  if (!id) return "—";
  const opt = KEY_OPTIONS.find((k) => k.id === id);
  return opt ? opt.label : String(id).toUpperCase();
}

function keyEventToId(e) {
  // Space must be handled before the single-character branch: its e.key is
  // " " (length 1) and would otherwise return the raw " " instead of "space",
  // which then fails KEY_OPTIONS validation and silently drops the binding.
  if (e.key === " " || e.key === "Spacebar" || e.key === "Space") return "space";
  // Alphanumeric single characters
  if (e.key && e.key.length === 1) return e.key.toLowerCase();
  switch (e.key) {
    case "Enter": return "enter";
    case "Escape": return "none"; // use Escape to clear binding
    case "Tab": return "tab";
    case "Backspace": return "backspace";
    case "ArrowUp": return "arrowup";
    case "ArrowDown": return "arrowdown";
    case "ArrowLeft": return "arrowleft";
    case "ArrowRight": return "arrowright";
    case "PageUp": return "pageup";
    case "PageDown": return "pagedown";
    default: return null;
  }
}

function renderGestureRows(settings) {
  els.gestureList.innerHTML = GESTURES.map((g) => {
    const checked = settings.enabled[g.id] ? "checked" : "";
    const keyId = settings.mapping[g.id] || "none";
    return `
      <div class="gesture-row" data-gesture="${g.id}">
        <input type="checkbox" class="g-enable" ${checked} title="Enable this gesture" />
        <span class="g-label">${g.label}</span>
        <input class="g-key keybind" type="text" readonly placeholder="Click then press a key" value="${keyIdToLabel(keyId)}" />
      </div>`;
  }).join("");

  els.gestureList.querySelectorAll(".gesture-row").forEach((row) => {
    const id = row.dataset.gesture;
    row.querySelector(".g-enable").addEventListener("change", (e) => {
      currentSettings.enabled[id] = e.target.checked;
      queueSave();
    });
    const keyInput = row.querySelector(".g-key");
    bindInput(keyInput, id, "mapping");
  });
}

function renderBehavior(settings) {
  els.holdMode.checked = settings.holdMode;
  els.mirror.checked = settings.mirror;
  els.showSkeleton.checked = settings.showSkeleton;
  els.stableFrames.value = settings.stableFrames;
  els.stableFramesVal.textContent = settings.stableFrames;
  els.cooldownMs.value = settings.cooldownMs;
  els.cooldownMsVal.textContent = settings.cooldownMs;
  els.tapDwellMs.value = settings.tapDwellMs ?? 150;
  els.tapDwellMsVal.textContent = settings.tapDwellMs ?? 150;
  els.tapRefractoryMs.value = settings.tapRefractoryMs ?? 600;
  els.tapRefractoryMsVal.textContent = settings.tapRefractoryMs ?? 600;
  els.swipeSensitivity.value = settings.swipeSensitivity ?? 25;
  els.swipeSensitivityVal.textContent = settings.swipeSensitivity ?? 25;
}

// Bind inputs: click/focus to start listening for a keypress, Escape clears.
function bindInput(el, settingPath, settingsRoot = "gaming") {
  const onKey = (e) => {
    e.preventDefault();
    const id = keyEventToId(e);
    if (id === null) return; // unsupported key
    // Validate against KEY_OPTIONS (except "none" which is allowed for clearing)
    if (id !== "none" && !KEY_OPTIONS.some((k) => k.id === id)) {
      return; // key not in allowed list
    }
    // Escape clears binding
    const finalId = id === "none" ? "none" : id;
    // set nested path currentSettings[settingsRoot][settingPath]
    currentSettings[settingsRoot][settingPath] = finalId;
    // update visible label
    el.value = keyIdToLabel(finalId === "none" ? "none" : finalId);
    queueSave();
    window.removeEventListener("keydown", onKey);
    el.blur();
  };
  el.addEventListener("focus", () => {
    el.value = "Press a key... (Esc to clear)";
    window.addEventListener("keydown", onKey);
  });
  el.addEventListener("click", () => el.focus());
}

// ---------- Gaming tab ----------

function renderGaming(settings) {
  const g = settings.gaming;
  els.steerLeftKey.value = keyIdToLabel(g.steerLeftKey);
  els.steerRightKey.value = keyIdToLabel(g.steerRightKey);
  els.accelerateKey.value = keyIdToLabel(g.accelerateKey);
  els.brakeKey.value = keyIdToLabel(g.brakeKey);
  els.hornKey.value = keyIdToLabel(g.hornKey || "none");
  els.nitroKey.value = keyIdToLabel(g.nitroKey || "none");
  els.deadzoneDeg.value = g.deadzoneDeg;
  els.deadzoneDegVal.textContent = g.deadzoneDeg;
  els.steerReleaseDeg.value = g.steerReleaseDeg ?? 5;
  els.steerReleaseDegVal.textContent = g.steerReleaseDeg ?? 5;
  els.steerSmoothing.value = Math.round((g.smoothing ?? 0.25) * 100);
  els.steerSmoothingVal.textContent = Math.round((g.smoothing ?? 0.25) * 100);
  els.maxAngleDeg.value = g.maxAngleDeg;
  els.maxAngleDegVal.textContent = g.maxAngleDeg;
  els.autoAccelerate.checked = g.autoAccelerate;
  els.brakeOnBothFists.checked = g.brakeOnBothFists;
}

// ---------- Persistence ----------

function queueSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    await saveSettings(currentSettings);
    els.savedNote.textContent = "Saved";
    els.savedNote.classList.add("show");
    setTimeout(() => els.savedNote.classList.remove("show"), 900);
  }, 200);
}

function setPill(state, text) {
  els.statusPill.className = "pill " + (state === "ok" ? "pill-ok" : state === "fail" ? "pill-fail" : "pill-unknown");
  els.statusPill.textContent = text;
}

function testConnection() {
  const url = els.serverUrl.value.trim();
  setPill("unknown", "Checking...");
  let settled = false;
  try {
    const ws = new WebSocket(url);
    const timeout = setTimeout(() => {
      if (!settled) {
        settled = true;
        setPill("fail", "Timed out");
        ws.close();
      }
    }, 2500);
    ws.onopen = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      setPill("ok", "Server reachable");
      ws.close();
    };
    ws.onerror = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      setPill("fail", "Could not connect");
    };
  } catch (err) {
    setPill("fail", "Invalid URL");
  }
}

function openCameraWindow(mode) {
  chrome.windows.create({
    url: chrome.runtime.getURL(`detector.html?mode=${mode}`),
    type: "popup",
    width: mode === "gaming" ? 520 : 460,
    height: mode === "gaming" ? 620 : 560
  });
}

async function init() {
  currentSettings = await loadSettings();
  els.serverUrl.value = currentSettings.serverUrl;
  renderGestureRows(currentSettings);
  renderBehavior(currentSettings);
  renderGaming(currentSettings);

  els.tabBtnGeneral.addEventListener("click", () => selectTab("general"));
  els.tabBtnGaming.addEventListener("click", () => selectTab("gaming"));

  els.serverUrl.addEventListener("change", () => {
    currentSettings.serverUrl = els.serverUrl.value.trim();
    queueSave();
  });
  els.testBtn.addEventListener("click", testConnection);
  els.openCameraBtn.addEventListener("click", () => openCameraWindow("general"));
  els.openGamingBtn.addEventListener("click", () => openCameraWindow("gaming"));

  els.holdMode.addEventListener("change", () => { currentSettings.holdMode = els.holdMode.checked; queueSave(); });
  els.mirror.addEventListener("change", () => { currentSettings.mirror = els.mirror.checked; queueSave(); });
  els.showSkeleton.addEventListener("change", () => { currentSettings.showSkeleton = els.showSkeleton.checked; queueSave(); });
  els.stableFrames.addEventListener("input", () => {
    els.stableFramesVal.textContent = els.stableFrames.value;
    currentSettings.stableFrames = Number(els.stableFrames.value);
    queueSave();
  });
  els.cooldownMs.addEventListener("input", () => {
    els.cooldownMsVal.textContent = els.cooldownMs.value;
    currentSettings.cooldownMs = Number(els.cooldownMs.value);
    queueSave();
  });
  els.tapDwellMs.addEventListener("input", () => {
    els.tapDwellMsVal.textContent = els.tapDwellMs.value;
    currentSettings.tapDwellMs = Number(els.tapDwellMs.value);
    queueSave();
  });
  els.tapRefractoryMs.addEventListener("input", () => {
    els.tapRefractoryMsVal.textContent = els.tapRefractoryMs.value;
    currentSettings.tapRefractoryMs = Number(els.tapRefractoryMs.value);
    queueSave();
  });
  els.swipeSensitivity.addEventListener("input", () => {
    els.swipeSensitivityVal.textContent = els.swipeSensitivity.value;
    currentSettings.swipeSensitivity = Number(els.swipeSensitivity.value);
    queueSave();
  });

  bindInput(els.steerLeftKey, "steerLeftKey");
  bindInput(els.steerRightKey, "steerRightKey");
  bindInput(els.accelerateKey, "accelerateKey");
  bindInput(els.brakeKey, "brakeKey");
  bindInput(els.hornKey, "hornKey");
  bindInput(els.nitroKey, "nitroKey");
  els.deadzoneDeg.addEventListener("input", () => {
    els.deadzoneDegVal.textContent = els.deadzoneDeg.value;
    currentSettings.gaming.deadzoneDeg = Number(els.deadzoneDeg.value);
    queueSave();
  });
  els.steerReleaseDeg.addEventListener("input", () => {
    els.steerReleaseDegVal.textContent = els.steerReleaseDeg.value;
    currentSettings.gaming.steerReleaseDeg = Number(els.steerReleaseDeg.value);
    queueSave();
  });
  els.steerSmoothing.addEventListener("input", () => {
    els.steerSmoothingVal.textContent = els.steerSmoothing.value;
    currentSettings.gaming.smoothing = Number(els.steerSmoothing.value) / 100;
    queueSave();
  });
  els.maxAngleDeg.addEventListener("input", () => {
    els.maxAngleDegVal.textContent = els.maxAngleDeg.value;
    currentSettings.gaming.maxAngleDeg = Number(els.maxAngleDeg.value);
    queueSave();
  });
  els.autoAccelerate.addEventListener("change", () => { currentSettings.gaming.autoAccelerate = els.autoAccelerate.checked; queueSave(); });
  els.brakeOnBothFists.addEventListener("change", () => { currentSettings.gaming.brakeOnBothFists = els.brakeOnBothFists.checked; queueSave(); });

  // removed select change listeners; bindings are handled by keypress capture

  els.resetBtn.addEventListener("click", async () => {
    currentSettings = JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
    await saveSettings(currentSettings);
    els.serverUrl.value = currentSettings.serverUrl;
    renderGestureRows(currentSettings);
    renderBehavior(currentSettings);
    renderGaming(currentSettings);
    setPill("unknown", "Not checked");
  });
}

init();
