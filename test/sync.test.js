"use strict";
const assert = require("node:assert/strict");
const { afterEach, test } = require("node:test");
const Sync = require("../sync.js");

// An open channel keeps the test process running, even after a failure.
const opened = [];
afterEach(() => { opened.splice(0).forEach((link) => link.close()); });

const page = (name, { checked = true, playing = true } = {}) => {
  const calls = { start: [], stop: 0, tempo: [], status: [] };
  const checkbox = { checked, addEventListener() {} };
  const link = Sync.connect({
    name,
    checkbox,
    storageKey: name,
    start: (info) => { calls.start.push(info); return playing; },
    stop: () => { calls.stop += 1; },
    tempo: (info) => { calls.tempo.push(info); },
    status: (message, isError) => { calls.status.push([message, Boolean(isError)]); },
  });
  opened.push(link);
  checkbox.checked = checked;
  return { calls, checkbox, link };
};
const pause = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });
// Message timing varies on a busy computer, so this waits for the result.
const until = async (done) => {
  for (let tries = 0; tries < 200 && !done(); tries += 1) await pause(10);
};
// For checking that nothing arrives.
const nothingFurther = () => pause(100);

test("pressing play starts the other page at the same moment and tempo", async () => {
  const a = page("A");
  const b = page("B");
  const at = a.link.announcePlay(97.5);
  await until(() => a.calls.status.length);
  assert.equal(b.calls.start.length, 1);
  assert.equal(b.calls.start[0].bpm, 97.5);
  assert.ok(Math.abs(b.calls.start[0].at - at) < 50);
  assert.equal(a.calls.start.length, 0);
  assert.deepEqual(a.calls.status, [["Playing with B.", false]]);
});

test("stop and tempo reach the other page", async () => {
  const a = page("A");
  const b = page("B");
  a.link.announceStop();
  a.link.announceTempo({ bpm: 140, nextTime: performance.now() + 50, nextPulse: 480 });
  await until(() => b.calls.tempo.length);
  assert.equal(b.calls.stop, 1);
  assert.equal(b.calls.tempo[0].bpm, 140);
  assert.equal(b.calls.tempo[0].pulse, 480);
});

test("a page with no MIDI output says so to the page that pressed play", async () => {
  const a = page("A");
  const b = page("B", { playing: false });
  a.link.announcePlay(120);
  await until(() => a.calls.status.length);
  assert.deepEqual(a.calls.status, [["B isn't playing, as it has no MIDI output.", true]]);
});

test("turning sync off stops sending and receiving", async () => {
  const off = page("A");
  const on = page("B");
  off.checkbox.checked = false;
  assert.equal(off.link.announcePlay(120), null);
  on.link.announcePlay(120);
  await nothingFurther();
  assert.equal(off.calls.start.length, 0);
  assert.equal(on.calls.start.length, 0);
});

test("each page can tell which others are open", async () => {
  const names = [];
  const checkbox = { checked: true, addEventListener() {} };
  const link = Sync.connect({
    name: "A", checkbox, storageKey: "A", start() {}, stop() {}, tempo() {}, status() {}, peers: (list) => names.push(list),
  });
  opened.push(link);
  const other = page("B");
  await until(() => names.length);
  assert.deepEqual(names.at(-1), ["B"]);
  other.link.close();
  const b2 = new BroadcastChannel("grid-sync");
  b2.postMessage({ type: "bye", from: "B" });
  await until(() => names.at(-1).length === 0);
  b2.close();
  assert.deepEqual(names.at(-1), []);
});

test("a nonsense tempo is ignored", async () => {
  const a = page("A");
  const b = page("B");
  a.link.announcePlay(5000);
  await nothingFurther();
  assert.equal(b.calls.start.length, 0);
});

test("alignment moves a page onto the other's beats by the shortest way", () => {
  const timing = { pulsesPerBeat: 960, msPerPulse: 0.5, at: 1000, pulse: 0 };
  assert.equal(Sync.aligned({ ...timing, nextPulse: 960, nextTime: 1480 }), 1480);
  assert.equal(Sync.aligned({ ...timing, nextPulse: 960, nextTime: 1490 }), 1480);
  // Half a pattern apart in pulses, but on the beat, so nothing needs to move.
  assert.equal(Sync.aligned({ ...timing, nextPulse: 2880, nextTime: 1480 }), 1480);
  assert.equal(Sync.aligned({ ...timing, nextPulse: 960, nextTime: 1460 }), 1480);
});

