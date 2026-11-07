"use strict";

const PPQ = 960;
const SLOTS = 16;
const SCHEDULE_AHEAD_MS = 150;
const CHUNK_PULSES = 10; // Must divide CLOCK_PULSES.
const CLOCK_PULSES = PPQ / 24;
const VELOCITY_STEPS = [1.0, 0.7, 0.4];
const BANKS = "ABCDEFGH";
const PADS_PER_BANK = 16;
const BAR_CHOICES = [1, 2, 4, 8];
const BLANK_PATH = "";
const BLANK_DRAFT = "live-patterns";
const BLANK_TRACK = "Pads";
const CC_VOLUME = 7;
const CC_PAN = 10;
const PAN_CENTRE = 64;
const DRAG_THRESHOLD_PX = 4; // A press that moves less than this counts as a click.
const FINE_DIVISIONS = 8; // Resizing moves in eighths of a step, or quarters when steps are narrow.
const NARROW_STEP_PX = 32;
const MIN_CELL_PX = 14; // Below this, steps are too small to click reliably.
const DENSE_CELL_PX = 22;
const LAST_PROJECT_KEY = "mpc-grid-last-project";
const NO_PROJECT_MESSAGE =
  "No project open, so sample names aren't available. Choose a project to see them.";

const $ = (id) => document.getElementById(id);

let backend = null;

const state = {
  path: BLANK_PATH,
  projectName: "",
  view: null,
  currentKey: 0,
  queuedKey: null,
  bank: 0,
  resolution: 240,
  baseResolution: 240,
  triplets: false,
  repeat: 1,
  page: 0,
  pageBars: 1,
  windowStart: 0,
  windowSpan: 0,
  editor: null,
  dirty: new Set(),
  undo: [],
  midi: null,
  output: null,
  channel: 0,
  playing: false,
  nextPulse: 0,
  nextTime: 0,
  paint: null,
  draftTimer: null,
  cardMounted: false,
  syncing: false,
  projectsSignature: "",
  sendOnce: false,
  newLength: "off",
  barsQueued: false,
  lengthDrag: null,
  muted: new Set(), // Notes that don't play. Only for this visit, and never saved to a project.
};

function blankView() {
  const pads = [];
  for (let pad = 0; pad < BANKS.length * PADS_PER_BANK; pad += 1) {
    pads.push({ pad, note: (36 + pad) % 128, sample: "" });
  }
  return {
    bpm: 120,
    currentSequence: 0,
    tracks: [{ name: BLANK_TRACK, pads, volume: 0.7079457640647888, pan: 0.5 }],
    sequences: [makeSequence(0, 2, 120, 4, PPQ, BLANK_TRACK)],
  };
}

function makeSequence(key, bars, bpm, beatsPerBar, beatLength, trackName) {
  return {
    key,
    name: `Sequence ${String(key + 1).padStart(2, "0")}`,
    bpm,
    lengthPulses: bars * beatsPerBar * beatLength,
    beatsPerBar,
    beatLength,
    notes: { [trackName]: [] },
    isNew: true,
  };
}

const isBlank = () => state.path === BLANK_PATH;
const track = () => state.view.tracks[0];
const sequenceByKey = (key) => state.view.sequences.find((s) => s.key === key);
const sequence = () => sequenceByKey(state.currentKey);
const notesOf = (seq) => seq.notes[track().name] || [];
const trackNotes = () => notesOf(sequence());
const pulsesPerBar = (seq = sequence()) => seq.beatsPerBar * seq.beatLength;

function padId(pad) {
  const bank = BANKS[Math.floor(pad / PADS_PER_BANK)] || "?";
  return bank + String((pad % PADS_PER_BANK) + 1).padStart(2, "0");
}

function setStatus(message, isError = false) {
  $("status").textContent = message;
  $("status").classList.toggle("error", isError);
}

/* ---------- Projects ---------- */

// Keeps the grid usable for live MIDI in browsers without the file APIs.
function localOnlyBackend() {
  return {
    projects: async () => ({
      library: [], card: [], cardMounted: false, cardStatus: "none", cardName: "",
    }),
    readDraft: async () => ({ draft: null }),
    writeDraft: async () => {},
  };
}

function renderCardState(listing) {
  const pill = $("card-state");
  const views = {
    none: ["Connect card", "Card: not connected", ""],
    permission: ["Allow card access", `Card: ${listing.cardName} needs permission`, "warn"],
    missing: ["Change card folder", `Card: ${listing.cardName} not found. Enter SD mode.`, ""],
    ready: ["Change card folder", `Card: ${listing.cardName}`, "ok"],
  };
  const [button, text, kind] = views[listing.cardStatus];
  $("card").textContent = button;
  $("card").dataset.status = listing.cardStatus;
  pill.textContent = text;
  pill.className = `pill ${kind}`;
}

async function connectCard() {
  try {
    if ($("card").dataset.status === "permission") {
      await backend.requestCardPermission();
    } else {
      const folder = await window.showDirectoryPicker({ id: "mpc-card", mode: "readwrite" });
      await backend.setCard(folder);
    }
    await refreshProjects();
  } catch (error) {
    // Cancelling the folder picker isn't a problem worth reporting.
    if (error.name !== "AbortError") setStatus(`Couldn't open that folder: ${error.message}`, true);
  }
}

async function refreshProjects() {
  const listing = await backend.projects();
  state.cardMounted = listing.cardMounted;
  renderCardState(listing);
  await syncFromCard(listing.card);
  const select = $("project");
  updateFileButtons();
  // Only rebuild when the list changes, so an open menu isn't disturbed.
  const signature = JSON.stringify([listing.library, listing.card, state.path]);
  if (signature === state.projectsSignature) return;
  state.projectsSignature = signature;
  select.replaceChildren(new Option("No project (blank pads)", BLANK_PATH));
  const addGroup = (label, entries) => {
    if (!entries.length) return;
    const group = document.createElement("optgroup");
    group.label = label;
    for (const entry of entries) group.append(new Option(entry.name, entry.path));
    select.append(group);
  };
  addGroup("In this browser", listing.library);
  addGroup("On the card", listing.card);
  select.value = state.path;
  updateFileButtons();
}

// Picks up samples loaded on the MPC: once a project is saved there and the
// card is mounted, the open project is refreshed from it automatically.
async function syncFromCard(cardEntries) {
  if (isBlank() || state.syncing) return;
  const entry = cardEntries.find((e) => e.name === state.projectName && e.changed);
  if (!entry) return;
  state.syncing = true;
  try {
    stop();
    await flushDraft();
    const opened = await backend.open({ path: entry.path });
    const keep = { currentKey: state.currentKey, bank: state.bank };
    await loadView(opened.view);
    state.bank = keep.bank;
    if (sequenceByKey(keep.currentKey)) state.currentKey = keep.currentKey;
    renderAll();
    const kept = state.dirty.size ? " Your unsaved patterns are kept." : "";
    setStatus(`Updated pad names from ${opened.name} on the card.${kept}`);
  } catch (error) {
    setStatus(`Could not read the card version yet: ${error.message}`, true);
  } finally {
    state.syncing = false;
  }
}

async function flushDraft() {
  if (state.draftTimer === null) return;
  window.clearTimeout(state.draftTimer);
  state.draftTimer = null;
  await writeDraft();
}

