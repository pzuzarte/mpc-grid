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

  // One page's part of a song, checked, or null if there isn't one for it.
  // Patterns are counted from 0, and null is silence.
  function songPart(plan, name) {
    if (!plan || typeof plan !== "object" || !Number.isInteger(plan.bars) || plan.bars < 1) return null;
    const cues = plan.parts?.[name];
    if (!Array.isArray(cues)) return null;
    const valid = cues.filter((cue) => cue && Number.isInteger(cue.bar) && cue.bar >= 0 && cue.bar < plan.bars
      && (cue.pattern === null || (Number.isInteger(cue.pattern) && cue.pattern >= 0 && cue.pattern < 16)));
    return { bars: plan.bars, loop: Boolean(plan.loop), cues: valid.sort((a, b) => a.bar - b.bar) };
  }

  // The cue that starts at a bar, if one does.
  const songCue = (part, bar) => part.cues.find((cue) => cue.bar === bar);
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

  function connect({ name, checkbox, storageKey, start, stop, tempo, status, peers = () => {}, song = () => {} }) {
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

  return { aligned, connect, songCue, songPart };
})();

if (typeof module !== "undefined") module.exports = Sync;
