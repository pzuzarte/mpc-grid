# MPC Grid

**[Open MPC Grid](https://pzuzarte.github.io/mpc-grid/)**

A step grid for the Akai MPC Sample that runs in your browser. Build patterns
across all 8 pad banks, keep them in 16 sequence slots, play them on the MPC live
over USB MIDI, and save them into a new copy of a project as MPC sequences.

It doesn't change the MPC's firmware or your original project files, and nothing
is uploaded: your projects stay on your computer and your card.

Unofficial and not affiliated with or endorsed by Akai Professional or inMusic.
Back up projects you care about. It has been tested with MPC Sample firmware
1.3.0.12.

**Requires a current version of Google Chrome or Microsoft Edge.** Other browsers
don't offer the MIDI and folder access it needs.

The **Help** button in the page (or the ? key) explains setup, saving and every
control.

## MPC settings for live play

Connect the MPC by USB, press SHIFT + PAD 8 to open MIDI Configuration, then set:

- MIDI Port: USB
- MIDI In Channel: All
- Pad MIDI In: On

The MPC only makes sound if the loaded project has samples on the pads you use.

## Patterns and sequences

- Slots 1-16 are sequences. Click an empty slot to start a pattern there.
- During playback, clicking a slot queues it for the end of the loop.
- Duplicate copies the pattern to the next empty slot.
- Bars sets the length of the current pattern. Shortening it removes notes past
  the new end, and Undo brings them back.
- Banks A-H are along the top of the grid, or press keys 1-8. A dot means the
  bank has notes in this pattern. "In use" shows pads with samples or notes.
- Steps sets the grid to 1/8, 1/16 or 1/32. Triplets (or the T key) switches to
  three steps in the space of two.
- Note repeat makes each new step play 2-8 evenly spaced hits, drawn as bars in
  the step. Alt-click an existing step to apply the current setting to it. These
  are saved as ordinary notes, so the MPC plays and shows them as separate hits.
- Right-click a step (or Control-click on a Mac) to edit its velocity (1-127),
  length and timing in ticks, and probability. A dashed outline marks a step with
  less than 100% probability. The grid honours probability during live playback;
  whether the MPC does after saving hasn't been confirmed.
- The grid resizes to fit the window. If steps would be too small to click, it
  shows fewer bars at a time with arrows to move between them, and follows the
  playhead during playback.

## Working with projects

The MPC can't use MIDI and share its card at the same time:

1. Put the MPC in SD Card Access mode, click **Connect card**, and choose the
   card. Chrome may ask you to allow access again on later visits.
2. Pick a project under "On the card". It's copied into this browser's storage.
3. Exit SD Card Access mode to play and edit it live.
4. "Save to new project" writes a new project in this browser.
5. Back in SD Card Access mode, "Copy to card" adds it to the card without
   overwriting anything. Eject the card before leaving that mode.

Projects must be saved to the card on the MPC for the grid to see them.

**Sample names** come from the saved project, because MIDI doesn't carry them.
Load samples on the MPC, save the project to the card, and enter SD Card Access
mode. If that project is open, its pad names update within a few seconds and
unsaved patterns are kept.

**Keep your work on the card.** Unsaved patterns and projects in the grid live in
this browser's storage for the site. Clearing your browsing data for the site
erases them, and they won't appear in other browsers. Patterns made with "No
project" can't be saved into a project.

## Sending a pattern straight to the MPC (experimental)

"Send to MPC" plays the current pattern exactly once with MIDI start, clock and
stop, so the MPC can record it without SD mode or a new project file. Arm SEQ
RECORD on an empty sequence of the same length, with MIDI Sync In set to MIDI
Clock, then click the button. This hasn't been confirmed on the hardware.

## Known limits

- Live BPM is used for laptop playback and is not saved to the project.
- Sample assignment is edited on the MPC.
- Slots in use can be cleared but not removed from a project.
- A project whose format can't be reproduced exactly can be viewed but not saved,
  so nothing is ever silently altered.

## Development

The site is plain HTML, CSS and JavaScript with nothing to build. Serve the folder
from any local web server, because browsers only allow these features on secure
pages and localhost. Tests need Node.js 21 or later:

```bash
npm test
```