async function openProject(path) {
  stop();
  await flushDraft();
  try {
    if (path === BLANK_PATH) {
      state.path = BLANK_PATH;
      state.projectName = "";
      await loadView(blankView());
      rememberProject();
      setStatus(NO_PROJECT_MESSAGE);
      return;
    }
    setStatus("Opening project...");
    const opened = await backend.open({ path });
    state.path = opened.path;
    state.projectName = opened.name;
    await loadView(opened.view);
    rememberProject();
    await refreshProjects();
    const restored = state.dirty.size ? " Restored your unsaved patterns." : "";
    setStatus(`Opened ${opened.name}. The original project is not changed.${restored}`);
  } catch (error) {
    $("project").value = state.path;
    setStatus(error.message, true);
  }
}

const draftName = () => (isBlank() ? BLANK_DRAFT : state.projectName);

function rememberProject() {
  try {
    localStorage.setItem(LAST_PROJECT_KEY, state.path);
  } catch (error) {
    // Reopening the last project is only a convenience.
  }
}

function lastProject() {
  try {
    return localStorage.getItem(LAST_PROJECT_KEY);
  } catch (error) {
    return null;
  }
}

async function loadView(view) {
  state.view = view;
  state.dirty = new Set();
  state.undo = [];
  state.bank = 0;
  state.queuedKey = null;

  const { draft } = await backend.readDraft({ name: draftName() });
  if (draft) {
    // Only edited patterns come from the draft. The rest stay as the project
    // file has them, as it may have been saved again on the MPC.
    const merged = new Map(view.sequences.map((s) => [s.key, s]));
    for (const edited of draft.sequences) {
      if (!draft.dirty.includes(edited.key)) continue;
      edited.isNew = !merged.has(edited.key);
      merged.set(edited.key, edited);
    }
    state.view.sequences = [...merged.values()].sort((a, b) => a.key - b.key);
    state.dirty = new Set(draft.dirty);
  }

  const wanted = sequenceByKey(draft ? draft.currentKey : view.currentSequence);
  state.currentKey = (wanted || state.view.sequences[0]).key;
  const bpm = view.bpm ?? sequence().bpm;
  $("bpm").value = Math.round(bpm * 10) / 10;
  // Shows the project's mix. Nothing is sent until a slider is moved.
  $("live-volume").value = Math.round(track().volume * 127);
  $("live-pan").value = Math.round(track().pan * 127);
  $("save-name").value = isBlank() ? "" : nextSaveName(state.projectName);
  renderAll();
}

function nextSaveName(name) {
  const match = name.match(/^(.*)-v(\d+)$/);
  return match ? `${match[1]}-v${Number(match[2]) + 1}` : `${name}-v2`;
}

function savableKeys() {
  return [...state.dirty].filter((key) => {
    const seq = sequenceByKey(key);
    return seq && !(seq.isNew && !notesOf(seq).length);
  });
}

function hasChanges() {
  return isBlank()
    ? state.view.sequences.some((s) => notesOf(s).length)
    : savableKeys().length > 0;
}

async function saveCopy() {
  const keys = savableKeys();
  const edits = keys.map((key) => {
    const seq = sequenceByKey(key);
    const edit = {
      sequence: key,
      track: track().name,
      notes: notesOf(seq),
      lengthPulses: seq.lengthPulses,
    };
    if (seq.isNew) edit.create = true;
    return edit;
  });
  try {
    await flushDraft();
    const saved = await backend.save({
      path: state.path, name: $("save-name").value, edits,
    });
    state.path = saved.path;
    state.projectName = saved.name;
    rememberProject();
    for (const key of keys) {
      const seq = sequenceByKey(key);
      seq.isNew = false;
      // The saved file now has these notes at their new times.
      for (const note of notesOf(seq)) delete note.sourceTime;
    }
    state.view.sequences = state.view.sequences.filter((s) => !s.isNew);
    if (!sequence()) state.currentKey = state.view.sequences[0].key;
    state.dirty = new Set();
    state.undo = [];
    $("save-name").value = nextSaveName(saved.name);
    await refreshProjects();
    renderAll();
    setStatus(`Saved ${keys.length} sequence(s) to ${saved.name} in this browser. Use Copy to card to keep it on the MPC.`);
  } catch (error) {
    setStatus(error.message, true);
  }
}

async function copyToCard() {
  try {
    const copied = await backend.copyToCard({ path: state.path });
    setStatus(`Copied ${copied.name} to the card. Eject the card before leaving SD Card Access mode.`);
  } catch (error) {
    setStatus(error.message, true);
  }
}

async function discardChanges() {
  if (!window.confirm("Discard all unsaved patterns in this project?")) return;
  stop();
  window.clearTimeout(state.draftTimer);
  state.draftTimer = null;
  await backend.writeDraft({ name: draftName(), draft: null });
  await openProject(state.path);
  setStatus("Unsaved patterns discarded.");
}

function scheduleDraft() {
  window.clearTimeout(state.draftTimer);
  state.draftTimer = window.setTimeout(() => {
    state.draftTimer = null;
    writeDraft().catch(() => setStatus("Could not autosave in this browser.", true));
  }, 300);
}

function writeDraft() {
  const keep = hasChanges() || state.dirty.size > 0;
  const draft = keep ? {
    sequences: state.view.sequences,
    dirty: [...state.dirty],
    currentKey: state.currentKey,
  } : null;
  return backend.writeDraft({ name: draftName(), draft });
}

function updateFileButtons() {
  const hasProject = !isBlank();
  const changed = savableKeys().length > 0;
  $("save").disabled = !hasProject || !changed || state.view.canSave === false;
  $("save-name").disabled = !hasProject;
  $("to-card").disabled = !hasProject || !state.cardMounted || changed;
  $("discard").disabled = !hasChanges();
}

/* ---------- Rendering ---------- */

function renderSlots() {
  const nodes = [];
  for (let key = 0; key < SLOTS; key += 1) {
    const seq = sequenceByKey(key);
    const button = document.createElement("button");
    button.type = "button";
    button.className = "slot";
    button.textContent = String(key + 1);
    const used = seq && notesOf(seq).length > 0;
    button.classList.toggle("has-pattern", Boolean(used));
    button.classList.toggle("queued", key === state.queuedKey);
    button.classList.toggle("changed", state.dirty.has(key) && Boolean(used));
    button.setAttribute("aria-current", String(key === state.currentKey));
    button.setAttribute("aria-label",
      `Sequence ${key + 1}${used ? `, ${notesOf(seq).length} notes` : ", empty"}`);
    button.addEventListener("click", () => selectSlot(key));
    nodes.push(button);
  }
  $("slots").replaceChildren(...nodes);
}

function renderBars() {
  const seq = sequence();
  const bars = seq.lengthPulses / pulsesPerBar(seq);
  const choices = [...new Set([...BAR_CHOICES, bars])].sort((a, b) => a - b);
  $("bars").replaceChildren(...choices.map((b) => new Option(String(b), String(b))));
  $("bars").value = String(bars);
}

function renderBanks() {
  const noted = new Set(trackNotes().map((n) => n.note));
  const nodes = [];
  const add = (label, value, title, hasNotes) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "bank";
    if (value === "used") button.classList.add("used");
    button.textContent = label;
    button.title = title;
    button.classList.toggle("has-notes", hasNotes);
    button.setAttribute("aria-current", String(state.bank === value));
    button.setAttribute("aria-label", title + (hasNotes ? ", has notes" : ""));
    button.addEventListener("click", () => setBank(value));
    nodes.push(button);
  };
  add("In use", "used", "Pads with samples or notes in any bank", false);
  for (let bank = 0; bank < BANKS.length; bank += 1) {
    const pads = track().pads.filter((p) => Math.floor(p.pad / PADS_PER_BANK) === bank);
    add(BANKS[bank], bank, `Bank ${BANKS[bank]}`, pads.some((p) => noted.has(p.note)));
  }
  $("banks").replaceChildren(...nodes);
}

