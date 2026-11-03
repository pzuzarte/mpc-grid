"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");
const Xpj = require("../xpj.js");
const {
  gunzipText, gzip, makeProject, projectBytes, projectText,
} = require("./helpers.js");

const NOTE = { time: 0, note: 36, velocity: 1, length: 10 };

const eventsOf = (project, key = 0) =>
  Xpj.clips(Xpj.findSequence(project, key))["Drum 001"].eventList.events;
const notesOf = (project, key = 0) => eventsOf(project, key).filter((e) => e.type === 3);
const textOf = async (project) => gunzipText(await Xpj.serialise(project));

test("unedited project is rewritten byte for byte, including 1.0 and 64-bit integers", async () => {
  const project = await makeProject();
  assert.equal(project.lossless, true);
  const text = await textOf(project);
  assert.equal(text, projectText());
  assert.ok(text.includes("9223372036854775807"));
  assert.ok(text.includes('"bpm": 120.0'));
});

test("rejects files that aren't projects", async () => {
  await assert.rejects(Xpj.parse(new TextEncoder().encode("not gzip")), Xpj.XpjError);
  await assert.rejects(Xpj.parse(await gzip("NOPE\na\nb\nc\nd\n{}")), Xpj.XpjError);
  await assert.rejects(Xpj.parse(await gzip("ACVS\na\nb\nc\nd\n{not json")), Xpj.XpjError);
  await assert.rejects(Xpj.parse(await gzip("ACVS\na\nb\nc\nd\n{}")), Xpj.XpjError);
});

test("a project that can't be reproduced exactly can be viewed but not saved", async () => {
  // JavaScript moves number-like keys to the front of an object.
  const text = projectText().replace('"tracks": [', '"5": 1,\n"tracks": [');
  const project = await Xpj.parse(await gzip(text));
  assert.equal(project.lossless, false);
  assert.equal(Xpj.view(project).canSave, false);
  await assert.rejects(Xpj.serialise(project), Xpj.XpjError);
});

test("view lists drum tracks, pads, notes and tempo as plain numbers", async () => {
  const view = Xpj.view(await makeProject());
  assert.deepEqual(view.tracks.map((t) => t.name), ["Drum 001"]);
  assert.deepEqual(view.tracks[0].pads[0], { pad: 0, note: 36, sample: "Kick" });
  assert.deepEqual(view.sequences[0].notes["Drum 001"], [
    { time: 0, note: 36, velocity: 1, length: 100, probability: 50 },
  ]);
  assert.equal(view.bpm, 90);
  assert.equal(view.sequences[0].bpm, 120);
  assert.equal(view.canSave, true);
});

test("resaving unchanged notes changes nothing at all", async () => {
  const project = await makeProject();
  const notes = Xpj.view(project).sequences[0].notes["Drum 001"];
  Xpj.setNotes(project, 0, "Drum 001", notes);
  assert.equal(await textOf(project), projectText());
});

test("adding a note keeps existing fields and automation, and sorts by time", async () => {
  const project = await makeProject();
  Xpj.setNotes(project, 0, "Drum 001", [
    { time: 480, note: 38, velocity: 0.5, length: 240 },
    { time: 0, note: 36, velocity: 0.75, length: 100 },
  ]);
  const events = eventsOf(project);
  assert.deepEqual(events.map((e) => e.type), [1, 3, 3]);
  assert.deepEqual(events.map((e) => e.time), [0, 0, 480]);
  assert.equal(events[1].note.probability, 50);
  assert.equal(events[1].note.velocity, 0.75);
  assert.equal(events[2].note.note, 38);
  assert.equal(events[2].note.ratchet, 1);
});

test("a new note writes float fields as floats", async () => {
  const project = await makeProject();
  Xpj.setNotes(project, 0, "Drum 001", [{ time: 240, note: 37, velocity: 1, length: 10 }]);
  const text = await textOf(project);
  assert.ok(text.includes('"velocity": 1.0'));
  assert.ok(text.includes('"modifierValue2": 0.0'));
  assert.ok(text.includes('"modifierValue6": 1.0'));
});

test("probability is saved, and kept when not sent", async () => {
  const project = await makeProject();
  Xpj.setNotes(project, 0, "Drum 001", [
    { time: 0, note: 36, velocity: 1, length: 100 },
    { time: 240, note: 37, velocity: 1, length: 100, probability: 25 },
  ]);
  assert.deepEqual(notesOf(project).map((e) => e.note.probability), [50, 25]);
});

test("a moved note keeps its other fields", async () => {
  const project = await makeProject();
  notesOf(project)[0].note.articulation = 123;
  Xpj.setNotes(project, 0, "Drum 001", [
    { time: 60, note: 36, velocity: 1, length: 100, sourceTime: 0 },
  ]);
  const [moved] = notesOf(project);
  assert.equal(moved.time, 60);
  assert.equal(moved.note.articulation, 123);
  assert.equal(moved.note.probability, 50);
});

test("a stale source time makes a new note", async () => {
  const project = await makeProject();
  Xpj.setNotes(project, 0, "Drum 001", [
    { time: 60, note: 36, velocity: 1, length: 100, sourceTime: 999 },
  ]);
  assert.deepEqual(notesOf(project).map((e) => [e.time, e.note.probability]), [[60, 100]]);
});

