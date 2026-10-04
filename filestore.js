// FocusGate's own copy of a file you picked.
//
// Chrome never tells an extension where a picked file lives. A single file arrives from the dialog
// as "History-Class-7th.pdf" and nothing more — no drive, no folder — so there is no file://
// address to link to, and the only way back to the file was to go and find it by hand in Chrome's
// directory listing. That is a real cost for the one row on the blocked page whose whole job is
// "here is the work, go and do it".
//
// What the dialog DOES hand over is the file's contents. So those are kept here, in the
// extension's own IndexedDB, and served back by viewer.html. That gives a picked file the one
// thing it was missing: a link that opens it in a new tab, from the blocked page, Settings and the
// popup alike.
//
// Worth being plain about, since it is the user's file: this is a copy, it lives inside the
// extension's own storage on this computer, it is never sent anywhere, and it is deleted the
// moment the target is taken off the list (see pruneStoredFiles in background.js).
//
// Loaded three ways, which is why it declares plain globals and no module: a <script> tag in
// options.html and viewer.html, and importScripts from the service worker.

const FG_FILE_DB = "focusgate-files";
const FG_FILE_STORE = "picked";
const FG_FILE_DB_VERSION = 1;
// A textbook or a lecture recording is what this is for. Past this, no copy is kept and the target
// keeps the behaviour it always had — matched by name, opened by hand — because quietly duplicating
// a two-gigabyte file on someone's disk is not a reasonable thing to do on their behalf.
const FG_FILE_MAX_BYTES = 200 * 1024 * 1024;

function fgFileDb() {
  return new Promise((resolve, reject) => {
    let req;
    try { req = indexedDB.open(FG_FILE_DB, FG_FILE_DB_VERSION); }
    catch (e) { reject(e); return; }
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(FG_FILE_STORE)) db.createObjectStore(FG_FILE_STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error("indexeddb open failed"));
    req.onblocked = () => reject(new Error("indexeddb blocked"));
  });
}

// One transaction, closed again afterwards. The connection is not held open: the service worker
// this also runs in is killed and restarted all day long, and a live connection would keep an
// upgrade in another tab blocked.
function fgFileTx(mode, run) {
  return fgFileDb().then(db => new Promise((resolve, reject) => {
    let out;
    let tx;
    try { tx = db.transaction(FG_FILE_STORE, mode); }
    catch (e) { db.close(); reject(e); return; }
    tx.oncomplete = () => { db.close(); resolve(out); };
    tx.onerror = () => { db.close(); reject(tx.error || new Error("tx failed")); };
    tx.onabort = () => { db.close(); reject(tx.error || new Error("tx aborted")); };
    let req;
    try { req = run(tx.objectStore(FG_FILE_STORE)); }
    catch (e) { try { tx.abort(); } catch {} reject(e); return; }
    if (req) req.onsuccess = () => { out = req.result; };
  }));
}

// Chrome leaves File.type empty for plenty of things — .epub, .md, an odd .pdf — and viewer.html
// decides how to show a file from its type. So the extension gets the last word rather than
// showing a download prompt for a PDF.
function fgGuessType(name) {
  const m = String(name || "").toLowerCase().match(/\.([a-z0-9]+)$/);
  switch (m ? m[1] : "") {
    case "pdf":  return "application/pdf";
    case "png":  return "image/png";
    case "jpg":
    case "jpeg": return "image/jpeg";
    case "gif":  return "image/gif";
    case "webp": return "image/webp";
    case "avif": return "image/avif";
    case "bmp":  return "image/bmp";
    case "svg":  return "image/svg+xml";
    case "mp4":  return "video/mp4";
    case "webm": return "video/webm";
    case "mov":  return "video/quicktime";
    case "mkv":  return "video/x-matroska";
    case "mp3":  return "audio/mpeg";
    case "m4a":  return "audio/mp4";
    case "wav":  return "audio/wav";
    case "ogg":
    case "opus": return "audio/ogg";
    case "htm":
    case "html": return "text/html";
    case "csv":  return "text/csv";
    case "json": return "application/json";
    case "txt":
    case "md":
    case "log":  return "text/plain";
    default:     return "application/octet-stream";
  }
}

// Keep a copy of one picked file against a target id.
//
// Returns false rather than throwing when the file is too big, or the browser refuses the write
// because the disk is full. The caller then carries on without a copy, which is exactly how every
// local target behaved before this existed — so the worst case is the old behaviour, not a
// half-added target.
async function fgFileSave(id, file) {
  if (!id || !file) return false;
  const size = Number(file.size || 0);
  if (!size || size > FG_FILE_MAX_BYTES) return false;
  try {
    // Read the bytes out rather than storing the File itself. A File from the dialog is a live
    // reference to the disk: storing it succeeds, and then reading it back weeks later throws
    // because the file has been moved, renamed or edited since.
    const buf = await file.arrayBuffer();
    const type = String(file.type || "") || fgGuessType(file.name);
    await fgFileTx("readwrite", store => store.put({
      name: String(file.name || "file"),
      type,
      size,
      savedAt: Date.now(),
      blob: new Blob([buf], { type })
    }, id));
    return true;
  } catch { return false; }
}

async function fgFileLoad(id) {
  if (!id) return null;
  try { return (await fgFileTx("readonly", s => s.get(id))) || null; }
  catch { return null; }
}

async function fgFileDrop(id) {
  if (!id) return false;
  try { await fgFileTx("readwrite", s => s.delete(id)); return true; }
  catch { return false; }
}

async function fgFileIds() {
  try { return (await fgFileTx("readonly", s => s.getAllKeys())) || []; }
  catch { return []; }
}

// The address that opens a kept copy. One definition, used by every page that draws a target row —
// Settings, the blocked page, the popup — so a picked file's link is the same everywhere.
function fgViewerUrl(id) {
  if (!id) return "";
  try { return chrome.runtime.getURL("viewer.html") + "?t=" + encodeURIComponent(id); }
  catch { return ""; }
}