function setBank(value) {
  state.bank = value;
  renderBanks();
  renderGrid();
}

function visiblePads() {
  const pads = track().pads;
  if (state.bank !== "used") {
    return pads.filter((p) => Math.floor(p.pad / PADS_PER_BANK) === state.bank);
  }
  const noted = new Set(trackNotes().map((n) => n.note));
  const used = pads.filter((p) => p.sample || noted.has(p.note));
  return used.length ? used : pads.filter((p) => p.pad < PADS_PER_BANK);
}

function renderChannel() {
  if (!$("channel").options.length) {
    for (let channel = 1; channel <= 16; channel += 1) {
      $("channel").append(new Option(String(channel), String(channel)));
    }
  }
  $("channel").value = String(state.channel + 1);
}

function gridWidthForSteps() {
  const wrap = $("grid-wrap");
  const style = getComputedStyle(wrap);
  const label = document.querySelector(".pad-label");
  return wrap.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight)
    - (label ? label.offsetWidth : 190);
}

// Everything fits on one page. Only when steps would be too small to click does
// the grid show fewer bars at a time, with buttons to move between them.
function updatePaging() {
  const seq = sequence();
  const perBar = pulsesPerBar(seq);
  const totalBars = Math.ceil(seq.lengthPulses / perBar);
  const stepsPerBar = perBar / state.resolution;
  const available = gridWidthForSteps();
  let pageBars = totalBars;
  while (pageBars > 1 && available / (pageBars * stepsPerBar) < MIN_CELL_PX) {
    pageBars = Math.ceil(pageBars / 2);
  }
  state.pageBars = pageBars;
  const pages = Math.ceil(totalBars / pageBars);
  state.page = Math.min(state.page, pages - 1);

  $("pager").hidden = pages <= 1;
  const first = state.page * pageBars + 1;
  const last = Math.min(first + pageBars - 1, totalBars);
  $("page-label").textContent = first === last
    ? `Bar ${first} of ${totalBars}` : `Bars ${first}-${last} of ${totalBars}`;
  $("page-prev").disabled = state.page === 0;
  $("page-next").disabled = state.page >= pages - 1;
}

function goToPage(page) {
  state.page = page;
  renderGrid();
}

function renderGrid() {
  closeNoteEditor({ restoreFocus: false });
  const grid = $("grid");
  const seq = sequence();
  const perBar = pulsesPerBar(seq);
  updatePaging();
  const windowStart = state.page * state.pageBars * perBar;
  const windowEnd = Math.min(windowStart + state.pageBars * perBar, seq.lengthPulses);
  const stepCount = Math.ceil((windowEnd - windowStart) / state.resolution);
  state.windowStart = windowStart;
  state.windowSpan = stepCount * state.resolution;
  const pads = visiblePads();
  grid.style.gridTemplateColumns =
    `var(--label-width) repeat(${stepCount}, minmax(0, 1fr))`;
  grid.style.gridTemplateRows =
    `20px repeat(${pads.length}, minmax(14px, 1fr))`;
  const dense = gridWidthForSteps() / stepCount < DENSE_CELL_PX;
  grid.classList.toggle("dense", dense);
  grid.style.setProperty("--grid-gap", dense ? "1px" : "2px");

  const nodes = [];
  const corner = document.createElement("div");
  corner.className = "corner";
  nodes.push(corner);

  for (let step = 0; step < stepCount; step += 1) {
    const time = windowStart + step * state.resolution;
    const label = document.createElement("div");
    label.className = "step-number";
    if (time % perBar === 0) {
      label.classList.add("bar-start");
      label.textContent = String(time / perBar + 1);
    } else if (time % seq.beatLength === 0) {
      label.textContent = String((time % perBar) / seq.beatLength + 1);
    }
    nodes.push(label);
  }

  for (const pad of pads) {
    const muted = state.muted.has(pad.note);
    const label = document.createElement("div");
    label.className = "pad-label";
    label.classList.toggle("muted", muted);
    const hear = document.createElement("button");
    hear.type = "button";
    hear.className = "pad";
    hear.title = `Note ${pad.note}. Click to hear it.`;
    const id = document.createElement("span");
    id.className = "id";
    id.textContent = padId(pad.pad);
    const name = document.createElement("span");
    name.className = "name";
    // Without a project file there is no way to know what is on the pad.
    name.textContent = pad.sample || (isBlank() ? `Note ${pad.note}` : "(no sample)");
    hear.append(id, name);
    hear.addEventListener("pointerdown", () => audition(pad.note));
    const mute = document.createElement("button");
    mute.type = "button";
    mute.className = "mute";
    mute.textContent = "M";
    mute.title = muted ? "Muted. Click to play this pad again." : "Mute this pad while playing";
    mute.setAttribute("aria-label", `Mute pad ${padId(pad.pad)}`);
    mute.setAttribute("aria-pressed", String(muted));
    mute.addEventListener("click", () => toggleMute(pad));
    label.append(hear, mute);
    nodes.push(label);

    for (let step = 0; step < stepCount; step += 1) {
      const time = windowStart + step * state.resolution;
      const cell = document.createElement("button");
      cell.type = "button";
      cell.className = "cell";
      cell.classList.toggle("muted", muted);
      cell.dataset.note = String(pad.note);
      cell.dataset.pad = padId(pad.pad);
      cell.dataset.time = String(time);
      if (Math.floor(time / seq.beatLength) % 2 === 0) cell.classList.add("beat");
      if (time % perBar === 0) cell.classList.add("bar-start");
      nodes.push(cell);
    }
  }
  grid.replaceChildren(...nodes);
  renderNotes();
  renderStepControls();
}

// Muting goes by note, as that's what plays the pad on the MPC.
function toggleMute(pad) {
  if (state.muted.has(pad.note)) state.muted.delete(pad.note);
  else state.muted.add(pad.note);
  const muted = state.muted.has(pad.note);
  renderGrid();
  setStatus(muted ? `Pad ${padId(pad.pad)} muted. Its steps are kept but don't play.` : `Pad ${padId(pad.pad)} plays again.`);
}

function renderStepControls() {
  const mark = (group, value) => {
    for (const button of $(group).querySelectorAll("button")) {
      button.setAttribute("aria-pressed", String(Number(button.dataset.value) === value));
    }
  };
  mark("steps", state.baseResolution);
  mark("repeat", state.repeat);
  $("triplets").setAttribute("aria-pressed", String(state.triplets));
}

function setSteps(baseResolution, triplets) {
  state.baseResolution = baseResolution;
  state.triplets = triplets;
  state.resolution = triplets ? (baseResolution * 2) / 3 : baseResolution;
  renderGrid();
}

function notesInCell(note, time) {
  return trackNotes().filter((n) =>
    n.note === note && n.time >= time && n.time < time + state.resolution);
}

