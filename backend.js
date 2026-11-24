"use strict";
/* Project storage, using the browser's file APIs. Nothing leaves this computer.

   The card can't mount while the MPC is in MIDI mode, so projects are worked on
   from a library and copied to the card when it's available. The library is a
   folder the user chooses on the computer, or the browser's private storage
   until one is chosen. Save to new project leaves originals alone. Save to card
   replaces only the card project's .xpj, after backing up the previous one in
   this browser. Everything written is read back and checked.
*/
const Backend = (() => {
  const XpjLib = typeof Xpj !== "undefined" ? Xpj : require("./xpj.js");
  const BACKUPS_DIR = "backups";
  const BACKUPS_KEPT = 3;
  const INCOMING_SUFFIX = ".incoming";
  const CARD_KEY = "card-folder";
  const LIBRARY_KEY = "library-folder";

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

  // A short fingerprint of a file, to tell whether it has changed.
  function fingerprint(bytes) {
    let hash = 0x811c9dc5;
    for (const byte of bytes) hash = Math.imul(hash ^ byte, 0x01000193) >>> 0;
    return `${bytes.length}:${hash.toString(16)}`;
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

  /* library: a directory handle, used until a library folder is chosen.
     kv: {get, set, remove} async storage. */
  function createBackend({ library: browserLibrary, kv }) {
    let library = browserLibrary;
    // A folder on the computer, once one is chosen. Browsers ask again for
    // access on later visits, so it may be waiting for permission.
    let libraryFolder = null;
    let cardRoot = null;
    // Reading every card project on each check is wasteful, so results are kept
    // until a file's size or date changes.
    const changeCache = new Map();

    const backups = () => library.getDirectoryHandle(BACKUPS_DIR, { create: true });

    async function loadCard() {
      cardRoot = (await kv.get(CARD_KEY)) || null;
      libraryFolder = (await kv.get(LIBRARY_KEY)) || null;
      if (libraryFolder) library = libraryFolder;
    }

    async function libraryPermission() {
      if (!libraryFolder) return "granted";
      return libraryFolder.queryPermission({ mode: "readwrite" });
    }

    async function libraryReady() {
      return (await libraryPermission()) === "granted";
    }

    async function ensureLibrary() {
      if (!(await libraryReady())) {
        throw new XpjLib.XpjError("Allow access to your library folder first, with the button at the top.");
      }
    }

    async function requestLibraryPermission() {
      return libraryFolder.requestPermission({ mode: "readwrite" });
    }

    async function libraryInfo() {
      if (!libraryFolder) return { status: "browser", name: "" };
      return { status: (await libraryReady()) ? "ready" : "permission", name: libraryFolder.name };
    }

    /* Makes a folder on the computer the library. Projects and backups already
       in the current library are copied into it, skipping any whose name is
       taken there. The old copies are left where they were. */
    async function setLibraryFolder(folder) {
      if (cardRoot && await folder.isSameEntry(cardRoot)) {
        throw new XpjLib.XpjError("That's the card folder. Choose a folder on the computer for the library.");
      }
      const copied = [];
      const skipped = [];
      if (await libraryReady() && !(await folder.isSameEntry(library))) {
        for (const stem of await projectStems(library)) {
          try {
            await writeNewProject(library, stem, await readBytes(await library.getFileHandle(xpjName(stem))), folder, stem);
            copied.push(stem);
          } catch (error) {
            if (!(error instanceof XpjLib.XpjError)) throw error;
            skipped.push(stem);
          }
        }
        const oldBackups = await childDir(library, BACKUPS_DIR);
        if (oldBackups) {
          const newBackups = await folder.getDirectoryHandle(BACKUPS_DIR, { create: true });
          for (const stem of await projectStems(oldBackups)) {
            if (await exists(newBackups, xpjName(stem))) continue;
            await writeNewProject(oldBackups, stem, await readBytes(await oldBackups.getFileHandle(xpjName(stem))), newBackups, stem);
          }
        }
      }
      library = folder;
      libraryFolder = folder;
      await kv.set(LIBRARY_KEY, folder);
      changeCache.clear();
      return { copied, skipped };
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
      if (!(await libraryReady())) return false;
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
      const local = (await libraryReady()) ? await projectStems(library) : [];
      const cardDir = await cardProjects();
      let card = [];
      if (cardDir) {
        try {
          card = await Promise.all((await projectStems(cardDir)).map(async (name) => ({
            path: `card:${name}`,
            name,
            // A project saved here since, and not yet on the card, isn't replaced from it.
            changed: !(await kv.get(`ahead:${name}`)) && await differsFromLibrary(cardDir, name),
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
        libraryFolder: await libraryInfo(),
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
      await ensureLibrary();
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
        } else if (!(await kv.get(`ahead:${stem}`)) && await differsFromLibrary(cardDir, stem)) {
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
      await ensureLibrary();
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

    /* Saves edits into the same project on the card, keeping its name. The card's
       previous version is backed up in this browser first, the new file is read
       back and checked, and the library copy is updated to match. Samples aren't
       touched. */
    async function saveToCard({ path, edits }) {
      await ensureLibrary();
      const { place, stem } = splitPath(path);
      if (place !== "library") throw new XpjLib.XpjError("Only library projects can be saved.");
      const cardDir = await cardProjects();
      if (!cardDir) {
        throw new XpjLib.XpjError("No card found. Put the MPC in SD Card Access mode and connect the card.");
      }
      const cardFile = await childFile(cardDir, xpjName(stem));
      if (!cardFile) throw new XpjLib.XpjError(`There's no project called "${stem}" on the card. Use Copy to card instead.`);
      const oldBytes = await readBytes(cardFile);
      // Saved here since it was last on the card: this copy goes to the card, unless the
      // card's has changed too, on the MPC.
      const ahead = await kv.get(`ahead:${stem}`);
      if (ahead && fingerprint(oldBytes) !== ahead.card) {
        throw new XpjLib.XpjError(`${stem} was saved here and also changed on the MPC since. To keep both, use Save as here, then open the card's copy.`);
      }
      if (!ahead && await differsFromLibrary(cardDir, stem)) {
        throw new XpjLib.XpjError(`${stem} on the card has changed since it was opened here. Open it again from the card, then save.`);
      }
      const base = ahead ? await readBytes(await library.getFileHandle(xpjName(stem))) : oldBytes;
      const project = await XpjLib.parse(base);
      XpjLib.applyEdits(project, edits || []);
      const bytes = await XpjLib.serialise(project);
      await XpjLib.parse(bytes);

      const backupDir = await backups();
      await writeBytes(backupDir, xpjName(`${stem}-${Date.now()}`), oldBytes);
      await pruneBackups(backupDir, stem);

      const handle = await writeBytes(cardDir, xpjName(stem), bytes);
      if (!sameBytes(await readBytes(handle), bytes)) {
        await writeBytes(cardDir, xpjName(stem), oldBytes);
        throw new XpjLib.XpjError("Read-back check failed, so the card's project was put back as it was.");
      }
      await removeIfPresent(cardDir, `._${xpjName(stem)}`);
      await writeBytes(library, xpjName(stem), bytes);
      changeCache.delete(stem);
      await kv.remove(`draft:${stem}`);
      await kv.remove(`ahead:${stem}`);
      return { path: `library:${stem}`, name: stem };
    }

    /* Saves edits into the same project in the library, keeping its name. The previous
       version is backed up first, and the new file is read back and checked. */
    async function saveInPlace({ path, edits }) {
      await ensureLibrary();
      const { place, stem } = splitPath(path);
      if (place !== "library") throw new XpjLib.XpjError("Only library projects can be saved.");
      const file = await childFile(library, xpjName(stem));
      if (!file) throw new XpjLib.XpjError("That project is no longer available.");
      const oldBytes = await readBytes(file);
      const project = await XpjLib.parse(oldBytes);
      XpjLib.applyEdits(project, edits || []);
      const bytes = await XpjLib.serialise(project);
      await XpjLib.parse(bytes);
      const backupDir = await backups();
      await writeBytes(backupDir, xpjName(`${stem}-${Date.now()}`), oldBytes);
      await pruneBackups(backupDir, stem);
      // Remembers what the card had, so a later Save to card can tell if the MPC changed it.
      if (!(await kv.get(`ahead:${stem}`))) await kv.set(`ahead:${stem}`, { card: fingerprint(oldBytes) });
      const handle = await writeBytes(library, xpjName(stem), bytes);
      if (!sameBytes(await readBytes(handle), bytes)) {
        await writeBytes(library, xpjName(stem), oldBytes);
        throw new XpjLib.XpjError("Read-back check failed, so the project was put back as it was.");
      }
      changeCache.delete(stem);
      await kv.remove(`draft:${stem}`);
      return { path: `library:${stem}`, name: stem };
    }

    async function copyToCard({ path }) {
      await ensureLibrary();
      const { place, stem } = splitPath(path);
      if (place !== "library") throw new XpjLib.XpjError("Only library projects can be copied.");
      const cardDir = await cardProjects();
      if (!cardDir) {
        throw new XpjLib.XpjError("No card found. Put the MPC in SD Card Access mode and connect the card.");
      }
      const bytes = await readBytes(await library.getFileHandle(xpjName(stem)));
      const existing = await childFile(cardDir, xpjName(stem));
      if (!existing) {
        await writeNewProject(library, stem, bytes, cardDir, stem);
        return { name: stem, replaced: false };
      }
      // A project of the same name on the card is replaced, after backing it up here. Its
      // samples are added to, so none the card's version needs are lost.
      const oldBytes = await readBytes(existing);
      const backupDir = await backups();
      await writeBytes(backupDir, xpjName(`${stem}-${Date.now()}`), oldBytes);
      await pruneBackups(backupDir, stem);
      const sourceData = await childDir(library, dataName(stem));
      if (sourceData) await copyFolder(sourceData, await cardDir.getDirectoryHandle(dataName(stem), { create: true }));
      const handle = await writeBytes(cardDir, xpjName(stem), bytes);
      if (!sameBytes(await readBytes(handle), bytes)) {
        await writeBytes(cardDir, xpjName(stem), oldBytes);
        throw new XpjLib.XpjError("Read-back check failed, so the card's project was put back as it was.");
      }
      await removeAppleDouble(cardDir, stem);
      changeCache.delete(stem);
      await kv.remove(`ahead:${stem}`);
      return { name: stem, replaced: true };
    }

    const readDraft = async ({ name }) => ({ draft: (await kv.get(`draft:${name}`)) || null });

    async function writeDraft({ name, draft }) {
      if (draft === null || draft === undefined) await kv.remove(`draft:${name}`);
      else await kv.set(`draft:${name}`, draft);
    }

    return {
      loadCard,
      setCard,
      setLibraryFolder,
      requestLibraryPermission,
      requestCardPermission,
      projects,
      open,
      save,
      copyToCard,
      saveToCard,
      saveInPlace,
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
