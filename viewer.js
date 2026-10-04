// Shows the copy FocusGate kept of a file you picked.
//
// Chrome refuses to tell an extension where a picked file lives, so there is no file:// address to
// send you to — see filestore.js. The copy is served from here instead, at
// chrome-extension://<id>/viewer.html?t=<target id>. The target id in the address is what makes
// this page count: background.js reads it in viewerTargetId(), so targetCovers() treats this page
// as the file itself and the seconds land on that target.
//
// Nothing here draws a clock. viewer.html loads content.js, which puts FocusGate's ordinary
// countdown card on top — with the camera, the break button and the pause reasons — the same card
// you get on a website. This file's whole job is to put the file on the screen.

const params = new URLSearchParams(location.search);
const targetId = params.get("t") || "";
const stage = document.getElementById("stage");

function esc(v) {
  return String(v == null ? "" : v).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

function showNote(html) {
  stage.classList.add("center");
  stage.innerHTML = `<div class="note">${html}</div>`;
}

function render(rec, url) {
  const type = String(rec.type || "");
  stage.classList.remove("center");

  // A PDF, an image, a video — all the things a study file usually is. An <iframe> rather than
  // <embed>: frames are what the extension page's content security policy leaves open, while
  // <embed> answers to object-src. Chrome puts its own PDF viewer inside the frame anyway,
  // complete with the toolbar and the page count.
  if (/^application\/pdf/.test(type)) {
    const f = document.createElement("iframe");
    f.src = url;
    f.title = rec.name || "PDF";
    stage.appendChild(f);
    return;
  }
  if (/^image\//.test(type)) {
    stage.classList.add("center");
    const img = document.createElement("img");
    img.src = url;
    img.alt = rec.name || "Image";
    stage.appendChild(img);
    return;
  }
  if (/^video\//.test(type) || /^audio\//.test(type)) {
    stage.classList.add("center");
    const m = document.createElement(/^video\//.test(type) ? "video" : "audio");
    m.src = url;
    m.controls = true;
    m.setAttribute("aria-label", rec.name || "Media");
    stage.appendChild(m);
    return;
  }
  // A local web page. Sandboxed WITHOUT allow-same-origin on purpose: a blob made here carries the
  // extension's own origin, so an .html file given the run of it could reach chrome.* and act as
  // FocusGate. Scripts still run, in an origin of their own, which is what a self-contained study
  // page needs and nothing more.
  if (/^text\/html/.test(type)) {
    const f = document.createElement("iframe");
    f.setAttribute("sandbox", "allow-scripts allow-forms allow-popups");
    f.src = url;
    f.title = rec.name || "Page";
    stage.appendChild(f);
    return;
  }
  // Plain text of some kind. Read out and written as text, never as markup — the file is shown,
  // not run.
  if (/^text\//.test(type) || /json|xml|javascript/.test(type)) {
    const pre = document.createElement("pre");
    pre.textContent = "Loading…";
    stage.appendChild(pre);
    rec.blob.text().then(t => { pre.textContent = t; })
                   .catch(() => { pre.textContent = "Couldn't read this file."; });
    return;
  }
  // Anything else: Chrome has no viewer for it, so the honest answer is a download rather than a
  // blank page. The time still counts while this tab is in front of you.
  showNote(`<h2>No viewer for this kind of file</h2>
    <div>Chrome can't display <span class="fn">${esc(rec.name || "this file")}</span> in a tab.
    Your time still counts while this tab is open — or save a copy and open it in the app it belongs to.</div>
    <a class="btn" href="${esc(url)}" download="${esc(rec.name || "file")}">Save a copy</a>`);
}

(async () => {
  if (!targetId) {
    showNote(`<h2>No file was named</h2><div>This page opens a file you added in FocusGate's settings. Open it from the list there.</div>`);
    return;
  }

  const rec = await fgFileLoad(targetId);
  if (!rec || !rec.blob) {
    // Either the target is gone, or it was added before FocusGate started keeping copies. Both are
    // fixed the same way — pick the file again — so that is what it says.
    let nm = "that file";
    try {
      const s = await chrome.storage.local.get("productiveSites");
      const t = (s.productiveSites || []).find(x => x && x.id === targetId);
      if (t) nm = t.label || t.path || t.url || nm;
    } catch {}
    document.title = "FocusGate";
    showNote(`<h2>FocusGate doesn't have this file</h2>
      <div>There's no copy of <span class="fn">${esc(nm)}</span> saved here. Add it again with
      <b>Choose files…</b> in Settings and it will open from anywhere in FocusGate.</div>
      <button class="btn" id="toSettings" type="button">Open Settings</button>`);
    const b = document.getElementById("toSettings");
    if (b) b.addEventListener("click", () => { try { chrome.runtime.openOptionsPage(); } catch {} });
    return;
  }

  // The tab's own title is the only place the file's name is written now — the card content.js
  // draws carries it too, and a third copy along the top edge was reading space for nothing.
  document.title = (rec.name || "File") + " — FocusGate";

  // The object URL is deliberately never revoked: it has to stay valid for as long as this tab is
  // open, and the browser drops it by itself when the tab closes.
  let url = "";
  try { url = URL.createObjectURL(rec.blob); } catch {}
  if (!url) {
    showNote(`<h2>Couldn't open the copy</h2><div>Something went wrong reading FocusGate's copy of this file. Adding it again in Settings will replace it.</div>`);
    return;
  }
  render(rec, url);
})();
