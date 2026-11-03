"use strict";
/* An in-memory stand-in for the browser's folder handles, and a sample project. */
const Xpj = require("../xpj.js");

function notFound(name) {
  return Object.assign(new Error(`${name} not found`), { name: "NotFoundError" });
}

class FakeFile {
  constructor(name, parent) {
    this.kind = "file";
    this.name = name;
    this.parent = parent;
    this.bytes = new Uint8Array();
    this.lastModified = 1;
  }

  async getFile() {
    const blob = new Blob([this.bytes]);
    return {
      size: this.bytes.length,
      lastModified: this.lastModified,
      arrayBuffer: () => blob.arrayBuffer(),
      text: () => blob.text(),
      stream: () => blob.stream(),
    };
  }

  async createWritable() {
    const file = this;
    const chunks = [];
    const commit = () => {
      const size = chunks.reduce((total, chunk) => total + chunk.length, 0);
      file.bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) {
        file.bytes.set(chunk, offset);
        offset += chunk.length;
      }
      file.lastModified += 1;
      if (file.parent.appleDouble) file.parent.children.set(`._${file.name}`, new FakeFile(`._${file.name}`, file.parent));
    };
    // The browser's writable is a real WritableStream with an added write().
    const stream = new WritableStream({
      write(chunk) { chunks.push(new Uint8Array(chunk)); },
      close: commit,
    });
    stream.write = async (bytes) => {
      const writer = stream.getWriter();
      await writer.write(bytes);
      writer.releaseLock();
    };
    return stream;
  }
}

class FakeDir {
  constructor(name = "root") {
    this.kind = "directory";
    this.name = name;
    this.children = new Map();
    this.permission = "granted";
  }

  async getDirectoryHandle(name, { create = false } = {}) {
    const child = this.children.get(name);
    if (child && child.kind === "directory") return child;
    if (child) throw Object.assign(new Error("not a folder"), { name: "TypeMismatchError" });
    if (!create) throw notFound(name);
    const made = new FakeDir(name);
    made.appleDouble = this.appleDouble;
    this.children.set(name, made);
    return made;
  }

  async getFileHandle(name, { create = false } = {}) {
    const child = this.children.get(name);
    if (child && child.kind === "file") return child;
    if (child) throw Object.assign(new Error("not a file"), { name: "TypeMismatchError" });
    if (!create) throw notFound(name);
    const made = new FakeFile(name, this);
    this.children.set(name, made);
    return made;
  }

  async removeEntry(name) {
    if (!this.children.delete(name)) throw notFound(name);
  }

  async* keys() { yield* [...this.children.keys()]; }

  async* entries() { yield* [...this.children.entries()]; }

  async queryPermission() { return this.permission; }

  async requestPermission() { this.permission = "granted"; return "granted"; }
}

function fakeStore() {
  const values = new Map();
  return {
    values,
    get: async (key) => values.get(key),
    // Drafts are copied as IndexedDB would. Folder handles can't be cloned here.
    set: async (key, value) => {
      values.set(key, key.startsWith("draft:") ? structuredClone(value) : value);
    },
    remove: async (key) => { values.delete(key); },
  };
}

const raw = (text) => JSON.rawJSON(text);

function noteEvent(time, note, probability = 100) {
  return {
    version: 2,
    time,
    type: 3,
    channel: 0,
    note: {
      version: 1,
      note,
      velocity: raw("1.0"),
      length: 100,
      probability,
      ratchet: 1,
      articulation: 197,
    },
  };
}

const automationEvent = (time) => ({ version: 2, time, type: 1, automation: { note: 45 } });

// Built as text, as the MPC writes it, so number formats are real.
function projectText() {
  const noteMap = {};
  const instruments = [];
  for (let pad = 0; pad < 128; pad += 1) {
    noteMap[`value${pad}`] = (36 + pad) % 128;
    instruments.push({ layersv: [{ sampleName: pad === 0 ? "Kick" : "" }] });
  }
  const root = {
    data: {
      masterTempoEnabled: true,
      masterTempo: raw("90.0"),
      tracks: [
        {
          name: "Drum 001",
          colour: 1,
          program: {
            name: "Drum 001", type: 0, padNoteMap: { noteForPad: noteMap }, drum: { instruments },
          },
        },
        { name: "Submix 1", program: { type: 8 } },
      ],
      currentSequence: 0,
      sequences: [{
        key: 0,
        value: {
          name: "Sequence 01",
          bpm: raw("120.0"),
          lengthBars: 2,
          loopStartBar: 0,
          loopEndBar: 2,
          lengthPulses: 7680,
          loopStartPulses: 0,
          loopEndPulses: 7680,
          timeSignatureTrack: { timeSignatures: [{ beatsPerBar: 4, beatLength: 960, barStart: 0 }] },
          seqEventList: { events: [] },
          trackClipMaps: [[
            {
              key: "Drum 001",
              value: {
                name: "Drum 001",
                endPulses: 7680,
                loopEndPulses: 7680,
                eventList: {
                  length: raw("9223372036854775807"),
                  events: [automationEvent(0), noteEvent(0, 36, 50)],
                },
              },
            },
            { key: "Submix 1", value: { name: "Submix 1" } },
          ]],
        },
      }],
    },
  };
  // JSON.stringify with indent 0 would drop the MPC's line breaks.
  const write = (value) => {
    if (value === null || typeof value !== "object") return JSON.stringify(value);
    if (JSON.isRawJSON(value)) return value.rawJSON;
    if (Array.isArray(value)) return value.length ? `[\n${value.map(write).join(",\n")}\n]` : "[]";
    const keys = Object.keys(value);
    if (!keys.length) return "{}";
    return `{\n${keys.map((k) => `${JSON.stringify(k)}: ${write(value[k])}`).join(",\n")}\n}`;
  };
  return `ACVS\n1.3.0.12\nSerialisableProjectData\njson\nLinux\n${write(root)}`;
}

async function gzip(text) {
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function gunzipText(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
  return new Response(stream).text();
}

const projectBytes = () => gzip(projectText());
const makeProject = async () => Xpj.parse(await projectBytes());

module.exports = {
  FakeDir, fakeStore, gunzipText, gzip, makeProject, projectBytes, projectText,
};