function paintCell(cell) {
  const time = Number(cell.dataset.time);
  const found = notesInCell(Number(cell.dataset.note), time);
  const on = found.length > 0;
  const hits = found.length;
  queueNoteBars();
  cell.classList.toggle("on", on);
  cell.classList.toggle("repeat", hits > 1);
  cell.classList.toggle("off-grid", on && Math.min(...found.map((n) => n.time)) !== time);
  cell.classList.toggle("chance", found.some((n) => (n.probability ?? 100) < 100));
  cell.setAttribute("aria-pressed", String(on));
  cell.setAttribute("aria-label",
    `Pad ${cell.dataset.pad}, pulse ${time}${on ? `, on${hits > 1 ? `, ${hits} hits` : ""}` : ""}`);
  if (on) {
    const loudest = Math.max(...found.map((n) => n.velocity));
    cell.style.setProperty("--velocity", String(0.3 + 0.7 * loudest));
    cell.style.setProperty("--hits", String(hits));
  } else {
    cell.style.removeProperty("--velocity");
    cell.style.removeProperty("--hits");
  }
}

function renderNotes() {
  document.querySelectorAll(".cell").forEach(paintCell);
}

/* ---------- Note lengths ---------- */

// Many edits can happen in one moment, so bars are redrawn once per frame.
function queueNoteBars() {
  if (state.barsQueued) return;
  state.barsQueued = true;
  requestAnimationFrame(() => {
    state.barsQueued = false;
    renderNoteBars();
  });
}

function renderNoteBars() {
  document.querySelectorAll(".note-bar").forEach((bar) => bar.remove());
  document.querySelectorAll(".cell.has-bar").forEach((cell) => cell.classList.remove("has-bar"));
  const start = state.windowStart;
  const end = start + state.windowSpan;
  for (const note of trackNotes()) {
    const noteEnd = note.time + note.length;
    if (noteEnd <= start || note.time >= end) continue;
    const cellTime = Math.floor(note.time / state.resolution) * state.resolution;
    // Repeats are drawn as hits inside the step, not as a bar.
    if (notesInCell(note.note, cellTime).length > 1) continue;
    const anchorTime = Math.max(cellTime, start);
    const cell = cellElement(note.note, anchorTime);
    if (!cell) continue;

    const barStart = Math.max(note.time, start);
    const barEnd = Math.min(noteEnd, end);
    const steps = (barEnd - barStart) / state.resolution;
    const bar = document.createElement("span");
    bar.className = "note-bar";
    bar.style.setProperty("--steps", String(steps));
    bar.style.setProperty("--gaps", String(Math.max(0, Math.ceil(steps) - 1)));
    bar.style.left = `${((barStart - anchorTime) / state.resolution) * 100}%`;
    bar.style.setProperty("--velocity", String(0.3 + 0.7 * note.velocity));
    // A note that runs on past this page can't be resized from here.
    if (noteEnd <= end) {
      const handle = document.createElement("span");
      handle.className = "note-handle";
      handle.title = "Drag to change where this note ends. Hold Alt for finer control.";
      bar.append(handle);
    }
    cell.append(bar);
    if (note.time === barStart) cell.classList.add("has-bar");
  }
}

function describeLength(length) {
  const steps = length / state.resolution;
  const shown = Number.isInteger(steps) ? String(steps) : steps.toFixed(2);
  return `${shown} ${steps === 1 ? "step" : "steps"}`;
}

function newNoteLength(time) {
  const seq = sequence();
  const lengths = {
    off: state.resolution,
    step: state.resolution,
    beat: seq.beatLength,
    bar: pulsesPerBar(seq),
    "2bars": 2 * pulsesPerBar(seq),
    "4bars": 4 * pulsesPerBar(seq),
  };
  return Math.min(lengths[state.newLength], seq.lengthPulses - time);
}

function startLengthDrag(event, handle) {
  const cell = handle.closest(".cell");
  const note = Number(cell.dataset.note);
  const anchorTime = Number(cell.dataset.time);
  const found = trackNotes().find((n) => n.note === note
    && n.time < anchorTime + state.resolution && n.time + n.length > anchorTime);
  if (!found) return;
  remember();
  state.lengthDrag = { note: found, anchorTime, cell, pressed: true, startX: event.clientX };
  event.preventDefault();
}

// Where a resize ends. Drawing a new note uses whole steps, while resizing is finer so
// a note can end inside a step. Alt gives single ticks.
function dragEnd(event, drag, start, currentLength, box) {
  const gap = parseFloat(getComputedStyle($("grid")).getPropertyValue("--grid-gap")) || 0;
  const ticksAt = (x) => drag.anchorTime + ((x - box.left) / (box.width + gap)) * state.resolution;
  // Follows the mouse from where the note was grabbed, so it doesn't jump at the start.
  if (!drag.drawing && drag.grabOffset === undefined) {
    drag.grabOffset = start + currentLength - ticksAt(drag.startX);
  }
  const pointer = ticksAt(event.clientX) + (drag.grabOffset || 0);
  if (event.altKey) return { end: Math.round(pointer), shortest: start + 1 };
  const divisions = box.width < NARROW_STEP_PX ? FINE_DIVISIONS / 2 : FINE_DIVISIONS;
  const unit = drag.drawing ? state.resolution : state.resolution / divisions;
  return {
    end: Math.round(pointer / unit) * unit,
    shortest: Math.floor(start / unit) * unit + unit,
  };
}

function moveLengthDrag(event) {
  const { note, anchorTime, cell, drawing } = state.lengthDrag;
  const box = cell.getBoundingClientRect();
  // A click that stays on its step keeps the New note length.
  if (drawing && !state.lengthDrag.moved) {
    if (event.clientX <= box.right) return;
    state.lengthDrag.moved = true;
  }
  if (state.lengthDrag.pressed && !state.lengthDrag.moved) {
    if (Math.abs(event.clientX - state.lengthDrag.startX) < DRAG_THRESHOLD_PX) return;
    state.lengthDrag.moved = true;
  }
  // Repeats have a fixed spacing, so they don't resize.
  if (!note) return;
  const windowEnd = state.windowStart + state.windowSpan;
  const target = dragEnd(event, state.lengthDrag, note.time, note.length, box);
  const end = Math.max(target.shortest, Math.min(target.end, windowEnd, sequence().lengthPulses));
  const length = end - note.time;
  if (length !== note.length) {
    note.length = length;
    renderNoteBars();
  }
  setStatus(`Length: ${describeLength(length)} (${length} ticks).`);
}

function endLengthDrag() {
  const drag = state.lengthDrag;
  state.lengthDrag = null;
  if (drag.pressed && !drag.moved) setCell(drag.cell, false);
  markDirty();
}

function renderChrome() {
  $("dirty").hidden = !hasChanges();
  $("undo").disabled = state.undo.length === 0;
  updateFileButtons();
  renderSlots();
  renderBanks();
}

function renderAll() {
  renderBars();
  renderChannel();
  renderGrid();
  renderChrome();
}

/* ---------- Sequences ---------- */

function selectSlot(key) {
  if (key === state.currentKey) {
    state.queuedKey = null;
    renderSlots();
    return;
  }
  if (state.playing) {
    state.queuedKey = key;
    renderSlots();
    setStatus(`Sequence ${key + 1} starts at the end of this loop.`);
    return;
  }
  switchTo(key);
}

function switchTo(key) {
  const seq = sequence();
  if (!sequenceByKey(key)) {
    const bars = seq.lengthPulses / pulsesPerBar(seq);
    state.view.sequences.push(makeSequence(
      key, bars, seq.bpm, seq.beatsPerBar, seq.beatLength, track().name));
    state.view.sequences.sort((a, b) => a.key - b.key);
    state.dirty.add(key);
  }
  state.currentKey = key;
  state.queuedKey = null;
  state.page = 0;
  renderAll();
  scheduleDraft();
}

