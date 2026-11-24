"use strict";
/* Lets the grids play together when they're open in one browser. They share a website,
   so they can message each other directly, and each schedules its own notes for the same
   moment. Date.now() is the shared clock, as performance.now() differs between tabs.

   Song Grid also sends each grid its part of a song just before it starts them: which
   pattern each grid starts at which bar, or silence, and how many bars the song lasts.
   Each grid follows it from its own clock. The same file is used by every grid. */
const Sync = (() => {
  const CHANNEL = "grid-sync";
  const START_DELAY_MS = 120; // Time for the message to arrive before the first note.
  const HEARTBEAT_MS = 3000;
  const GONE_AFTER_MS = 8000;

  const validBpm = (bpm) => Number.isFinite(bpm) && bpm >= 20 && bpm <= 300;

  // One page's part of a song, checked, or null if there isn't one for it. Patterns are
  // counted from 0, or for TD-3 Grid named by a string, and null is silence.
  // Stretches of bars that repeat until they're let go, checked: [{ start, end }].
  function cleanLoops(loops, bars) {
    if (!Array.isArray(loops)) return [];
    return loops.filter((item) => item && Number.isInteger(item.start) && Number.isInteger(item.end)
      && item.start >= 0 && item.end > item.start && item.end <= bars).map(({ start, end }) => ({ start, end }));
  }

  // The grids that Song Grid has muted, checked: a list of names.
  const cleanMutes = (mutes) => (Array.isArray(mutes) ? mutes.filter((item) => typeof item === "string" && item.length <= 40).slice(0, 16) : []);

  /* Besides its pattern, a cue can change the tempo (bpm), shift the notes by some
     semitones (transpose), and send a program change (program) to pick a preset. */
  function cleanCue(cue) {
    const clean = { bar: cue.bar, pattern: cue.pattern };
    if (Number.isFinite(cue.bpm) && validBpm(cue.bpm)) clean.bpm = cue.bpm;
    if (Number.isInteger(cue.transpose) && cue.transpose >= -24 && cue.transpose <= 24 && cue.transpose !== 0) clean.transpose = cue.transpose;
    if (Number.isInteger(cue.program) && cue.program >= 0 && cue.program <= 127) clean.program = cue.program;
    return clean;
  }

  function songPart(plan, name) {
    if (!plan || typeof plan !== "object" || !Number.isInteger(plan.bars) || plan.bars < 1) return null;
    const cues = plan.parts?.[name];
    if (!Array.isArray(cues)) return null;
    const valid = cues.filter((cue) => cue && Number.isInteger(cue.bar) && cue.bar >= 0 && cue.bar < plan.bars
      && (cue.pattern === null || (Number.isInteger(cue.pattern) && cue.pattern >= 0 && cue.pattern < 16)
        || (typeof cue.pattern === "string" && cue.pattern.length > 0 && cue.pattern.length <= 64))).map(cleanCue);
    return {
      name, bars: plan.bars, loop: Boolean(plan.loop), cues: valid.sort((a, b) => a.bar - b.bar),
      loops: cleanLoops(plan.loops, plan.bars), mutes: cleanMutes(plan.mutes),
    };
  }

  // Whether Song Grid has muted this part's grid, with its mute and solo buttons.
  const songSilenced = (part) => Boolean(part.name && part.mutes?.includes(part.name));

  // The cue that starts at a bar, if one does.
  const songCue = (part, bar) => part.cues.find((cue) => cue.bar === bar);

  /* A song can have looped sections, which repeat each time they're reached until they're
     let go. While it plays, Song Grid can jump to another bar, or change which sections
     loop. Each move names the bar it happens on, counted from the start of playback however
     the song has moved, so every page makes it at the same moment. A move is
     { atBar, toBar, loops, mutes }, where each is left out when it doesn't change, loops
     is the new list of looped stretches, and mutes the grids muted from then on. */
  function songMove(data, bars) {
    if (!data || !Number.isInteger(data.atBar) || data.atBar < 1) return null;
    const move = { atBar: data.atBar };
    if (Number.isInteger(data.toBar) && data.toBar >= 0 && data.toBar < bars) move.toBar = data.toBar;
    if (Array.isArray(data.loops)) move.loops = cleanLoops(data.loops, bars);
    if (Array.isArray(data.mutes)) move.mutes = cleanMutes(data.mutes);
    return "toBar" in move || "loops" in move || "mutes" in move ? move : null;
  }

  // The song bar that plays next. part also holds bar, the bar playing, played, how many
  // bars have played since the start, looping and moves. Returns false once the song ends.
  function songNextBar(part) {
    part.played += 1;
    let bar = part.bar + 1;
    let jumped = false;
    for (const move of part.moves.filter((item) => item.atBar === part.played)) {
      if ("loops" in move) part.looping = move.loops;
      if ("mutes" in move) part.mutes = move.mutes;
      if ("toBar" in move) {
        bar = move.toBar;
        jumped = true;
      }
    }
    part.moves = part.moves.filter((item) => item.atBar > part.played);
    // A looped stretch goes back to its start when it's played through.
    const looped = !jumped && part.looping.find((item) => part.bar >= item.start && part.bar < item.end && bar >= item.end);
    if (looped) bar = looped.start;
    if (bar >= part.bars) {
      if (!part.loop) return false;
      bar = 0;
    }
    part.bar = bar;
    return true;
  }

  // A part ready to play from its first bar, with its looped sections as planned.
  const songStart = (part) => Object.assign(part, { bar: 0, played: 0, looping: [...(part.loops || [])], moves: [], mutes: [...(part.mutes || [])] });
  const toLocal = (wall) => performance.now() + wall - Date.now();
  const toWall = (local) => Date.now() + local - performance.now();

  // Where the next chunk should fall to line up with another page's beats. Only moves by
  // less than half a beat, so each page stays where it is in its own pattern.
  function aligned({ nextTime, nextPulse, at, pulse, msPerPulse, pulsesPerBeat }) {
    const error = nextTime - (at + (nextPulse - pulse) * msPerPulse);
    const beat = pulsesPerBeat * msPerPulse;
    return nextTime - (error - Math.round(error / beat) * beat);
  }

  // A worker's timer keeps running in a background tab, where a page's own slows down.
  function everyHeartbeat(callback) {
    if (typeof Worker === "undefined") {
      const timer = setInterval(callback, HEARTBEAT_MS);
      timer.unref?.();
      return () => clearInterval(timer);
    }
    const worker = new Worker(URL.createObjectURL(new Blob(
      [`setInterval(() => postMessage(0), ${HEARTBEAT_MS});`], { type: "text/javascript" })));
    worker.onmessage = callback;
    return () => worker.terminate();
  }

  /* Patterns sent to a grid with numbered slots, checked: [{ index, data }] for each one
     that names a slot and has notes to put in it, in slot order, one per slot. */
  function assetSlots(assets, slots = 16) {
    const found = new Map();
    for (const item of Array.isArray(assets?.patterns) ? assets.patterns : []) {
      const data = item?.data;
      if (!item || !Number.isInteger(item.ref) || item.ref < 0 || item.ref >= slots || found.has(item.ref)) continue;
      if (!data || !Array.isArray(data.notes) || !Number.isFinite(data.bars) || data.bars <= 0 || data.bars > 64) continue;
      found.set(item.ref, JSON.parse(JSON.stringify(data)));
    }
    return [...found].sort((a, b) => a[0] - b[0]).map(([index, data]) => ({ index, data }));
  }

  /* Song Grid can ask every open grid for its assets: its patterns, and its sound where it
     has one. assets() gives them, or a promise of them, as { patterns, sound }, and each
     reply reaches Song Grid's assetsReceived(name, assets).

     It can also send a grid the assets kept with a song, to put back. loadAssets(assets)
     puts them in, and gives what it did, or a promise of it, as { ok, message }, which
     reaches Song Grid's assetsLoaded(name, result).

     Any page can also ask another a question by name with ask(to, kind, payload), which
     gives a promise of its answer. The page asked answers with answers[kind](payload),
     which gives the answer or a promise of it. Song Grid asks a grid for its "catalog",
     what it can offer a song, and to "fetch" the ones picked from it. */
  function connect({
    name, checkbox, storageKey, start, stop, tempo, status, peers = () => {}, song = () => {}, songMoved = () => {},
    assets = null, assetsReceived = () => {}, loadAssets = null, assetsLoaded = () => {}, answers = {},
    startOff = false,
  }) {
    const channel = typeof BroadcastChannel === "undefined" ? null : new BroadcastChannel(CHANNEL);
    // A page can start with Sync off on every visit, until it's ticked.
    try {
      checkbox.checked = !startOff && localStorage.getItem(storageKey) !== "off";
    } catch {
      checkbox.checked = !startOff;
    }
    const active = () => channel && checkbox.checked;
    const post = (message) => channel.postMessage({ ...message, from: name });

    // Which other pages are open, and when each was last heard from.
    const seen = new Map();
    const report = () => peers([...seen.keys()].sort());
    const sweep = () => {
      const oldest = Date.now() - GONE_AFTER_MS;
      let changed = false;
      for (const [peer, time] of seen) {
        if (time < oldest) changed = seen.delete(peer) || changed;
      }
      if (changed) report();
    };

    checkbox.addEventListener("change", () => {
      try {
        localStorage.setItem(storageKey, checkbox.checked ? "on" : "off");
      } catch {
        // It still works for this visit.
      }
      if (!channel) return;
      post({ type: checkbox.checked ? "hello" : "bye" });
      if (!checkbox.checked) seen.clear();
      report();
    });

    // Questions sent with ask() that haven't been answered yet, by request id.
    const asking = new Map();

    let stopHeartbeat = () => {};
    let leave = null;
    if (channel) {
      channel.onmessage = ({ data }) => {
        if (!active() || !data || data.from === name) return;
        if (data.type === "bye") {
          if (seen.delete(data.from)) report();
          return;
        }
        const isNew = !seen.has(data.from);
        seen.set(data.from, Date.now());
        if (isNew) report();
        if (data.type === "hello") post({ type: "here" });
        if (data.type === "play" && validBpm(data.bpm) && Number.isFinite(data.at)) {
          const playing = start({ bpm: data.bpm, at: toLocal(data.at) });
          if (playing) status(`Playing with ${data.from} at ${data.bpm} BPM.`);
          post({ type: playing ? "joined" : "unable" });
        } else if (data.type === "song") {
          song(songPart(data.plan, name));
        } else if (data.type === "song-move") {
          songMoved(data.move);
        } else if (data.type === "assets-request" && assets) {
          Promise.resolve(assets()).then((reply) => {
            if (reply && active()) post({ type: "assets", request: data.request, assets: reply });
          }).catch(() => {});
        } else if (data.type === "assets" && data.assets && typeof data.assets === "object") {
          assetsReceived(data.from, data.assets, data.request);
        } else if (data.type === "assets-load" && data.to === name && loadAssets && data.assets && typeof data.assets === "object") {
          const reply = (result) => {
            if (active()) post({ type: "assets-loaded", request: data.request, ok: Boolean(result?.ok), message: String(result?.message || "") });
          };
          Promise.resolve().then(() => loadAssets(data.assets)).then(reply, () => reply({ ok: false, message: "Couldn't put them in." }));
        } else if (data.type === "ask" && data.to === name && typeof data.kind === "string") {
          const handler = Object.prototype.hasOwnProperty.call(answers, data.kind) ? answers[data.kind] : null;
          const reply = (ok, value, error) => { if (active()) post({ type: "answer", request: data.request, ok, value, error }); };
          if (!handler) reply(false, null, "It can't answer that. Hard-refresh it to load the latest version.");
          else Promise.resolve().then(() => handler(data.payload)).then((value) => reply(true, value), (error) => reply(false, null, String(error?.message || error)));
        } else if (data.type === "answer" && asking.has(data.request)) {
          const waiting = asking.get(data.request);
          if (waiting.to !== data.from) return;
          asking.delete(data.request);
          clearTimeout(waiting.timer);
          if (data.ok) waiting.resolve(data.value);
          else waiting.reject(new Error(typeof data.error === "string" ? data.error : "It couldn't answer."));
        } else if (data.type === "assets-loaded") {
          assetsLoaded(data.from, { ok: Boolean(data.ok), message: typeof data.message === "string" ? data.message.slice(0, 300) : "" }, data.request);
        } else if (data.type === "stop") {
          stop();
        } else if (data.type === "tempo" && validBpm(data.bpm) && Number.isFinite(data.at)) {
          tempo({ bpm: data.bpm, at: toLocal(data.at), pulse: data.pulse });
        } else if (data.type === "joined") {
          status(`Playing with ${data.from}.`);
        } else if (data.type === "unable") {
          status(`${data.from} isn't playing, as it has no MIDI output.`, true);
        }
      };
      stopHeartbeat = everyHeartbeat(() => {
        if (active()) post({ type: "here" });
        sweep();
      });
      if (typeof addEventListener === "function") {
        leave = () => { if (active()) post({ type: "bye" }); };
        addEventListener("pagehide", leave);
      }
      if (active()) post({ type: "hello" });
    }

    return {
      // The moment to start, or null if nothing else needs to know.
      // waitMs puts off the start, such as for a count-in.
      announcePlay(bpm, waitMs = 0) {
        if (!active()) return null;
        const at = performance.now() + START_DELAY_MS + Math.max(0, waitMs);
        post({ type: "play", bpm, at: toWall(at) });
        return at;
      },
      announceStop() {
        if (active()) post({ type: "stop" });
      },
      // Sent just before announcePlay, so each page has its part when it starts.
      // Asks every open grid for its assets. Returns the request's id, sent back with each reply.
      requestAssets() {
        if (!active()) return null;
        const request = `a${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
        post({ type: "assets-request", request });
        return request;
      },
      // Asks one page a question. Gives a promise of its answer, which fails if it doesn't
      // answer within waitMs, or Sync is off.
      ask(to, kind, payload = null, waitMs = 5000) {
        if (!active()) return Promise.reject(new Error("Sync is off."));
        const request = `q${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
        return new Promise((resolve, reject) => {
          const timer = setTimeout(() => {
            asking.delete(request);
            reject(new Error(`${to} didn't answer. Hard-refresh it to load the latest version, then try again.`));
          }, waitMs);
          asking.set(request, { to, resolve, reject, timer });
          post({ type: "ask", to, kind, request, payload });
        });
      },
      // Sends one grid a song's assets to put back. Returns the request's id, or null.
      sendAssets(to, assets) {
        if (!active()) return null;
        const request = `l${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
        post({ type: "assets-load", to, request, assets });
        return request;
      },
      // Sent ahead of the bar it happens on. See songMove.
      announceSongMove(move) {
        if (active()) post({ type: "song-move", move });
      },
      announceSong(plan) {
        if (active()) post({ type: "song", plan });
      },
      announceTempo({ bpm, nextTime, nextPulse }) {
        if (active()) post({ type: "tempo", bpm, at: toWall(nextTime), pulse: nextPulse });
      },
      close() {
        stopHeartbeat();
        if (leave) removeEventListener("pagehide", leave);
        if (channel) channel.close();
      },
    };
  }

  return { aligned, assetSlots, connect, songCue, songMove, songNextBar, songPart, songSilenced, songStart };
})();

if (typeof module !== "undefined") module.exports = Sync;
