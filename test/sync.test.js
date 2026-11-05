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
