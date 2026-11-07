"use strict";
/* Records notes into the grid from any MIDI input, on every channel or just one. While the
   pattern plays, notes land on the nearest step and last as long as they're held, or a set length, and each
   pass round the loop adds to the last. A click can be played on each beat. While stopped, each key adds a note and moves on a
   step. Notes from another keyboard are passed on to the instrument while recording, so you
   hear what you play. The same file is used by S-1 Grid, Protein Grid, Bass Station Grid and
   MPC Grid. */
const Recorder = (() => {
  const ANY = "";
  const ECHO_WINDOW_MS = 40; // A note this close to one we sent is the instrument echoing it.
  const CHORD_WINDOW_MS = 80; // Keys this close together count as one chord in step entry.

  // Note on or off from the chosen input and channel. Inputs are kept by name, which
  // stays the same between visits.
  function accepts(choice, portName, status) {
    const kind = status & 0xF0;
    if (kind !== 0x80 && kind !== 0x90) return false;
    if (choice.input !== ANY && choice.input !== portName) return false;
    return !choice.channel || (status & 0x0F) === choice.channel - 1;
  }

  const wrap = (pulse, length) => ((pulse % length) + length) % length;

  function nearestStep(pulse, resolution, length) {
    return wrap(Math.round(pulse / resolution) * resolution, length);
  }

  // How long a key was held, as played rather than rounded to steps, ending at the
  // pattern's end at the latest. A quick tap still gets an eighth of a step.
  function heldLength(fromPulse, toPulse, time, resolution, length) {
    const held = Math.round(wrap(toPulse - fromPulse, length));
    return Math.min(Math.max(Math.round(resolution / 8), held), length - time);
  }

  function readChoice(key) {
    try {
      const saved = JSON.parse(localStorage.getItem(key) || "null");
      if (saved && typeof saved.input === "string" && Number.isInteger(saved.channel)) return saved;
    } catch {
      // Private windows can refuse storage, so the choice starts fresh.
    }
    return { input: ANY, channel: 0 };
  }

  /* api supplies the pattern and how to show changes:
     notes() the current pattern's notes, makeNote({time, note, velocity, length}),
     resolution(), length(), playing(), pulseAt(timeStamp), startStep(), moveCursor(time),
     fixedLength(time) the length every recorded note gets, or null to keep how long it's held,
     begin() before a take, for Undo, added(item), lengthened(item), status(text, isError),
     thru(data) to pass a note to the instrument, and isInstrument(port), its own keys. */
  function create(api, { storageKey, button, input, channel }) {
    const recorder = { on: false, choice: readChoice(storageKey) };
    const open = new Map();
    const passed = new Set();
    const recent = [];
    let last = 0;
    let step = 0;

    const save = () => {
      try {
        localStorage.setItem(storageKey, JSON.stringify(recorder.choice));
      } catch {
        // It's just not remembered.
      }
    };

    function render() {
      button.setAttribute("aria-pressed", String(recorder.on));
    }

    // Fills the input list, keeping a chosen input that isn't connected right now.
    recorder.refresh = (midi) => {
      const names = midi ? [...midi.inputs.values()].map((port) => port.name) : [];
      const options = [new Option("Any input", ANY), ...names.map((name) => new Option(name, name))];
      if (recorder.choice.input !== ANY && !names.includes(recorder.choice.input)) {
        options.push(new Option(`${recorder.choice.input} (not connected)`, recorder.choice.input));
      }
      input.replaceChildren(...options);
      input.value = recorder.choice.input;
    };

    recorder.toggle = () => {
      if (recorder.on) {
        recorder.on = false;
        open.clear();
        render();
        api.status("Stopped recording.");
        return;
      }
      api.begin();
      recorder.on = true;
      last = 0;
      step = api.startStep();
      render();
      if (api.playing()) {
        api.status("Recording. Notes land on the nearest step, and each time round the loop adds more. Undo takes back the whole take.");
      } else {
        api.moveCursor(step);
        api.status("Step recording. Each key adds a note and moves on a step. Press Play to record in time instead.");
      }
    };

    // Notes this page plays, so the instrument echoing them back isn't recorded.
    recorder.sent = (note, at) => {
      if (!recorder.on) return;
      recent.push({ note, at });
      if (recent.length > 64) recent.shift();
    };

    function noteOn(note, velocity, at) {
      let time;
      if (api.playing()) {
        time = nearestStep(api.pulseAt(at), api.resolution(), api.length());
      } else {
        const chord = at - last < CHORD_WINDOW_MS;
        if (!chord && last) {
          step = (step + api.resolution()) % api.length();
          api.moveCursor(step);
        }
        time = step;
        last = at;
      }
      const fixed = api.fixedLength(time);
      const notes = api.notes();
      const existing = notes.find((n) => n.note === note && n.time === time);
      const item = existing || api.makeNote({ time, note, velocity: velocity / 127, length: fixed ?? api.resolution() });
      if (existing && fixed !== null) existing.length = fixed;
      if (!existing) {
        notes.push(item);
        notes.sort((a, b) => a.time - b.time || a.note - b.note);
      }
      // A note given a set length keeps it, whenever the key is let go.
      open.set(note, { item, pulse: api.playing() && fixed === null ? api.pulseAt(at) : null });
      api.added(item);
    }

    function noteOff(note, at) {
      const held = open.get(note);
      if (!held) return;
      open.delete(note);
      if (!api.playing() || held.pulse === null) return;
      held.item.length = heldLength(held.pulse, api.pulseAt(at), held.item.time, api.resolution(), api.length());
      api.lengthened(held.item);
    }

    // Returns true if the message was a note from the chosen input, whether or not it was recorded.
    recorder.message = (event, port) => {
      const [status, note, velocity] = event.data;
      if (!accepts(recorder.choice, port.name, status)) return false;
      const on = (status & 0xF0) === 0x90 && velocity > 0;
      const at = event.timeStamp || performance.now();
      const own = api.isInstrument(port);
      // Another keyboard is heard through the instrument, with its note offs even after stopping.
      if (!own && (recorder.on || passed.has(note))) {
        if (on) passed.add(note);
        else passed.delete(note);
        recorder.sent(note, at);
        api.thru(on ? [0x90, note, velocity] : [0x80, note, 0]);
      }
      if (!recorder.on) return true;
      if (on) {
        if (own && recent.some((sent) => sent.note === note && Math.abs(sent.at - at) < ECHO_WINDOW_MS)) return true;
        noteOn(note, velocity, at);
      } else {
        noteOff(note, at);
      }
      return true;
    };

    button.addEventListener("click", recorder.toggle);
    input.addEventListener("change", () => {
      recorder.choice.input = input.value;
      save();
    });
    channel.replaceChildren(new Option("Any channel", "0"),
      ...Array.from({ length: 16 }, (_, index) => new Option(`Channel ${index + 1}`, String(index + 1))));
    channel.value = String(recorder.choice.channel);
    channel.addEventListener("change", () => {
      recorder.choice.channel = Number(channel.value);
      save();
    });
    recorder.refresh(null);
    render();
    return recorder;
  }

  /* A metronome click in the browser, on each beat while the pattern plays, louder on
     the first beat of each bar. at() takes a performance.now() time, as MIDI sends do. */
  function createClick({ storageKey, button }) {
    const click = { on: false };
    let audio = null;
    try {
      click.on = localStorage.getItem(storageKey) === "on";
    } catch {
      // It starts off.
    }

    function render() {
      button.setAttribute("aria-pressed", String(click.on));
    }

    // Browsers only start sound after a click, so the audio is set up here.
    function wake() {
      if (!audio) {
        const Context = window.AudioContext || window.webkitAudioContext;
        if (!Context) return;
        audio = new Context();
      }
      if (audio.state === "suspended") audio.resume();
    }

    click.at = (at, accent) => {
      if (!click.on || !audio || audio.state !== "running") return;
      const when = audio.currentTime + (at - performance.now()) / 1000;
      if (when < audio.currentTime) return;
      const tone = audio.createOscillator();
      const level = audio.createGain();
      tone.frequency.value = accent ? 1760 : 1320;
      level.gain.setValueAtTime(accent ? 0.5 : 0.3, when);
      level.gain.exponentialRampToValueAtTime(0.001, when + 0.04);
      tone.connect(level).connect(audio.destination);
      tone.start(when);
      tone.stop(when + 0.05);
    };

    button.addEventListener("click", () => {
      click.on = !click.on;
      if (click.on) wake();
      render();
      try {
        localStorage.setItem(storageKey, click.on ? "on" : "off");
      } catch {
        // It's just not remembered.
      }
    });
    // A click left on from last time sounds once the page has been clicked anywhere.
    document.addEventListener("pointerdown", () => { if (click.on) wake(); }, { once: true });
    document.addEventListener("keydown", () => { if (click.on) wake(); }, { once: true });
    render();
    return click;
  }

  return { ANY, accepts, create, createClick, heldLength, nearestStep };
})();

if (typeof module !== "undefined") module.exports = Recorder;
