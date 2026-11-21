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
  function songPart(plan, name) {
    if (!plan || typeof plan !== "object" || !Number.isInteger(plan.bars) || plan.bars < 1) return null;
    const cues = plan.parts?.[name];
    if (!Array.isArray(cues)) return null;
    const valid = cues.filter((cue) => cue && Number.isInteger(cue.bar) && cue.bar >= 0 && cue.bar < plan.bars
      && (cue.pattern === null || (Number.isInteger(cue.pattern) && cue.pattern >= 0 && cue.pattern < 16)
        || (typeof cue.pattern === "string" && cue.pattern.length > 0 && cue.pattern.length <= 64)));
    return { bars: plan.bars, loop: Boolean(plan.loop), cues: valid.sort((a, b) => a.bar - b.bar) };
  }

  // The cue that starts at a bar, if one does.
  const songCue = (part, bar) => part.cues.find((cue) => cue.bar === bar);

  /* While a song plays, Song Grid can move it: jump to another bar, or hold a stretch of
     bars, such as a section, repeating it until it's let go. Each move names the bar it
     happens on, counted from the start of playback however the song has moved, so every
     page makes it at the same moment. A move is { atBar, toBar, hold }, where toBar and
     hold are each left out when they don't change, and hold is { start, end } or null. */
  function songMove(data, bars) {
    if (!data || !Number.isInteger(data.atBar) || data.atBar < 1) return null;
    const move = { atBar: data.atBar };
    if (Number.isInteger(data.toBar) && data.toBar >= 0 && data.toBar < bars) move.toBar = data.toBar;
    if (data.hold === null) move.hold = null;
    else if (data.hold && Number.isInteger(data.hold.start) && Number.isInteger(data.hold.end)
      && data.hold.start >= 0 && data.hold.end > data.hold.start && data.hold.end <= bars) {
      move.hold = { start: data.hold.start, end: data.hold.end };
    }
    return "toBar" in move || "hold" in move ? move : null;
  }

  // The song bar that plays next. part also holds bar, the bar playing, played, how many
  // bars have played since the start, hold and moves. Returns false once the song ends.
  function songNextBar(part) {
    part.played += 1;
    let bar = part.bar + 1;
    let jumped = false;
    for (const move of part.moves.filter((item) => item.atBar === part.played)) {
      if ("hold" in move) part.hold = move.hold;
      if ("toBar" in move) {
        bar = move.toBar;
        jumped = true;
      }
    }
    part.moves = part.moves.filter((item) => item.atBar > part.played);
    // A held stretch repeats from its start when it's played through.
    if (!jumped && part.hold && part.bar < part.hold.end && bar >= part.hold.end) bar = part.hold.start;
    if (bar >= part.bars) {
      if (!part.loop) return false;
      bar = 0;
    }
    part.bar = bar;
    return true;
  }

  // A part ready to play from its first bar.
  const songStart = (part) => Object.assign(part, { bar: 0, played: 0, hold: null, moves: [] });
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

  function connect({ name, checkbox, storageKey, start, stop, tempo, status, peers = () => {}, song = () => {}, songMoved = () => {} }) {
    const channel = typeof BroadcastChannel === "undefined" ? null : new BroadcastChannel(CHANNEL);
    try {
      checkbox.checked = localStorage.getItem(storageKey) !== "off";
    } catch {
      checkbox.checked = true;
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
      announcePlay(bpm) {
        if (!active()) return null;
        const at = performance.now() + START_DELAY_MS;
        post({ type: "play", bpm, at: toWall(at) });
        return at;
      },
      announceStop() {
        if (active()) post({ type: "stop" });
      },
      // Sent just before announcePlay, so each page has its part when it starts.
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

  return { aligned, connect, songCue, songMove, songNextBar, songPart, songStart };
})();

if (typeof module !== "undefined") module.exports = Sync;
