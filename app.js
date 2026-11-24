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
  lanes: [], // Pads with a knob lane open under the grid: { note, parameter }.
  padFilters: {}, // Pads' own filter modes changed here and not saved yet: { track: { pad: type } }.
  laneDraw: null,
  dirty: new Set(),
  undo: [],
  redo: [],
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

function renderLibraryState(info) {
  const views = {
    browser: ["Choose library folder", "Library: in this browser", "warn",
      "Projects are kept privately in this browser. Choose a folder to keep them as files on this computer."],
    permission: ["Allow library access", `Library: ${info.name} needs permission`, "warn",
      "The browser needs your permission again to use the library folder."],
    ready: ["Change library folder", `Library: ${info.name}`, "ok", "Projects are kept as files in this folder."],
  };
  const [button, text, kind, title] = views[info.status];
  $("library").textContent = button;
  $("library").dataset.status = info.status;
  $("library-state").textContent = text;
  $("library-state").className = `pill ${kind}`;
  $("library-state").title = title;
  state.libraryName = info.status === "ready" ? info.name : "";
}

// Where saved projects go, for messages.
const libraryPlace = () => (state.libraryName ? `your library (${state.libraryName})` : "this browser");

async function chooseLibrary() {
  try {
    if ($("library").dataset.status === "permission") {
      await backend.requestLibraryPermission();
      await refreshProjects();
      if (isBlank() && lastProject() && [...$("project").options].some((o) => o.value === lastProject())) {
        await openProject(lastProject());
      }
      return;
    }
    const folder = await window.showDirectoryPicker({ id: "mpc-library", mode: "readwrite", startIn: "documents" });
    setStatus("Setting up the library folder...");
    const { copied, skipped } = await backend.setLibraryFolder(folder);
    await refreshProjects();
    const parts = [`Your library is now the ${folder.name} folder.`];
    if (copied.length) parts.push(`Copied ${copied.length} project(s) into it.`);
    if (skipped.length) parts.push(`Left out ${skipped.join(", ")}, as the folder already has a project with that name.`);
    setStatus(parts.join(" "));
  } catch (error) {
    if (error.name !== "AbortError") setStatus(`Couldn't use that folder: ${error.message}`, true);
  }
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
  if (listing.libraryFolder) renderLibraryState(listing.libraryFolder);
  state.cardMounted = listing.cardMounted;
  // The card disappears in MIDI mode, so what was last seen there is kept.
  if (listing.cardMounted) state.onCard = listing.card.some((e) => e.name === state.projectName);
  renderCardState(listing);
  await syncFromCard(listing.card);
  const select = $("project");
  updateFileButtons();
  // Only rebuild when the list changes, so an open menu isn't disturbed.
  const signature = JSON.stringify([listing.library, listing.card, state.path, state.libraryName]);
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
  addGroup(state.libraryName ? `In ${state.libraryName}` : "In this browser", listing.library);
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
    state.onCard = path.startsWith("card:");
    state.path = opened.path;
    state.projectName = opened.name;
    await loadView(opened.view);
    rememberProject();
    await refreshProjects();
    const restored = state.dirty.size ? " Restored your unsaved patterns." : "";
    setStatus(`Opened ${opened.name}. Nothing changes on the card until you save.${restored}`);
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
  state.redo = [];
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
  // Pad filter modes changed here and not saved yet.
  state.padFilters = draft?.padFilters && typeof draft.padFilters === "object" ? draft.padFilters : {};
  for (const item of state.view.tracks || []) {
    for (const pad of item.pads) {
      const type = state.padFilters[item.name]?.[pad.pad];
      if (Number.isInteger(type)) pad.filterType = type;
    }
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

// Names the sequence you're on. Song Grid shows the name, and Save keeps it in the project.
function renameSequence(value) {
  const seq = sequence();
  const name = String(value || "").trim().slice(0, 32);
  if (!seq || !name || name === seq.name) {
    renderSequenceName();
    return;
  }
  seq.name = name;
  markDirty();
  renderSlots();
  setStatus(`Named sequence ${seq.key + 1} "${name}". Save keeps the name in the project.`);
}

// The name of the pattern on the grid, shown just above it. Clicking it renames it.
function renderGridTitle(word, number, name) {
  const title = $("grid-title");
  if (!title) return;
  const label = document.createElement("span");
  label.className = "number";
  label.textContent = number === "" ? `${word}: ` : `${word} ${number}: `;
  const shown = document.createElement("span");
  shown.className = "name";
  shown.textContent = name || "Untitled";
  title.replaceChildren(label, shown);
  title.classList.toggle("untitled", !name);
  title.title = name ? `Click to rename ${word.toLowerCase()} ${number}` : `Click to name ${word.toLowerCase()} ${number}`;
}

function renderSequenceName() {
  const seq = sequence();
  if (seq) renderGridTitle("Sequence", seq.key + 1, seq.name && seq.name !== `Sequence ${String(seq.key + 1).padStart(2, "0")}` ? seq.name : "");
  const field = $("sequence-name");
  if (!field || document.activeElement === field) return;
  field.value = seq?.name || "";
  field.placeholder = seq ? `Sequence ${seq.key + 1}` : "";
}

function editsFor(keys) {
  return keys.map((key) => {
    const seq = sequenceByKey(key);
    const edit = {
      sequence: key,
      track: track().name,
      notes: notesOf(seq),
      lengthPulses: seq.lengthPulses,
    };
    if (seq.isNew) edit.create = true;
    if (seq.name) edit.name = seq.name;
    if (Array.isArray(seq.automation?.[track().name])) edit.automation = seq.automation[track().name];
    const pads = state.padFilters[track().name];
    if (pads && Object.keys(pads).length) edit.padFilters = Object.entries(pads).map(([pad, type]) => ({ pad: Number(pad), type }));
    return edit;
  });
}

// After a save, the open patterns match the saved file.
function markSaved(saved, keys) {
  state.padFilters = {};
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
  state.redo = [];
  $("save-name").value = nextSaveName(saved.name);
}

async function saveCopy() {
  const keys = savableKeys();
  try {
    await flushDraft();
    const saved = await backend.save({
      path: state.path, name: $("save-name").value, edits: editsFor(keys),
    });
    markSaved(saved, keys);
    state.onCard = false; // A new project isn't on the card until it's copied there.
    await refreshProjects();
    renderAll();
    setStatus(`Saved ${keys.length} sequence(s) to ${saved.name} in ${libraryPlace()}. Use Copy to card to keep it on the MPC.`);
  } catch (error) {
    setStatus(error.message, true);
  }
}

// Writes the changes straight into the project on the card, under its own name.
async function saveToCard({ ask = true } = {}) {
  const keys = savableKeys();
  if (ask && !window.confirm(`Save your changes into ${state.projectName} on the card? This replaces the project file on the card. The previous version is kept as a backup in ${libraryPlace()}.`)) return;
  try {
    stop();
    await flushDraft();
    setStatus("Saving to the card...");
    const saved = await backend.saveToCard({ path: state.path, edits: editsFor(keys) });
    markSaved(saved, keys);
    await refreshProjects();
    renderAll();
    setStatus(`Saved ${keys.length} sequence(s) into ${saved.name} on the card. Eject the card before leaving SD Card Access mode, then load the project on the MPC.`);
  } catch (error) {
    setStatus(error.message, true);
  }
}

// Writes the project as it is here, unsaved changes included, to the card under its own
// name, replacing a project of that name there after backing it up.
async function copyToCard() {
  try {
    stop();
    await flushDraft();
    const keys = savableKeys();
    if (keys.length && state.view.canSave !== false) {
      const saved = await backend.saveInPlace({ path: state.path, edits: editsFor(keys) });
      markSaved(saved, keys);
    }
    setStatus("Copying to the card...");
    const copied = await backend.copyToCard({ path: state.path });
    state.onCard = true;
    await refreshProjects();
    renderAll();
    const how = copied.replaced ? `Replaced ${copied.name} on the card with the version here. The card's previous version is kept as a backup in ${libraryPlace()}.` : `Copied ${copied.name} to the card.`;
    setStatus(`${how} Eject the card before leaving SD Card Access mode.`);
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
    padFilters: state.padFilters,
    dirty: [...state.dirty],
    currentKey: state.currentKey,
  } : null;
  return backend.writeDraft({ name: draftName(), draft });
}

function updateFileButtons() {
  const hasProject = !isBlank();
  const changed = savableKeys().length > 0;
  const canSave = hasProject && changed && state.view.canSave !== false;
  $("project-save").disabled = !canSave;
  $("project-save-as").disabled = !canSave;
  $("to-card").disabled = !hasProject || !state.cardMounted;
  $("to-card").title = !state.cardMounted ? "Enter SD Card Access mode on the MPC and connect the card first"
    : "Write this project as it is here, unsaved changes included, to the card under its own name, replacing one of that name there";
  $("discard").disabled = !hasChanges();
  const label = $("pattern-name");
  label.textContent = hasProject ? state.projectName : "No project";
  label.classList.toggle("untitled", !hasProject);
  label.title = !hasProject ? "Choose a project in the Project menu to save patterns into it."
    : state.onCard && state.cardMounted ? `Save puts your changes into ${state.projectName} on the card.`
      : state.onCard ? `Save keeps your changes in your library. With the card connected, Save puts them on the card too.`
        : `Save puts your changes into ${state.projectName} in your library.`;
}

// Save puts changes into the same project: on the card when it's there and connected,
// otherwise in the library, keeping a backup either way.
async function saveProject() {
  if (isBlank()) {
    setStatus("Choose a project in the Project menu first. Patterns are saved into a project.", true);
    return;
  }
  if (!savableKeys().length) {
    setStatus("There are no changes to save.");
    return;
  }
  if (state.onCard && state.cardMounted) {
    await saveToCard({ ask: false });
    return;
  }
  const keys = savableKeys();
  try {
    stop();
    await flushDraft();
    const saved = await backend.saveInPlace({ path: state.path, edits: editsFor(keys) });
    markSaved(saved, keys);
    await refreshProjects();
    renderAll();
    const later = state.onCard ? " Save again with the card connected to put it on the card." : "";
    setStatus(`Saved ${keys.length} sequence(s) into ${saved.name} in ${libraryPlace()}. The previous version is kept as a backup.${later}`);
  } catch (error) {
    setStatus(error.message, true);
  }
}

// Save as makes a new project in the library, with a name you choose.
async function saveProjectAs() {
  if (isBlank()) {
    setStatus("Choose a project in the Project menu first. Patterns are saved into a project.", true);
    return;
  }
  const name = window.prompt("Save as a new project called", nextSaveName(state.projectName));
  if (name === null || !name.trim()) return;
  $("save-name").value = name.trim();
  await saveCopy();
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
    if (seq?.name) button.title = seq.name;
    const used = seq && notesOf(seq).length > 0;
    button.classList.toggle("has-pattern", Boolean(used));
    button.classList.toggle("queued", key === state.queuedKey);
    button.classList.toggle("changed", state.dirty.has(key) && Boolean(used));
    button.setAttribute("aria-current", String(key === state.currentKey));
    button.setAttribute("aria-label",
      `Sequence ${key + 1}${used ? `, ${notesOf(seq).length} notes` : ", empty"}`);
    button.addEventListener("click", () => selectSlot(key));
    // Drag a pattern onto an empty slot to move it there.
    button.draggable = Boolean(used);
    button.addEventListener("dragstart", (event) => {
      event.dataTransfer.setData("application/x-mpc-sequence", String(key));
      event.dataTransfer.effectAllowed = "move";
    });
    button.addEventListener("dragover", (event) => {
      if (!event.dataTransfer.types.includes("application/x-mpc-sequence")) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = isEmptySlot(key) ? "move" : "none";
      button.classList.toggle("drop-target", isEmptySlot(key));
    });
    button.addEventListener("dragleave", () => button.classList.remove("drop-target"));
    button.addEventListener("drop", (event) => {
      event.preventDefault();
      button.classList.remove("drop-target");
      const from = Number(event.dataTransfer.getData("application/x-mpc-sequence"));
      if (!Number.isInteger(from) || from === key) return;
      if (!isEmptySlot(key)) {
        setStatus(`Sequence ${key + 1} already has a pattern. Drop onto an empty slot, or clear it first.`, true);
        return;
      }
      moveSequence(from, key);
    });
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
    holdNoteOn(hear, pad.note);
    const mute = document.createElement("button");
    mute.type = "button";
    mute.className = "mute";
    mute.textContent = "M";
    mute.title = muted ? "Muted. Click to play this pad again." : "Mute this pad while playing";
    mute.setAttribute("aria-label", `Mute pad ${padId(pad.pad)}`);
    mute.setAttribute("aria-pressed", String(muted));
    mute.addEventListener("click", () => toggleMute(pad));
    const open = state.lanes.some((lane) => lane.note === pad.note);
    const moved = (sequence()?.automation?.[track().name] || []).some((point) => point.note === pad.note);
    const laneButton = document.createElement("button");
    laneButton.type = "button";
    laneButton.className = "lane-button";
    laneButton.classList.toggle("moved", moved);
    laneButton.textContent = "~";
    laneButton.title = `${open ? "Close" : "Open"} ${padId(pad.pad)}'s knob lane under the grid${moved ? ". It has movements." : ""}`;
    laneButton.setAttribute("aria-label", `Knob lane for pad ${padId(pad.pad)}`);
    laneButton.setAttribute("aria-pressed", String(open));
    laneButton.addEventListener("click", () => toggleLane(pad.note));
    label.append(hear, mute, laneButton);
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
  renderLane();
}

/* ---------- Drawing filter movements ---------- */

// The MPC records a knob about every 100 ticks. Drawn points are a 1/16 of a beat apart.
const LANE_TICKS = 60;
const MODES = Xpj.FILTER_MODES;
const modeIndex = (value) => {
  const found = MODES.findIndex((mode) => Math.abs(mode.type / Xpj.MODE_SCALE - value) < 0.001);
  return found < 0 ? 0 : found;
};
const lanePoints = () => sequence()?.automation?.[track().name] || [];
// Velocity isn't a knob: its lane sets the hits' own velocities.
const VELOCITY_LANE = 0;
const PARAM_NAMES = { 0: "Velocity", 514: "Cutoff", 515: "Resonance", 1082: "Filter mode", 1043: "Pitch", 1044: "Fine pitch" };
// The lane menu's order: the filter, then pitch.
const LANE_ORDER = [VELOCITY_LANE, 514, 515, 1082, 1043, 1044];
// Pitch lanes draw up or down from the centre, in whole semitones or cents.
const PITCH_UNITS = { 1043: { steps: 72, range: 36, unit: "semitone" }, 1044: { steps: 198, range: 99, unit: "cent" } };
const pitchUnits = (parameter, value) => Math.round((value - 0.5) * PITCH_UNITS[parameter].steps);
function describeValue(parameter, value) {
  if (parameter === Xpj.FILTER.mode) return MODES[modeIndex(value)].name;
  const pitch = PITCH_UNITS[parameter];
  if (pitch) {
    const units = pitchUnits(parameter, value);
    return `${units > 0 ? "+" : ""}${units} ${pitch.unit}${Math.abs(units) === 1 ? "" : "s"}`;
  }
  return String(Math.round(value * 127));
}

function editablePoints() {
  const seq = sequence();
  seq.automation ??= {};
  seq.automation[track().name] ??= [];
  return seq.automation[track().name];
}

// Sets a pad's own filter mode. Save keeps it in the project.
function setPadFilter(pad, type) {
  if (!MODES.some((item) => item.type === type)) return;
  pad.filterType = type;
  state.padFilters[track().name] ??= {};
  state.padFilters[track().name][pad.pad] = type;
  markDirty();
  setStatus(`Pad ${padId(pad.pad)} plays with the ${MODES.find((item) => item.type === type).name} filter. Save or Copy to card keeps it in the project.`);
}

// Opens or closes a pad's knob lane, on the knob it was last on, or cutoff.
function toggleLane(note) {
  if (state.lanes.some((lane) => lane.note === note)) state.lanes = state.lanes.filter((lane) => lane.note !== note);
  else state.lanes.push({ note, parameter: state.lastLaneParameter ?? Xpj.FILTER.cutoff });
  renderGrid();
}

const padForNote = (note) => track().pads.find((pad) => pad.note === note) || { pad: note - 36, note, sample: "" };

function renderLane() {
  const section = $("lane");
  const rows = $("lane-rows");
  section.hidden = !state.lanes.length;
  if (!state.lanes.length) {
    rows.replaceChildren();
    return;
  }
  const first = document.querySelector(".cell");
  const last = document.querySelector(".grid > :last-child");
  if (!first || !last) return;
  const left = first.getBoundingClientRect().left;
  const width = last.getBoundingClientRect().right - left;
  const sideWidth = Math.max(80, left - rows.getBoundingClientRect().left);
  rows.replaceChildren(...state.lanes.map((lane) => {
    const pad = padForNote(lane.note);
    const row = document.createElement("div");
    row.className = "lane-row";
    const side = document.createElement("div");
    side.className = "lane-side";
    side.style.width = `${sideWidth}px`;
    const name = Object.assign(document.createElement("span"), { className: "lane-name", textContent: `${padId(pad.pad)} ${pad.sample || `Note ${pad.note}`}` });
    name.title = name.textContent;
    const select = document.createElement("select");
    select.setAttribute("aria-label", `Knob shown for pad ${padId(pad.pad)}`);
    for (const param of LANE_ORDER) {
      const label = PARAM_NAMES[param];
      const moved = param !== VELOCITY_LANE && lanePoints().some((p) => p.note === lane.note && p.parameter === Number(param));
      select.append(new Option(`${moved ? "* " : ""}${label}`, param));
    }
    select.value = String(lane.parameter);
    select.addEventListener("change", () => {
      lane.parameter = Number(select.value);
      state.lastLaneParameter = lane.parameter;
      renderLane();
    });
    // The pad's own filter mode, which it plays with unless the lane's movements change it.
    const padMode = document.createElement("select");
    padMode.setAttribute("aria-label", `Filter mode for pad ${padId(pad.pad)}`);
    padMode.title = "The pad's own filter mode, as the MPC's mode knob sets it. Drawn Filter mode movements change it during the sequence.";
    if (!Number.isInteger(pad.filterType)) padMode.append(new Option("Filter Mode: unknown", ""));
    padMode.append(...MODES.map((item) => new Option(`Filter Mode: ${item.name}`, String(item.type))));
    padMode.value = Number.isInteger(pad.filterType) ? String(pad.filterType) : "";
    padMode.disabled = isBlank();
    padMode.addEventListener("change", () => setPadFilter(pad, Number(padMode.value)));
    const actions = Object.assign(document.createElement("div"), { className: "lane-actions" });
    const clear = Object.assign(document.createElement("button"), { type: "button", textContent: "Clear" });
    clear.title = `Remove ${padId(pad.pad)}'s ${PARAM_NAMES[lane.parameter].toLowerCase()} movements`;
    clear.addEventListener("click", () => clearLane(lane));
    clear.disabled = lane.parameter === VELOCITY_LANE;
    const close = Object.assign(document.createElement("button"), { type: "button", textContent: "×" });
    close.title = "Close this lane";
    close.setAttribute("aria-label", `Close pad ${padId(pad.pad)}'s lane`);
    close.addEventListener("click", () => toggleLane(lane.note));
    actions.append(clear, close);
    side.append(name, padMode, select, actions);
    const canvas = document.createElement("canvas");
    canvas.className = "lane-canvas";
    canvas.dataset.note = String(lane.note);
    canvas.dataset.parameter = String(lane.parameter);
    canvas.style.width = `${width}px`;
    canvas.setAttribute("aria-label", `${PARAM_NAMES[lane.parameter]} for pad ${padId(pad.pad)}`);
    row.append(side, canvas);
    return row;
  }));
  for (const canvas of rows.querySelectorAll("canvas")) paintLane(canvas, width);
}

function paintLane(canvas, width) {
  const note = Number(canvas.dataset.note);
  const parameter = Number(canvas.dataset.parameter);
  const scale = window.devicePixelRatio || 1;
  const height = canvas.clientHeight || 56;
  canvas.width = Math.round(width * scale);
  canvas.height = Math.round(height * scale);
  const ctx = canvas.getContext("2d");
  ctx.scale(scale, scale);
  const style = getComputedStyle(document.documentElement);
  ctx.fillStyle = style.getPropertyValue("--cell") || "#333";
  ctx.fillRect(0, 0, width, height);
  const span = state.windowSpan || 1;
  const xAt = (time) => ((time - state.windowStart) / span) * width;
  ctx.fillStyle = style.getPropertyValue("--line") || "#555";
  for (let time = state.windowStart; time < state.windowStart + span; time += state.resolution) ctx.fillRect(xAt(time), 0, 1, height);
  if (parameter === VELOCITY_LANE) {
    // A bar for each hit, as tall as its velocity.
    const accent = style.getPropertyValue("--accent") || "#f80";
    const barWidth = Math.max(3, Math.min(10, (state.resolution / span) * width * 0.5));
    ctx.fillStyle = accent;
    for (const hit of trackNotes()) {
      if (hit.note !== note || hit.time < state.windowStart || hit.time >= state.windowStart + span) continue;
      const bar = Math.max(2, hit.velocity * height);
      ctx.fillRect(xAt(hit.time), height - bar, barWidth, bar);
    }
    return;
  }
  // A knob holds its value until the next point, as the MPC plays it.
  const points = lanePoints().filter((p) => p.note === note && p.parameter === parameter).sort((a, b) => a.time - b.time);
  const mode = parameter === Xpj.FILTER.mode;
  const pitch = Boolean(PITCH_UNITS[parameter]);
  const level = (value) => (mode ? (modeIndex(value) + 1) / MODES.length : value);
  const accent = style.getPropertyValue("--accent") || "#f80";
  const text = style.getPropertyValue("--text") || "#fff";
  if (pitch) {
    ctx.fillStyle = style.getPropertyValue("--strong") || "#aaa";
    ctx.fillRect(0, Math.round(height / 2), width, 1);
  }
  ctx.font = "10px sans-serif";
  const end = sequence().lengthPulses;
  points.forEach((point, index) => {
    const until = points[index + 1]?.time ?? end;
    if (until <= state.windowStart || point.time >= state.windowStart + span) return;
    const x0 = Math.max(0, xAt(point.time));
    const x1 = Math.min(width, xAt(until));
    // Pitch fills from the centre line, the rest from the bottom.
    const top = pitch ? Math.min(height / 2, height - point.value * height) : height - level(point.value) * height;
    const bar = pitch ? Math.max(1, Math.abs(point.value - 0.5) * height) : level(point.value) * height;
    ctx.fillStyle = accent;
    ctx.globalAlpha = 0.35;
    ctx.fillRect(x0, top, x1 - x0, bar);
    ctx.globalAlpha = 1;
    ctx.fillRect(x0, top, Math.max(1, xAt(point.time + LANE_TICKS) - xAt(point.time)), bar);
    if (mode && (index === 0 || modeIndex(points[index - 1].value) !== modeIndex(point.value))) {
      ctx.fillStyle = text;
      ctx.fillText(MODES[modeIndex(point.value)].name, x0 + 3, 11);
    }
  });
}

// Sets or erases a pad's knob at one point, replacing any point within its 1/16 beat.
function setLanePoint(note, parameter, time, value, erase) {
  const points = editablePoints();
  const kept = points.filter((p) => !(p.note === note && p.parameter === parameter && p.time >= time && p.time < time + LANE_TICKS));
  if (!erase) kept.push({ time, note, parameter, value });
  kept.sort((a, b) => a.time - b.time);
  sequence().automation[track().name] = kept;
}

// Sets the velocity of the pad's hits the drag passes over, to the height of the pointer.
function velocityStroke(event) {
  const drag = state.laneDraw;
  const box = drag.canvas.getBoundingClientRect();
  const x = Math.max(0, Math.min(box.width, event.clientX - box.left));
  const y = Math.max(0, Math.min(box.height, event.clientY - box.top));
  const time = state.windowStart + (x / box.width) * state.windowSpan;
  const velocity = Math.max(1, Math.round((1 - y / box.height) * 127));
  // Covers everything between this point and the last, so a fast drag misses nothing,
  // and a click catches the hit nearest it within half a step.
  const from = drag.lastTime ?? time;
  const low = Math.min(from, time) - (drag.lastTime === undefined ? state.resolution / 2 : 0);
  const high = Math.max(from, time) + (drag.lastTime === undefined ? state.resolution / 2 : 0);
  let changed = 0;
  for (const hit of trackNotes()) {
    if (hit.note === drag.note && hit.time >= low && hit.time <= high) {
      hit.velocity = velocity / 127;
      changed += 1;
    }
  }
  drag.lastTime = time;
  paintLane(drag.canvas, box.width);
  setStatus(`Velocity ${velocity}${changed ? "" : ". Drag across the pad's hits to set them."}`);
}

function laneStroke(event) {
  const drag = state.laneDraw;
  if (drag.parameter === VELOCITY_LANE) {
    velocityStroke(event);
    return;
  }
  const box = drag.canvas.getBoundingClientRect();
  const x = Math.max(0, Math.min(box.width - 1, event.clientX - box.left));
  const y = Math.max(0, Math.min(box.height, event.clientY - box.top));
  const end = Math.min(state.windowStart + state.windowSpan, sequence().lengthPulses);
  const raw = state.windowStart + (x / box.width) * state.windowSpan;
  const time = Math.min(end - LANE_TICKS, Math.floor(raw / LANE_TICKS) * LANE_TICKS);
  const share = 1 - y / box.height;
  const mode = drag.parameter === Xpj.FILTER.mode;
  const pitch = PITCH_UNITS[drag.parameter];
  // Pitch snaps to whole semitones or cents, the way the MPC stores it.
  const snap = (raw) => {
    if (!pitch) return Math.round(Math.max(0, Math.min(1, raw)) * 127) / 127;
    const units = Math.max(-pitch.range, Math.min(pitch.range, Math.round((raw - 0.5) * pitch.steps)));
    return 0.5 + units / pitch.steps;
  };
  const value = mode
    ? MODES[Math.max(0, Math.min(MODES.length - 1, Math.floor(share * MODES.length)))].type / Xpj.MODE_SCALE
    : snap(share);
  // Fills the gap since the last point, as a fast drag skips over some.
  const from = drag.last ? drag.last.time : time;
  const startValue = drag.last ? drag.last.value : value;
  const step = time >= from ? LANE_TICKS : -LANE_TICKS;
  const count = Math.abs(time - from) / LANE_TICKS;
  for (let index = 0; index <= count; index += 1) {
    const between = count ? index / count : 1;
    const v = mode ? value : snap(startValue + (value - startValue) * between);
    setLanePoint(drag.note, drag.parameter, from + index * step, v, drag.erase);
  }
  drag.last = { time, value };
  paintLane(drag.canvas, box.width);
  const name = PARAM_NAMES[drag.parameter];
  setStatus(drag.erase ? `Erasing ${name.toLowerCase()}.` : `${name}: ${describeValue(drag.parameter, value)}.`);
}

function clearLane(lane) {
  const before = lanePoints().length;
  const kept = lanePoints().filter((p) => !(p.note === lane.note && p.parameter === lane.parameter));
  if (kept.length === before) return;
  remember();
  editablePoints();
  sequence().automation[track().name] = kept;
  markDirty();
  renderGrid();
  setStatus(`Cleared ${padId(padForNote(lane.note).pad)}'s ${PARAM_NAMES[lane.parameter].toLowerCase()}. Undo brings it back.`);
}

function bindLane() {
  const rows = $("lane-rows");
  rows.addEventListener("pointerdown", (event) => {
    const canvas = event.target.closest("canvas");
    if (!canvas || event.button !== 0) return;
    remember();
    state.laneDraw = { canvas, note: Number(canvas.dataset.note), parameter: Number(canvas.dataset.parameter), erase: event.altKey, last: null };
    canvas.setPointerCapture(event.pointerId);
    laneStroke(event);
    event.preventDefault();
  });
  rows.addEventListener("pointermove", (event) => {
    if (state.laneDraw) laneStroke(event);
  });
  const finish = () => {
    if (!state.laneDraw) return;
    state.laneDraw = null;
    markDirty();
    renderGrid();
  };
  rows.addEventListener("pointerup", finish);
  rows.addEventListener("pointercancel", finish);
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
  const PATTERN_END = sequence().lengthPulses;
  for (const note of trackNotes()) {
    const noteEnd = note.time + note.length;
    // The part of a note that crosses the pattern's end, drawn at its start.
    const overflow = noteEnd - PATTERN_END;
    if (overflow > 0 && overflow > start && 0 < end) {
      const tailStart = Math.max(0, start);
      const tailCell = cellElement(note.note, Math.floor(tailStart / state.resolution) * state.resolution);
      if (tailCell) {
        const tailSteps = (Math.min(overflow, end) - tailStart) / state.resolution;
        const tailBar = document.createElement("span");
        tailBar.className = "note-bar wrapped";
        tailBar.title = "The end of a note that starts near the end of the pattern";
        tailBar.style.setProperty("--steps", String(tailSteps));
        tailBar.style.setProperty("--gaps", String(Math.max(0, Math.ceil(tailSteps) - 1)));
        tailBar.style.left = `${((tailStart - Math.floor(tailStart / state.resolution) * state.resolution) / state.resolution) * 100}%`;
        tailBar.style.setProperty("--velocity", String(0.3 + 0.7 * note.velocity));
        tailCell.append(tailBar);
      }
    }
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
    // Its start, when the note begins on this page.
    if (note.time === barStart) {
      const startHandle = document.createElement("span");
      startHandle.className = "note-handle note-start";
      startHandle.title = "Drag to change where this note starts. Its end stays put. Hold Alt for finer control.";
      bar.append(startHandle);
    }
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
  const edge = handle.classList.contains("note-start") ? "start" : "end";
  state.lengthDrag = { note: found, anchorTime, cell, pressed: true, startX: event.clientX, edge };
  event.preventDefault();
}

// Dragging a note's start moves where it begins, while its end stays put. Like resizing,
// it moves in fine steps, and Alt gives single ticks.
function moveStartDrag(event, drag, box, items, setItems) {
  const gap = parseFloat(getComputedStyle($("grid")).getPropertyValue("--grid-gap")) || 0;
  const ticksAt = (x) => drag.anchorTime + ((x - box.left) / (box.width + gap)) * state.resolution;
  drag.ends ??= items.map((item) => item.time + item.length);
  if (drag.grabOffset === undefined) drag.grabOffset = items[0].time - ticksAt(drag.startX);
  const pointer = ticksAt(event.clientX) + drag.grabOffset;
  const divisions = box.width < NARROW_STEP_PX ? FINE_DIVISIONS / 2 : FINE_DIVISIONS;
  const unit = event.altKey ? 1 : state.resolution / divisions;
  const latest = Math.min(...drag.ends) - (event.altKey ? 1 : unit);
  const start = Math.max(state.windowStart, Math.min(latest, Math.round(pointer / unit) * unit));
  const before = items[0].time;
  if (start !== before) {
    items.forEach((item, index) => {
      item.time = start;
      item.length = drag.ends[index] - start;
    });
    setItems();
    for (const time of [before, start]) {
      const cell = cellElement(items[0].note, Math.floor(time / state.resolution) * state.resolution);
      if (cell) paintCell(cell);
    }
    renderNoteBars();
  }
  const step = start / state.resolution + 1;
  setStatus(`Starts at step ${Number.isInteger(step) ? step : step.toFixed(2)}, ${describeLength(drag.ends[0] - start)} long. The end stays where it was.`);
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
  if (state.lengthDrag.edge === "start") {
    moveStartDrag(event, state.lengthDrag, box, [note], () => trackNotes().sort((a, b) => a.time - b.time || a.note - b.note));
    return;
  }
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
  $("redo").disabled = state.redo.length === 0;
  updateFileButtons();
  renderSlots();
  renderBanks();
  renderSequenceName();
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

// Moves the track's notes one step in time, wrapping around the sequence.
function shiftInTime(direction) {
  if (!trackNotes().length) {
    setStatus("This track has no notes to move.", true);
    return;
  }
  closeNoteEditor({ restoreFocus: false });
  remember();
  const by = direction * state.resolution;
  const length = sequence().lengthPulses;
  sequence().notes[track().name] = trackNotes()
    .map((n) => {
      // A note keeps its whole length. One that crosses the end carries on into the
      // start, so shifting back brings it back as it was.
      const time = ((n.time + by) % length + length) % length;
      return { ...n, time, length: Math.min(n.length, length) };
    })
    .sort((a, b) => a.time - b.time || a.note - b.note);
  const points = sequence().automation?.[track().name];
  if (points) {
    sequence().automation[track().name] = points.map((point) => ({ ...point, time: ((point.time + by) % length + length) % length }))
      .sort((a, b) => a.time - b.time);
  }
  renderGrid();
  markDirty();
  setStatus(`Moved the notes ${direction > 0 ? "later" : "earlier"} by one step. Undo puts them back.`);
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
  copySequence(source.key, target);
}

const isEmptySlot = (key) => !sequenceByKey(key) || !notesOf(sequenceByKey(key)).length;

// Copies one sequence's pattern into an empty slot, and shows the copy.
function copySequence(sourceKey, target) {
  const source = sequenceByKey(sourceKey);
  stop();
  state.undo = [];
  state.redo = [];
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
  setStatus(`Copied sequence ${sourceKey + 1} to sequence ${target + 1}.`);
}

// Moves a pattern into an empty slot, leaving its old slot empty.
function moveSequence(sourceKey, target) {
  copySequence(sourceKey, target);
  sequenceByKey(sourceKey).notes[track().name] = [];
  if (sequenceByKey(sourceKey).automation) sequenceByKey(sourceKey).automation[track().name] = [];
  state.dirty.add(sourceKey);
  renderAll();
  scheduleDraft();
  setStatus(`Moved sequence ${sourceKey + 1} to sequence ${target + 1}.`);
}

function setBars(bars) {
  const seq = sequence();
  const length = bars * pulsesPerBar(seq);
  remember();
  seq.lengthPulses = length;
  seq.notes[track().name] = notesOf(seq).filter((n) => n.time < length);
  if (seq.automation?.[track().name]) seq.automation[track().name] = seq.automation[track().name].filter((point) => point.time < length);
  if (state.nextPulse >= length) state.nextPulse = 0;
  markDirty();
  renderGrid();
}

/* ---------- Editing ---------- */

// A sequence as it is now, for Undo and Redo to bring back.
function snapshotOf(key) {
  const seq = sequenceByKey(key);
  return {
    key, lengthPulses: seq.lengthPulses, notes: JSON.stringify(notesOf(seq)),
    automation: JSON.stringify(seq.automation?.[track().name] || []), dirtyBefore: state.dirty.has(key),
  };
}

function remember() {
  state.undo.push(snapshotOf(sequence().key));
  if (state.undo.length > 200) state.undo.shift();
  state.redo = [];
}

function markDirty() {
  state.dirty.add(state.currentKey);
  // A pad that now plays gets a lane.
  if (state.lanes.length && !state.laneDraw) renderLane();
  renderChrome();
  scheduleDraft();
}

const undo = () => stepHistory(state.undo, state.redo);
const redo = () => stepHistory(state.redo, state.undo);

// Brings back the last state from one list, keeping the current one in the other.
function stepHistory(from, to) {
  const last = from.pop();
  if (!last) return;
  const seq = sequenceByKey(last.key);
  if (!seq) return;
  to.push(snapshotOf(last.key));
  seq.lengthPulses = last.lengthPulses;
  seq.notes[track().name] = JSON.parse(last.notes);
  if (last.automation) {
    seq.automation ??= {};
    seq.automation[track().name] = JSON.parse(last.automation);
  }
  if (last.dirtyBefore) state.dirty.add(last.key);
  else state.dirty.delete(last.key);
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
  const start = Math.min(...found.map((n) => n.time));
  $("edit-pitch").value = pitchUnits(Xpj.PITCH.coarse, pitchAt(state.editor.note, Xpj.PITCH.coarse, start));
  $("edit-fine").value = pitchUnits(Xpj.PITCH.fine, pitchAt(state.editor.note, Xpj.PITCH.fine, start));
  for (const id of ["edit-velocity", "edit-length", "edit-offset", "edit-probability", "edit-pitch", "edit-fine"]) {
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

// The pitch a pad plays with at a time: the last point at or before it, or no change.
function pitchAt(note, parameter, time) {
  let value = 0.5;
  for (const point of lanePoints()) {
    if (point.note === note && point.parameter === parameter && point.time <= time) value = point.value;
  }
  return value;
}

/* Tunes the hit being edited by putting a pitch point at its start. The pad's next hit
   gets a point back to the pitch it had before, so only this hit changes, unless there's
   already a point in between. */
function setStepPitch(parameter, units) {
  const steps = PITCH_UNITS[parameter].steps;
  const note = state.editor.note;
  const start = Math.min(...editorNotes().map((n) => n.time));
  const before = pitchAt(note, parameter, start - 1);
  const value = 0.5 + units / steps;
  changeEditorNotes(() => {
    const points = editablePoints().filter((p) => !(p.note === note && p.parameter === parameter && p.time === start));
    points.push({ time: start, note, parameter, value });
    const next = trackNotes().filter((n) => n.note === note && n.time > start).sort((a, b) => a.time - b.time)[0];
    if (next && !points.some((p) => p.note === note && p.parameter === parameter && p.time > start && p.time <= next.time)) {
      points.push({ time: next.time, note, parameter, value: before });
    }
    sequence().automation[track().name] = points.sort((a, b) => a.time - b.time);
  });
  renderLane();
  const pad = padForNote(note);
  const lane = state.lanes.find((item) => item.note === note);
  setStatus(`Pad ${padId(pad.pad)} at this hit: ${describeValue(parameter, value)}.${lane ? "" : " Its ~ lane shows its pitch."}`);
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
  $("edit-pitch").addEventListener("input", () => {
    editorNumber("edit-pitch", -36, 36, (value) => setStepPitch(Xpj.PITCH.coarse, value));
  });
  $("edit-fine").addEventListener("input", () => {
    editorNumber("edit-fine", -99, 99, (value) => setStepPitch(Xpj.PITCH.fine, value));
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
      // The left part of the note moves its start, and the rest changes its length.
      const box = cell.getBoundingClientRect();
      state.lengthDrag = {
        note: hits.length === 1 ? hits[0] : null,
        anchorTime: Number(cell.dataset.time),
        cell,
        pressed: true,
        startX: event.clientX,
        edge: event.clientX < box.left + box.width * 0.4 ? "start" : "end",
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
  for (const port of state.midi.inputs.values()) {
    port.onmidimessage = (event) => {
      if (followMpcClock(event)) return;
      recorder.message(event, port);
    };
  }
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
    playing: () => state.playing,
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
  }, { storageKey: "mpc-grid-record-input", button: $("record"), input: $("record-input"), channel: $("record-channel"), snap: $("record-snap") });
}

// Repeat hits sit back to back, so each note ends well before the next hit
// on the same pad. Otherwise its note-off can land on, or just after, the
// next note-on, and a recording MPC drops the repeat.
function heldPulses(seq, note) {
  let gap = seq.lengthPulses;
  for (const other of notesOf(seq)) {
    if (other.note !== note.note || other === note) continue;
    const ahead = ((other.time - note.time) % seq.lengthPulses + seq.lengthPulses) % seq.lengthPulses;
    if (ahead > 0 && ahead < gap) gap = ahead;
  }
  return Math.max(1, Math.min(note.length, gap * 0.5));
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

// A note name plays its note for as long as it's held down.
function holdNoteOn(element, note) {
  element.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    if (!state.output) {
      setStatus("No MIDI output connected.", true);
      return;
    }
    const output = state.output;
    const channel = state.channel;
    const now = performance.now();
    recorder.sent(note, now);
    output.send([0x90 | channel, note, 127]);
    element.classList.add("held");
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      output.send([0x80 | channel, note, 0]);
      element.classList.remove("held");
      for (const type of ["pointerup", "pointercancel", "lostpointercapture"]) element.removeEventListener(type, release);
    };
    // Captures the pointer, so letting go anywhere ends the note.
    try {
      element.setPointerCapture(event.pointerId);
    } catch {
      // It still ends when let go over the name.
    }
    for (const type of ["pointerup", "pointercancel", "lostpointercapture"]) element.addEventListener(type, release);
    // In case the grid is redrawn while the name is held.
    window.addEventListener("pointerup", release, { once: true });
  });
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

const CC_ALL_SOUND_OFF = 120;
const CC_ALL_NOTES_OFF = 123;

// Stops playback and silences anything still sounding on the MPC.
function panic() {
  stop();
  if (!state.output) {
    setStatus("No MIDI output connected.", true);
    return;
  }
  sendController(CC_ALL_SOUND_OFF, 0);
  sendController(CC_ALL_NOTES_OFF, 0);
  setStatus("All notes off.");
}

// Shared by all the grids, so switching one switches them all.
const THEME_KEY = "midi-grids-theme";

function setTheme(light) {
  if (light) document.documentElement.dataset.theme = "light";
  else delete document.documentElement.dataset.theme;
  $("theme-toggle").textContent = light ? "☾" : "☀";
  try {
    localStorage.setItem(THEME_KEY, light ? "light" : "dark");
  } catch {
    // It's just not remembered.
  }
}

// Follows a switch made on another grid open in this browser.
window.addEventListener("storage", (event) => {
  if (event.key === THEME_KEY && event.newValue) setTheme(event.newValue === "light");
});

/* ---------- Playback ---------- */

const ticker = new Worker(URL.createObjectURL(new Blob(
  ["setInterval(() => postMessage(0), 25);"], { type: "text/javascript" })));
ticker.onmessage = () => { if (state.playing) schedule(); };

const msPerPulse = () => 60000 / (currentBpm() * PPQ);

function currentBpm() {
  const value = Number($("bpm").value);
  return value >= 20 && value <= 300 ? value : 120;
}

/* A song from Song Grid while it plays one: { bars, loop, cues, pulse, muted }. Each cue
   starts a sequence from its first step, or silence, at a bar of 4/4, and the song ends
   or loops after its last bar. The part arrives just before Song Grid starts playback.
   See sync.js. */
const SONG_BAR = PPQ * 4;
let song = null;
let pendingSong = null;

// Called at the start of each chunk. Returns false once the song has ended.
// A song's cue can change the tempo.
function setSongBpm(bpm) {
  if (bpm !== currentBpm()) $("bpm").value = bpm;
}

function followSong() {
  if (song.pulse % SONG_BAR !== 0) return true;
  // Each bar after the first moves the song on, following any move from Song Grid.
  if (song.pulse > 0 && !Sync.songNextBar(song)) {
    stop({ fromLink: true });
    setStatus("The song has ended.");
    return false;
  }
  const bar = song.bar;
  const cue = Sync.songCue(song, bar);
  if (cue) {
    song.off = !Number.isInteger(cue.pattern);
    if (!song.off && cue.pattern !== state.currentKey) switchTo(cue.pattern);
    if (cue.bpm) setSongBpm(cue.bpm);
    state.nextPulse = 0;
    setStatus(song.off ? `Song: silent from bar ${bar + 1}.` : `Song: sequence ${cue.pattern + 1} from bar ${bar + 1}.`);
  }
  // Song Grid's mute and solo buttons can silence this grid from any bar.
  song.muted = song.off || Sync.songSilenced(song);
  return true;
}

function schedule() {
  const horizon = performance.now() + SCHEDULE_AHEAD_MS;
  let ms = msPerPulse();
  while (state.nextTime < horizon) {
    if (song && !followSong()) return;
    ms = msPerPulse(); // A song can change the tempo at a bar.
    const seq = sequence();
    const from = state.nextPulse;
    const to = from + CHUNK_PULSES;
    if (sendingClock() && from % CLOCK_PULSES === 0 && state.output) {
      state.output.send([0xF8], state.nextTime);
    }
    if (from % PPQ === 0) click.at(state.nextTime, from % (4 * PPQ) === 0);
    for (const note of song?.muted ? [] : notesOf(seq)) {
      if (note.time >= from && note.time < to && !state.muted.has(note.note)
          && Math.random() * 100 < (note.probability ?? 100)) {
        sendNote(note.note, note.velocity,
          state.nextTime + (note.time - from) * ms, heldPulses(seq, note) * ms);
      }
    }
    state.nextTime += CHUNK_PULSES * ms;
    if (song) song.pulse += CHUNK_PULSES;
    state.nextPulse = to >= seq.lengthPulses ? 0 : to;
    if (state.nextPulse === 0 && state.queuedKey !== null && !song) {
      switchTo(state.queuedKey);
    }
  }
}

const sendingClock = () => $("clock").checked;

function renderPeers(names) {
  const pill = $("sync-peers");
  pill.hidden = !$("sync").checked;
  pill.textContent = names.length ? `Linked: ${names.join(", ")}` : "Not linked";
  pill.className = `pill ${names.length ? "ok" : ""}`;
  pill.title = names.length ? "Play, stop and tempo are shared with this page." : "The other grid isn't open in this browser, or has Sync off.";
}

// Plays together with the other grid when both are open. See sync.js.
// Puts the sequences kept with a song in Song Grid back into the sequences they came
// from, on this track. Nothing is sent to the MPC until you save. Undo brings back each
// sequence as it was, one at a time. See sync.js.
function loadAssets(assets) {
  if (!state.view) return { ok: false, message: "Open a project first." };
  const put = [];
  let missing = 0;
  for (const item of Array.isArray(assets.patterns) ? assets.patterns : []) {
    const data = item?.data;
    if (!data || !Number.isInteger(item.ref) || !Array.isArray(data.notes) || !Number.isFinite(data.lengthPulses) || data.lengthPulses <= 0) continue;
    const seq = sequenceByKey(item.ref);
    if (!seq) {
      missing += 1;
      continue;
    }
    if (put.includes(seq)) continue;
    state.undo.push(snapshotOf(seq.key));
    if (state.undo.length > 200) state.undo.shift();
    seq.lengthPulses = data.lengthPulses;
    seq.notes[track().name] = JSON.parse(JSON.stringify(data.notes));
    state.dirty.add(seq.key);
    put.push(seq);
  }
  if (put.length) {
    state.redo = [];
    renderAll();
    scheduleDraft();
  }
  const names = put.map((seq) => seq.name || `Sequence ${seq.key + 1}`);
  const list = names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}` : names.join("");
  const parts = [];
  if (put.length) parts.push(`Put ${list} back. Save to send ${put.length === 1 ? "it" : "them"} to the MPC. Undo here brings back what was there.`);
  if (missing) parts.push(`${missing} ${missing === 1 ? "sequence isn't" : "sequences aren't"} in this project, so ${missing === 1 ? "it was" : "they were"} left out.`);
  const message = parts.join(" ") || "There was nothing to put in.";
  setStatus(`From Song Grid: ${message}`, !put.length || missing > 0);
  return { ok: put.length > 0 && !missing, message };
}

/* What this grid can offer Song Grid for a song, to pick from: the sequences in the open
   project with notes on this track. fetchPicked gives the ones picked, as assets. See sync.js. */
function catalog() {
  return {
    grid: collectAssets().patterns.map((item) => ({ id: item.id, label: item.label, meta: `${item.length}, ${item.notes} note${item.notes === 1 ? "" : "s"}` })),
    patterns: [], sounds: [], note: "",
  };
}

function fetchPicked({ patterns: ids = [] } = {}) {
  const list = Array.isArray(ids) ? ids : [];
  return { patterns: collectAssets().patterns.filter((item) => list.includes(item.id)), sound: null };
}

// What Song Grid keeps of this grid for a song: its patterns, and its sound where it has
// one. See sync.js.
function collectAssets() {
  const patterns = (state.view?.sequences || []).filter((seq) => notesOf(seq).length).map((seq) => ({
    id: `seq:${seq.key}`, ref: seq.key, label: seq.name || `Sequence ${seq.key + 1}`,
    length: `${Math.round((seq.lengthPulses / pulsesPerBar(seq)) * 100) / 100} bars`, notes: notesOf(seq).length,
    data: { key: seq.key, name: seq.name, lengthPulses: seq.lengthPulses, beatsPerBar: seq.beatsPerBar, beatLength: seq.beatLength, notes: JSON.parse(JSON.stringify(notesOf(seq))) },
  }));
  return { patterns, sound: null };
}

const link = Sync.connect({
  startOff: true, // Each visit starts with Sync off.
  name: "MPC Grid",
  checkbox: $("sync"),
  storageKey: "mpc-grid-sync",
  start({ bpm, at }) {
    if (intoMpc) return false; // Recording into the MPC follows its clock instead.
    if (state.playing) stop({ fromLink: true });
    $("bpm").value = bpm;
    // Song Grid sends this page its part just before it starts playback.
    song = pendingSong;
    pendingSong = null;
    play({ startAt: at, fromLink: true });
    return state.playing;
  },
  stop: () => stop({ fromLink: true }),
  song: (part) => { pendingSong = part; },
  assets: collectAssets,
  loadAssets,
  answers: { catalog, fetch: fetchPicked },
  songMoved(data) {
    const move = song && Sync.songMove(data, song.bars);
    if (move) song.moves.push(move);
  },
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
  if (!fromLink) song = null;
  if (song) Object.assign(Sync.songStart(song), { pulse: 0, muted: false });
  if (!state.output) {
    setStatus("No MIDI output connected. Exit SD Card Access mode on the MPC.", true);
    return;
  }
  state.playing = true;
  state.nextPulse = 0;
  const shared = fromLink ? null : link.announcePlay(currentBpm());
  state.nextTime = startAt ?? shared ?? performance.now() + 60;
  if (sendingClock()) state.output.send([0xFA], state.nextTime);
  $("play").textContent = "Stop";
  $("playhead").hidden = false;
  schedule();
  requestAnimationFrame(drawPlayhead);
}

/* Recording into the MPC: the MPC starts recording on its own, so the page waits for it.
   With MIDI Sync Out on MIDI Clock, the MPC sends start, then 24 clocks a beat. The page
   plays the loop once from the first clock, following the MPC's clock so the tempo always
   matches, then stops sending, so the MPC's next time round doesn't double the notes. */
let intoMpc = null; // While waiting or playing: { started, pulse, last, interval, key }.

function armIntoMpc() {
  if (!state.output) {
    setStatus("No MIDI output connected. Exit SD Card Access mode on the MPC.", true);
    return;
  }
  if (state.playing) stop();
  intoMpc = { started: false, pulse: 0, last: null, tick: null, ends: new Map(), interval: 60000 / (currentBpm() * 24), key: state.currentKey };
  renderIntoMpc();
  setStatus("Waiting for the MPC. Press REC, then PLAY on the MPC, and the loop plays once in time with it.");
}

function cancelIntoMpc(message) {
  intoMpc = null;
  renderIntoMpc();
  if (message) setStatus(message);
}

function renderIntoMpc() {
  $("send").textContent = intoMpc ? "Stop waiting" : "Record into MPC";
  $("send").setAttribute("aria-pressed", String(Boolean(intoMpc)));
}

// Handles the MPC's start, clock and stop while recording into it. Returns whether the
// message was used.
function followMpcClock(event) {
  if (!intoMpc) return false;
  const status = event.data[0];
  if (status === 0xFA) {
    Object.assign(intoMpc, { started: true, pulse: 0, last: null, tick: null, ends: new Map() });
    setStatus("The MPC started. Playing the loop into it...");
    return true;
  }
  if (status === 0xFC) {
    if (intoMpc.started) cancelIntoMpc("The MPC stopped before the loop finished, so only part of it went in. Undo the take on the MPC, and try again.");
    return true;
  }
  if (status !== 0xF8 || !intoMpc.started) return status === 0xF8;
  const now = event.timeStamp || performance.now();
  if (intoMpc.last !== null) {
    const gap = now - intoMpc.last;
    // Follows tempo changes, while smoothing out uneven arrival times.
    if (gap > 2 && gap < 200) intoMpc.interval = intoMpc.interval * 0.7 + gap * 0.3;
  }
  intoMpc.last = now;
  // Clocks arrive a few ms early or late. Following a smoothed beat instead
  // keeps closely spaced hits, like 8x repeats, evenly apart and in order.
  intoMpc.tick = intoMpc.tick === null ? now
    : (() => { const expected = intoMpc.tick + intoMpc.interval; return expected + (now - expected) * 0.2; })();
  const seq = sequenceByKey(intoMpc.key);
  const from = intoMpc.pulse;
  const to = from + CLOCK_PULSES;
  const ms = intoMpc.interval / CLOCK_PULSES;
  for (const note of notesOf(seq)) {
    if (note.time >= from && note.time < to && !state.muted.has(note.note)
        && Math.random() * 100 < (note.probability ?? 100)) {
      // Never start a hit before the last one on the same pad has ended.
      const at = Math.max(intoMpc.tick + (note.time - from) * ms, (intoMpc.ends.get(note.note) ?? 0) + 1);
      const held = Math.max(1, heldPulses(seq, note) * ms);
      intoMpc.ends.set(note.note, at + held);
      sendNote(note.note, note.velocity, at, held);
    }
  }
  intoMpc.pulse = to;
  if (to >= seq.lengthPulses) {
    cancelIntoMpc("Played the loop once into the MPC. Press STOP on the MPC, play the sequence back to check it, and save the project on the MPC to keep it.");
  }
  return true;
}

// Shows how to get the MPC ready to record, before waiting for it to start.
function openSendDialog() {
  if (intoMpc) {
    cancelIntoMpc("Stopped waiting for the MPC.");
    return;
  }
  if (!trackNotes().length) {
    setStatus("This track has no notes to record into the MPC.", true);
    return;
  }
  const seq = sequence();
  const bars = seq.lengthPulses / pulsesPerBar(seq);
  $("send-what").textContent = `this track's ${trackNotes().length === 1 ? "note" : `${trackNotes().length} notes`}`;
  $("send-bars").textContent = `${bars} ${bars === 1 ? "bar" : "bars"}`;
  $("send-dialog").showModal();
  $("send-start").focus();
}


function stop({ fromLink = false } = {}) {
  state.queuedKey = null;
  if (!state.playing) return;
  if (!fromLink) link.announceStop();
  if (sendingClock() && state.output) state.output.send([0xFC]);
  state.playing = false;
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
  $("send").addEventListener("click", openSendDialog);
  for (const id of ["send-cancel", "send-cancel-top"]) $(id).addEventListener("click", () => $("send-dialog").close());
  $("send-start").addEventListener("click", () => {
    $("send-dialog").close();
    armIntoMpc();
  });
  $("undo").addEventListener("click", undo);
  $("redo").addEventListener("click", redo);
  $("stop-all").addEventListener("click", panic);
  $("theme-toggle").addEventListener("click", () => setTheme(document.documentElement.dataset.theme !== "light"));
  setUpRecorder();
  $("duplicate").addEventListener("click", duplicateSequence);
  $("shift-left").addEventListener("click", () => shiftInTime(-1));
  $("shift-right").addEventListener("click", () => shiftInTime(1));
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
  $("library").addEventListener("click", chooseLibrary);
  $("project-save").addEventListener("click", saveProject);
  bindLane();
  $("sequence-name").addEventListener("change", (event) => renameSequence(event.target.value));
  $("grid-title").addEventListener("click", () => {
    const seq = sequence();
    if (!seq) return;
    const answer = window.prompt("Name this sequence", seq.name || `Sequence ${seq.key + 1}`);
    if (answer !== null) renameSequence(answer);
  });
  $("sequence-name").addEventListener("keydown", (event) => {
    if (event.key === "Enter") event.target.blur();
    if (event.key === "Escape") {
      event.target.value = sequence()?.name || "";
      event.target.blur();
    }
  });
  $("project-save-as").addEventListener("click", saveProjectAs);
  $("to-card").addEventListener("click", copyToCard);
  $("discard").addEventListener("click", discardChanges);

  const typing = (target) => /^(INPUT|SELECT|TEXTAREA)$/.test(target.tagName);
  window.addEventListener("keydown", (event) => {
    if ($("help").open || $("send-dialog").open) return;
    // Cmd+S saves into the project, and Cmd+Shift+S saves a new one.
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
      event.preventDefault();
      if (!event.repeat) {
        if (event.shiftKey) saveProjectAs();
        else saveProject();
      }
      return;
    }
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
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "z") {
      event.preventDefault();
      if (event.shiftKey) redo();
      else undo();
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
  setTheme(document.documentElement.dataset.theme === "light");
  bindNoteEditor();
  const missing = missingBrowserFeatures();
  if (missing.length) {
    $("card").disabled = true;
    $("library").disabled = true;
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
  if ($("library").dataset.status === "permission") {
    setStatus("Click Allow library access at the top to open your projects again.");
  }
  const last = lastProject();
  if (last && [...$("project").options].some((o) => o.value === last)) {
    await openProject(last);
  }
  await initMidi();
}

start().catch((error) => setStatus(error.message, true));