function duplicateSequence() {
  const source = sequence();
  let target = null;
  for (let key = 0; key < SLOTS && target === null; key += 1) {
    const seq = sequenceByKey(key);
    if (!seq || !notesOf(seq).length) target = key;
  }
  if (target === null) {
    setStatus("All 16 sequences have patterns. Clear one first.", true);
    return;
  }
  stop();
  state.undo = [];
  const existing = sequenceByKey(target);
  const copy = JSON.parse(JSON.stringify(source));
  copy.key = target;
  copy.name = existing ? existing.name
    : `Sequence ${String(target + 1).padStart(2, "0")}`;
  copy.isNew = existing ? Boolean(existing.isNew) : true;
  state.view.sequences = state.view.sequences.filter((s) => s.key !== target);
  state.view.sequences.push(copy);
  state.view.sequences.sort((a, b) => a.key - b.key);
  state.dirty.add(target);
  state.currentKey = target;
  renderAll();
  scheduleDraft();
  setStatus(`Copied to sequence ${target + 1}.`);
}

function setBars(bars) {
  const seq = sequence();
  const length = bars * pulsesPerBar(seq);
  remember();
  seq.lengthPulses = length;
  seq.notes[track().name] = notesOf(seq).filter((n) => n.time < length);
  if (state.nextPulse >= length) state.nextPulse = 0;
  markDirty();
  renderGrid();
}

/* ---------- Editing ---------- */

function remember() {
  const seq = sequence();
  state.undo.push({
    key: seq.key,
    lengthPulses: seq.lengthPulses,
    notes: JSON.stringify(notesOf(seq)),
    dirtyBefore: state.dirty.has(seq.key),
  });
  if (state.undo.length > 200) state.undo.shift();
}

function markDirty() {
  state.dirty.add(state.currentKey);
  renderChrome();
  scheduleDraft();
}

function undo() {
  const last = state.undo.pop();
  if (!last) return;
  const seq = sequenceByKey(last.key);
  seq.lengthPulses = last.lengthPulses;
  seq.notes[track().name] = JSON.parse(last.notes);
  if (!last.dirtyBefore) state.dirty.delete(last.key);
  state.currentKey = last.key;
  renderAll();
  scheduleDraft();
}

function setCell(cell, on) {
  const note = Number(cell.dataset.note);
  const time = Number(cell.dataset.time);
  const existing = notesInCell(note, time);
  const seq = sequence();
  if (on && !existing.length) {
    addHits(note, time, 1.0);
  } else if (!on && existing.length) {
    seq.notes[track().name] = trackNotes().filter((n) => !existing.includes(n));
  }
  paintCell(cell);
}

// Note repeat writes real notes, so it plays back on the MPC exactly as shown.
function addHits(note, time, velocity) {
  const notes = trackNotes();
  const spacing = state.resolution / state.repeat;
  const length = state.repeat > 1 ? Math.max(1, Math.round(spacing)) : newNoteLength(time);
  for (let hit = 0; hit < state.repeat; hit += 1) {
    notes.push({ time: Math.round(time + hit * spacing), note, velocity, length });
  }
  notes.sort((a, b) => a.time - b.time || a.note - b.note);
}

function applyRepeatToCell(cell) {
  const note = Number(cell.dataset.note);
  const time = Number(cell.dataset.time);
  const existing = notesInCell(note, time);
  if (!existing.length) return;
  remember();
  const velocity = existing[0].velocity;
  sequence().notes[track().name] = trackNotes().filter((n) => !existing.includes(n));
  addHits(note, time, velocity);
  paintCell(cell);
  markDirty();
  setStatus(state.repeat > 1 ? `Step set to ${state.repeat} hits.` : "Step set to a single hit.");
}

function cycleVelocity(cell) {
  const found = notesInCell(Number(cell.dataset.note), Number(cell.dataset.time));
  if (!found.length) return;
  remember();
  const current = VELOCITY_STEPS.findIndex((v) => found[0].velocity >= v - 0.001);
  const next = VELOCITY_STEPS[(Math.max(current, 0) + 1) % VELOCITY_STEPS.length];
  found.forEach((n) => { n.velocity = next; });
  paintCell(cell);
  markDirty();
  setStatus(`Velocity ${Math.round(next * 127)} of 127.`);
}

/* ---------- Note editor ---------- */

const cellElement = (note, time) =>
  document.querySelector(`.cell[data-note="${note}"][data-time="${time}"]`);
const clampInt = (value, low, high) => Math.min(high, Math.max(low, Math.round(value)));

function editorNotes() {
  return notesInCell(state.editor.note, state.editor.time);
}

function openNoteEditor(cell) {
  closeNoteEditor({ restoreFocus: false });
  const note = Number(cell.dataset.note);
  const time = Number(cell.dataset.time);
  let remembered = false;
  if (!notesInCell(note, time).length) {
    remember();
    remembered = true;
    addHits(note, time, 1.0);
    markDirty();
  }
  state.editor = { note, time, pad: cell.dataset.pad, remembered };
  cell.classList.add("editing");
  paintCell(cell);

  const perBar = pulsesPerBar();
  const seq = sequence();
  const bar = Math.floor(time / perBar) + 1;
  const beat = ((time % perBar) / seq.beatLength + 1).toFixed(2).replace(/\.?0+$/, "");
  $("editor-title").textContent = `Pad ${cell.dataset.pad}, bar ${bar}, beat ${beat}`;
  fillNoteEditor();

  const panel = $("note-editor");
  panel.hidden = false;
  const box = cell.getBoundingClientRect();
  const margin = 8;
  const fitsRight = box.right + margin + panel.offsetWidth < innerWidth;
  const left = fitsRight ? box.right + margin : box.left - panel.offsetWidth - margin;
  const top = Math.min(box.top, innerHeight - panel.offsetHeight - margin);
  panel.style.left = `${Math.max(margin, left)}px`;
  panel.style.top = `${Math.max(margin, top)}px`;
  $("edit-velocity").focus();
  $("edit-velocity").select();
}

function fillNoteEditor() {
  const found = editorNotes();
  const first = found[0];
  const velocity = clampInt(first.velocity * 127, 1, 127);
  const hits = $("editor-hits");
  hits.hidden = found.length < 2;
  hits.textContent = `Changes apply to all ${found.length} hits in this step.`;
  $("edit-velocity").value = velocity;
  $("edit-velocity-range").value = velocity;
  $("edit-length").value = first.length;
  $("edit-length").max = sequence().lengthPulses;
  $("edit-length-steps").textContent = `ticks, ${describeLength(first.length)}`;
  const maxOffset = maxEditorOffset(found);
  $("edit-offset").value = Math.min(...found.map((n) => n.time)) - state.editor.time;
  $("edit-offset").max = maxOffset;
  $("edit-offset-range").textContent = `ticks, 0-${maxOffset}`;
  $("edit-probability").value = first.probability ?? 100;
  for (const id of ["edit-velocity", "edit-length", "edit-offset", "edit-probability"]) {
    $(id).setAttribute("aria-invalid", "false");
  }
}

// Notes must stay inside their step, or they would leave the step being edited.
function maxEditorOffset(found) {
  const times = found.map((n) => n.time);
  return state.resolution - 1 - (Math.max(...times) - Math.min(...times));
}

function changeEditorNotes(change) {
  if (!state.editor.remembered) {
    remember();
    state.editor.remembered = true;
  }
  const found = editorNotes();
  change(found);
  trackNotes().sort((a, b) => a.time - b.time || a.note - b.note);
  const cell = cellElement(state.editor.note, state.editor.time);
  if (cell) paintCell(cell);
  markDirty();
}