test("removing notes keeps automation", async () => {
  const project = await makeProject();
  Xpj.setNotes(project, 0, "Drum 001", []);
  assert.deepEqual(eventsOf(project).map((e) => e.type), [1]);
});

test("bad notes are rejected without changing the project", async () => {
  const bad = [
    { ...NOTE, time: 7680 },
    { ...NOTE, time: -1 },
    { ...NOTE, note: 128 },
    { ...NOTE, velocity: 0 },
    { ...NOTE, velocity: 1.5 },
    { ...NOTE, length: 0 },
    { ...NOTE, time: 1.5 },
    { ...NOTE, time: "0" },
    { ...NOTE, probability: 101 },
    { ...NOTE, probability: -1 },
    { ...NOTE, probability: 50.5 },
    { ...NOTE, sourceTime: "x" },
    { time: 0 },
    null,
  ];
  for (const note of bad) {
    const project = await makeProject();
    assert.throws(() => Xpj.setNotes(project, 0, "Drum 001", [NOTE, note]), Xpj.XpjError,
      JSON.stringify(note));
    assert.equal(await textOf(project), projectText());
  }
});

test("unknown targets are rejected", async () => {
  const project = await makeProject();
  assert.throws(() => Xpj.setNotes(project, 99, "Drum 001", []), Xpj.XpjError);
  assert.throws(() => Xpj.setNotes(project, 0, "Nope", []), Xpj.XpjError);
});

test("a new sequence is empty and the existing one is untouched", async () => {
  const project = await makeProject();
  const before = JSON.stringify(eventsOf(project));
  Xpj.addSequence(project, 4);
  assert.deepEqual(project.data.sequences.map((s) => s.key), [4, 0]);
  const created = Xpj.findSequence(project, 4);
  assert.equal(created.value.name, "Sequence 05");
  const clip = Xpj.clips(created)["Drum 001"];
  assert.deepEqual(clip.eventList.events, []);
  assert.ok((await textOf(project)).includes("9223372036854775807"));
  assert.equal(JSON.stringify(eventsOf(project)), before);
});

test("used or invalid slots are rejected", async () => {
  const project = await makeProject();
  for (const key of [0, -1, 16, "3", true, 1.5]) {
    assert.throws(() => Xpj.addSequence(project, key), Xpj.XpjError, String(key));
  }
});

test("length updates the sequence and clips, and trims events", async () => {
  const project = await makeProject();
  Xpj.setNotes(project, 0, "Drum 001", [NOTE, { ...NOTE, time: 5000 }]);
  Xpj.setSequenceLength(project, 0, 3840);
  const { value } = Xpj.findSequence(project, 0);
  assert.deepEqual(
    [value.lengthBars, value.lengthPulses, value.loopEndBar, value.loopEndPulses],
    [1, 3840, 1, 3840]);
  const clip = Xpj.clips(Xpj.findSequence(project, 0))["Drum 001"];
  assert.deepEqual([clip.endPulses, clip.loopEndPulses], [3840, 3840]);
  assert.deepEqual(clip.eventList.events.map((e) => e.time), [0, 0]);
});

test("lengths that aren't whole bars are rejected", async () => {
  const project = await makeProject();
  for (const length of [0, 100, 3841, -3840, 3840.5, true, 65 * 3840]) {
    assert.throws(() => Xpj.setSequenceLength(project, 0, length), Xpj.XpjError, String(length));
  }
});

test("edits can create, resize and fill a sequence", async () => {
  const project = await makeProject();
  Xpj.applyEdits(project, [{
    sequence: 6,
    track: "Drum 001",
    create: true,
    lengthPulses: 15360,
    notes: [{ ...NOTE, time: 15000 }],
  }]);
  const reread = await Xpj.parse(await Xpj.serialise(project));
  const sequence = Xpj.view(reread).sequences.find((s) => s.key === 6);
  assert.equal(sequence.lengthPulses, 15360);
  assert.equal(sequence.notes["Drum 001"][0].time, 15000);
  assert.throws(
    () => Xpj.applyEdits(project, [{ sequence: 6, track: "Drum 001", create: true, notes: [] }]),
    Xpj.XpjError);
});

test("project names are checked", () => {
  assert.equal(Xpj.cleanName(" song v2.xpj "), "song v2");
  for (const name of ["../evil", "a/b", "", ".hidden", "a".repeat(80)]) {
    assert.throws(() => Xpj.cleanName(name), Xpj.XpjError, name);
  }
});

// Read-only checks against any real projects kept beside the code, which aren't
// part of the repository.
const libraryDir = path.join(__dirname, "..", "library");
const realProjects = fs.existsSync(libraryDir)
  ? fs.readdirSync(libraryDir).filter((n) => n.endsWith(".xpj") && !n.startsWith("."))
  : [];

for (const name of realProjects) {
  test(`real project ${name} is reproduced exactly`, async () => {
    const bytes = fs.readFileSync(path.join(libraryDir, name));
    const project = await Xpj.parse(bytes);
    assert.equal(project.lossless, true);
    const view = Xpj.view(project);
    for (const sequence of view.sequences) {
      for (const [track, notes] of Object.entries(sequence.notes)) {
        Xpj.setNotes(project, sequence.key, track, notes);
      }
    }
    assert.equal(await textOf(project), await gunzipText(bytes));
  });
}

test("sample project helper is valid", async () => {
  assert.ok((await projectBytes()).length > 0);
});
