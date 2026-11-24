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
  const again = await backend.copyToCard({ path: saved.path });
  assert.equal(again.replaced, true, "a second copy replaces the card's");
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

test("saving to the card replaces the card project in place and backs up the old one", async () => {
  await backend.setCard(cardRoot);
  const opened = await backend.open({ path: "card:song" });
  const notes = [{ time: 0, note: 36, velocity: 1, length: 60, probability: 100 }];
  const saved = await backend.saveToCard({
    path: opened.path, edits: [{ sequence: 0, track: "Drum 001", notes }],
  });
  assert.equal(saved.path, "library:song");
  const onCard = await read(card, "song.xpj");
  assert.deepEqual(Xpj.view(await Xpj.parse(onCard)).sequences[0].notes["Drum 001"], notes);
  assert.deepEqual(await read(library, "song.xpj"), onCard);
  const backupDir = await library.getDirectoryHandle("backups");
  const backup = (await names(backupDir)).find((n) => /^song-\d+\.xpj$/.test(n));
  assert.deepEqual(await read(backupDir, backup), original);
  // Samples on the card are left alone, and no second project appears.
  assert.deepEqual(await names(await card.getDirectoryHandle("song_[ProjectData]")), ["._kick.wav", "kick.wav"]);
  assert.deepEqual((await backend.projects()).card.map((p) => [p.name, p.changed]), [["song", false]]);
});

test("saving to the card refuses when the card project changed or is missing", async () => {
  await backend.setCard(cardRoot);
  const { path } = await backend.open({ path: "card:song" });
  const changed = await gzip(projectText().replace('"sampleName": ""', '"sampleName": "New Snare"'));
  await write(card, "song.xpj", changed);
  await assert.rejects(backend.saveToCard({ path, edits: [] }), /changed since/);
  assert.deepEqual(await read(card, "song.xpj"), changed);
  await card.removeEntry("song.xpj");
  await assert.rejects(backend.saveToCard({ path, edits: [] }), /no project called/);
});

test("a bad edit leaves the card project as it was", async () => {
  await backend.setCard(cardRoot);
  const { path } = await backend.open({ path: "card:song" });
  const edits = [{ sequence: 0, track: "Drum 001", notes: [{ time: -1, note: 36, velocity: 1, length: 1 }] }];
  await assert.rejects(backend.saveToCard({ path, edits }), Xpj.XpjError);
  assert.deepEqual(await read(card, "song.xpj"), original);
});

test("choosing a library folder copies the projects across and is used from then on", async () => {
  await backend.setCard(cardRoot);
  await backend.open({ path: "card:song" });
  const folder = new FakeDir("MPC Library");
  folder.permission = "granted";
  await write(folder, "other.xpj", original);
  const result = await backend.setLibraryFolder(folder);
  assert.deepEqual(result, { copied: ["song"], skipped: [] });
  assert.deepEqual(await read(folder, "song.xpj"), original);
  assert.deepEqual(await names(await folder.getDirectoryHandle("song_[ProjectData]")), ["kick.wav"]);
  const listing = await backend.projects();
  assert.deepEqual(listing.library.map((p) => p.name), ["other", "song"]);
  assert.deepEqual(listing.libraryFolder, { status: "ready", name: "MPC Library" });

  const saved = await backend.save({ path: "library:song", name: "song-v2", edits: [] });
  assert.equal(saved.path, "library:song-v2");
  assert.ok((await names(folder)).includes("song-v2.xpj"));
  assert.ok(!(await names(library)).includes("song-v2.xpj"));
});

test("a library folder waiting for permission hides its projects until allowed", async () => {
  const folder = new FakeDir("MPC Library");
  folder.permission = "granted";
  await backend.setLibraryFolder(folder);
  await write(folder, "song.xpj", original);
  const later = Backend.createBackend({ library: new FakeDir("browser"), kv });
  await later.loadCard();
  folder.permission = "prompt";
  const listing = await later.projects();
  assert.deepEqual(listing.library, []);
  assert.equal(listing.libraryFolder.status, "permission");
  await assert.rejects(later.open({ path: "library:song" }), /library folder/);
  await later.requestLibraryPermission();
  assert.deepEqual((await later.projects()).library.map((p) => p.name), ["song"]);
});