// Applies a typed value if it's valid, and otherwise leaves the notes alone.
function editorNumber(id, low, high, apply) {
  const input = $(id);
  const value = Number(input.value);
  const valid = input.value !== "" && Number.isInteger(value) && value >= low && value <= high;
  input.setAttribute("aria-invalid", String(!valid));
  if (valid) apply(value);
}

function setEditorVelocity(value) {
  changeEditorNotes((found) => found.forEach((n) => { n.velocity = value / 127; }));
}

function setEditorOffset(value) {
  changeEditorNotes((found) => {
    const start = Math.min(...found.map((n) => n.time));
    const delta = state.editor.time + value - start;
    for (const n of found) {
      n.sourceTime ??= n.time;
      n.time += delta;
    }
  });
}

function bindNoteEditor() {
  $("edit-velocity").addEventListener("input", () => {
    editorNumber("edit-velocity", 1, 127, (value) => {
      $("edit-velocity-range").value = value;
      setEditorVelocity(value);
    });
  });
  $("edit-velocity-range").addEventListener("input", (event) => {
    const value = Number(event.target.value);
    $("edit-velocity").value = value;
    $("edit-velocity").setAttribute("aria-invalid", "false");
    setEditorVelocity(value);
  });
  $("edit-length").addEventListener("input", () => {
    editorNumber("edit-length", 1, sequence().lengthPulses, (value) => {
      changeEditorNotes((found) => found.forEach((n) => { n.length = value; }));
      $("edit-length-steps").textContent = `ticks, ${describeLength(value)}`;
    });
  });
  $("edit-offset").addEventListener("input", () => {
    editorNumber("edit-offset", 0, maxEditorOffset(editorNotes()), setEditorOffset);
  });
  $("edit-probability").addEventListener("input", () => {
    editorNumber("edit-probability", 0, 100, (value) => {
      changeEditorNotes((found) => found.forEach((n) => { n.probability = value; }));
    });
  });
  // Leaving a field with a bad value puts back the value actually in use.
  $("note-editor").addEventListener("focusout", (event) => {
    if (state.editor && event.target.getAttribute("aria-invalid") === "true") fillNoteEditor();
  });
  $("note-editor").addEventListener("keydown", (event) => {
    if (event.key === "Enter" && event.target.tagName === "INPUT") closeNoteEditor();
  });
  $("edit-hear").addEventListener("click", () => {
    audition(state.editor.note, editorNotes()[0].velocity);
  });
  $("edit-delete").addEventListener("click", () => {
    changeEditorNotes((found) => {
      sequence().notes[track().name] = trackNotes().filter((n) => !found.includes(n));
    });
    closeNoteEditor();
  });
  $("edit-done").addEventListener("click", () => closeNoteEditor());
  window.addEventListener("pointerdown", (event) => {
    if (!state.editor || $("note-editor").contains(event.target)) return;
    if (!event.target.closest("#grid")) closeNoteEditor({ restoreFocus: false });
  });
}

function closeNoteEditor({ restoreFocus = true } = {}) {
  if (!state.editor) return;
  const cell = cellElement(state.editor.note, state.editor.time);
  state.editor = null;
  $("note-editor").hidden = true;
  if (cell) {
    cell.classList.remove("editing");
    if (restoreFocus) cell.focus();
  }
}

function bindGridEvents() {
  const grid = $("grid");
  grid.addEventListener("contextmenu", (event) => {
    event.preventDefault();
    const cell = event.target.closest(".cell");
    if (cell) openNoteEditor(cell);
  });
  window.addEventListener("pointermove", (event) => {
    if (state.lengthDrag) moveLengthDrag(event);
  });
  grid.addEventListener("pointerdown", (event) => {
    const handle = event.target.closest(".note-handle");
    if (handle && event.button === 0 && !event.ctrlKey) {
      if (state.editor) closeNoteEditor({ restoreFocus: false });
      startLengthDrag(event, handle);
      return;
    }
    const cell = event.target.closest(".cell");
    // Control-click is a right-click on a Mac and opens the editor instead.
    if (!cell || event.button !== 0 || event.ctrlKey) return;
    event.preventDefault();
    // A click away from an open editor only closes it.
    if (state.editor) {
      closeNoteEditor({ restoreFocus: false });
      return;
    }
    if (event.shiftKey) {
      cycleVelocity(cell);
      return;
    }
    if (event.altKey) {
      applyRepeatToCell(cell);
      return;
    }
    remember();
    const on = !cell.classList.contains("on");
    // Dragging a note resizes it, so it's only removed by a click that doesn't move.
    if (!on && !event.metaKey) {
      const hits = notesInCell(Number(cell.dataset.note), Number(cell.dataset.time));
      state.lengthDrag = {
        note: hits.length === 1 ? hits[0] : null,
        anchorTime: Number(cell.dataset.time),
        cell,
        pressed: true,
        startX: event.clientX,
      };
      return;
    }
    setCell(cell, on);
    markDirty();
    if (on) audition(Number(cell.dataset.note));
    // Dragging draws one note at the dragged length. Cmd-drag fills separate steps,
    // and repeats always do, because their hits have a fixed spacing.
    const drawing = on && !event.metaKey && state.repeat === 1;
    if (drawing) {
      const [note] = notesInCell(Number(cell.dataset.note), Number(cell.dataset.time));
      state.lengthDrag = { note, anchorTime: Number(cell.dataset.time), cell, drawing: true };
    } else {
      state.paint = { on };
    }
  });
  grid.addEventListener("pointerover", (event) => {
    const cell = event.target.closest(".cell");
    if (cell && state.paint) {
      setCell(cell, state.paint.on);
      renderChrome();
    }
  });
  window.addEventListener("pointerup", () => {
    if (state.lengthDrag) endLengthDrag();
    if (state.paint) scheduleDraft();
    state.paint = null;
  });
  // Keyboard activation: pointer clicks are already handled on pointerdown.
  grid.addEventListener("click", (event) => {
    const cell = event.target.closest(".cell");
    if (!cell || event.detail !== 0) return;
    remember();
    setCell(cell, !cell.classList.contains("on"));
    markDirty();
  });
}

/* ---------- MIDI ---------- */

async function initMidi() {
  if (!navigator.requestMIDIAccess) {
    setMidiPill("MIDI needs Google Chrome", "warn");
    return;
  }
  try {
    state.midi = await navigator.requestMIDIAccess({ sysex: false });
  } catch (error) {
    setMidiPill("MIDI permission denied", "warn");
    return;
  }
  state.midi.onstatechange = refreshOutputs;
  refreshOutputs();
}

function setMidiPill(text, kind) {
  const pill = $("midi-state");
  pill.textContent = text;
  pill.className = `pill ${kind || ""}`;
}

function refreshOutputs() {
  if (!state.midi) return;
  const outputs = [...state.midi.outputs.values()];
  const previous = state.output && state.output.id;
  $("output").replaceChildren(...outputs.map((o) => new Option(o.name, o.id)));
  const chosen = outputs.find((o) => o.id === previous)
    || outputs.find((o) => /mpc/i.test(o.name))
    || null;
  state.output = chosen;
  if (chosen) $("output").value = chosen.id;
  if (chosen && /mpc/i.test(chosen.name)) {
    setMidiPill(`MIDI: ${chosen.name}`, "ok");
  } else if (chosen) {
    setMidiPill(`MIDI: ${chosen.name}`);
  } else {
    setMidiPill("MPC not found. Exit SD Card Access mode.", "warn");
    if (outputs[0]) $("output").value = "";
  }
  // Every input is heard, for recording from any keyboard or the MPC's own pads.
  for (const port of state.midi.inputs.values()) port.onmidimessage = (event) => recorder.message(event, port);
  recorder.refresh(state.midi);
}