test("each page gets its own part of a song, checked", () => {
  const plan = {
    bars: 16,
    loop: true,
    parts: {
      "S-1 Grid": [{ bar: 8, pattern: 2 }, { bar: 0, pattern: 0 }, { bar: 12, pattern: null }, { bar: 20, pattern: 1 }, { bar: 4, pattern: 99 }],
    },
  };
  const part = Sync.songPart(plan, "S-1 Grid");
  assert.deepEqual(part, { bars: 16, loop: true, cues: [{ bar: 0, pattern: 0 }, { bar: 8, pattern: 2 }, { bar: 12, pattern: null }], loops: [] });
  assert.equal(Sync.songPart(plan, "Protein Grid"), null);
  assert.equal(Sync.songPart({ bars: 0, parts: {} }, "S-1 Grid"), null);
  assert.equal(Sync.songPart(null, "S-1 Grid"), null);
  // TD-3 Grid's patterns are named by a string.
  const td3 = Sync.songPart({ bars: 4, parts: { "TD-3 Grid": [{ bar: 0, pattern: "grid" }, { bar: 2, pattern: "p1abc" }, { bar: 3, pattern: "" }] } }, "TD-3 Grid");
  assert.deepEqual(td3.cues, [{ bar: 0, pattern: "grid" }, { bar: 2, pattern: "p1abc" }]);
  assert.deepEqual(Sync.songCue(part, 8), { bar: 8, pattern: 2 });
  assert.equal(Sync.songCue(part, 9), undefined);
});

test("a song sent before play reaches the other pages first", async () => {
  const conductor = page("Song Grid");
  const parts = [];
  const order = [];
  const checkbox = { checked: true, addEventListener() {} };
  const grid = Sync.connect({
    name: "S-1 Grid", checkbox, storageKey: "song-test",
    start: () => { order.push("play"); return true; }, stop() {}, tempo() {}, status() {},
    song: (part) => { order.push("song"); parts.push(part); },
  });
  opened.push(grid);
  conductor.link.announceSong({ bars: 4, loop: false, parts: { "S-1 Grid": [{ bar: 0, pattern: 3 }] } });
  conductor.link.announcePlay(120);
  await until(() => order.length >= 2);
  assert.deepEqual(order, ["song", "play"]);
  assert.deepEqual(parts[0], { bars: 4, loop: false, cues: [{ bar: 0, pattern: 3 }], loops: [] });
});

// Plays a part bar by bar, returning the song bars heard, or "end" when it ends.
function playBars(part, count) {
  Sync.songStart(part);
  const heard = [part.bar];
  for (let i = 1; i < count; i += 1) {
    if (!Sync.songNextBar(part)) {
      heard.push("end");
      break;
    }
    heard.push(part.bar);
  }
  return heard;
}

test("a song plays its bars in order, then ends or loops", () => {
  assert.deepEqual(playBars({ bars: 3, loop: false }, 5), [0, 1, 2, "end"]);
  assert.deepEqual(playBars({ bars: 3, loop: true }, 7), [0, 1, 2, 0, 1, 2, 0]);
});

test("a move jumps on the bar it names", () => {
  const part = { bars: 12, loop: false };
  Sync.songStart(part);
  part.moves.push({ atBar: 2, toBar: 8 });
  const heard = [part.bar];
  for (let i = 0; i < 5; i += 1) { Sync.songNextBar(part); heard.push(part.bar); }
  assert.deepEqual(heard, [0, 1, 8, 9, 10, 11]);
});

test("a looped section repeats each time it's reached, until it's let go", () => {
  // Bars 2 to 3 loop from the start, and are let go on the eighth bar played.
  const part = { bars: 8, loop: false, loops: [{ start: 2, end: 4 }] };
  Sync.songStart(part);
  part.moves.push({ atBar: 7, loops: [] });
  const heard = [part.bar];
  for (let i = 0; i < 10; i += 1) { Sync.songNextBar(part); heard.push(part.bar); }
  assert.deepEqual(heard, [0, 1, 2, 3, 2, 3, 2, 3, 4, 5, 6]);
});