test("the card can't be the library folder", async () => {
  await backend.setCard(cardRoot);
  cardRoot.permission = "granted";
  await assert.rejects(backend.setLibraryFolder(cardRoot), /card folder/);
});

test("saving in place updates the library project and backs up the old one", async () => {
  await backend.setCard(cardRoot);
  const { path } = await backend.open({ path: "card:song" });
  const notes = [{ time: 480, note: 38, velocity: 1, length: 120, probability: 100 }];
  const saved = await backend.saveInPlace({ path, edits: [{ sequence: 0, track: "Drum 001", notes }] });
  assert.equal(saved.path, "library:song");
  const view = Xpj.view(await Xpj.parse(await read(library, "song.xpj")));
  assert.deepEqual(view.sequences[0].notes["Drum 001"], notes);
  const backupDir = await library.getDirectoryHandle("backups");
  assert.ok((await names(backupDir)).some((n) => /^song-\d+\.xpj$/.test(n)));
  assert.deepEqual(await read(card, "song.xpj"), original, "the card isn't changed");
});

test("a project saved here isn't replaced from the card, and Save to card takes it there", async () => {
  await backend.setCard(cardRoot);
  const { path } = await backend.open({ path: "card:song" });
  const first = [{ time: 0, note: 36, velocity: 1, length: 60, probability: 100 }];
  await backend.saveInPlace({ path, edits: [{ sequence: 0, track: "Drum 001", notes: first }] });
  assert.deepEqual((await backend.projects()).card.map((p) => p.changed), [false], "not seen as changed on the card");
  await backend.open({ path: "card:song" });
  assert.deepEqual(Xpj.view(await Xpj.parse(await read(library, "song.xpj"))).sequences[0].notes["Drum 001"], first, "kept");
  const second = [...first, { time: 240, note: 38, velocity: 1, length: 60, probability: 100 }];
  await backend.saveToCard({ path, edits: [{ sequence: 0, track: "Drum 001", notes: second }] });
  assert.deepEqual(Xpj.view(await Xpj.parse(await read(card, "song.xpj"))).sequences[0].notes["Drum 001"], second);
  assert.equal(await kv.get("ahead:song"), undefined);
});

test("Save to card won't overwrite a card project the MPC changed after a save here", async () => {
  await backend.setCard(cardRoot);
  const { path } = await backend.open({ path: "card:song" });
  await backend.saveInPlace({ path, edits: [{ sequence: 0, track: "Drum 001", notes: [] }] });
  const changed = await gzip(projectText().replace('"sampleName": ""', '"sampleName": "New Snare"'));
  await write(card, "song.xpj", changed);
  await assert.rejects(backend.saveToCard({ path, edits: [] }), /changed on the MPC/);
  assert.deepEqual(await read(card, "song.xpj"), changed);
});

test("Copy to card replaces a project of the same name, backing up the card's and keeping its samples", async () => {
  await backend.setCard(cardRoot);
  const { path } = await backend.open({ path: "card:song" });
  await write(await card.getDirectoryHandle("song_[ProjectData]"), "only-on-card.wav", text("card"));
  const notes = [{ time: 0, note: 36, velocity: 1, length: 60, probability: 100 }];
  await backend.saveInPlace({ path, edits: [{ sequence: 0, track: "Drum 001", notes }] });
  const copied = await backend.copyToCard({ path });
  assert.deepEqual(copied, { name: "song", replaced: true });
  assert.deepEqual(await read(card, "song.xpj"), await read(library, "song.xpj"));
  assert.ok((await names(await card.getDirectoryHandle("song_[ProjectData]"))).includes("only-on-card.wav"));
  const backupDir = await library.getDirectoryHandle("backups");
  assert.ok((await names(backupDir)).filter((n) => /^song-\d+\.xpj$/.test(n)).length >= 1);
  assert.equal(await kv.get("ahead:song"), undefined);
});

test("a sequence's name is saved into the project", async () => {
  await backend.setCard(cardRoot);
  const { path } = await backend.open({ path: "card:song" });
  await backend.saveInPlace({ path, edits: [{ sequence: 0, track: "Drum 001", notes: [], name: "Verse groove" }] });
  const view = Xpj.view(await Xpj.parse(await read(library, "song.xpj")));
  assert.equal(view.sequences[0].name, "Verse groove");
});
