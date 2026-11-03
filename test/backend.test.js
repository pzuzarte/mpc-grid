"use strict";
const assert = require("node:assert/strict");
const { beforeEach, test } = require("node:test");
const Backend = require("../backend.js");
const Xpj = require("../xpj.js");
const {
  FakeDir, fakeStore, gzip, makeProject, projectBytes, projectText,
} = require("./helpers.js");

let library;
let card;
let cardRoot;
let kv;
let backend;
let original;

async function write(dir, name, bytes) {
  const handle = await dir.getFileHandle(name, { create: true });
  const writable = await handle.createWritable();
  await writable.write(bytes);
  await writable.close();
}

const read = async (dir, name) =>
  new Uint8Array(await (await (await dir.getFileHandle(name)).getFile()).arrayBuffer());
const text = (value) => new TextEncoder().encode(value);
const names = async (dir) => {
  const found = [];
  for await (const name of dir.keys()) found.push(name);
  return found.sort();
};

beforeEach(async () => {
  library = new FakeDir("library");
  cardRoot = new FakeDir("CARD");
  const sample = await cardRoot.getDirectoryHandle("MPC-Sample", { create: true });
  card = await sample.getDirectoryHandle("Projects", { create: true });
  original = await projectBytes();
  await write(card, "song.xpj", original);
  const data = await card.getDirectoryHandle("song_[ProjectData]", { create: true });
  await write(data, "kick.wav", text("RIFF"));
  await write(data, "._kick.wav", text("junk"));
  kv = fakeStore();
  backend = Backend.createBackend({ library, kv });
});

test("opening a card project copies it to the library once, with samples", async () => {
  await backend.setCard(cardRoot);
  const opened = await backend.open({ path: "card:song" });
  assert.equal(opened.path, "library:song");
  assert.equal(opened.updated, false);
  assert.deepEqual(await read(library, "song.xpj"), original);
  const data = await library.getDirectoryHandle("song_[ProjectData]");
  assert.deepEqual(await names(data), ["kick.wav"]);
  const again = await backend.open({ path: "card:song" });
  assert.equal(again.updated, false);
  assert.deepEqual((await backend.projects()).library.map((p) => p.name), ["song"]);
});

test("saving makes a new project, leaving originals alone, then copies to the card", async () => {
  await backend.setCard(cardRoot);
  const opened = await backend.open({ path: "card:song" });
  const notes = [{ time: 240, note: 37, velocity: 0.5, length: 120, probability: 75 }];
  const saved = await backend.save({
    path: opened.path,
    name: "song-v2",
    edits: [{ sequence: 0, track: "Drum 001", notes }],
  });
  assert.equal(saved.path, "library:song-v2");
  const view = Xpj.view(await Xpj.parse(await read(library, "song-v2.xpj")));
  assert.deepEqual(view.sequences[0].notes["Drum 001"], notes);
  assert.deepEqual(await read(card, "song.xpj"), original);
  assert.deepEqual(await read(library, "song.xpj"), original);

  await backend.copyToCard({ path: saved.path });
  assert.deepEqual(await read(card, "song-v2.xpj"), await read(library, "song-v2.xpj"));
  const copied = await card.getDirectoryHandle("song-v2_[ProjectData]");
  assert.deepEqual(await names(copied), ["kick.wav"]);
  await assert.rejects(backend.copyToCard({ path: saved.path }), Xpj.XpjError);
});

test("saving never overwrites and rejects unsafe names", async () => {
  await backend.setCard(cardRoot);
  const { path } = await backend.open({ path: "card:song" });
  await assert.rejects(backend.save({ path, name: "song", edits: [] }), Xpj.XpjError);
  await assert.rejects(backend.save({ path, name: "../evil", edits: [] }), Xpj.XpjError);
  assert.deepEqual(await read(library, "song.xpj"), original);
});

test("a bad edit saves nothing", async () => {
  await backend.setCard(cardRoot);
  const { path } = await backend.open({ path: "card:song" });
  const edits = [{
    sequence: 0, track: "Drum 001", notes: [{ time: -1, note: 36, velocity: 1, length: 1 }],
  }];
  await assert.rejects(backend.save({ path, name: "bad", edits }), Xpj.XpjError);
  assert.ok(!(await names(library)).some((n) => n.startsWith("bad")));
});