/* ---------- Recording ---------- */

let recorder = null;
let click = null;

function pulseAt(time) {
  const length = sequence().lengthPulses;
  const behind = (state.nextTime - time) / msPerPulse();
  return ((state.nextPulse - behind) % length + length) % length;
}

function moveRecordCursor(time) {
  const page = Math.floor(time / (state.pageBars * pulsesPerBar()));
  if (page !== state.page) goToPage(page);
}

// A pad that isn't shown yet appears once it has notes, in the In use view.
function showRecorded(item) {
  if (!document.querySelector(`.cell[data-note="${item.note}"]`)) {
    renderBanks();
    renderGrid();
  } else {
    renderNotes();
  }
  markDirty();
}

function setUpRecorder() {
  click = Recorder.createClick({ storageKey: "mpc-grid-click", button: $("click") });
  recorder = Recorder.create({
    notes: trackNotes,
    makeNote: (fields) => fields,
    // Off keeps each note as long as it was held.
    fixedLength: (time) => (state.newLength === "off" ? null : newNoteLength(time)),
    resolution: () => state.resolution,
    length: () => sequence().lengthPulses,
    playing: () => state.playing && !state.sendOnce,
    pulseAt,
    startStep: () => 0,
    moveCursor: moveRecordCursor,
    begin: () => {
      closeNoteEditor({ restoreFocus: false });
      remember();
      renderChrome();
    },
    added: showRecorded,
    lengthened: () => {
      renderNoteBars();
      markDirty();
    },
    status: setStatus,
    thru: ([status, note, velocity]) => {
      if (state.output) state.output.send([status | state.channel, note, velocity]);
    },
    isInstrument: (port) => /mpc/i.test(port.name),
  }, { storageKey: "mpc-grid-record-input", button: $("record"), input: $("record-input"), channel: $("record-channel") });
}

function sendNote(note, velocity, atTime, lengthMs) {
  if (!state.output) return;
  const value = Math.max(1, Math.min(127, Math.round(velocity * 127)));
  recorder.sent(note, atTime);
  try {
    state.output.send([0x90 | state.channel, note, value], atTime);
    state.output.send([0x80 | state.channel, note, 0], atTime + lengthMs);
  } catch (error) {
    setStatus(`MIDI send failed: ${error.message}`, true);
    stop();
  }
}

function audition(note, velocity = 1.0) {
  if (!state.output) {
    setStatus("No MIDI output connected.", true);
    return;
  }
  sendNote(note, velocity, performance.now(), 120);
}

function sendController(number, value, atTime) {
  if (!state.output) return;
  const message = [0xB0 | state.channel, number, Math.max(0, Math.min(127, Math.round(value)))];
  if (atTime === undefined) state.output.send(message);
  else state.output.send(message, atTime);
}

/* ---------- Playback ---------- */

const ticker = new Worker(URL.createObjectURL(new Blob(
  ["setInterval(() => postMessage(0), 25);"], { type: "text/javascript" })));
ticker.onmessage = () => { if (state.playing) schedule(); };

const msPerPulse = () => 60000 / (currentBpm() * PPQ);

function currentBpm() {
  const value = Number($("bpm").value);
  return value >= 20 && value <= 300 ? value : 120;
}

function schedule() {
  const horizon = performance.now() + SCHEDULE_AHEAD_MS;
  const ms = msPerPulse();
  while (state.nextTime < horizon) {
    const seq = sequence();
    const from = state.nextPulse;
    const to = from + CHUNK_PULSES;
    if (sendingClock() && from % CLOCK_PULSES === 0 && state.output) {
      state.output.send([0xF8], state.nextTime);
    }
    if (from % PPQ === 0 && !state.sendOnce) click.at(state.nextTime, from % (4 * PPQ) === 0);
    for (const note of notesOf(seq)) {
      if (note.time >= from && note.time < to && !state.muted.has(note.note)
          && Math.random() * 100 < (note.probability ?? 100)) {
        sendNote(note.note, note.velocity,
          state.nextTime + (note.time - from) * ms, note.length * ms);
      }
    }
    state.nextTime += CHUNK_PULSES * ms;
    state.nextPulse = to >= seq.lengthPulses ? 0 : to;
    if (state.nextPulse === 0 && state.sendOnce) {
      finishSendOnce();
      return;
    }
    if (state.nextPulse === 0 && state.queuedKey !== null) {
      switchTo(state.queuedKey);
    }
  }
}

const sendingClock = () => $("clock").checked || state.sendOnce;

function renderPeers(names) {
  const pill = $("sync-peers");
  pill.hidden = !$("sync").checked;
  pill.textContent = names.length ? `Linked: ${names.join(", ")}` : "Not linked";
  pill.className = `pill ${names.length ? "ok" : ""}`;
  pill.title = names.length ? "Play, stop and tempo are shared with this page." : "The other grid isn't open in this browser, or has Sync off.";
}

// Plays together with the other grid when both are open. See sync.js.
const link = Sync.connect({
  name: "MPC Grid",
  checkbox: $("sync"),
  storageKey: "mpc-grid-sync",
  start({ bpm, at }) {
    if (state.sendOnce) return false;
    if (state.playing) stop({ fromLink: true });
    $("bpm").value = bpm;
    play({ startAt: at, fromLink: true });
    return state.playing;
  },
  stop: () => stop({ fromLink: true }),
  tempo({ bpm, at, pulse }) {
    $("bpm").value = bpm;
    if (!state.playing || !Number.isFinite(pulse)) return;
    state.nextTime = Sync.aligned({
      nextTime: state.nextTime, nextPulse: state.nextPulse, at, pulse, msPerPulse: msPerPulse(), pulsesPerBeat: PPQ,
    });
  },
  status: (message, isError) => setStatus(message, isError),
  peers: renderPeers,
});
renderPeers([]);

const announceTempo = () => link.announceTempo({
  bpm: currentBpm(), nextTime: state.nextTime, nextPulse: state.playing ? state.nextPulse : 0,
});

function play({ startAt = null, fromLink = false } = {}) {
  if (!state.output) {
    setStatus("No MIDI output connected. Exit SD Card Access mode on the MPC.", true);
    return;
  }
  state.playing = true;
  state.nextPulse = 0;
  const shared = fromLink || state.sendOnce ? null : link.announcePlay(currentBpm());
  state.nextTime = startAt ?? shared ?? performance.now() + 60;
  if (sendingClock()) state.output.send([0xFA], state.nextTime);
  $("play").textContent = "Stop";
  $("playhead").hidden = false;
  schedule();
  requestAnimationFrame(drawPlayhead);
}

// Plays the pattern exactly once with MIDI start, clock and stop. The MPC
// overdubs while recording, so a second pass could double every note.
function sendToMpc() {
  if (state.playing) stop();
  if (!trackNotes().length) {
    setStatus("This sequence has no notes to send.", true);
    return;
  }
  state.sendOnce = true;
  state.queuedKey = null;
  play();
  if (state.playing) setStatus("Sending one pass to the MPC...");
  else state.sendOnce = false;
}

