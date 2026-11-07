"use strict";
const assert = require("node:assert/strict");
const { test } = require("node:test");
const Recorder = require("../recorder.js");

const STEP = 240;
const LENGTH = 16 * STEP;

// Just enough of a button and two lists for the recorder to work with.
function element() {
  const listeners = {};
  return {
    value: "",
    attributes: {},
    children: [],
    setAttribute(name, value) { this.attributes[name] = value; },
    addEventListener(type, listener) { listeners[type] = listener; },
    replaceChildren(...children) { this.children = children; },
    fire(type) { listeners[type](); },
  };
}

global.Option = function Option(text, value) {
  this.text = text;
  this.value = value;
};
const stored = new Map();
global.localStorage = { getItem: (key) => stored.get(key) ?? null, setItem: (key, value) => stored.set(key, value) };

function setUp({ playing = true } = {}) {
  const notes = [];
  const passed = [];
  const clock = { pulse: 0, playing };
  const ui = { button: element(), input: element(), channel: element() };
  const recorder = Recorder.create({
    notes: () => notes,
    makeNote: (fields) => ({ ...fields, probability: 100 }),
    resolution: () => STEP,
    length: () => LENGTH,
    playing: () => clock.playing,
    pulseAt: () => clock.pulse,
    startStep: () => 0,
    moveCursor: () => {},
    begin: () => {},
    added: () => {},
    lengthened: () => {},
    status: () => {},
    thru: (data) => passed.push(data),
    isInstrument: (port) => port.name === "S-1",
  }, { storageKey: `test-${Math.random()}`, ...ui });
  const send = (port, data, at = 0) => recorder.message({ data, timeStamp: at }, { name: port });
  return { notes, passed, clock, ui, recorder, send };
}

test("only notes from the chosen input and channel are taken", () => {
  const choice = { input: "Keystep", channel: 2 };
  assert.ok(Recorder.accepts(choice, "Keystep", 0x91));
  assert.ok(!Recorder.accepts(choice, "Keystep", 0x90), "another channel");
  assert.ok(!Recorder.accepts(choice, "S-1", 0x91), "another input");
  assert.ok(!Recorder.accepts(choice, "Keystep", 0xB1), "not a note");
  assert.ok(Recorder.accepts({ input: Recorder.ANY, channel: 0 }, "Anything", 0x8F));
});

test("notes land on the nearest step, wrapping round the loop", () => {
  assert.equal(Recorder.nearestStep(250, STEP, LENGTH), STEP);
  assert.equal(Recorder.nearestStep(LENGTH - 20, STEP, LENGTH), 0);
  assert.equal(Recorder.heldLength(LENGTH - STEP, STEP, LENGTH - STEP, STEP, LENGTH), STEP, "cut at the pattern's end");
  assert.equal(Recorder.heldLength(0, 700, 0, STEP, LENGTH), 3 * STEP);
});

test("each pass of the loop adds to the take, and held notes keep their length", () => {
  const { notes, clock, ui, recorder, send } = setUp();
  ui.button.fire("click");
  assert.equal(ui.button.attributes["aria-pressed"], "true");
  clock.pulse = 10;
  send("Keystep", [0x90, 60, 100]);
  clock.pulse = 2 * STEP + 5;
  send("Keystep", [0x80, 60, 0]);
  clock.pulse = 4 * STEP; // Next time round, a different step.
  send("Keystep", [0x90, 64, 127]);
  send("Keystep", [0x90, 64, 0]);
  assert.deepEqual(notes.map((n) => [n.time, n.note, n.length]), [[0, 60, 2 * STEP], [4 * STEP, 64, STEP]]);
  assert.equal(notes[1].velocity, 1);
  assert.equal(notes[0].probability, 100);
  recorder.toggle();
  send("Keystep", [0x90, 67, 100]);
  assert.equal(notes.length, 2, "nothing is recorded once stopped");
});

test("another keyboard is heard through the instrument, but the instrument's own keys aren't", () => {
  const { passed, ui, send } = setUp();
  send("Keystep", [0x90, 60, 100]);
  assert.deepEqual(passed, [], "not while recording is off");
  ui.button.fire("click");
  send("Keystep", [0x92, 60, 100]);
  send("S-1", [0x90, 62, 100]);
  ui.button.fire("click");
  send("Keystep", [0x82, 60, 0]);
  assert.deepEqual(passed, [[0x90, 60, 100], [0x80, 60, 0]], "the note off still goes after stopping");
});

test("the instrument echoing a note this page sent isn't recorded", () => {
  const { notes, ui, recorder, send } = setUp();
  ui.button.fire("click");
  recorder.sent(60, 1000);
  send("S-1", [0x90, 60, 100], 1010);
  assert.equal(notes.length, 0);
  send("S-1", [0x90, 60, 100], 1500);
  assert.equal(notes.length, 1);
});

test("step recording moves on a step per key, keeping chords together", () => {
  const { notes, ui, send } = setUp({ playing: false });
  ui.button.fire("click");
  send("Keystep", [0x90, 60, 100], 1000);
  send("Keystep", [0x90, 64, 100], 1030);
  send("Keystep", [0x90, 67, 100], 2000);
  assert.deepEqual(notes.map((n) => [n.time, n.note]), [[0, 60], [0, 64], [STEP, 67]]);
});

test("the chosen input and channel are remembered", () => {
  const { ui } = setUp();
  ui.input.value = "Keystep";
  ui.input.fire("change");
  ui.channel.value = "5";
  ui.channel.fire("change");
  assert.ok([...stored.values()].includes(JSON.stringify({ input: "Keystep", channel: 5 })));
});
