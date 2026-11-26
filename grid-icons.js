"use strict";
/* The icons the grids share, so each common button looks the same in every grid: Play,
   Stop, Rec, Save, Open, Undo, Copy and so on. A button gets one with data-icon="name", or
   data-icon="auto" to follow its label, as Play does when it turns into Stop. The icon is
   put back if the page changes the button's label.

   This file is the same in each grid. */

const GridIcons = (() => {
  const SVG = {
    play: '<path d="M7 4.5v15l12.5-7.5z" fill="currentColor" stroke="none"/>',
    stop: '<rect x="6" y="6" width="12" height="12" rx="1.5" fill="currentColor" stroke="none"/>',
    record: '<circle cx="12" cy="12" r="6.5" fill="currentColor" stroke="none"/>',
    panic: '<path d="M4 9.5v5h3.5l5 4.5v-14l-5 4.5z"/><path d="M16.5 9.5l5 5M21.5 9.5l-5 5"/>',
    save: '<path d="M5 4h11.5l2.5 2.5V20H5z"/><path d="M8.5 4v4.5h6V4"/><rect x="8" y="13" width="8" height="7"/>',
    "save-as": '<path d="M12 20H5V4h11.5l2.5 2.5V11"/><path d="M8.5 4v4.5h6V4"/><path d="M18 14v7M14.5 17.5h7"/>',
    open: '<path d="M3.5 19V5.5h5.5l2 2h8V11"/><path d="M3.5 19l2.8-7.5h15.2L18.7 19z"/>',
    library: '<path d="M5 4.5h4v15H5zM10 4.5h4v15h-4z"/><path d="M15.5 6l3.6-1 3.4 13.6-3.6 1z"/>',
    folder: '<path d="M3.5 6h5.5l2 2h9.5v11h-17z"/>',
    undo: '<path d="M9 14.5L4 9.5l5-5"/><path d="M4 9.5h10.5a5 5 0 0 1 0 10H12"/>',
    redo: '<path d="M15 14.5l5-5-5-5"/><path d="M20 9.5H9.5a5 5 0 0 0 0 10H12"/>',
    duplicate: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V5H4v11h4"/><path d="M14 11v6M11 14h6"/>',
    clear: '<path d="M4 7h16M9.5 7V4.5h5V7M6.5 7l1 13h9l1-13"/>',
    generate: '<path d="M11 3.5l1.9 5.1 5.1 1.9-5.1 1.9L11 17.5l-1.9-5.1-5.1-1.9 5.1-1.9z"/><path d="M18.5 15v5M16 17.5h5"/>',
    "shift-left": '<path d="M4.5 4.5v15M20 12H8.5M12.5 8l-4 4 4 4"/>',
    "shift-right": '<path d="M19.5 4.5v15M4 12h11.5M11.5 8l4 4-4 4"/>',
    down: '<path d="M12 4.5v15M6.5 14l5.5 5.5 5.5-5.5"/>',
    up: '<path d="M12 19.5v-15M6.5 10L12 4.5 17.5 10"/>',
    copy: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V5H4v11h4"/>',
    paste: '<rect x="5.5" y="5" width="13" height="16" rx="2"/><path d="M9 3.5h6V7H9z"/>',
    click: '<path d="M7.5 20.5h9L14 3.5h-4z"/><path d="M12 15l5.5-7"/>',
    help: '<circle cx="12" cy="12" r="9"/><path d="M9.5 9.5a2.5 2.5 0 1 1 3.6 2.2c-.7.4-1.1.9-1.1 1.8v.5"/><path d="M12 17.2v.1"/>',
    new: '<path d="M6 3.5h8l4 4v13H6z"/><path d="M14 3.5v4h4M12 11v6M9 14h6"/>',
    load: '<path d="M12 4.5v11M7.5 11l4.5 4.5 4.5-4.5"/><path d="M5 19.5h14"/>',
    collect: '<path d="M12 19.5v-11M7.5 13L12 8.5l4.5 4.5"/><path d="M5 4.5h14"/>',
  };
  // For data-icon="auto": the icon for each label.
  const BY_LABEL = { Play: "play", Stop: "stop", "Play set": "play", "Stop set": "stop", Rec: "record" };

  function iconFor(button) {
    const name = button.dataset.icon;
    if (name !== "auto") return name;
    return BY_LABEL[button.textContent.trim()] || null;
  }

  function apply(button) {
    const name = iconFor(button);
    const current = button.querySelector(":scope > svg.grid-icon");
    if (current && current.dataset.name === name) return;
    current?.remove();
    if (!name || !SVG[name]) return;
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("class", "grid-icon");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("aria-hidden", "true");
    svg.dataset.name = name;
    svg.innerHTML = SVG[name];
    button.prepend(svg);
  }

  function applyAll(root = document) {
    root.querySelectorAll("[data-icon]").forEach(apply);
  }

  function start() {
    const style = document.createElement("style");
    style.textContent = `
      svg.grid-icon { width: 1.15em; height: 1.15em; flex: none; vertical-align: -0.2em; margin-right: 0.35em;
        fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
      [data-icon] { display: inline-flex; align-items: center; justify-content: center; }
      [data-icon].icon-only svg.grid-icon { margin-right: 0; }`;
    document.head.append(style);
    applyAll();
    // Pages change some labels, such as Play to Stop, which takes the icon away.
    new MutationObserver((changes) => {
      for (const change of changes) {
        const button = change.target.nodeType === 1 ? change.target.closest?.("[data-icon]") : change.target.parentElement?.closest("[data-icon]");
        if (button) apply(button);
        for (const node of change.addedNodes) if (node.nodeType === 1) applyAll(node);
      }
    }).observe(document.body, { childList: true, subtree: true, characterData: true });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
  else start();

  return { apply, applyAll, SVG };
})();
