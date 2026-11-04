"use strict";
/* Lets S-1 Grid and MPC Grid play together when both are open in one browser. They share
   a website, so they can message each other directly, and each schedules its own notes
   for the same moment. Date.now() is the shared clock, as performance.now() differs
   between tabs. */
const Sync = (() => {
  const CHANNEL = "grid-sync";
  const START_DELAY_MS = 120; // Time for the message to arrive before the first note.

  const validBpm = (bpm) => Number.isFinite(bpm) && bpm >= 20 && bpm <= 300;
  const toLocal = (wall) => performance.now() + wall - Date.now();
  const toWall = (local) => Date.now() + local - performance.now();

  // Where the next chunk should fall to line up with another page's beats. Only moves by
  // less than half a beat, so each page stays where it is in its own pattern.
  function aligned({ nextTime, nextPulse, at, pulse, msPerPulse, pulsesPerBeat }) {
    const error = nextTime - (at + (nextPulse - pulse) * msPerPulse);
    const beat = pulsesPerBeat * msPerPulse;
    return nextTime - (error - Math.round(error / beat) * beat);
  }

  function connect({ name, checkbox, storageKey, start, stop, tempo, status }) {
    const channel = typeof BroadcastChannel === "undefined" ? null : new BroadcastChannel(CHANNEL);
    try {
      checkbox.checked = localStorage.getItem(storageKey) !== "off";
    } catch {
      checkbox.checked = true;
    }
    checkbox.addEventListener("change", () => {
      try {
        localStorage.setItem(storageKey, checkbox.checked ? "on" : "off");
      } catch {
        // It still works for this visit.
      }
    });
    const active = () => channel && checkbox.checked;
    const post = (message) => channel.postMessage({ ...message, from: name });

    if (channel) {
      channel.onmessage = ({ data }) => {
        if (!active() || !data || data.from === name) return;
        if (data.type === "play" && validBpm(data.bpm) && Number.isFinite(data.at)) {
          const playing = start({ bpm: data.bpm, at: toLocal(data.at) });
          if (playing) status(`Playing with ${data.from} at ${data.bpm} BPM.`);
          post({ type: playing ? "joined" : "unable" });
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
      announceTempo({ bpm, nextTime, nextPulse }) {
        if (active()) post({ type: "tempo", bpm, at: toWall(nextTime), pulse: nextPulse });
      },
      close() {
        if (channel) channel.close();
      },
    };
  }

  return { aligned, connect };
})();

if (typeof module !== "undefined") module.exports = Sync;