function finishSendOnce() {
  state.output.send([0xFC], state.nextTime);
  state.sendOnce = false;
  state.playing = false;
  $("play").textContent = "Play";
  $("playhead").hidden = true;
  setStatus("Sent one pass. If the MPC was recording, press STOP on it and play it back.");
}

function stop({ fromLink = false } = {}) {
  state.queuedKey = null;
  if (!state.playing) return;
  if (!fromLink && !state.sendOnce) link.announceStop();
  if (sendingClock() && state.output) state.output.send([0xFC]);
  state.playing = false;
  state.sendOnce = false;
  $("play").textContent = "Play";
  $("playhead").hidden = true;
  renderSlots();
}

function drawPlayhead() {
  if (!state.playing) return;
  const length = sequence().lengthPulses;
  const behind = (state.nextTime - performance.now()) / msPerPulse();
  const pulse = ((state.nextPulse - behind) % length + length) % length;
  // Follow the music when the pattern is split across pages.
  const pageLength = state.pageBars * pulsesPerBar();
  const playingPage = Math.floor(pulse / pageLength);
  // Page turns redraw the grid, so they wait while a step is being edited.
  if (playingPage !== state.page && !state.editor) goToPage(playingPage);
  const firstCell = document.querySelector(".cell");
  const lastCell = document.querySelector(".grid > :last-child");
  if (firstCell && lastCell) {
    const origin = firstCell.offsetLeft;
    const width = lastCell.offsetLeft + lastCell.offsetWidth - origin;
    const head = $("playhead");
    head.style.left = `${origin + ((pulse - state.windowStart) / state.windowSpan) * width}px`;
    head.hidden = playingPage !== state.page;
    head.style.height = `${$("grid").offsetHeight}px`;
  }
  requestAnimationFrame(drawPlayhead);
}

/* ---------- Controls ---------- */

function openHelp() {
  closeNoteEditor({ restoreFocus: false });
  $("help").showModal();
  document.querySelector(".help-body").scrollTop = 0;
}

function bindControls() {
  $("project").addEventListener("change", (event) => openProject(event.target.value));
  $("bars").addEventListener("change", (event) => setBars(Number(event.target.value)));
  $("steps").addEventListener("click", (event) => {
    const button = event.target.closest("button");
    if (button) setSteps(Number(button.dataset.value), state.triplets);
  });
  $("triplets").addEventListener("click", () => {
    setSteps(state.baseResolution, !state.triplets);
  });
  $("repeat").addEventListener("click", (event) => {
    const button = event.target.closest("button");
    if (!button) return;
    state.repeat = Number(button.dataset.value);
    renderStepControls();
  });
  $("new-length").addEventListener("change", (event) => {
    state.newLength = event.target.value;
  });
  $("live-volume").addEventListener("input", (event) => {
    sendController(CC_VOLUME, Number(event.target.value));
  });
  $("live-pan").addEventListener("input", (event) => {
    sendController(CC_PAN, Number(event.target.value));
  });
  $("live-pan").addEventListener("dblclick", () => {
    $("live-pan").value = PAN_CENTRE;
    sendController(CC_PAN, PAN_CENTRE);
  });
  $("page-prev").addEventListener("click", () => goToPage(state.page - 1));
  $("page-next").addEventListener("click", () => goToPage(state.page + 1));
  let resizeTimer = null;
  window.addEventListener("resize", () => {
    window.clearTimeout(resizeTimer);
    resizeTimer = window.setTimeout(renderGrid, 100);
  });
  $("output").addEventListener("change", (event) => {
    state.output = state.midi.outputs.get(event.target.value) || null;
    if (state.output) {
      setMidiPill(`MIDI: ${state.output.name}`, /mpc/i.test(state.output.name) ? "ok" : "");
    }
  });
  $("channel").addEventListener("change", (event) => {
    state.channel = Number(event.target.value) - 1;
  });
  $("play").addEventListener("click", () => (state.playing ? stop() : play()));
  $("bpm").addEventListener("change", announceTempo);
  $("send").addEventListener("click", sendToMpc);
  $("undo").addEventListener("click", undo);
  setUpRecorder();
  $("duplicate").addEventListener("click", duplicateSequence);
  $("clear").addEventListener("click", () => {
    if (!trackNotes().length) return;
    remember();
    sequence().notes[track().name] = [];
    renderGrid();
    markDirty();
  });
  $("help-open").addEventListener("click", openHelp);
  $("help-close").addEventListener("click", () => $("help").close());
  // A click on the backdrop lands on the dialog itself, not its contents.
  $("help").addEventListener("click", (event) => {
    if (event.target === $("help")) $("help").close();
  });
  $("card").addEventListener("click", connectCard);
  $("save").addEventListener("click", saveCopy);
  $("to-card").addEventListener("click", copyToCard);
  $("discard").addEventListener("click", discardChanges);

  const typing = (target) => /^(INPUT|SELECT|TEXTAREA)$/.test(target.tagName);
  window.addEventListener("keydown", (event) => {
    if ($("help").open) return;
    if (event.key === "?" && !typing(event.target)) {
      openHelp();
      return;
    }
    if (event.key === "Escape" && state.editor) {
      closeNoteEditor();
      return;
    }
    // Space is the transport wherever you've last clicked, unless you're writing text.
    const writing = event.target.tagName === "TEXTAREA" || /^(text|search)$/.test(event.target.type);
    if (event.code === "Space" && !writing && !event.metaKey && !event.ctrlKey && !event.altKey
      && !event.target.closest?.("#note-editor") && !document.querySelector("dialog[open]")) {
      event.preventDefault();
      if (!event.repeat) {
        if (state.playing) stop(); else play();
      }
      return;
    }
    if (typing(event.target) || event.target.closest?.("#note-editor")) return;
    if ((event.metaKey || event.ctrlKey) && event.key === "z") {
      event.preventDefault();
      undo();
    } else if (/^[1-8]$/.test(event.key) && !event.metaKey && !event.ctrlKey) {
      setBank(Number(event.key) - 1);
    } else if (event.key === "t" && !event.metaKey && !event.ctrlKey) {
      setSteps(state.baseResolution, !state.triplets);
    }
  });
  window.setInterval(() => {
    refreshProjects().catch(() => setStatus("Could not check for projects.", true));
  }, 5000);
}

function missingBrowserFeatures() {
  const needs = {
    "project files": typeof JSON.rawJSON === "function" && "DecompressionStream" in window,
    "card access": "showDirectoryPicker" in window,
    "browser storage": Boolean(navigator.storage && navigator.storage.getDirectory),
  };
  return Object.keys(needs).filter((name) => !needs[name]);
}

async function start() {
  bindControls();
  bindGridEvents();
  bindNoteEditor();
  const missing = missingBrowserFeatures();
  if (missing.length) {
    $("card").disabled = true;
    $("card-state").textContent = "Needs Chrome or Edge";
    $("card-state").className = "pill warn";
    state.view = blankView();
    backend = localOnlyBackend();
    renderAll();
    setStatus(`This browser can't use ${missing.join(", ")}. Please use a current Chrome or Edge.`, true);
    await initMidi();
    return;
  }
  backend = await Backend.createBrowserBackend();
  if (navigator.storage.persist) navigator.storage.persist().catch(() => {});
  await loadView(blankView());
  setStatus(hasChanges()
    ? "No project open: restored your unsaved patterns."
    : NO_PROJECT_MESSAGE);
  await refreshProjects();
  const last = lastProject();
  if (last && [...$("project").options].some((o) => o.value === last)) {
    await openProject(last);
  }
  await initMidi();
}

start().catch((error) => setStatus(error.message, true));
