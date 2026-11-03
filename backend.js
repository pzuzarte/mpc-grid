"use strict";
/* Project storage, using the browser's file APIs. Nothing leaves this computer.

   The card can't mount while the MPC is in MIDI mode, so projects are worked on
   from a library in the browser's private storage and copied to the card when
   it's available. Originals are never changed: saves always create a new project,
   and everything written is read back and checked.
*/
const Backend = (() => {
  const XpjLib = typeof Xpj !== "undefined" ? Xpj : require("./xpj.js");
  const BACKUPS_DIR = "backups";
  const BACKUPS_KEPT = 3;
  const INCOMING_SUFFIX = ".incoming";
  const CARD_KEY = "card-folder";

  const isMissing = (error) => error.name === "NotFoundError";

  async function childDir(parent, name) {
    try {
      return await parent.getDirectoryHandle(name);
    } catch (error) {
      if (isMissing(error) || error.name === "TypeMismatchError") return null;
      throw error;
    }
  }

  async function childFile(parent, name) {
    try {
      return await parent.getFileHandle(name);
    } catch (error) {
      if (isMissing(error) || error.name === "TypeMismatchError") return null;
      throw error;
    }
  }

  async function exists(parent, name) {
    return Boolean(await childFile(parent, name)) || Boolean(await childDir(parent, name));
  }

  async function readBytes(fileHandle) {
    const file = await fileHandle.getFile();
    return new Uint8Array(await file.arrayBuffer());
  }

  async function writeBytes(parent, name, bytes) {
    const handle = await parent.getFileHandle(name, { create: true });
    const writable = await handle.createWritable();
    await writable.write(bytes);
    await writable.close();
    return handle;
  }

  const sameBytes = (a, b) => a.length === b.length && a.every((value, i) => value === b[i]);

  async function removeIfPresent(parent, name) {
    try {
      await parent.removeEntry(name, { recursive: true });
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
  }

  async function entryNames(directory) {
    const names = [];
    for await (const name of directory.keys()) names.push(name);
    return names;
  }

  async function projectStems(directory) {
    const names = await entryNames(directory);
    return names
      .filter((n) => n.toLowerCase().endsWith(".xpj") && !n.startsWith("."))
      .map((n) => n.slice(0, -4))
      .filter((n) => !n.endsWith(INCOMING_SUFFIX))
      .sort();
  }

  const xpjName = (stem) => `${stem}.xpj`;
  const dataName = (stem) => stem + XpjLib.DATA_SUFFIX;

  async function copyFolder(source, destination) {
    for await (const [name, handle] of source.entries()) {
      if (name.startsWith("._")) continue;
      if (handle.kind === "directory") {
        const inner = await destination.getDirectoryHandle(name, { create: true });
        await copyFolder(handle, inner);
      } else {
        const target = await destination.getFileHandle(name, { create: true });
        const writable = await target.createWritable();
        // Streams, so large samples aren't all held in memory.
        await (await handle.getFile()).stream().pipeTo(writable);
      }
    }
  }

  // macOS adds hidden ._ files beside new files on exFAT cards.
  async function removeAppleDouble(destDir, stem) {
    await removeIfPresent(destDir, `._${xpjName(stem)}`);
    await removeIfPresent(destDir, `._${dataName(stem)}`);
    const data = await childDir(destDir, dataName(stem));
    if (!data) return;
    for (const name of await entryNames(data)) {
      if (name.startsWith("._")) await removeIfPresent(data, name);
    }
  }

  /* Writes bytes as a new project with a copy of its sample folder. The .xpj goes
     last, so a project that appears is complete. Refuses to overwrite anything. */
  async function writeNewProject(sourceDir, sourceStem, bytes, destDir, stem) {
    if (await exists(destDir, xpjName(stem)) || await exists(destDir, dataName(stem))) {
      throw new XpjLib.XpjError(`A project called "${stem}" already exists there.`);
    }
    try {
      const destData = await destDir.getDirectoryHandle(dataName(stem), { create: true });
      const sourceData = await childDir(sourceDir, dataName(sourceStem));
      if (sourceData) await copyFolder(sourceData, destData);
      const handle = await writeBytes(destDir, xpjName(stem), bytes);
      if (!sameBytes(await readBytes(handle), bytes)) {
        throw new XpjLib.XpjError("Read-back check failed; nothing was saved.");
      }
    } catch (error) {
      await removeIfPresent(destDir, xpjName(stem));
      await removeIfPresent(destDir, dataName(stem));
      throw error;
    }
    await removeAppleDouble(destDir, stem);
  }

  // Finds the projects folder inside whichever folder was chosen.
  async function resolveProjects(root) {
    const sample = await childDir(root, "MPC-Sample");
    if (sample) {
      const projects = await childDir(sample, "Projects");
      if (projects) return projects;
    }
    const projects = await childDir(root, "Projects");
    if (projects) return projects;
    if ((await projectStems(root)).length) return root;
    return null;
  }

  /* library: a directory handle. kv: {get, set, remove} async storage. */
  function createBackend({ library, kv }) {
    let cardRoot = null;
    // Reading every card project on each check is wasteful, so results are kept
    // until a file's size or date changes.
    const changeCache = new Map();

    const backups = () => library.getDirectoryHandle(BACKUPS_DIR, { create: true });

    async function loadCard() {
      cardRoot = (await kv.get(CARD_KEY)) || null;
    }

    async function setCard(handle) {
      cardRoot = handle;
      await kv.set(CARD_KEY, handle);
      changeCache.clear();
    }

    async function cardPermission() {
      if (!cardRoot) return "none";
      return cardRoot.queryPermission({ mode: "readwrite" });
    }

    const requestCardPermission = () => cardRoot.requestPermission({ mode: "readwrite" });

    // The chosen folder is missing while the MPC is out of SD Card Access mode.
    async function cardProjects() {
      if (!cardRoot || (await cardPermission()) !== "granted") return null;
      try {
        return await resolveProjects(cardRoot);
      } catch (error) {
        if (isMissing(error) || error.name === "NotReadableError" || error.name === "InvalidStateError") {
          return null;
        }
        throw error;
      }
    }

    async function differsFromLibrary(cardDir, stem) {
      const local = await childFile(library, xpjName(stem));
      if (!local) return false;
      const handle = await cardDir.getFileHandle(xpjName(stem));
      const [cardFile, localFile] = [await handle.getFile(), await local.getFile()];
      const stamp = `${cardFile.size}:${cardFile.lastModified}:${localFile.size}:${localFile.lastModified}`;
      const cached = changeCache.get(stem);
      if (cached && cached.stamp === stamp) return cached.changed;
      const changed = cardFile.size !== localFile.size
        || !sameBytes(await readBytes(handle), await readBytes(local));
      changeCache.set(stem, { stamp, changed });
      return changed;
    }

    async function projects() {
      const local = await projectStems(library);
      const cardDir = await cardProjects();
      let card = [];
      if (cardDir) {
        try {
          card = await Promise.all((await projectStems(cardDir)).map(async (name) => ({
            path: `card:${name}`,
            name,
            changed: await differsFromLibrary(cardDir, name),
          })));
        } catch (error) {
          if (!isMissing(error)) throw error;
        }
      }
      return {
        library: local.map((name) => ({ path: `library:${name}`, name })),
        card,
        cardMounted: Boolean(cardDir),
        cardStatus: !cardRoot ? "none"
          : (await cardPermission()) !== "granted" ? "permission"
            : cardDir ? "ready" : "missing",
        cardName: cardRoot ? cardRoot.name : "",
      };
    }

    async function replaceFromCard(cardDir, stem) {
      const incoming = stem + INCOMING_SUFFIX;
      await removeIfPresent(library, xpjName(incoming));
      await removeIfPresent(library, dataName(incoming));
      // Copy first: if the card read fails, the library copy is left as it was.
      const bytes = await readBytes(await cardDir.getFileHandle(xpjName(stem)));
      await XpjLib.parse(bytes);
      await writeNewProject(cardDir, stem, bytes, library, incoming);

      const backupDir = await backups();
      const backupStem = `${stem}-${Date.now()}`;
      const oldBytes = await readBytes(await library.getFileHandle(xpjName(stem)));
      await writeNewProject(library, stem, oldBytes, backupDir, backupStem);

      await removeIfPresent(library, xpjName(stem));
      await removeIfPresent(library, dataName(stem));
      await writeNewProject(library, incoming, bytes, library, stem);
      await removeIfPresent(library, xpjName(incoming));
      await removeIfPresent(library, dataName(incoming));
      await pruneBackups(backupDir, stem);
    }

    async function pruneBackups(backupDir, stem) {
      const prefix = `${stem}-`;
      const stems = (await projectStems(backupDir))
        .filter((n) => n.startsWith(prefix) && /^\d+$/.test(n.slice(prefix.length)))
        .sort((a, b) => Number(b.slice(prefix.length)) - Number(a.slice(prefix.length)));
      for (const old of stems.slice(BACKUPS_KEPT)) {
        await removeIfPresent(backupDir, xpjName(old));
        await removeIfPresent(backupDir, dataName(old));
      }
    }

    // Brings across patterns autosaved by the earlier local version of this tool.
    async function importOldDraft(stem) {
      if (!cardRoot || (await kv.get(`draft:${stem}`))) return;
      const drafts = await childDir(cardRoot, "drafts");
      const file = drafts && await childFile(drafts, `${stem}.json`);
      if (!file) return;
      await kv.set(`draft:${stem}`, JSON.parse(await (await file.getFile()).text()));
    }

    function splitPath(path) {
      const match = /^(library|card):(.+)$/.exec(path || "");
      if (!match) throw new XpjLib.XpjError("That project is no longer available.");
      return { place: match[1], stem: match[2] };
    }

    async function open({ path }) {
      const { place, stem } = splitPath(path);
      let updated = false;
      if (place === "card") {
        const cardDir = await cardProjects();
        const file = cardDir && await childFile(cardDir, xpjName(stem));
        if (!file) throw new XpjLib.XpjError("That project is no longer on the card.");
        if (!(await childFile(library, xpjName(stem)))) {
          const bytes = await readBytes(file);
          await XpjLib.parse(bytes);
          await writeNewProject(cardDir, stem, bytes, library, stem);
        } else if (await differsFromLibrary(cardDir, stem)) {
          await replaceFromCard(cardDir, stem);
          updated = true;
          changeCache.delete(stem);
        }
        await importOldDraft(stem);
      }
      const file = await childFile(library, xpjName(stem));
      if (!file) throw new XpjLib.XpjError("That project is no longer available.");
      const project = await XpjLib.parse(await readBytes(file));
      return { path: `library:${stem}`, name: stem, updated, view: XpjLib.view(project) };
    }

    async function save({ path, name, edits }) {
      const { place, stem } = splitPath(path);
      if (place !== "library") throw new XpjLib.XpjError("Only library projects can be saved.");
      const newStem = XpjLib.cleanName(name);
      const file = await childFile(library, xpjName(stem));
      if (!file) throw new XpjLib.XpjError("That project is no longer available.");
      const project = await XpjLib.parse(await readBytes(file));
      XpjLib.applyEdits(project, edits || []);
      const bytes = await XpjLib.serialise(project);
      await XpjLib.parse(bytes);
      await writeNewProject(library, stem, bytes, library, newStem);
      await kv.remove(`draft:${stem}`);
      return { path: `library:${newStem}`, name: newStem };
    }

    async function copyToCard({ path }) {
      const { place, stem } = splitPath(path);
      if (place !== "library") throw new XpjLib.XpjError("Only library projects can be copied.");
      const cardDir = await cardProjects();
      if (!cardDir) {
        throw new XpjLib.XpjError("No card found. Put the MPC in SD Card Access mode and connect the card.");
      }
      const bytes = await readBytes(await library.getFileHandle(xpjName(stem)));
      await writeNewProject(library, stem, bytes, cardDir, stem);
      return { name: stem };
    }

    const readDraft = async ({ name }) => ({ draft: (await kv.get(`draft:${name}`)) || null });

    async function writeDraft({ name, draft }) {
      if (draft === null || draft === undefined) await kv.remove(`draft:${name}`);
      else await kv.set(`draft:${name}`, draft);
    }

    return {
      loadCard,
      setCard,
      requestCardPermission,
      projects,
      open,
      save,
      copyToCard,
      readDraft,
      writeDraft,
    };
  }

  /* Small IndexedDB key/value store. It can hold folder handles, unlike localStorage. */
  function browserStore() {
    const opened = new Promise((resolve, reject) => {
      const request = indexedDB.open("mpc-grid", 1);
      request.onupgradeneeded = () => request.result.createObjectStore("kv");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const run = async (mode, action) => {
      const db = await opened;
      return new Promise((resolve, reject) => {
        const request = action(db.transaction("kv", mode).objectStore("kv"));
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
    };
    return {
      get: (key) => run("readonly", (store) => store.get(key)),
      set: (key, value) => run("readwrite", (store) => store.put(value, key)),
      remove: (key) => run("readwrite", (store) => store.delete(key)),
    };
  }

  async function createBrowserBackend() {
    const root = await navigator.storage.getDirectory();
    const library = await root.getDirectoryHandle("library", { create: true });
    const backend = createBackend({ library, kv: browserStore() });
    await backend.loadCard();
    return backend;
  }

  return { createBackend, createBrowserBackend };
})();

if (typeof module !== "undefined") module.exports = Backend;