test("a project saved on the MPC replaces the library copy and keeps a backup", async () => {
  await backend.setCard(cardRoot);
  await backend.open({ path: "card:song" });
  const libraryData = await library.getDirectoryHandle("song_[ProjectData]");
  await write(libraryData, "old.wav", text("old"));

  const changedText = projectText().replace('"sampleName": ""', '"sampleName": "New Snare"');
  const changed = await gzip(changedText);
  await write(card, "song.xpj", changed);
  await write(await card.getDirectoryHandle("song_[ProjectData]"), "new.wav", text("new"));

  const listing = await backend.projects();
  assert.equal(listing.card[0].changed, true);
  assert.deepEqual(listing.library.map((p) => p.name), ["song"]);

  const reopened = await backend.open({ path: "card:song" });
  assert.equal(reopened.updated, true);
  assert.equal(reopened.path, "library:song");
  assert.equal(reopened.view.tracks[0].pads[1].sample, "New Snare");
  assert.deepEqual(await read(library, "song.xpj"), changed);
  assert.deepEqual(await names(await library.getDirectoryHandle("song_[ProjectData]")),
    ["kick.wav", "new.wav"]);

  const backups = await library.getDirectoryHandle("backups");
  const backupName = (await names(backups)).find((n) => n.endsWith(".xpj"));
  assert.deepEqual(await read(backups, backupName), original);
  const backupData = await backups.getDirectoryHandle(`${backupName.slice(0, -4)}_[ProjectData]`);
  assert.ok((await names(backupData)).includes("old.wav"));

  assert.equal((await backend.projects()).card[0].changed, false);
  assert.ok(!(await names(library)).some((n) => n.includes("incoming")));
});

test("an unreadable card version leaves the library copy alone", async () => {
  await backend.setCard(cardRoot);
  await backend.open({ path: "card:song" });
  await write(card, "song.xpj", text("half written"));
  await assert.rejects(backend.open({ path: "card:song" }), Xpj.XpjError);
  assert.deepEqual(await read(library, "song.xpj"), original);
});

test("only recent backups are kept", async () => {
  await backend.setCard(cardRoot);
  await backend.open({ path: "card:song" });
  for (let round = 0; round < 5; round += 1) {
    await write(card, "song.xpj", await gzip(projectText().replace("Kick", `Kick ${round}`)));
    await backend.open({ path: "card:song" });
    await new Promise((resolve) => { setTimeout(resolve, 2); });
  }
  const backups = await library.getDirectoryHandle("backups");
  assert.equal((await names(backups)).filter((n) => n.endsWith(".xpj")).length, 3);
});

test("the card folder can be the card, MPC-Sample, or the projects folder", async () => {
  for (const folder of [cardRoot, await cardRoot.getDirectoryHandle("MPC-Sample"), card]) {
    await backend.setCard(folder);
    const listing = await backend.projects();
    assert.equal(listing.cardStatus, "ready");
    assert.deepEqual(listing.card.map((p) => p.name), ["song"]);
  }
});

test("card status covers no card, needs permission, and not mounted", async () => {
  assert.equal((await backend.projects()).cardStatus, "none");
  await backend.setCard(cardRoot);
  cardRoot.permission = "prompt";
  const asking = await backend.projects();
  assert.equal(asking.cardStatus, "permission");
  assert.equal(asking.cardMounted, false);
  await backend.requestCardPermission();
  assert.equal((await backend.projects()).cardStatus, "ready");
  const empty = new FakeDir("empty");
  await backend.setCard(empty);
  const missing = await backend.projects();
  assert.equal(missing.cardStatus, "missing");
  await assert.rejects(backend.open({ path: "card:song" }), Xpj.XpjError);
});

test("the chosen card folder is remembered", async () => {
  await backend.setCard(cardRoot);
  const next = Backend.createBackend({ library, kv });
  await next.loadCard();
  assert.equal((await next.projects()).cardName, cardRoot.name);
});

test("hidden files macOS adds to the card are removed after writing", async () => {
  await backend.setCard(cardRoot);
  const { path } = await backend.open({ path: "card:song" });
  card.appleDouble = true;
  const saved = await backend.save({ path, name: "song-v2", edits: [] });
  await backend.copyToCard({ path: saved.path });
  assert.deepEqual((await names(card)).filter((n) => n.startsWith("._")), []);
  const data = await card.getDirectoryHandle("song-v2_[ProjectData]");
  assert.deepEqual((await names(data)).filter((n) => n.startsWith("._")), []);
});

test("drafts round trip, clear on save, and import from the earlier version", async () => {
  const draft = { sequences: [{ key: 3 }], dirty: [3], currentKey: 3 };
  await backend.writeDraft({ name: "song", draft });
  assert.deepEqual((await backend.readDraft({ name: "song" })).draft, draft);
  await backend.setCard(cardRoot);
  const { path } = await backend.open({ path: "card:song" });
  assert.deepEqual((await backend.readDraft({ name: "song" })).draft, draft);
  await backend.save({ path, name: "song-v2", edits: [] });
  assert.equal((await backend.readDraft({ name: "song" })).draft, null);

  const old = new FakeDir("library");
  await write(old, "other.xpj", original);
  const drafts = await old.getDirectoryHandle("drafts", { create: true });
  await write(drafts, "other.json", text(JSON.stringify(draft)));
  await backend.setCard(old);
  await backend.open({ path: "card:other" });
  assert.deepEqual((await backend.readDraft({ name: "other" })).draft, draft);
});

test("unknown project paths are refused", async () => {
  await assert.rejects(backend.open({ path: "../../etc" }), Xpj.XpjError);
  await assert.rejects(backend.open({ path: "library:nope" }), Xpj.XpjError);
  await assert.rejects(
    backend.save({ path: "card:song", name: "x", edits: [] }), Xpj.XpjError);
});

test("sample project helper parses", async () => {
  assert.ok((await makeProject()).lossless);
});