test("a jump leaves a looped section, and a loop can start while it plays", () => {
  const part = { bars: 8, loop: false, loops: [] };
  Sync.songStart(part);
  part.moves.push({ atBar: 2, loops: [{ start: 0, end: 2 }] }, { atBar: 5, toBar: 6 });
  const heard = [part.bar];
  for (let i = 0; i < 7; i += 1) { if (!Sync.songNextBar(part)) { heard.push("end"); break; } heard.push(part.bar); }
  assert.deepEqual(heard, [0, 1, 0, 1, 0, 6, 7, "end"]);
});

test("moves from Song Grid are checked against the song", () => {
  assert.deepEqual(Sync.songMove({ atBar: 3, toBar: 4 }, 8), { atBar: 3, toBar: 4 });
  assert.deepEqual(Sync.songMove({ atBar: 3, loops: [] }, 8), { atBar: 3, loops: [] });
  assert.deepEqual(Sync.songMove({ atBar: 3, loops: [{ start: 0, end: 4 }, { start: 6, end: 9 }] }, 8), { atBar: 3, loops: [{ start: 0, end: 4 }] });
  assert.equal(Sync.songMove({ atBar: 3, toBar: 9 }, 8), null);
  assert.equal(Sync.songMove({ atBar: 0, toBar: 1 }, 8), null);
  assert.equal(Sync.songMove({ atBar: 3 }, 8), null);
});

test("a grid sends its assets when Song Grid asks", async () => {
  const replies = [];
  const box = () => ({ checked: true, addEventListener() {} });
  const conductor = Sync.connect({
    name: "Song Grid", checkbox: box(), storageKey: "assets-song", start: () => true, stop() {}, tempo() {}, status() {},
    assetsReceived: (from, assets, request) => replies.push({ from, assets, request }),
  });
  const grid = Sync.connect({
    name: "S-1 Grid", checkbox: box(), storageKey: "assets-grid", start: () => true, stop() {}, tempo() {}, status() {},
    assets: async () => ({ patterns: [{ id: "slot:0", label: "Pattern 1" }], sound: null }),
  });
  opened.push(conductor, grid);
  const request = conductor.requestAssets();
  await until(() => replies.length > 0);
  assert.equal(replies[0].from, "S-1 Grid");
  assert.equal(replies[0].request, request);
  assert.deepEqual(replies[0].assets.patterns, [{ id: "slot:0", label: "Pattern 1" }]);
});

test("Song Grid sends a grid its assets to put back, and hears what it did", async () => {
  const results = [];
  const loaded = [];
  const box = () => ({ checked: true, addEventListener() {} });
  const conductor = Sync.connect({
    name: "Song Grid", checkbox: box(), storageKey: "load-song", start: () => true, stop() {}, tempo() {}, status() {},
    assetsLoaded: (from, result, request) => results.push({ from, result, request }),
  });
  const grid = Sync.connect({
    name: "S-1 Grid", checkbox: box(), storageKey: "load-grid", start: () => true, stop() {}, tempo() {}, status() {},
    loadAssets: async (assets) => { loaded.push(assets); return { ok: true, message: "Put 1 pattern in." }; },
  });
  const other = Sync.connect({
    name: "Protein Grid", checkbox: box(), storageKey: "load-other", start: () => true, stop() {}, tempo() {}, status() {},
    loadAssets: () => { throw new Error("only S-1 Grid's assets were sent"); },
  });
  opened.push(conductor, grid, other);
  const request = conductor.sendAssets("S-1 Grid", { patterns: [], sound: null });
  await until(() => results.length > 0);
  assert.equal(loaded.length, 1);
  assert.deepEqual(results, [{ from: "S-1 Grid", result: { ok: true, message: "Put 1 pattern in." }, request }]);
});

test("patterns for numbered slots are checked before they're put in", () => {
  const slots = Sync.assetSlots({ patterns: [
    { ref: 5, data: { bars: 2, notes: [{ note: 60 }] } },
    { ref: 1, data: { bars: 1, notes: [] } },
    { ref: 5, data: { bars: 4, notes: [] } },
    { ref: 16, data: { bars: 1, notes: [] } },
    { ref: "grid", data: { bars: 1, notes: [] } },
    { ref: 2, data: { bars: 0, notes: [] } },
    { ref: 3, data: { bars: 1 } },
    null,
  ] });
  assert.deepEqual(slots, [{ index: 1, data: { bars: 1, notes: [] } }, { index: 5, data: { bars: 2, notes: [{ note: 60 }] } }]);
  assert.deepEqual(Sync.assetSlots(null), []);
});
