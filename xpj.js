"use strict";
/* Read and write MPC Sample .xpj project files.

   An .xpj is gzip-compressed text: five header lines followed by JSON. Numbers
   JavaScript can't reproduce exactly, such as 1.0 or a 64-bit integer, are kept
   as their original text, so an unedited project is rewritten byte for byte. A
   project that can't be reproduced exactly can be viewed but not saved.
*/
const Xpj = (() => {
  const HEADER_LINES = 5;
  const NOTE_EVENT = 3;
  const DATA_SUFFIX = "_[ProjectData]";
  const SEQUENCE_SLOTS = 16;
  const MAX_BARS = 64;

  class XpjError extends Error {}

  const num = (value) => (JSON.isRawJSON(value) ? Number(value.rawJSON) : value);
  // Float fields must stay floats in the file: 1 is written as 1.0.
  const toFloat = (value) =>
    (Number.isInteger(value) ? JSON.rawJSON(value.toFixed(1)) : value);

  function parseJson(text) {
    return JSON.parse(text, (_key, value, context) => {
      if (typeof value === "number" && String(value) !== context.source) {
        return JSON.rawJSON(context.source);
      }
      return value;
    });
  }

  // The MPC writes one value per line with no indentation.
  function serialiseJson(value) {
    if (value === null || typeof value !== "object") {
      return typeof value === "number" ? String(value) : JSON.stringify(value);
    }
    if (JSON.isRawJSON(value)) return value.rawJSON;
    if (Array.isArray(value)) {
      if (!value.length) return "[]";
      return `[\n${value.map(serialiseJson).join(",\n")}\n]`;
    }
    const keys = Object.keys(value);
    if (!keys.length) return "{}";
    const items = keys.map((key) => `${JSON.stringify(key)}: ${serialiseJson(value[key])}`);
    return `{\n${items.join(",\n")}\n}`;
  }

  function deepCopy(value) {
    if (value === null || typeof value !== "object" || JSON.isRawJSON(value)) return value;
    if (Array.isArray(value)) return value.map(deepCopy);
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, deepCopy(v)]));
  }

  // Field values observed on notes recorded by MPC Sample firmware 1.3.0.12.
  function noteTemplate() {
    const note = {
      version: 1,
      note: 36,
      velocity: toFloat(1),
      length: 240,
      probability: 100,
      ratchet: 1,
      articulation: 197,
    };
    const defaults = [0.5, 0.5, 0, 0, 0, 0.5, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0];
    defaults.forEach((value, index) => {
      note[`modifierValue${index}`] = toFloat(value);
      note[`modifierActiveState${index}`] = false;
    });
    note["EnumCerealisationWrapper(selectedModifierType)"] = "Tuning (coarse)";
    return note;
  }

  async function pipe(bytes, transform) {
    const stream = new Blob([bytes]).stream().pipeThrough(transform);
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }

  function textOf(project) {
    return `${project.header.join("\n")}\n${serialiseJson(project.root)}`;
  }

  async function parse(bytes) {
    let text;
    try {
      const raw = await pipe(bytes, new DecompressionStream("gzip"));
      text = new TextDecoder("utf-8", { fatal: true }).decode(raw);
    } catch (error) {
      throw new XpjError(`Not a readable .xpj file: ${error.message}`);
    }
    let bodyStart = 0;
    for (let line = 0; line < HEADER_LINES; line += 1) {
      bodyStart = text.indexOf("\n", bodyStart) + 1;
      if (bodyStart === 0) throw new XpjError("Unexpected .xpj header.");
    }
    const header = text.slice(0, bodyStart - 1).split("\n");
    if (header[0] !== "ACVS") throw new XpjError("Unexpected .xpj header.");
    let root;
    try {
      root = parseJson(text.slice(bodyStart));
    } catch (error) {
      throw new XpjError(`Project data is unreadable: ${error.message}`);
    }
    if (!root.data || !root.data.sequences) throw new XpjError("Project has no sequence data.");
    const project = { header, root, data: root.data };
    project.lossless = textOf(project) === text;
    return project;
  }

  async function serialise(project) {
    if (!project.lossless) {
      throw new XpjError(
        "This project's format couldn't be reproduced exactly, so it won't be saved.");
    }
    return pipe(new TextEncoder().encode(textOf(project)), new CompressionStream("gzip"));
  }

  const isDrumTrack = (track) => track.program && track.program.type === 0 && track.program.drum;

  function padRows(track) {
    const noteMap = (track.program.padNoteMap || {}).noteForPad || {};
    const rows = [];
    track.program.drum.instruments.forEach((instrument, pad) => {
      const note = noteMap[`value${pad}`];
      if (note === undefined) return;
      let sample = "";
      for (const layer of instrument.layersv || []) {
        sample = layer.sampleName || layer.name || "";
        if (sample) break;
      }
      rows.push({ pad, note, sample });
    });
    return rows;
  }

  // Track name -> clip, for the sequence's first clip row.
  function clips(sequence) {
    const maps = sequence.value.trackClipMaps;
    return Object.fromEntries((maps[0] || []).map((entry) => [entry.key, entry.value]));
  }

  function view(project) {
    const { data } = project;
    const tracks = data.tracks.filter(isDrumTrack);
    const sequences = data.sequences.map((sequence) => {
      const { value } = sequence;
      const signature = ((value.timeSignatureTrack || {}).timeSignatures || [])[0]
        || { beatsPerBar: 4, beatLength: 960 };
      const sequenceClips = clips(sequence);
      const notes = {};
      for (const track of tracks) {
        const clip = sequenceClips[track.name];
        notes[track.name] = (clip ? clip.eventList.events : [])
          .filter((event) => event.type === NOTE_EVENT)
          .map((event) => ({
            time: event.time,
            note: event.note.note,
            velocity: num(event.note.velocity),
            length: event.note.length,
            probability: event.note.probability ?? 100,
          }));
      }
      return {
        key: sequence.key,
        name: value.name,
        bpm: num(value.bpm),
        lengthPulses: value.lengthPulses,
        beatsPerBar: signature.beatsPerBar,
        beatLength: signature.beatLength,
        notes,
      };
    });
    sequences.sort((a, b) => a.key - b.key);
    return {
      firmware: project.header[1],
      bpm: data.masterTempoEnabled ? num(data.masterTempo) : null,
      currentSequence: data.currentSequence,
      tracks: tracks.map((track) => ({ name: track.name, pads: padRows(track) })),
      sequences,
      canSave: project.lossless,
    };
  }

  function findSequence(project, key) {
    const found = project.data.sequences.find((sequence) => sequence.key === key);
    if (!found) throw new XpjError(`No sequence with key ${JSON.stringify(key)}.`);
    return found;
  }

  function cleanNote(raw, lengthPulses) {
    const show = JSON.stringify(raw);
    if (raw === null || typeof raw !== "object") throw new XpjError(`Bad note: ${show}`);
    const { time, note, velocity, length, probability } = raw;
    if (![time, note, length].every(Number.isInteger)) {
      throw new XpjError(`Note has a missing or non-integer value: ${show}`);
    }
    if (typeof velocity !== "number" || !(velocity > 0 && velocity <= 1)) {
      throw new XpjError(`Velocity out of range: ${show}`);
    }
    if (time < 0 || time >= lengthPulses) throw new XpjError(`Note time is outside the sequence: ${show}`);
    if (note < 0 || note > 127) throw new XpjError(`Note number out of range: ${show}`);
    if (length < 1) throw new XpjError(`Note length out of range: ${show}`);
    if (probability !== undefined && probability !== null
        && !(Number.isInteger(probability) && probability >= 0 && probability <= 100)) {
      throw new XpjError(`Probability out of range: ${show}`);
    }
    // A note moved in the grid says where it came from, to keep its other fields.
    const sourceTime = raw.sourceTime ?? time;
    if (!Number.isInteger(sourceTime)) throw new XpjError(`Note has a bad source time: ${show}`);
    return { time, note, velocity, length, probability, sourceTime };
  }

  function newNoteEvent(time, note, velocity, length) {
    return {
      version: 2,
      time,
      type: NOTE_EVENT,
      channel: 0,
      selected: false,
      muted: false,
      invented: false,
      note: { ...noteTemplate(), note, velocity: toFloat(velocity), length },
    };
  }

  /* Replace one track's notes in one sequence. Non-note events are kept, and notes
     that still exist keep every field the grid doesn't edit. */
  function setNotes(project, sequenceKey, trackName, notes) {
    const sequence = findSequence(project, sequenceKey);
    const clip = clips(sequence)[trackName];
    if (!clip) throw new XpjError(`No track named ${JSON.stringify(trackName)} in this sequence.`);
    const cleaned = notes.map((note) => cleanNote(note, sequence.value.lengthPulses));

    const kept = [];
    const existing = new Map();
    for (const event of clip.eventList.events) {
      if (event.type === NOTE_EVENT) {
        const key = `${event.time}:${event.note.note}`;
        if (!existing.has(key)) existing.set(key, []);
        existing.get(key).push(event);
      } else {
        kept.push(event);
      }
    }
    for (const item of cleaned) {
      const matches = existing.get(`${item.sourceTime}:${item.note}`);
      let event;
      if (matches && matches.length) {
        event = matches.shift();
        event.time = item.time;
        if (num(event.note.velocity) !== item.velocity) event.note.velocity = toFloat(item.velocity);
        event.note.length = item.length;
      } else {
        event = newNoteEvent(item.time, item.note, item.velocity, item.length);
      }
      if (item.probability !== undefined && item.probability !== null) {
        event.note.probability = item.probability;
      }
      kept.push(event);
    }
    // Stable, so events sharing a time keep automation ahead of notes.
    kept.sort((a, b) => a.time - b.time);
    clip.eventList.events = kept;
  }

  function pulsesPerBar(value) {
    const signature = value.timeSignatureTrack.timeSignatures[0];
    return signature.beatsPerBar * signature.beatLength;
  }

  // Events past the new end are dropped.
  function setSequenceLength(project, key, lengthPulses) {
    const { value } = findSequence(project, key);
    const perBar = pulsesPerBar(value);
    if (!Number.isInteger(lengthPulses) || lengthPulses < perBar
        || lengthPulses % perBar || lengthPulses > MAX_BARS * perBar) {
      throw new XpjError(`Sequence length must be 1-${MAX_BARS} whole bars.`);
    }
    if (lengthPulses === value.lengthPulses) return;
    const bars = lengthPulses / perBar;
    Object.assign(value, {
      lengthBars: bars, lengthPulses, loopEndBar: bars, loopEndPulses: lengthPulses,
    });
    if (value.loopStartPulses >= lengthPulses) {
      value.loopStartBar = 0;
      value.loopStartPulses = 0;
    }
    for (const row of value.trackClipMaps) {
      for (const { value: clip } of row) {
        for (const field of ["endPulses", "loopEndPulses"]) {
          if (field in clip) clip[field] = lengthPulses;
        }
        if (clip.eventList) {
          clip.eventList.events = clip.eventList.events.filter((e) => e.time < lengthPulses);
        }
      }
    }
  }

  // Create an empty sequence in a free slot (key 0 is pad 1 on the MPC).
  function addSequence(project, key) {
    if (!Number.isInteger(key) || key < 0 || key >= SEQUENCE_SLOTS) {
      throw new XpjError(`Sequence slot out of range: ${JSON.stringify(key)}.`);
    }
    const { sequences } = project.data;
    if (sequences.some((sequence) => sequence.key === key)) {
      throw new XpjError(`Sequence slot ${key + 1} is already used.`);
    }
    if (!sequences.length) throw new XpjError("Project has no sequence to use as a template.");
    const value = deepCopy(sequences[0].value);
    value.name = `Sequence ${String(key + 1).padStart(2, "0")}`;
    if (value.seqEventList && value.seqEventList.events) value.seqEventList.events = [];
    for (const row of value.trackClipMaps) {
      for (const { value: clip } of row) {
        if (clip.eventList) clip.eventList.events = [];
      }
    }
    const keys = sequences.map((sequence) => sequence.key);
    const descending = keys.every((k, i) => i === 0 || keys[i - 1] >= k);
    sequences.push({ key, value });
    // Projects saved by the MPC list sequences from highest key to lowest.
    if (descending) sequences.sort((a, b) => b.key - a.key);
  }

  /* Each edit is {sequence: key, track: name, notes: [...]} and may also have
     create: true and lengthPulses: n. */
  function applyEdits(project, edits) {
    for (const edit of edits) {
      if (edit === null || typeof edit !== "object" || !Array.isArray(edit.notes)) {
        throw new XpjError("Bad edit.");
      }
      if (edit.create) addSequence(project, edit.sequence);
      if (edit.lengthPulses !== undefined) {
        setSequenceLength(project, edit.sequence, edit.lengthPulses);
      }
      setNotes(project, edit.sequence, edit.track, edit.notes);
    }
  }

  function cleanName(name) {
    let cleaned = String(name ?? "").trim();
    if (cleaned.toLowerCase().endsWith(".xpj")) cleaned = cleaned.slice(0, -4);
    if (!/^[A-Za-z0-9][A-Za-z0-9 _.-]{0,63}$/.test(cleaned)) {
      throw new XpjError("Project names can use letters, numbers, spaces, '_', '-' and '.'");
    }
    return cleaned;
  }

  return {
    DATA_SUFFIX,
    SEQUENCE_SLOTS,
    XpjError,
    addSequence,
    applyEdits,
    cleanName,
    clips,
    findSequence,
    parse,
    serialise,
    setNotes,
    setSequenceLength,
    view,
  };
})();

if (typeof module !== "undefined") module.exports = Xpj;
