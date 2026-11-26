"use strict";
/* The library folder button the grids share, in the same place in each (at the end of
   the pattern's file row) and with the same words, so it works the same way everywhere:

     Choose library folder   before one is chosen, or if it can't be found
     Allow library folder    after Chrome restarts, when it needs permission again
     Change library folder   once it's set; the label beside it names the folder

   Each grid remembers the folder it was given, which can be anywhere, such as a Google
   Drive folder, and saves there from then on. This file is the same in each grid. */

const LibraryButton = (() => {
  const WORDS = {
    none: ["Choose library folder", "No library folder", "warn", "Choose a folder on this computer, or in Google Drive or the like, to keep your library in."],
    browser: ["Choose library folder", "Library: in this browser", "warn", "Choose a folder on this computer, or in Google Drive or the like, to keep your library in."],
    missing: ["Choose library folder", "Library folder not found", "warn", "The library folder can't be found. Choose it again."],
    permission: ["Allow library folder", "Library: {name}", "warn", "Chrome needs your permission again to use \"{name}\"."],
    ready: ["Change library folder", "Library: {name}", "ok", "Your library is kept in \"{name}\". Click to keep it somewhere else."],
    unsupported: ["Choose library folder", "No library folder", "warn", "A library folder needs a current Chrome or Edge on a computer."],
  };

  // Shows a library's state. status is one of the WORDS keys; name is the folder's name.
  function render(button, label, status, name = "") {
    const [text, shown, kind, title] = WORDS[status] || WORDS.none;
    const fill = (words) => words.replaceAll("{name}", name || "the library folder");
    button.textContent = text;
    button.title = fill(title);
    button.dataset.status = status;
    button.disabled = status === "unsupported";
    if (label) {
      label.textContent = fill(shown);
      label.className = `pill library-where ${kind}`;
      label.title = fill(title);
    }
  }

  return { render, WORDS };
})();
