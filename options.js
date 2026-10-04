// FocusGate Options page - full settings, with the password on the writes
// Keep-alive port for auto-lock on close
try { chrome.runtime.connect({ name: "options" }); } catch {}

async function sha256(str) {
  const enc = new TextEncoder().encode(str);
  const buf = await crypto.subtle.digest("SHA-256", enc);
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2,"0")).join("");
}
const $ = (s, root=document) => root.querySelector(s);
const app = document.getElementById("app");

async function getState() { return await chrome.storage.local.get(null); }
// Ungated. Only three kinds of caller may use this: the form that MAKES the password (there
// is nothing to ask for yet), a form that has just checked the password by hand and must not
// be asked a second time, and the unlock itself. Everything else goes through setStateP.
async function setStateRaw(p) { return await chrome.storage.local.set(p); }

// Thrown when a write is refused because the page is locked and no password was given. Its
// whole job is to stop the caller: nearly every handler here is `await setStateP(...)`
// followed by a toast and a re-render, and none of that should happen after a refusal.
class EditLocked extends Error {
  constructor() { super("locked"); this.name = "EditLocked"; }
}

// The gated write, and the one place that decides which question a change has to answer.
//
// There are two, and they are opposite ends of the same table:
//
//   loosening — asks for the password. You are letting yourself off.
//   tightening — asks "are you sure". You are not letting yourself off, so there is nothing
//                to prove; but the change is ONE-WAY. The table that let you switch a check on
//                without a password is the table that will want one to switch it back off. A
//                confirmation is the honest place to say that: before, not after.
//
// Exclusive, and the password wins a mixed patch. See FGSettings.tightens.
//
// The direction is read from storage rather than declared by the caller. A handler that had
// to say which way it was going is a handler that can get it wrong, and the one that gets it
// wrong is the one that quietly stops asking. See FGSettings.STRICTER for the table, which is
// also the reason there is nothing to remember at the thirty-odd call sites below.
//
// `opts.confirmed` is for the handful of callers that already put a sheet in front of this
// exact decision — winding today's time back, starting the day over, restoring a backup.
// Deliberately about duplicate UI and nothing else: it cannot make a loosening write skip the
// password, only stop the same question being asked twice in a row.
async function setStateP(p, opts) {
  const patch = p || {};
  const before = await getState();
  if (FGSettings.loosens(patch, before)) {
    // Strict mode goes FIRST, ahead of the password, because it is the stronger answer: while a
    // window or a deadline is running there is no password that lets you ease a rule off. That is
    // the whole point of having committed to it.
    //
    // It only ever refuses this direction. Everything that makes a rule HARDER goes through
    // untouched — raise a goal, switch a check on, block another site — which is what strict mode
    // is for. Before this it refused both directions at each call site, so being frozen also
    // meant being unable to hold yourself to anything more.
    if (inStrictWindow(before)) {
      toast(strictRefusal(patch, before));
      renderRoot().catch(() => {});
      throw new EditLocked();
    }
    if (!(await requireUnlock())) {
      toast("Password needed to ease a rule off 🔒");
      // The control that was just moved is showing a value nothing saved, so put the page back
      // to what is actually stored rather than leaving the two disagreeing.
      renderRoot().catch(() => {});
      throw new EditLocked();
    }
  } else if (!(opts && opts.confirmed) && FGSettings.tightens(patch, before)) {
    if (!(await confirmTighten(patch, before))) {
      renderRoot().catch(() => {});
      throw new EditLocked();
    }
  }
  return await setStateRaw(patch);
}

// How long the freeze has left, in words. Written once because two messages need it and they
// must not disagree: the refusal that turns a loosening edit away, and the warning that tells you
// a tightening edit cannot be taken back. The two halves lift at very different times — a daily
// window is over this evening, a deadline can be days away — so "wait until it lifts" means
// nothing without saying which.
function strictWhenPhrase(s) {
  if (FGStrict.strictDeadlineActive(s)) {
    const left = FGStrict.strictLeftText(s);
    return left ? "for another " + left : "until the deadline";
  }
  if (FGStrict.dailyStrict(s)) return "until " + FGStrict.hhmm(s.strictEnd, STRICT_TO);
  return "";
}

// What to say when strict mode turns a loosening edit away.
//
// It names the setting, because "Strict mode is on" on its own leaves you guessing which of the
// things you just touched it objected to — and with a switch that springs back, guessing is all
// you have.
function strictRefusal(patch, before) {
  const what = FGSettings.describe(patch, before, "loosen");
  const thing = what.length ? what.join(", ") : "that";
  const when = strictWhenPhrase(before);
  return "Strict mode is on 🛡️ You cannot ease off " + thing +
         (when ? " " + when : "") + ". Making it stricter still works.";
}

// One sheet at a time, and a second question waits for the first to be answered rather than
// opening on top of it. Two tightening edits in quick succession are two real decisions, so
// neither is dropped — but confirmAsk paints a full-screen backdrop, and two of those stacked
// leaves the lower one taking no clicks and never closing.
let tightQueue = Promise.resolve();
function confirmTighten(patch, before) {
  const turn = tightQueue.then(() => askTighten(patch, before));
  // The chain must not break on a rejection, or every later question is skipped.
  tightQueue = turn.catch(() => {});
  return turn;
}
async function askTighten(patch, before) {
  // Re-read rather than trusting the `before` handed in: the sheet ahead of this one in the
  // queue may have been the edit that armed strict mode or turned the password off.
  const s = await getState();

  // TWO reasons a tightening edit is one-way, and either one on its own is enough to be worth
  // saying. Strict mode used to be missing from this test, which left a real hole: with no
  // password set but a window running, tightening was silent — and it was the LEAST undoable
  // case of the lot, because a strict window refuses the way back outright rather than asking
  // for something you could type.
  const frozen = inStrictWindow(s);
  const guarded = s.passwordProtectionEnabled !== false && !!s.passwordHash;
  // Neither. Undoing this is as easy as making it, so the warning would be describing a
  // consequence that does not exist — and a dialog that cries wolf is one people learn to
  // dismiss without reading. Say the true thing or say nothing.
  if (!frozen && !guarded) return true;

  // Named in the words the page itself uses, because a warning that will not say what it is
  // warning about does not get read. See FGSettings.SAYS.
  const what = FGSettings.describe(patch, before, "tighten");
  const list = what.length
    ? `<b>${what.map(escHtml).join("</b>, <b>")}</b>`
    : "a rule";

  // The reason sentence follows whichever gate is actually standing behind the change. Strict
  // mode leads when both apply: it is the stronger of the two, and it is the one with a clock
  // on it, so it is the part you need to have heard.
  const when = strictWhenPhrase(s);
  let why;
  if (frozen && guarded) {
    why = `<b>Strict mode is on</b>, so you will not be able to undo this
           ${escHtml(when || "until it lifts")} — and no password gets round that.
           After it lifts, undoing it will ask for your password.`;
  } else if (frozen) {
    why = `<b>Strict mode is on</b>, so you will not be able to undo this
           ${escHtml(when || "until it lifts")}. There is nothing to type and no way round it —
           that is what you asked strict mode for.`;
  } else {
    why = `This needs no password — going in this direction never does. <b>Undoing it will.</b>
           ${!s.sessionUnlocked
             ? "Settings are locked right now, so putting this back means typing your password."
             : "This session is unlocked, but it will not stay that way — once it locks, putting this back means typing your password."}`;
  }

  return await confirmAsk({
    title: frozen ? "Make this stricter? You can't undo it yet" : "Make this stricter?",
    body: `You are about to tighten ${list}.<br/><br/>${why}
           <br/><br/>That is the point of it, not a snag. Say yes when you mean to be held to it.`,
    go: "Yes, tighten it",
    no: "Leave it alone"
  });
}
function uid() { return "id_" + Math.random().toString(36).slice(2, 10); }
// `opts` is optional and every existing caller passes nothing, so they all keep the behaviour they
// had: one line, 2.5 seconds. It exists for the messages that are a sentence rather than a result —
// "saved ✓" can be read in a glance, "make sure your phone is online" cannot, and without a
// max-width the toast simply grows until it spans the window.
//   cls: an extra class ("wide" wraps it and caps its width)
//   ms:  how long it stays
function toast(msg, opts) {
  const o = opts || {};
  const t = document.createElement("div");
  t.className = "toast" + (o.cls ? " " + o.cls : "");
  // role, so a screen reader announces it. It is the only thing that reports these actions.
  t.setAttribute("role", "status");
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), Math.max(1200, o.ms || 2500));
}

// ---- permission to reach Google's API -------------------------------------
//
// The one and only origin anything here sends to. Top level, because TWO tabs need it now: the 🎯 Study
// topics card on General, and the AI category picker on Earn & Unlock. It used to be nested inside
// renderGeneral, which made it invisible to the second one — a copy in each would have been two chances to
// ask for a different origin, or to forget to ask at all.
//
// ALREADY GRANTED on today's manifest, and worth being clear about rather than implying a prompt nobody
// will see: FocusGate declares `host_permissions: ["<all_urls>"]` because it has to run its clock on every
// site you might nominate as work. That covers this, so `contains` answers true and `request` is never
// reached.
//
// It is asked anyway, and stays asked, for two reasons:
//
//   The worker CHECKS it before every call (see aiHasOrigin), so both sides already agree that a missing
//   origin means "don't send". If `<all_urls>` is ever narrowed — and it should be, it is far more than
//   this extension needs — these features keep working with an ordinary optional-permission prompt instead
//   of quietly going silent.
//
//   A revoked origin is a real state today. A user can take `<all_urls>` away in chrome://extensions by
//   setting site access to "on click", and then `contains` really does answer false.
//
// Asked from the page because chrome.permissions.request needs a live user gesture and a service worker
// never has one.
async function askAiOrigin() {
  try {
    if (await chrome.permissions.contains({ origins: [FGAi.ORIGIN_PATTERN] })) return true;
    return await chrome.permissions.request({ origins: [FGAi.ORIGIN_PATTERN] });
  } catch (e) { return false; }
}

// ---- how big the camera window is -----------------------------------------
// The bounds are stated in three places for three different reasons, and they have to agree:
// settings.js validates anything arriving from a file, content.js clamps what it draws, and this
// clamps what the slider can ask for. 72px is where the clock stops being readable — the whole card
// scales with the preview, so that is the binding limit. The ceiling is 1280 (a 1280 x 960 preview),
// which on most screens is as close to full screen as a 4:3 camera gets; the real limit is the window
// itself and content.js clamps to it, so this number only has to be big enough not to be in the way.
const CAM_SIZE_MIN = 72, CAM_SIZE_MAX = 1280, CAM_SIZE_DEFAULT = 134;
function camSizeClamp(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return CAM_SIZE_DEFAULT;
  return Math.round(Math.max(CAM_SIZE_MIN, Math.min(CAM_SIZE_MAX, n)));
}
function camSizeVal(s) { return camSizeClamp((s || {}).camSizePx); }
// The real numbers rather than a word. Every other dial in this group is a five-point scale where
// the value has no meaning on its own and a name is the only useful label; this one is a measurement,
// and "134 × 100" says something "normal" could not.
function camSizeText(w) { return `${w} × ${Math.round(w * 3 / 4)}`; }

// ---- Hard confirm ---------------------------------------------------------
// Wiping today's progress is one stray click away from ruining a day's work, so
// it gets a real speed bump: type the words, and the button stays dead for a few
// seconds either way. Escape or a click outside walks away; nothing is written
// unless this resolves true.
const RESET_PHRASE = "yes i want to reset";
function confirmReset({ title, body, phrase = RESET_PHRASE, wait = 5, go = "Reset" }) {
  return new Promise(resolve => {
    const back = document.createElement("div");
    back.className = "sheetback";
    back.setAttribute("data-testid", "confirm-reset");
    back.innerHTML = `
      <div class="sheet" role="alertdialog" aria-modal="true" aria-labelledby="cfTitle" aria-describedby="cfBody">
        <div class="sheettop"><span class="sheetic" aria-hidden="true">⚠️</span>
          <h3 id="cfTitle">${escHtml(title)}</h3></div>
        <p id="cfBody">${escHtml(body)}</p>
        <label class="sheetlbl" for="cfType">Type <b>${escHtml(phrase)}</b> below to allow it</label>
        <input class="input" id="cfType" autocomplete="off" spellcheck="false"
               placeholder="${escHtml(phrase)}" aria-describedby="cfHint" data-testid="confirm-input"/>
        <div class="sheetrow">
          <span class="sheethint" id="cfHint" role="status"></span>
          <button class="btn sec" id="cfNo" data-testid="confirm-cancel">Keep it</button>
          <button class="btn danger" id="cfYes" disabled data-testid="confirm-ok">${escHtml(go)}</button>
        </div>
      </div>`;
    document.body.appendChild(back);
    const yes = back.querySelector("#cfYes"), no = back.querySelector("#cfNo");
    const box = back.querySelector("#cfType"), hint = back.querySelector("#cfHint");
    let left = Math.max(0, wait | 0), typed = false, timer = 0;
    function paint() {
      yes.disabled = left > 0 || !typed;
      hint.textContent = left > 0
        ? `Wait ${left}s…`
        : typed ? "" : "Type the words to switch this on";
      yes.textContent = left > 0 ? `${go} (${left})` : go;
    }
    paint();
    if (left > 0) {
      timer = setInterval(() => {
        left--;
        if (left <= 0) { left = 0; clearInterval(timer); timer = 0; }
        paint();
      }, 1000);
    }
    box.addEventListener("input", () => {
      typed = box.value.trim().replace(/\s+/g, " ").toLowerCase() === phrase;
      paint();
    });
    function close(v) {
      if (timer) clearInterval(timer);
      document.removeEventListener("keydown", onKey, true);
      back.remove();
      resolve(v);
    }
    function onKey(e) {
      if (e.key === "Escape") { e.stopPropagation(); e.preventDefault(); close(false); }
      else if (e.key === "Enter" && !yes.disabled) { e.stopPropagation(); e.preventDefault(); close(true); }
      else if (e.key === "Enter") { e.stopPropagation(); e.preventDefault(); }
    }
    document.addEventListener("keydown", onKey, true);
    back.addEventListener("click", e => { if (e.target === back) close(false); });
    no.addEventListener("click", () => close(false));
    yes.addEventListener("click", () => { if (!yes.disabled) close(true); });
    setTimeout(() => box.focus(), 30);
  });
}
// ---- Plain yes / no confirm ----------------------------------------------
// The lighter sibling of confirmReset: no phrase to type, no countdown. For an
// act that is deliberate and reversible-by-waiting rather than destructive —
// switching strict mode on, where the cost is being held to your own rules
// rather than losing work. Same sheet, so it looks like one family.
function confirmAsk({ title, body, go = "Yes", no = "Cancel", danger = false }) {
  return new Promise(resolve => {
    const back = document.createElement("div");
    back.className = "sheetback";
    back.setAttribute("data-testid", "confirm-ask");
    back.innerHTML = `
      <div class="sheet" role="alertdialog" aria-modal="true" aria-labelledby="caTitle" aria-describedby="caBody">
        <div class="sheettop"><span class="sheetic" aria-hidden="true">⚠️</span>
          <h3 id="caTitle">${escHtml(title)}</h3></div>
        <p id="caBody">${body}</p>
        <div class="sheetrow">
          <span class="sheethint"></span>
          <button class="btn sec" id="caNo" data-testid="ask-cancel">${escHtml(no)}</button>
          <button class="btn ${danger ? "danger" : ""}" id="caYes" data-testid="ask-ok">${escHtml(go)}</button>
        </div>
      </div>`;
    document.body.appendChild(back);
    const yes = back.querySelector("#caYes");
    function close(v) {
      document.removeEventListener("keydown", onKey, true);
      back.remove();
      resolve(v);
    }
    function onKey(e) {
      if (e.key === "Escape") { e.stopPropagation(); e.preventDefault(); close(false); }
      else if (e.key === "Enter") { e.stopPropagation(); e.preventDefault(); close(true); }
    }
    document.addEventListener("keydown", onKey, true);
    back.addEventListener("click", e => { if (e.target === back) close(false); });
    back.querySelector("#caNo").addEventListener("click", () => close(false));
    yes.addEventListener("click", () => close(true));
    // Focus lands on the way out, not the way in: the safe button is the default.
    setTimeout(() => back.querySelector("#caNo").focus(), 30);
  });
}
// ---- Ask for a password ---------------------------------------------------
// Password boxes used to sit on the card, two rows of them, visible whether you
// wanted them or not. They belong to a moment, not to the page — so they live in
// a sheet that opens when you ask for it and takes its fields away again.
// `verify` gets the typed values and may reject: a wrong password leaves the
// sheet open with the reason under it, instead of clearing the page behind it.
function secretPrompt({ title, body, fields, go = "Confirm", verify }) {
  return new Promise(resolve => {
    const back = document.createElement("div");
    back.className = "sheetback";
    back.setAttribute("data-testid", "secret-prompt");
    const rows = fields.map((f, i) => `
      <label class="sheetlbl" for="sp${i}">${escHtml(f.label)}</label>
      <input class="input" id="sp${i}" type="password" autocomplete="off"
             placeholder="${escHtml(f.placeholder || "")}" data-testid="${escHtml(f.testid || ("secret-" + i))}"/>`).join("");
    back.innerHTML = `
      <div class="sheet" role="alertdialog" aria-modal="true" aria-labelledby="spTitle" aria-describedby="spBody">
        <div class="sheettop"><span class="sheetic" aria-hidden="true">🔑</span>
          <h3 id="spTitle">${escHtml(title)}</h3></div>
        <p id="spBody">${body}</p>
        ${rows}
        <div class="sheetrow">
          <span class="sheethint" id="spHint" role="status"></span>
          <button class="btn sec" id="spNo" data-testid="secret-cancel">Cancel</button>
          <button class="btn" id="spYes" data-testid="secret-ok">${escHtml(go)}</button>
        </div>
      </div>`;
    document.body.appendChild(back);
    const boxes = fields.map((_, i) => back.querySelector("#sp" + i));
    const hint = back.querySelector("#spHint");
    const yes = back.querySelector("#spYes"), no = back.querySelector("#spNo");
    let busy = false;

    function close(v) {
      document.removeEventListener("keydown", onKey, true);
      back.remove();
      resolve(v);
    }
    async function submit() {
      if (busy) return;
      busy = true; yes.disabled = true; hint.textContent = "";
      const values = boxes.map(b => b.value);
      let out = true;
      try { out = await verify(values, msg => { hint.textContent = msg; }); } catch { out = false; }
      busy = false; yes.disabled = false;
      if (out) close(true);
      else {
        // Keep what they typed for the field that was probably right, clear the
        // one they need to retype, and put the caret there.
        const bad = boxes[0];
        if (bad) { bad.value = ""; bad.focus(); }
      }
    }
    function onKey(e) {
      if (e.key === "Escape") { e.stopPropagation(); e.preventDefault(); close(false); }
      else if (e.key === "Enter") { e.stopPropagation(); e.preventDefault(); submit(); }
    }
    document.addEventListener("keydown", onKey, true);
    back.addEventListener("click", e => { if (e.target === back) close(false); });
    no.addEventListener("click", () => close(false));
    yes.addEventListener("click", submit);
    setTimeout(() => boxes[0] && boxes[0].focus(), 30);
  });
}
// ---- Info bubble ----------------------------------------------------------
// All the wordy explanations live inside these. Hover, tap or focus the "?"
// to read them, so the page itself stays icon-first and simple.
function tip(html, cls) {
  return `<span class="tip ${cls || ""}" tabindex="0" role="button" aria-label="More information">
    <span class="tip-i" aria-hidden="true">?</span>
    <span class="tip-box" role="tooltip">${html}</span>
  </span>`;
}
// Tap-to-open and Escape-to-close for the bubbles live in tip.js, which every page
// loads — one copy for all of them.
// Chunky on/off switch
// Pressing Enter in a field should do the obvious thing — the same as clicking the
// button next to it. One delegated listener, so it keeps working after every
// re-render instead of being wired up field by field.
const ENTER_TARGET = {
  // add a work target
  newUrl: "addBtn", newH: "addBtn", newM: "addBtn", newS: "addBtn",
  // block / allow lists
  newBlocked: "addBlocked", newAllowed: "addAllowed",
  // general settings
  // (the anti-cheat numbers and the strict-mode window save themselves, so Enter
  //  is handled where those are bound)
  resetTime: "saveTime",
  // password screen
  pw: "go", pw2: "go",
  // password tab — the rest of the password boxes live in sheets now, which
  // handle Enter themselves
  newProtPw: "enableProt"
};
document.addEventListener("keydown", (e) => {
  if (e.key !== "Enter" || e.isComposing || e.shiftKey) return;
  const el = e.target;
  if (!el || !el.id) return;
  const btn = document.getElementById(ENTER_TARGET[el.id] || "");
  if (!btn || btn.disabled) return;
  e.preventDefault();
  btn.click();
});

// Numbers are written back in their plainest form. Two things get tidied:
//   • an empty box means the smallest value it allows — 0 for every h / m / s box.
//     Clearing the minutes used to leave the box blank and the old value stored,
//     so nothing you did seemed to take.
//   • a leading zero goes. Typing 1 next to the 0 that was already there gives
//     "01", which means 1 and only takes up room.
// Decimals are left exactly as typed — "0.5" is not "5".
function tidyNumberValue(v, min) {
  const s = String(v == null ? "" : v).trim();
  if (s === "") return String(Number.isFinite(min) ? min : 0);
  if (!/^\d+$/.test(s)) return s;
  return String(parseInt(s, 10));
}
function tidyNumberInput(el) {
  if (!el || el.tagName !== "INPUT" || el.type !== "number") return false;
  const next = tidyNumberValue(el.value, parseFloat(el.getAttribute("min")));
  if (next === String(el.value)) return false;
  el.value = next;
  return true;
}
// Capture, because each box's own handlers are what actually save: tidying the
// value and then re-firing input/change lets them do their normal job.
document.addEventListener("focusout", (e) => {
  if (!tidyNumberInput(e.target)) return;
  e.target.dispatchEvent(new Event("input", { bubbles: true }));
  e.target.dispatchEvent(new Event("change", { bubbles: true }));
}, true);

// Click into a number box and what's already in it is selected, so the first digit you
// type replaces the value instead of landing beside it.
//
// Every number on this page is a short one you are setting, not text you are editing: a
// duration, a count of seconds, a day of the month. Typing 45 into a box reading 30 gave
// you 4530 or 3045 depending on where the caret happened to land, and then the box clamped
// that to its maximum — so a two-key change needed a select-all or two backspaces first.
//
// Delegated from the document and registered once, because renderApp() replaces the whole
// page on every change; a listener attached per box would have to be re-attached in a
// dozen places and would be missed in one of them.
function selectAllIn(el) {
  // Number inputs support select() but not selectionStart/selectionEnd — Chrome throws on
  // those — so this is deliberately the blunt version, and guarded anyway.
  try { el.select(); } catch {}
}
function isNumBox(el) {
  if (!el || el.tagName !== "INPUT" || el.disabled || el.readOnly) return false;
  // The deadline's time box is `type="text"` rather than `type="number"` — it holds "06:45", which is
  // not a number — but it is exactly the kind of box this exists for: five characters you replace, not
  // text you edit. Click it, type 0645, done. A second click inside puts the caret where you clicked,
  // which is how you get at just the minutes.
  // Only the select-on-focus half applies; tidyNumberInput below keeps its own type check, so the
  // focusout tidier leaves this box to the time row's own mask and clamping.
  if (el.classList && el.classList.contains("wtime")) return true;
  return el.type === "number";
}
// The box that has just taken focus, if it was a click that put it there. A click sets the
// caret AFTER focus lands, which collapses a selection made on focus alone — so the same
// box is selected again once the mouse comes up, and only then.
let selectOnMouseUp = null;
document.addEventListener("focusin", (e) => {
  if (!isNumBox(e.target)) return;
  selectAllIn(e.target);            // covers Tab and programmatic focus
  selectOnMouseUp = e.target;
});
document.addEventListener("mouseup", (e) => {
  const box = selectOnMouseUp;
  selectOnMouseUp = null;
  // Only the press that brought the box into focus. A second click inside a box you were
  // already typing in leaves the caret where you put it, which is what you want once you
  // are past replacing the whole value.
  if (box && box === e.target) selectAllIn(box);
});

// Write a duration back into its three boxes the way we'd have rendered it:
// no leading zeros, and anything that overflowed carried into the next unit, so
// 90 typed into minutes settles as 1h 30m. Boxes that already agree are left
// alone, so the caret never jumps while you're still in one.
function writeHMS(sec, hEl, mEl, sEl) {
  const t = splitHMS(Math.max(0, sec | 0));
  const put = (el, v) => { if (el && String(el.value) !== String(v)) el.value = String(v); };
  put(hEl, t.h); put(mEl, t.m); put(sEl, t.s);
}

// One hours : minutes : seconds control, used everywhere a time is set — the
// add-a-target row and each row in the list. Same shape every time, so the page
// only has one way of asking for a duration.
// `attrs(unit)` supplies whatever identifies each box (an id here, a data
// attribute there), so the callers' existing handlers keep working.
function hmsWells(sec, attrs, o = {}) {
  const t = splitHMS(sec || 0);
  // Strict mode no longer greys these out. A duration can be moved in two directions and only
  // one of them is a loosening, so a disabled box was the wrong answer half the time: it stopped
  // you raising today's goal, which is precisely what strict mode is supposed to be protecting.
  // Lowering it is refused by setStateP, with a message that says why.
  // `o.strict` is still accepted and still passed in by the callers, so a control that genuinely
  // has no stricter direction can ask for the old behaviour.
  const dis = o.freeze ? "disabled" : "";
  // The unit sits beside its box, not under it — captions underneath needed
  // reserved space below every row and still ended up overlapping.
  const cell = (unit, val, max, name) =>
    `<label class="tfld"><input class="input" type="number" min="0" max="${max}" value="${val}" title="${name}" aria-label="${name}" ${attrs(unit)} ${dis}/><i>${unit}</i></label>`;
  return `<span class="timeset${o.plain ? " plain" : ""}"${o.id ? ` id="${o.id}"` : ""}>
      ${o.icon === false ? "" : `<span class="gicon" aria-hidden="true">⏳</span>`}
      ${cell("h", t.h, 99, "hours")}${cell("m", t.m, 59, "minutes")}${cell("s", t.s, 59, "seconds")}
      ${o.tip || ""}
    </span>`;
}

// The handle on every foldable heading. A drawn chevron inside a round amber
// chip: a bare "▸" glyph was thin and easy to miss, so nobody could tell the
// heading was clickable. CSS rotates it 90° when the section is open.
const CARET = `<span class="car" aria-hidden="true"><svg viewBox="0 0 24 24" width="11" height="11" focusable="false"><path d="M9 5l7 7-7 7" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/></svg></span>`;

// Show / hide, for the API key box. Drawn for the same reason the caret and the shield below are: the
// 👁 emoji renders at a different size and baseline on every platform, and this one has to sit dead
// centre in a small square button beside a text box.
//
// The icon shows the CURRENT state rather than the action — an open eye means "this is hidden, press to
// see it", which is the convention every password box uses, and the tooltip says the action outright so
// the picture never has to carry it alone.
const EYE_SHOW = `<svg class="smark" viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/></svg>`;
const EYE_HIDE = `<svg class="smark" viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/><path d="M3 3l18 18"/></svg>`;

// The shield on a row, drawn rather than typed. The 🛡️ emoji carries its own
// spacing and never sits dead centre in a 16px circle; an SVG does, and it takes
// currentColor so "this row has its own rules" is just a colour.
const SHIELD_MARK = `<svg class="smark" viewBox="0 0 24 24" width="11" height="11" aria-hidden="true" focusable="false">
  <path d="M12 2.8 19.5 5.5v5.9c0 4.4-3 8.1-7.5 9.3-4.5-1.2-7.5-4.9-7.5-9.3V5.5Z"
        fill="none" stroke="currentColor" stroke-width="2.3" stroke-linejoin="round" stroke-linecap="round"/>
</svg>`;

// Icon for what kind of target a row is. The words live in the tooltip, so the
// list stays a column of names rather than a column of badges.
function targetKind(p) {
  if (p.type === "youtube_channel") return { icon: "📺", label: "YouTube channel" };
  if (p.type === "youtube_playlist") return { icon: "🎬", label: "YouTube playlist" };
  if (p.type === "youtube_video") return { icon: "▶️", label: "One exact video" };
  if (p.type === "local_file") {
    const path = p.path || p.url || "";
    const isFolder = !/\.[a-z0-9]{1,8}$/i.test(localPath(path));
    // Whether we know the whole address or only the tail of it, said in the tooltip, because it
    // changes what the target actually matches — and it is the one thing about a picked file that
    // is not obvious from looking at it.
    const tail = p.stored
      ? (looksLocalPath(path)
          ? " Click the name to open the original file on your computer."
          : " Click the name to open it — FocusGate will use its own copy until it learns the real path. Open the file once with Ctrl+O and FocusGate will remember the address.")
      : looksLocalPath(path) ? ""
        : " Matched by name and folder, because Chrome didn't say which drive it came from — open it once and FocusGate will remember the exact address.";
    return isFolder
      ? { icon: "📁", label: "A folder on this computer — every file inside it counts." + tail }
      : { icon: "🗂️", label: "A file on this computer, opened in Chrome." + tail };
  }
  if ((p.url || "").includes("/")) return { icon: "📄", label: "This page and anything deeper" };
  return { icon: "🌐", label: "Whole site" };
}

// Where clicking a row's name should take you. Addresses are stored without a
// protocol (normSite strips it), and YouTube targets keep an id rather than a
// link, so each kind is turned back into something a tab can open.
function targetOpenUrl(p) {
  if (!p) return "";
  if (p.type === "local_file") {
    // The real file:// address, when FocusGate knows it. The background learns the full path the
    // first time the file is opened in a tab (see the upgrade in background.js), at which point
    // p.url holds the file:// URL and p.path holds the normalised path. Opening the original file
    // directly is what the user expects from a link — it lands on the address they know.
    const path = p.url || p.path || "";
    if (looksLocalPath(path)) return toFileUrl(path);
    // No real path yet — Chrome's file dialog never says which drive a picked file came from, so
    // the first time it is only known by name. If a copy was kept, the viewer is the fallback: it
    // is also the only address where the camera and stillness checks can run, since Chrome draws a
    // file:// PDF with a built-in viewer that no script of ours can reach.
    if (p.stored) return fgViewerUrl(p.id);
    // Neither a real path nor a copy — a folder, or a file too big to keep whose drive is unknown.
    // "" leaves the row as plain text, which is better than a dead link.
    return "";
  }
  if (p.type === "youtube_video" && p.videoId) {
    return "https://www.youtube.com/watch?v=" + encodeURIComponent(p.videoId);
  }
  if (p.type === "youtube_playlist" && p.playlistId) {
    return "https://www.youtube.com/playlist?list=" + encodeURIComponent(p.playlistId);
  }
  if (p.type === "youtube_channel") {
    const raw = String(p.url || p.channelId || "").trim();
    if (!raw) return "";
    if (/^https?:\/\//i.test(raw)) return raw;
    if (raw.includes("youtube.com")) return "https://" + raw;
    if (raw.startsWith("@")) return "https://www.youtube.com/" + raw;
    if (/^UC[\w-]{20,}$/.test(raw)) return "https://www.youtube.com/channel/" + raw;
    return "https://www.youtube.com/@" + raw;
  }
  // The "*." prefix is a matching instruction, not part of a host name, so it comes off
  // before this becomes a link — see siteOpenUrl. A target has no use for it (a work
  // target already covers its subdomains), but normSite accepts it for the allow list
  // and the same box feeds both, so one typed here must not produce a dead link.
  const u = String(p.url || "").trim().replace(/^\*\./, "");
  if (!u) return "";
  return /^https?:\/\//i.test(u) ? u : "https://" + u;
}
// The same idea for a plain address typed into the locked / allowed lists.
// The "*." prefix is a matching instruction, not part of any host name:
// "https://*.google.com" is not a URL a browser will load, so leaving it in would turn
// the chip into a dead link. Dropping it opens the site the rule is named after, which
// is the page someone clicking "*.google.com" would expect.
function siteOpenUrl(url) {
  const u = String(url || "").trim().replace(/^\*\./, "");
  if (!u) return "";
  return /^https?:\/\//i.test(u) ? u : "https://" + u;
}

// ---------------------------------------------------------------------------
function sw(id, on, disabled, testid) {
  return `<label class="sw"><input type="checkbox" id="${id}" ${on ? "checked" : ""} ${disabled ? "disabled" : ""} ${testid ? `data-testid="${testid}"` : ""}/><span class="track"></span></label>`;
}

// ---------------------------------------------------------------------------
// One colour ramp for every progress bar in FocusGate: red at the start, through
// orange and yellow, to green when it's full — so the colour tells you where you
// are before you've read a single number. The same three functions live in
// popup.js and blocked.js; extension pages don't share modules, so the ramp is
// copied rather than imported. Keep them identical.
// ---------------------------------------------------------------------------
function barHue(pct) {
  const p = Math.max(0, Math.min(100, pct)) / 100;
  // Eased, so orange arrives around a quarter and yellow around half, instead of
  // the whole first half looking red.
  return Math.round(120 * Math.pow(p, 0.85));
}
function barFill(pct) {
  const h = barHue(pct);
  const from = Math.max(0, h - 40);
  const sat = h >= 100 ? 68 : 92;
  const lit = h >= 100 ? 46 : 52;
  return `linear-gradient(90deg, hsl(${from} ${sat}% ${Math.min(58, lit + 4)}%), hsl(${h} ${sat}% ${lit}%))`;
}
function barGlow(pct) {
  return `0 0 6px hsla(${barHue(pct)}, 90%, 50%, .45)`;
}
// Paint one bar's fill: width, colour and glow in one place.
function paintBar(fill, pct, shown) {
  if (!fill) return;
  const p = Math.max(0, Math.min(100, Math.round(pct || 0)));
  const w = shown === false ? 0 : p;
  fill.style.width = w + "%";
  fill.style.background = barFill(p);
  fill.style.boxShadow = w > 0 ? barGlow(p) : "none";
  fill.classList.toggle("zero", w <= 0);
}
// The same thing as an inline style, for freshly rendered markup.
function barStyle(pct, shown) {
  const p = Math.max(0, Math.min(100, Math.round(pct || 0)));
  const w = shown === false ? 0 : p;
  return `width:${w}%;background:${barFill(p)};box-shadow:${w > 0 ? barGlow(p) : "none"}`;
}

// Time helpers (hours / minutes / seconds)
function splitHMS(sec) {
  sec = Math.max(0, sec | 0);
  return { h: Math.floor(sec / 3600), m: Math.floor((sec % 3600) / 60), s: sec % 60 };
}
function fmtDur(sec) {
  sec = Math.max(0, sec | 0);
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  return (h ? h + "h " : "") + (m || h ? m + "m " : "") + s + "s";
}

let activeTab = "productive";
// The state the current render was built from. The per-site no-cheating panel needs
// the global values to show what a row inherits when it isn't overriding them.
let lastState = null;

// The window this card offers when storage holds no times yet, and the parser that reads
// them. Both from strict.js, which is also where the guard reads them — they used to be
// written out here with one fallback and in the guard with another.
const STRICT_FROM = FGStrict.STRICT_FROM;
const STRICT_TO = FGStrict.STRICT_TO;
const YEARS_AHEAD = FGStrict.YEARS_AHEAD;
const strictTime = (v, fallback) => FGStrict.hhmm(v, fallback);

// Are the settings frozen right now? Every guard on this page asks this and nothing else.
// Kept as a local name because those thirty-odd call sites read better for it, but the
// answer comes from strict.js — and it now covers BOTH reasons, the daily window and a
// running deadline, so no guard has to remember to ask about the second one.
function inStrictWindow(s) {
  return FGStrict.strictNow(s);
}

// ---- waking up when strict mode changes ------------------------------------
// The page is drawn once and then sits there. Strict mode, though, is a fact about the
// clock, so it can stop being true while nothing at all has happened in storage — and
// storage is the only thing this page listened to. So a window that ended at 16:44 left the
// red banner up, the time boxes greyed and the tooltips saying "frozen" until you reloaded,
// which reads as the freeze having outlasted its own schedule.
//
// The fix is a single timer aimed at the next edge — see FGStrict.strictNextChangeAt — that
// re-reads the state, and redraws only if the answer actually moved.
//
// Capped at ten minutes. If the next-edge sum is ever wrong, the page self-corrects within
// ten minutes instead of never; without a cap a bad answer would be a page that never
// unfreezes, which is the worst failure this can have. Long timers are also unreliable in
// a suspended tab, so re-checking on the way past costs nothing and buys accuracy.
const STRICT_WATCH_CAP = 10 * 60 * 1000;
let strictWatch = 0;
// What the render currently on screen assumed. Compared rather than trusted, so a tick that
// changes nothing does not take the focus out of a box you are typing in.
let shownStrict = null;

function armStrictWatch(s) {
  clearTimeout(strictWatch);
  shownStrict = inStrictWindow(s);
  const next = FGStrict.strictNextChangeAt(s);
  // A second past the edge, not exactly on it: dailyStrict compares whole minutes, and a
  // timer that fires a hair early would find the answer unchanged, redraw nothing, and arm
  // itself for the same moment again.
  const wait = next ? Math.min(STRICT_WATCH_CAP, Math.max(1000, next - Date.now() + 1000))
                    : STRICT_WATCH_CAP;
  strictWatch = setTimeout(() => { strictTick().catch(() => {}); }, wait);
}

async function strictTick() {
  const s = await getState();
  // Two reasons to redraw, and renderRoot handles the tidying for both — a served commitment
  // has its switch cleared there, on the one path every render goes through.
  if (FGStrict.strictDeadlineSpent(s) || inStrictWindow(s) !== shownStrict) return renderRoot();
  // Nothing moved. Aim at the next edge rather than redrawing, so a tick that changes nothing
  // does not take the focus out of a box you are typing in.
  armStrictWatch(s);
}

// Switched off from the popup, this page would otherwise look exactly as usual —
// bars, times, locked lists — while none of it is doing anything. So it says so, at
// the top, with the way back.
function offBanner(s) {
  if (s.enabled !== false) return "";
  return `<div class="card offbanner" data-testid="off-banner">
    <span class="offic" aria-hidden="true">⏻</span>
    <div class="offtxt">
      <div class="offttl">FocusGate is switched off</div>
      <div class="offsub">Nothing is blocked, no time is being counted, and the camera stays off — everything below is only what <i>would</i> happen. Your settings and today's progress are kept.</div>
    </div>
    <button class="btn" id="turnOnFg" data-testid="turn-on-btn">Turn it on</button>
  </div>`;
}

function strictBanner(s) {
  if (!inStrictWindow(s)) return "";
  // Which of the two is holding it, and when it lifts. Both, when both are on. This used
  // to state the daily window unconditionally, so a deadline froze the page while the
  // banner quoted a window that had nothing to do with it — and told you it would lift at
  // 08:00 when in fact it would not lift for three days.
  const deadline = FGStrict.strictDeadlineActive(s);
  const daily = FGStrict.dailyStrict(s);
  const left = FGStrict.strictLeftText(s);
  const why = [];
  if (deadline) {
    why.push(`Held on until <b>${escHtml(FGStrict.strictUntilLabel(FGStrict.strictUntil(s)))}, ` +
             `${escHtml(FGStrict.strictUntilTime(s))}</b>${left ? " — " + escHtml(left) + " left" : ""}.`);
  }
  if (daily) {
    why.push(`Locked every day from <b>${escHtml(strictTime(s.strictStart, STRICT_FROM))}</b> ` +
             `to <b>${escHtml(strictTime(s.strictEnd, STRICT_TO))}</b>.`);
  }
  return `<div class="card" style="background:linear-gradient(135deg,#7f1d1d,#431407);border-color:#f97316;">
    <div style="display:flex;align-items:center;gap:10px;">
      <div style="font-size:24px">🛡️</div>
      <div>
        <div style="font-weight:800;color:#fde68a;font-size:14px">Strict Mode Active</div>
        <!-- The old sentence named two allowed acts out of about twenty, which was both wrong
             and unhelpful. The rule is a direction, not a list: anything that makes a rule
             harder goes through, anything that eases one off is refused until this lifts. -->
        <div style="font-size:12px;color:#fed7aa;margin-top:2px">${why.join(" ")}
          You can still make any rule <b>stricter</b> — raise a goal, switch a check on, block
          another site. <b>Easing one off is refused</b> until this lifts, and no password gets
          round it.</div>
      </div>
    </div>
  </div>`;
}

// ---- the edit gate --------------------------------------------------------
// True while this page may be read but not eased off.
//
// The password used to stand in front of the whole page: a locked session showed a single box
// and nothing else. That guarded the wrong thing. What the password is for is that you cannot
// casually undo your own rules, and that is about CHANGING them — locking the reading too
// meant you could not check what today's goal was, how much of it was left, or which sites
// were locked, without first proving who you are, and not one of those is a rule you could
// weaken by looking at it. The practical result was people leaving the page unlocked.
//
// So the page opens. Loosening writes ask. There is one place to ask from because there is one
// place that writes — setStateP — plus the few handlers that check the password themselves.
//
// Making a password for the first time is still a whole page: see renderSetupPassword.
let editLocked = false;
let lockedNow = false;
// True from the moment this page unlocks itself until its own storage event has been seen and
// ignored. Without it the unlock's own write would redraw the page from under the edit that
// asked for the password.
let selfUnlock = false;
async function requireUnlock() {
  if (!editLocked) return true;
  const s = await getState();
  // Turned off, or unlocked in another tab, while this page sat open. Nothing to ask.
  if (s.passwordProtectionEnabled === false || !s.passwordHash || s.sessionUnlocked) {
    editLocked = false;
    return true;
  }
  if (!(await askPassword(s.passwordHash))) return false;
  // Raw: this would otherwise come straight back through the gate it has just satisfied.
  selfUnlock = true;
  await setStateRaw({ sessionUnlocked: true });
  editLocked = false;
  return true;
}

// One row at the bottom of the window, and deliberately not a modal.
//
// It dims nothing and covers nothing. It has one question, the answer is one short word, and
// it interrupts an edit you have already decided on. A dark scrim would be the worst of it: it
// would hide the very setting being asked about, and a page going dark is how this file says
// "are you sure you want to wipe the day", not "type your password".
//
// The hash is checked in here rather than by the caller, so a wrong password can be answered
// where it was typed without the bar closing and losing the edit that opened it.
//
// One bar at a time, and every waiting write shares the same promise. Nothing blocks the page
// now, so a second edit can easily arrive while this is open — two bars would be two prompts
// for one password, and answering the first would strand the second.
let pwAsk = null;
function askPassword(hash) {
  if (pwAsk) return pwAsk;
  pwAsk = new Promise(resolve => {
    const bar = document.createElement("div");
    bar.className = "pwbar";
    bar.setAttribute("role", "dialog");
    bar.setAttribute("aria-label", "Password needed to change a setting");
    bar.setAttribute("data-testid", "pw-bar");
    bar.innerHTML = `
      <div class="pwrow">
        <span class="pwic" aria-hidden="true">🔒</span>
        <input class="input" id="pgPw" type="password" autocomplete="current-password"
               placeholder="Your password" aria-label="Your password" data-testid="pw-bar-input"/>
        <button class="btn" id="pgYes" type="button" data-testid="pw-bar-ok">Unlock</button>
        <button class="btn sec" id="pgNo" type="button" data-testid="pw-bar-no">Cancel</button>
      </div>
      <div class="pwerr" id="pgHint" role="status"></div>`;
    document.body.appendChild(bar);
    const box = bar.querySelector("#pgPw"), hint = bar.querySelector("#pgHint");
    const yes = bar.querySelector("#pgYes"), no = bar.querySelector("#pgNo");
    function close(v) {
      document.removeEventListener("keydown", onKey, true);
      document.removeEventListener("pointerdown", onAway, true);
      bar.remove();
      pwAsk = null;
      resolve(v);
    }
    async function submit() {
      const pw = box.value;
      if (!pw) { hint.textContent = "Type your password"; return; }
      if ((await sha256(pw)) !== hash) {
        hint.textContent = "Wrong password";
        box.select();
        return;
      }
      close(true);
    }
    function onKey(e) {
      if (e.key === "Escape") { e.stopPropagation(); e.preventDefault(); close(false); }
      else if (e.key === "Enter" && bar.contains(document.activeElement)) {
        e.stopPropagation(); e.preventDefault(); submit();
      }
    }
    // A press anywhere else on the page is a cancel, the same as Escape. There is no scrim to
    // click on, so without this the only ways out are the Cancel button and a key — and
    // clicking off a small thing at the edge of the screen is what everyone tries first.
    //
    // pointerdown rather than click, so the bar is gone before whatever you pressed reacts. On
    // `click` the bar was still standing while the control underneath ran its handler, and if
    // that handler is one that needs the password it would open a second bar which this one's
    // own close would then remove.
    function onAway(e) {
      // Inside the bar is not away. composedPath, not `contains`, because the target of a
      // press on the bar's own input can sit in a shadow tree the bar does not contain.
      const path = typeof e.composedPath === "function" ? e.composedPath() : [e.target];
      if (path.includes(bar)) return;
      close(false);
    }
    // Escape works from anywhere; Enter only from inside the bar, because with no scrim the
    // rest of the page still has the keyboard and Enter means something in its own boxes.
    document.addEventListener("keydown", onKey, true);
    // Registered on the next task, not now. This bar is opened from an edit that a press just
    // started, and on some of those paths the press is still being dispatched — registering
    // during it would have the bar close itself on the very press that asked for it.
    // `bar.isConnected`, not `pwAsk`: by the time this runs THIS bar may already be closed and
    // a different one open, which leaves pwAsk truthy and pointing at someone else.
    setTimeout(() => {
      if (bar.isConnected) document.addEventListener("pointerdown", onAway, true);
    }, 0);
    no.addEventListener("click", () => close(false));
    yes.addEventListener("click", submit);
    setTimeout(() => box.focus(), 30);
  });
  return pwAsk;
}

// Says out loud what state the page is in, so a prompt on the first edit is expected rather
// than a surprise. Only on screen while the lock is actually up.
function lockBanner() {
  if (!editLocked) return "";
  return `<div class="card lockbar" data-testid="lock-bar">
    <span class="lockbaric" aria-hidden="true">🔒</span>
    <div class="grow">
      <div class="lockbarttl">Settings are locked</div>
      <!-- Not "changing something will ask", which is what this said when every write asked.
           Only the loosening direction prompts now, and a banner that overstates the rule
           trains you to stop believing it. -->
      <div class="lockbarsub">Read anything, and make any rule <b>stricter</b> freely — raise a goal, switch a check on, lock another site. Easing one off asks for your password.</div>
    </div>
    <button class="btn sec lockbarbtn" id="unlockNow" type="button" data-testid="unlock-now">Unlock</button>
  </div>`;
}
// Delegated, and registered once at module scope rather than inside a render's wiring. The
// banner is rebuilt by every renderRoot, so a per-element binding would have to be re-attached
// on each one — and the render that forgot would leave a button that does nothing.
document.addEventListener("click", async (e) => {
  if (!e.target.closest || !e.target.closest("#unlockNow")) return;
  // Unlocking ahead of an edit rather than during one. Nothing to write afterwards: the banner
  // going away IS the result, and requireUnlock has already stored the unlock.
  if (await requireUnlock()) {
    renderRoot().catch(() => {});
    toast("Unlocked — settings can be eased off now");
  }
});

// ---- offering a password, the one thing still worth a whole page ------------
// This used to be two screens in one function: "make a password" and "enter password". The
// second is gone — a locked session reads the page and asks on the first loosening edit — so
// what is left is the first run, where there is no hash to check anything against and so
// nothing that "read-only" could protect.
//
// An offer, not a toll gate. Nothing in FocusGate needs a password: the timers, the blocking and
// the daily reset all work without one. All it buys is that YOU cannot quickly undo your own rules
// in a weak moment — genuinely worth having, and precisely the kind of thing someone should choose
// once they have seen what they are protecting, rather than be made to invent on the way in.
async function renderSetupPassword() {
  app.innerHTML = `
    <div class="wrap">
      <div class="brand"><div class="logo">F</div><h1>FocusGate</h1></div>
      <div class="card lockcard">
        <h2>🔑 Password — optional ${tip("This password protects your settings so you can't easily undo your own rules later. At least 4 characters. Write it down somewhere safe.<br/><br/>It only guards the <b>loosening</b> direction: you can always open Settings and read them, and you can always make a rule harder, without typing anything.<br/><br/>Skipping is fine — everything else works the same, and you can add one later from the <b>🔑 Password</b> tab.")}</h2>
        <!-- Said here rather than left to the tooltip. Someone deciding whether to skip needs to
             know what they are giving up, and "optional" on its own does not tell them. -->
        <div class="setupnote">Stops <b>you</b> undoing your own rules later — lowering a goal, switching a check off, unblocking a site. Reading this page and making a rule <b>stricter</b> never ask for it.</div>
        <input class="input" id="pw" type="password" placeholder="Password" data-testid="options-password-input"/>
        <input class="input" id="pw2" type="password" placeholder="Confirm password" style="margin-top:8px" data-testid="options-password-confirm"/>
        <div class="err" id="err"></div>
        <button class="btn" id="go" style="width:100%;margin-top:8px" data-testid="options-unlock-btn">Save &amp; continue</button>
        <button class="btn sec" id="skipPw" type="button" style="width:100%;margin-top:8px" data-testid="options-skip-pw">No thanks — skip for now</button>
      </div>
    </div>`;

  // Recorded as protection being off rather than as a "skipped" flag of its own, because that is
  // exactly what it means and it is the same state the switch in the Password tab produces. So this
  // screen does not come back (renderRoot sends that state straight to renderApp), and the Password
  // tab already knows how to offer one later: with no hash it shows the box instead of the switch.
  //
  // Raw, and it has to be. Turning protection off is the loosening direction, so the ordinary
  // setter would demand a password to allow it — and the whole point of this button is that there
  // isn't one. A gate cannot guard the decision about whether to have a gate.
  $("#skipPw").addEventListener("click", async () => {
    await setStateRaw({ passwordProtectionEnabled: false });
    editLocked = false;
    await renderRoot();
    toast("No password set — you can add one any time in the 🔑 Password tab");
  });

  $("#go").addEventListener("click", async () => {
    const pw = $("#pw").value, pw2 = $("#pw2").value;
    const err = $("#err");
    if (!pw) { err.textContent = "Password required"; return; }
    if (pw.length < 4) { err.textContent = "Password too short"; return; }
    if (pw !== pw2) { err.textContent = "Passwords do not match"; return; }
    // Raw: this IS the password being made, so it must not be sent through a gate that would
    // ask for a password which does not exist yet.
    await setStateRaw({ passwordHash: await sha256(pw), sessionUnlocked: true });
    renderRoot();
  });
}

// ---- full-page lock: nothing visible until the password is entered --------
// When fullPageLockEnabled is on AND the session is locked, the entire settings
// page is replaced by a single password prompt. Unlike the old read-only mode
// (which shows everything and asks on loosening edits), this shows NOTHING —
// not the targets, not the blocklist, not the streak.
async function renderFullPageLock() {
  const s = await getState();
  app.innerHTML = `
    <div class="wrap">
      <div class="brand">
        <div class="logo">F</div>
        <h1>FocusGate</h1>
        <span class="grow"></span>
        ${supportLinks()}
      </div>
      <div class="card lockcard">
        <h2>🔒 Settings are locked ${tip("<b>Full-page lock</b> is on. Nothing on the settings page is visible until you enter your password.<br/><br/>You can turn this off from the <b>🔑 Password</b> tab once you are inside.")}</h2>
        <p class="hint" style="margin:8px 0 12px">Enter your password to view and edit settings.</p>
        <input class="input" id="fpPw" type="password" placeholder="Password" autocomplete="current-password" style="width:100%"/>
        <div class="err" id="fpErr"></div>
        <button class="btn" id="fpGo" style="width:100%;margin-top:6px">Unlock</button>
      </div>
    </div>`;
  bindSupportLinks();
  const box = $("#fpPw"), err = $("#fpErr"), btn = $("#fpGo");
  async function submit() {
    const pw = box.value;
    if (!pw) { err.textContent = "Enter your password"; return; }
    if ((await sha256(pw)) !== s.passwordHash) { err.textContent = "Wrong password"; box.select(); return; }
    selfUnlock = true;
    await setStateRaw({ sessionUnlocked: true });
    editLocked = false;
    lockedNow = false;
    renderRoot();
  }
  btn.addEventListener("click", submit);
  box.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); submit(); }
  });
  setTimeout(() => box.focus(), 30);
}

// Which of the pages this is, and whether edits are gated.
async function renderRoot() {
  let s = await getState();
  // Checked on the way in as well as by the watcher, because a deadline that ran out while no
  // settings page was open would otherwise sit there reading ON until the first tick ten
  // minutes later — and the first thing you would see on opening the page is the stale version.
  // Nothing is enforced either way; see strictDeadlineSpent.
  if (FGStrict.strictDeadlineSpent(s)) {
    await setStateRaw({ strictUntilEnabled: false });
    s = await getState();
  }
  if (s.passwordProtectionEnabled === false) { lockedNow = false; editLocked = false; return renderApp(); }
  if (!s.passwordHash) { lockedNow = true; editLocked = false; return renderSetupPassword(); }
  // Full-page lock: when on AND the session is not unlocked, nothing is shown at all.
  // The user must enter the password before even seeing the settings page.
  if (s.fullPageLockEnabled && !s.sessionUnlocked) {
    lockedNow = true;
    editLocked = true;
    return renderFullPageLock();
  }
  lockedNow = false;
  editLocked = !s.sessionUnlocked;
  return renderApp();
}

// Normalise an address the user typed: drop the protocol, "www." and any #hash,
// keep the path AND the query. The query matters — "youtube.com/watch?v=abc" and
// "site.com/quiz?id=7" are only exact if their query survives. Case is kept
// because ids in paths and queries are case sensitive when you open them again.
// Returns "" for anything that is not a site, and every caller already treats "" as
// "skip this one" — so this is also the validator.
//
// "www." goes because it is not a different site: google.com redirects to
// www.google.com and the matcher treats the two as one for the same reason. What it
// must NOT do is confuse that with a subdomain — see hostMatches in background.js.
//
// A leading "*." survives. It is how you ask for every subdomain, which the allow list
// does not hand you by default any more, and stripping it here would quietly turn a
// deliberate "all of google.com" back into the one site.
function normSite(v) {
  let head = (v || "").trim().replace(/^https?:\/\//i, "");
  // Taken off the front and put back on at the return, so every check in between sees
  // an ordinary host name. Those checks reject a "*" on sight, deliberately: a wildcard
  // anywhere other than this prefix matches nothing, and used to be stored as a chip
  // that looked like a rule and was not one.
  let wide = false;
  if (/^\*\./.test(head)) { wide = true; head = head.slice(2); }
  const raw = head
    .replace(/^www\./i, "")
    .split("#")[0];
  const q = raw.indexOf("?");
  const beforeQuery = q < 0 ? raw : raw.slice(0, q);
  const query = q < 0 ? "" : raw.slice(q + 1).replace(/[?&]+$/, "");
  const [hostRaw, ...rest] = beforeQuery.split("/");
  // A trailing dot is the same host to DNS, so it must not survive into a stored
  // pattern either — otherwise the list holds two spellings of one site.
  const host = hostRaw.replace(/\.+$/, "");
  if (!host) return "";

  // ---- it has to be a host name ----
  // Without these checks any stray word was accepted as a "site": it matched nothing,
  // ever, sat in the list as a chip that looked exactly like a real rule, and the only
  // feedback was a cheerful "Added". A blocklist entry that silently blocks nothing is
  // worse than a refusal, because you believe the site is covered.
  //
  // A bare `:port` is dropped rather than refused — typing one is a reasonable mistake
  // and the rule means the same site either way. Bracketed IPv6 keeps its colons.
  const bracketed = /^\[.*\]$/.test(host);
  const bare = bracketed ? host : host.replace(/:\d+$/, "");
  if (!bare) return "";
  // Letters, digits, dots and hyphens only. The matcher compares against a URL's host,
  // which never holds a wildcard, credentials or spaces — so `re*dit.com`,
  // `me@example.com` and `my notes` would all have been stored and matched nothing.
  // The leading `*.` is already off the front by here, so this still turns away a `*`
  // used anywhere a host name cannot contain one.
  if (!bracketed && !/^[a-z0-9.-]+$/i.test(bare)) return "";
  // And it needs a dot in it. This is the check that turns away "edged" and "etwwe".
  // localhost is the one real host name without one; a bracketed IPv6 literal has none
  // either, and is already known to be a host by its brackets.
  if (!bracketed && !bare.includes(".") && bare !== "localhost") return "";
  // A label cannot start or end with a hyphen, and ".." is not a host.
  if (!bracketed && (/(^|\.)-|-(\.|$)|\.\./.test(bare))) return "";
  // The last label of a real domain is alphabetic (.com, .org, .co.uk). This turns away
  // "1.2" and "version.2" while leaving "192.168.0.1" alone, which is a host you may
  // genuinely want to block.
  const isIPv4 = /^\d{1,3}(\.\d{1,3}){3}$/.test(bare);
  if (!bracketed && !isIPv4 && bare !== "localhost" && !/\.[a-z]{2,}$/i.test(bare)) return "";

  // The path is resolved the way a browser resolves it, because that is what the
  // matcher compares against: empty and "." segments go, ".." pops the one before it.
  const segs = [];
  for (const seg of rest.join("/").split("/")) {
    if (!seg || seg === ".") continue;
    if (seg === "..") { segs.pop(); continue; }
    segs.push(seg);
  }
  const path = segs.join("/");
  return (wide ? "*." : "") + bare + (path ? "/" + path : "") + (query ? "?" + query : "");
}

// ---------- files on this computer ----------
// A local file isn't a website: it has no host, only a path. So it's stored as its
// own kind of target, matched by path, and the background compares it the same way
// it compares an exact page — the file itself, or anything inside it if you point
// at a folder.
function isLocalUrl(u) { return /^file:/i.test(String(u || "").trim()); }
// Does what was typed look like a path on this computer rather than an address?
//   file:///D:/x   ·   D:\notes\a.pdf   ·   C:/notes   ·   \\server\share   ·   /Users/me/a.html
function looksLocalPath(v) {
  const s = String(v || "").trim();
  if (!s) return false;
  if (/^file:/i.test(s)) return true;
  if (/^[a-z]:[\\/]/i.test(s)) return true;
  if (/^\\\\/.test(s)) return true;
  return /^\/[^/]/.test(s);
}
// One plain form, so the same file written any of those ways compares equal.
// Must stay in step with filePath() in background.js.
function localPath(v) {
  let s = String(v || "").trim().split("#")[0].split("?")[0];
  s = s.replace(/^file:\/*/i, "").replace(/\\/g, "/");
  try { s = decodeURIComponent(s); } catch {}
  return s.replace(/\/{2,}/g, "/").replace(/^\/+/, "").replace(/\/+$/, "").toLowerCase();
}
// Back to something a tab can open: file:///D:/notes/my%20file.pdf
function toFileUrl(v) {
  let s = String(v || "").trim().split("#")[0];
  s = s.replace(/^file:\/*/i, "").replace(/\\/g, "/");
  try { s = decodeURIComponent(s); } catch {}
  s = s.replace(/\/{2,}/g, "/").replace(/^\/+/, "").replace(/\/+$/, "");
  if (!s) return "";
  const enc = s.split("/").map(seg => encodeURIComponent(seg).replace(/%3A/gi, ":")).join("/");
  return "file:///" + enc;
}
// Try to discover a picked file's original path on this computer.
//
// Chrome's file dialog refuses to say where a picked file lives — not even the drive — so the
// path of a single picked file is unknown on the spot. This function tries two other sources:
//   1. Chrome's download history: most PDFs and study materials came through a download, and the
//      download record carries the full path on disk.
//   2. A file:// tab already open: if the file is up in another tab, its address bar has the path.
// Returns a file:/// URL when found, or "" when neither source knows.
async function discoverOriginalPath(name) {
  if (!name) return "";
  // 1. Chrome's download history.
  try {
    if (chrome.downloads && chrome.downloads.search) {
      const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const hits = await chrome.downloads.search({
        filenameRegex: escaped + '$',
        state: 'complete',
        orderBy: ['-startTime'],
        limit: 10
      });
      const dl = hits.find(h => {
        if (!h.filename || h.exists === false) return false;
        const base = h.filename.replace(/\\/g, '/').split('/').pop();
        return base === name;
      });
      if (dl && dl.filename) return toFileUrl(dl.filename);
    }
  } catch {}
  // 2. An already-open file:// tab with the same name.
  try {
    const tabs = await chrome.tabs.query({});
    const tab = tabs.find(tb => {
      if (!tb.url || !/^file:/i.test(tb.url)) return false;
      try {
        const decoded = decodeURIComponent(tb.url).replace(/\\/g, '/');
        return decoded.split('/').pop() === name;
      } catch { return false; }
    });
    if (tab && tab.url) return tab.url;
  } catch {}
  return "";
}
function localDisplay(v) {
  let s = String(v || "").trim().replace(/^file:\/*/i, "");
  try { s = decodeURIComponent(s); } catch {}
  return s;
}
// The short name a row goes by: its nickname if you gave it one, otherwise the
// address — or, for a file on this computer, just the file's own name.
function targetName(p) {
  if (!p) return "Site";
  if (p.label) return p.label;
  if (p.type === "local_file") return localName(p.url || p.path);
  return p.url || "Site";
}
// The name to show in the list: the file itself, not the folders above it.
function localName(v) {
  const p = String(v || "").trim().split("#")[0].split("?")[0].replace(/^file:\/*/i, "").replace(/\\/g, "/").replace(/\/+$/, "");
  let last = p.split("/").filter(Boolean).pop() || p;
  try { last = decodeURIComponent(last); } catch {}
  return last || "Local file";
}
// The local files you have open in Chrome right now. Chrome never hands an
// extension the real path of a file picked from a file dialog, so the address bar
// of an open tab is the only honest source: open the file (Ctrl+O), then pick it.
async function localTabsOpen() {
  try {
    const tabs = await chrome.tabs.query({});
    const seen = new Set();
    return (tabs || [])
      .map(t => (t.url || t.pendingUrl || "").trim())
      .filter(isLocalUrl)
      .filter(u => { const k = u.toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; });
  } catch { return []; }
}

// Is FocusGate allowed to see file:// pages at all? Chrome keeps this off by
// default for every extension, and without it a local file can neither be timed
// nor opened from here — so it's worth saying out loud rather than failing quietly.
function fileAccessAllowed() {
  return new Promise(resolve => {
    try {
      if (chrome.extension && chrome.extension.isAllowedFileSchemeAccess) {
        chrome.extension.isAllowedFileSchemeAccess(r => resolve(r !== false));
      } else resolve(true);
    } catch { resolve(true); }
  });
}

// A modal red-alert popup dialog warning that Chrome is hiding local files from FocusGate until
// "Allow access to file URLs" is turned on.
function showFileAccessAlert() {
  if (document.querySelector(".sheetback[data-file-alert]")) return;
  const back = document.createElement("div");
  back.className = "sheetback";
  back.setAttribute("data-file-alert", "1");
  back.setAttribute("data-testid", "file-access-alert");
  back.innerHTML = `
    <div class="sheet" style="border:1.5px solid #ef4444;box-shadow:0 20px 50px rgba(239,68,68,0.35);background:#0f172a" role="alertdialog" aria-modal="true">
      <div class="sheettop">
        <span class="sheetic" style="font-size:24px;line-height:1">⚠️</span>
        <h3 style="color:#f87171;font-size:16px;font-weight:800">Allow Access to File URLs</h3>
      </div>
      <p style="color:#cbd5e1;font-size:13px;line-height:1.6;margin:12px 0 12px">
        FocusGate detected local <span class="kbd" style="background:#1e293b;border-color:#475569;color:#fca5a5">file:///</span> URLs. 
        Chrome hides local files from extensions by default, so your study time on local files <b>cannot be tracked or timed</b> until permission is granted.
        <br/><br/>
        On the page that opens, find <b>"Allow access to file URLs"</b> and switch it on — it is the row ringed below.
      </p>
      <!-- The drawing, not another sentence. The page this sends you to is Chrome's own: it is long,
           it has four other switches on it, and FocusGate may not scroll it, highlight anything on
           it, or even find out whether the switch was ever flicked. Pointing at the row is the most
           this can do, so it does that rather than describing it a fourth time. -->
      <div style="margin:0 0 14px;padding:10px;background:#0b1020;border:1px solid #1e293b;border-radius:10px">
        ${FGSettings.fileAccessGuideSvg()}
      </div>
      <div class="sheetrow" style="justify-content:flex-end;gap:10px">
        <button class="btn sec" id="faDismiss" style="color:#94a3b8">I'll do it later</button>
        <button class="btn danger" id="faOpenPage" style="background:#dc2626;border-color:#ef4444;color:#fff;font-weight:700">Open Extension Page</button>
      </div>
    </div>`;
  document.body.appendChild(back);
  const openBtn = back.querySelector("#faOpenPage");
  const dismissBtn = back.querySelector("#faDismiss");
  function close() {
    document.removeEventListener("keydown", onKey, true);
    back.remove();
  }
  function onKey(e) {
    if (e.key === "Escape") { e.stopPropagation(); e.preventDefault(); close(); }
  }
  document.addEventListener("keydown", onKey, true);
  openBtn.addEventListener("click", () => {
    try { chrome.tabs.create({ url: "chrome://extensions/?id=" + chrome.runtime.id }); } catch {}
    close();
  });
  dismissBtn.addEventListener("click", close);
  back.addEventListener("click", (e) => {
    if (e.target === back) close();
  });
}

// ---- whole categories, in one press ---------------------------------------
//
// The box beside this takes anything, and typing one address into it was never the hard part. The
// hard part is remembering the rest of a category: you block instagram.com and mean Threads too, and
// the mobile host, and the one you only ever open on your phone — and a list with three of a
// category's fifteen doors shut is a list you walk around without noticing you did.
//
// Deliberately not a stored "category" of its own. Pressing one writes the ordinary domains into the
// ordinary list, and every one can be removed on its own afterwards; the chip below simply counts how
// many of its sites are currently there. So nothing new has to be understood, nothing new can get out
// of step with the list it describes, and the worker never learns that categories exist.
//
// Which also decides what a second press does: with the whole set already in, it takes the set back
// out. Anything else would make the chip a one-way door and leave fifteen chips to remove by hand.
// Folded away, because a wall of twenty chips above the one box most people use is the wrong first
// impression of a list you are supposed to type into.
let catOpenFor = null;                 // "blockedSites" | "allowedSites" | null — which picker is unfolded
function catPickerHtml(key, current) {
  const cats = (FGSettings.SITE_CATEGORIES || []);
  if (!cats.length) return "";
  const have = new Set((current || []).map(b => String(b.url || "").toLowerCase()));
  // A category's sites, normalised the same way the box normalises what you type — otherwise the
  // count would disagree with what pressing it actually adds.
  const normed = (c) => c.sites.map(normSite).filter(Boolean);
  const open = catOpenFor === key;
  const allow = key === "allowedSites";
  const chips = cats.map(c => {
    const list = normed(c);
    const inList = list.filter(u => have.has(u.toLowerCase())).length;
    const full = list.length > 0 && inList === list.length;
    const some = inList > 0 && !full;
    return `<button type="button" class="catchip${full ? " full" : some ? " some" : ""}"
            data-cat="${key}|${c.id}"
            aria-pressed="${full ? "true" : "false"}"
            title="${full
              ? `All ${list.length} ${escHtml(c.name)} sites are on this list. Press to take them all off.`
              : some
                ? `${inList} of ${list.length} ${escHtml(c.name)} sites are on this list. Press to add the other ${list.length - inList}.`
                : `Add all ${list.length} ${escHtml(c.name)} sites to this list.`}"
            data-testid="cat-${key}-${c.id}">
            <span class="cic" aria-hidden="true">${c.icon}</span>
            <span class="cnm">${escHtml(c.name)}</span>
            <span class="ccount">${full ? "✓" : some ? `${inList}/${list.length}` : `+${list.length}`}</span>
          </button>`;
  }).join("");
  // How many groups are wholly on the list, so the badge says something about STATE rather than just
  // counting the inventory. Amber when some are on, quiet grey when none are — the page's own rule is
  // that amber means "this is holding you to something", and "20 groups exist" is not that.
  const onCount = cats.filter(c => {
    const list = normed(c);
    return list.length > 0 && list.every(u => have.has(u.toLowerCase()));
  }).length;
  // ---- the same fold as "Phone apps block", at the same left edge ----
  //
  // This used to be its own smaller bar, indented to line up with the text field above it, on the
  // reasoning that it adds to the same list that field adds to. The reasoning was right about what it
  // DOES and wrong about what it IS: it is a fold with twenty chips and a whole AI sub-section inside
  // it, which is exactly what `.sect` exists for, and the card ended up with two collapsible bars at
  // two different indents in two different sizes — which reads as a mistake rather than as a hierarchy.
  //
  // So it is a `.sect` now, identical to the phone fold below it, and the chips that show what is
  // actually on the list moved ABOVE it — see renderBlocked. That leaves the card in two halves: the
  // field with its own contents under it, then the two folds, aligned.
  return `
    <div class="sect">
      <!-- Wrapped in a sechead with a "?" beside it, exactly like the phone fold. Two reasons, and the
           second is the alignment: the "?" is what pulls that fold's badge in from the right edge, so
           without one here the two badges sat at different places on rows that are otherwise identical.
           The first reason is that this fold had no explanation on it at all — the text inside only
           appears once you have already opened it, which is too late to tell you what it is for.
           (No backticks in this comment: the whole block is a template literal, so one would end the
           string here and turn the markup after it into code.) -->
      <div class="sechead">
        <button type="button" class="secthead" data-catfold="${key}" aria-expanded="${open ? "true" : "false"}"
                data-testid="catfold-${key}">
          ${CARET}
          <span class="ic" aria-hidden="true">🗂️</span>
          <span class="ttl">Add by category</span>
          <span class="cnt${onCount ? "" : " quiet"}">${onCount ? `${onCount} on` : `${cats.length} groups`}</span>
        </button>
        ${tip(`<b>Ready-made groups of sites</b>, so you do not have to remember every address yourself. Press one and its sites go straight onto the list.<br/><br/>
<b>It writes ordinary addresses.</b> Nothing new is stored and no "category" is kept — the sites turn up as chips you can remove one at a time, and pressing the group again takes the whole set back off.<br/><br/>
<b>A group is never complete.</b> Fifteen social networks is not <i>social media</i>; it is fifteen doors shut in a corridor with no walls, and the one reached for at 1am is the sixteenth. For everything nobody thought to list, switch on <b>🤖 AI category ${allow ? "allowing" : "blocking"}</b> inside this fold — then every site you visit is read and judged against the categories you pick, including the ones you have never heard of.<br/><br/>
The two work together: a typed address is exact and always wins, and the AI covers the rest.`)}
      </div>
      <!-- Body only when open, and that is not a space saving. BOTH lists render this picker — the
           blocklist card and the allowlist card are both in the DOM, one of them merely hidden — and
           the AI block inside carries a switch with a fixed id. Rendering both bodies at once would put
           that id in the page twice, and the handler that reads it would silently wire the other list's
           switch. catOpenFor holds one key, so only one body can exist, which is what keeps it unique.
           (No backticks, and no id spelled out, in this comment: the whole block is a template literal,
           so a backtick would end the string — and this comment ships to the browser, so an id written
           here would turn up in the page text and confuse anything counting them.) -->
      ${open ? `
      <div class="sectbody">
        <div class="catbody">
          <div class="cathint">${allow
            ? "Each press opens that whole group. On the allow list an entry opens <b>that exact site only</b> — write <span class='kbd'>*.example.com</span> in the box above for its subdomains too."
            : "Each press locks that whole group, subdomains included. Press again to unlock it. Anything a group misses goes in the box above."
          }</div>
          <div class="catchips">${chips}</div>
          ${aiCatHtml(key)}
        </div>
      </div>` : ""}
    </div>`;
}

// ---- the same categories, decided by an AI instead of by a list ------------
//
// The chips above write ordinary domains. This writes CATEGORY IDS, and every site you visit is classified
// against them.
//
// Both exist because they fail in opposite directions, and the honest thing is to offer both rather than
// pretend either is complete. A typed list is exact, free, instant and permanent — and it can only ever
// contain the domains somebody thought of. Fifteen social networks is not "social media"; it is fifteen
// doors shut in a corridor with no walls, and the one reached for at 1am is the sixteenth. The classifier
// covers the corridor, and costs a request per domain and a model's judgement, which can be wrong.
//
// Deliberately in the same fold as the chips rather than in a card of its own. They are two answers to one
// question, and separating them would leave somebody choosing categories in two places without ever being
// told the difference.
function aiCatHtml(key) {
  const s = lastState || {};
  const cats = (FGSettings.SITE_CATEGORIES || []);
  const allow = key === "allowedSites";
  const on = s.aiCatEnabled === true;
  const picked = new Set(Array.isArray(allow ? s.aiCatAllow : s.aiCatBlock)
    ? (allow ? s.aiCatAllow : s.aiCatBlock) : []);
  // The other list's picks, so a category can never be in both — which would be a rule that contradicts
  // itself and whose outcome depended on the order the blocker happened to test them in.
  const other = new Set(Array.isArray(allow ? s.aiCatBlock : s.aiCatAllow)
    ? (allow ? s.aiCatBlock : s.aiCatAllow) : []);
  const hasKey = !!String(s.aiTopicKey || "").trim();
  const chips = cats.map(c => {
    const mine = picked.has(c.id), theirs = other.has(c.id);
    return `<button type="button" class="catchip ai${mine ? " full" : ""}${theirs ? " taken" : ""}"
            data-aicat="${key}|${c.id}" aria-pressed="${mine ? "true" : "false"}"
            ${theirs ? "disabled" : ""}
            title="${theirs
              ? `${escHtml(c.name)} is already on the other AI list, so it can't be on this one too.`
              : mine
                ? `On — any site the AI reads as ${escHtml(c.name)} is ${allow ? "allowed" : "blocked"}, whether or not you listed it.`
                : `Off — press to ${allow ? "allow" : "block"} every site the AI reads as ${escHtml(c.name)}.`}"
            data-testid="aicat-${key}-${c.id}">
            <span class="cic" aria-hidden="true">${c.icon}</span>
            <span class="cnm">${escHtml(c.name)}</span>
            <span class="ccount">${mine ? "✓" : theirs ? "—" : "AI"}</span>
          </button>`;
  }).join("");
  return `
    <div class="aicat${on ? " on" : ""}">
      <div class="srow" style="padding:8px 0 4px">
        <span class="ic">🤖</span>
        <span class="lbl grow">AI category ${allow ? "allowing" : "blocking"} ${tip(`<b>Every site you visit is read by an AI and sorted into categories.</b> Pick the categories below and any site that belongs to one is ${allow ? "allowed" : "blocked"} — including the thousands you would never think to type.<br/><br/><b>Why this exists beside the buttons above.</b> Those add a list of well-known addresses, which is exact, instant, free and permanent. It is also only ever the addresses somebody thought of: fifteen social networks is not "social media", it is fifteen doors shut in a corridor with no walls.<br/><br/><b>What it costs.</b> One question per <b>domain</b>, not per page — "youtube.com is a video site" is true of every address on it, so each site is asked about once and remembered for two months. It uses the same free Gemini key as <b>🎯 Study topics</b> in Settings → General, and the same daily allowance.<br/><br/><b>What it does when it cannot decide.</b> Nothing. A site not yet classified, a site the model does not recognise, no key, no internet, quota spent — every one of those leaves the site exactly as it would be without this feature. It never blocks on a guess.<br/><br/><b>It can be wrong.</b> It is a language model reading a domain name and a page title. An explicit address in the box above always wins over it, so the fix for a misjudged site is to leave the category on and deal with that one site by hand.<br/><br/>A category can be on the blocked list or the allowed list, never both.${allow ? "<br/><br/><b>On the allowed list this only does anything in Allowlist mode</b>, where it plays the part an allowed address plays." : ""}`)}</span>
        <span class="ropt-state">${!on ? "off" : !hasKey ? "no key" : picked.size ? picked.size + " on" : "none picked"}</span>
        <label class="sw">
          <input type="checkbox" id="aiCatSw" ${on ? "checked" : ""}
                 aria-label="AI category ${allow ? "allowing" : "blocking"}" data-testid="aicat-sw"/>
          <span class="track"></span>
        </label>
      </div>
      ${on ? `
        ${hasKey ? "" : `<div class="cathint" style="color:#fca5a5">This needs the same Gemini API key as <b>🎯 Study topics</b>. Add it in <b>Settings → General</b> — until then nothing is classified and every site behaves as normal.</div>`}
        <div class="catchips">${chips}</div>` : ""}
    </div>`;
}

// One box, many sites. Split on commas — and on newlines, semicolons and stray
// spaces too, because that's what a pasted list actually looks like. Repeats in
// the same paste are dropped, so "a.com, a.com" adds one.
function splitSites(v) {
  const seen = new Set();
  return String(v || "")
    .split(/[,;\n\r\t]+|\s{2,}/)
    .map(x => x.trim())
    .filter(Boolean)
    .filter(x => {
      const k = x.toLowerCase();
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
}
// The same box also takes a path on this computer, and a path can contain commas
// and single spaces — "D:\Class notes, term 2\week1.pdf" is one file, not three.
// So when the box holds a path, it's only ever split on new lines.
function splitTargets(v) {
  const s = String(v || "").trim();
  if (!s) return [];
  const lines = s.split(/[\r\n]+/).map(x => x.trim()).filter(Boolean);
  if (lines.some(looksLocalPath)) {
    const seen = new Set();
    return lines.filter(x => {
      const k = x.toLowerCase();
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  }
  return splitSites(v);
}
// "3 sites" / "1 site" — used in the confirmations below.
function nSites(n) { return n + (n === 1 ? " site" : " sites"); }
// What to say after a bulk add: how many landed, how many were already there.
function addedToast(added, dupes) {
  if (!added) return dupes ? (dupes === 1 ? "Already there" : "All " + nSites(dupes) + " were already there") : "Nothing to add";
  const head = added === 1 ? "Added" : "Added " + nSites(added);
  return dupes ? head + " · " + nSites(dupes) + " already there" : head;
}

// The video a YouTube link points at, in any shape YouTube uses.
function youtubeVideoId(url) {
  try {
    const u = new URL(/^https?:\/\//i.test(url) ? url : "https://" + url);
    const host = u.hostname.toLowerCase().replace(/^www\./, "").replace(/^m\./, "");
    if (host === "youtu.be") return (u.pathname.split("/").filter(Boolean)[0] || "").trim();
    if (host !== "youtube.com" && !host.endsWith(".youtube.com")) return "";
    const v = u.searchParams.get("v");
    if (v) return v.trim();
    const segs = u.pathname.split("/").filter(Boolean);
    if (segs.length >= 2 && ["shorts", "embed", "live", "v"].includes(segs[0].toLowerCase())) {
      return segs[1].trim();
    }
    return "";
  } catch { return ""; }
}

function detectType(url) {
  url = (url || "").trim();
  if (!url) return { type: "site", url: "" };
  // A file on this computer. Checked first: a path is never a website, and a local
  // page can carry anything in its name — including things that look like a domain.
  if (looksLocalPath(url)) {
    return { type: "local_file", url: toFileUrl(url), path: localPath(url) };
  }
  // YouTube channel handle/url
  const ytChan = url.match(/youtube\.com\/(?:@|c\/|channel\/|user\/)([^\/?#]+)/i);
  if (ytChan) return { type: "youtube_channel", channelId: ytChan[1], url: normSite(url) };
  if (url.startsWith("@")) return { type: "youtube_channel", channelId: url.slice(1), url };
  // One exact YouTube video. Checked before the playlist rule, so a link copied
  // out of a playlist ("...watch?v=ID&list=PL...") tracks THAT video, not the
  // whole playlist. Only that video earns time.
  const vid = youtubeVideoId(url);
  if (vid) return { type: "youtube_video", videoId: vid, url: "youtube.com/watch?v=" + vid };
  // YouTube playlist
  try {
    const u = new URL(/^https?:\/\//i.test(url) ? url : "https://" + url);
    if (u.hostname.includes("youtube.com")) {
      const list = u.searchParams.get("list");
      if (list) return { type: "youtube_playlist", playlistId: list, url: normSite(url) };
    }
  } catch {}
  if (/^PL[A-Za-z0-9_-]{10,}$/.test(url) || /^UU[A-Za-z0-9_-]+/.test(url)) return { type: "youtube_playlist", playlistId: url, url };
  // Site or exact page. "duolingo.com" tracks the whole site, while
  // "duolingo.com/lesson" tracks that page and anything under it (and blocks the
  // shallower pages of the same site). A query is kept and must match too.
  return { type: "site", url: normSite(url) };
}

async function renderApp(opts = {}) {
  const isTabSwitch = opts && opts.tabSwitch;
  const savedY = isTabSwitch ? 0 : ((opts && typeof opts.scrollY === "number") ? opts.scrollY : window.scrollY);
  const s = await getState();
  lastState = s;
  app.innerHTML = `
    <div class="wrap">
      <div class="brand">
        <div class="logo">F</div>
        <h1>FocusGate</h1>
        <span class="grow"></span>
        ${supportLinks()}
      </div>
      <div class="tag">Use your study sites first. Then the fun sites open. ${tip("<b>How FocusGate works</b><ol><li>In step <b>1</b>, pick what you must spend time on (a study site, a YouTube channel, or a file on this computer) and how long.</li><li>In step <b>2</b>, pick the sites to keep locked (games, social media…).</li><li>Step 2 stays locked until step 1 is finished.</li><li>Everything resets each day.</li></ol>")}</div>

      ${offBanner(s)}

      <!-- Above the score strip and the tabs, because it is about the whole page rather than
           any one card, and because a prompt appearing on your first edit should have been
           announced before you made it. -->
      ${lockBanner()}

      ${scoreStrip(s)}

      <div class="tabs">
        <div class="tab ${activeTab==='productive'?'active':''}" data-tab="productive" data-testid="tab-productive" title="Spend time here, open the sites there">🎯 Earn &amp; Unlock</div>
        <div class="tab ${activeTab==='general'?'active':''}" data-tab="general" data-testid="tab-general" title="Settings">⚙️ Setup</div>
        <div class="tab ${activeTab==='security'?'active':''}" data-tab="security" data-testid="tab-security" title="Password">🔑 Password</div>
      </div>

      ${strictBanner(s)}
      <div id="tabContent"></div>
    </div>`;
  document.querySelectorAll(".tab").forEach(t => t.addEventListener("click", () => { activeTab = t.dataset.tab; renderApp({ tabSwitch: true }); }));
  bindSupportLinks();
  // Turning it back on is free — it's the direction that can only help you. (The
  // popup asks for the password to switch it off, not on.)
  $("#turnOnFg")?.addEventListener("click", async () => {
    await setStateP({ enabled: true });
    chrome.runtime.sendMessage({ type: "refreshBlockedTabs" });
    chrome.runtime.sendMessage({ type: "macrodroidSync" });
    renderApp();
    toast("FocusGate is on ✓");
  });
  if (activeTab === "productive" || activeTab === "blocked") renderEarnUnlock(s);
  else if (activeTab === "general") renderGeneral(s);
  else renderSecurity(s);
  // Fresh markup means fresh dots.
  paintOpenDotsSoon(0);
  // Last thing, and after the tab has drawn: this render is now what is on screen, so the
  // watcher records what it assumed about strict mode and aims itself at the next edge.
  armStrictWatch(s);
  if (opts && opts.anchorTargetId) {
    const targetItem = document.querySelector(`.item[data-id="${opts.anchorTargetId}"]`);
    if (targetItem) {
      const rect = targetItem.getBoundingClientRect();
      if (opts.willOpen) {
        // Position targetItem nicely on screen (~140px from top) so its options expand downwards in full view
        const targetY = window.scrollY + rect.top - 140;
        window.scrollTo({ top: Math.max(0, targetY), behavior: "instant" });
        requestAnimationFrame(() => window.scrollTo({ top: Math.max(0, targetY), behavior: "instant" }));
      } else {
        if (rect.top < 60 || rect.bottom > window.innerHeight) {
          const targetY = window.scrollY + rect.top - 140;
          window.scrollTo({ top: Math.max(0, targetY), behavior: "instant" });
          requestAnimationFrame(() => window.scrollTo({ top: Math.max(0, targetY), behavior: "instant" }));
        }
      }
    }
  } else if (savedY > 0) {
    window.scrollTo({ top: savedY, behavior: "instant" });
    requestAnimationFrame(() => window.scrollTo({ top: savedY, behavior: "instant" }));
  }
}

// Points, streak and today's totals used to be a whole tab. They're never
// something you *do*, only something you glance at, so they live in one strip
// above the tabs and are always on screen.
function scoreStrip(s) {
  const xp = s.xp || 0, level = s.level || 1;
  const inLevel = xp % 500;
  const pct = Math.round((inLevel / 500) * 100);
  const sites = (s.productiveSites || []).filter(p => p.enabled !== false && (p.requiredSec !== undefined && p.requiredSec !== null && !isNaN(p.requiredSec) && p.requiredSec >= 0));
  const totals = (self.FGSettings && self.FGSettings.calcTotals) ? self.FGSettings.calcTotals(sites) : null;
  const done = totals ? totals.done : sites.filter(p => (p.requiredSec === 0) || (p.spentSec || 0) >= (p.requiredSec || 0)).length;
  const total = totals ? totals.total : sites.length;
  const mins = Math.floor(sites.reduce((a, b) => a + (b.spentSec || 0), 0) / 60);
  const allDone = totals ? totals.allDone : (total > 0 && done >= total);
  return `
      <div class="score" data-testid="score-strip">
        <span class="s1" title="Level ${level} — ${inLevel} of 500 points to level ${level + 1}">
          <b data-testid="score-level">Lv ${level}</b>
          <span class="xpbar"><span style="width:${pct}%"></span></span>
        </span>
        <span class="s1" title="${s.streakCount || 0} days in a row where you finished everything">
          🔥 <b data-testid="score-streak">${s.streakCount || 0}</b>
        </span>
        <span class="s1${allDone ? " ok" : ""}" title="Jobs done today">
          ${allDone ? "✅" : "☑️"} <b data-testid="score-done">${done}/${total}</b>
        </span>
        <span class="s1" title="Time you spent today">⏱️ <b data-testid="score-mins">${mins}m</b></span>
        <span class="grow"></span>
        ${tip("<b>+1 point</b> for each minute of work<br/><b>+50 points</b> when you finish one thing<br/><b>+200 points</b> when you finish everything for the day<br/><b>500 points = 1 level up</b><br/><br/><b>🔥 Streak</b> grows by 1 each day you finish everything before the day resets. Miss a day and it goes back to zero.<br/><br/><b>${done}/${total}</b> is how many jobs you finished today. The clock is the time you spent.")}
      </div>`;
}

// Support lives in the corner rather than in a tab of its own — it's one line of
// links, not a page.
const SUPPORT_MAIL = "sinhanikhil549@gmail.com";
let supportOpen = false;
function supportLinks() {
  const ver = chrome.runtime.getManifest ? chrome.runtime.getManifest().version : "1.0.0";
  return `
        <span class="support">
          <button class="supbtn" id="supHead" aria-expanded="${supportOpen ? "true" : "false"}" aria-controls="supMenu" title="Get help or send an idea" data-testid="support-toggle">
            <span aria-hidden="true">💬</span> Support ${CARET}
          </button>
          <div class="supmenu" id="supMenu" role="menu" ${supportOpen ? "" : "hidden"}>
            <button class="supitem" id="supMail" role="menuitem" title="${SUPPORT_MAIL}" data-testid="feedback-email-link"><span aria-hidden="true">✉️</span> Email us</button>
            <button class="supitem" id="supWa" role="menuitem" title="+91 76930 75429" data-testid="feedback-whatsapp-link"><span aria-hidden="true">📱</span> WhatsApp</button>
            <div class="supfoot">FocusGate v${ver} · we read every message</div>
          </div>
        </span>`;
}
function bindSupportLinks() {
  const menu = $("#supMenu"), head = $("#supHead");
  function setOpen(open) {
    supportOpen = open;
    if (head) head.setAttribute("aria-expanded", open ? "true" : "false");
    if (menu) menu.hidden = !open;
  }
  head?.addEventListener("click", (e) => { e.stopPropagation(); setOpen(!supportOpen); });
  // Clicking anywhere else, or pressing Escape, puts it away again.
  document.addEventListener("click", (e) => {
    if (supportOpen && !e.target.closest(".support")) setOpen(false);
  });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && supportOpen) setOpen(false); });

  const open = url => { chrome.tabs.create({ url }); setOpen(false); };
  $("#supWa")?.addEventListener("click", () =>
    open("https://wa.me/917693075429?text=" + encodeURIComponent("Hi FocusGate support")));
  // Gmail's compose window, because a bare mailto: does nothing on a machine
  // with no mail app set up.
  $("#supMail")?.addEventListener("click", () =>
    open("https://mail.google.com/mail/?view=cm&fs=1&to=" + encodeURIComponent(SUPPORT_MAIL) +
         "&su=" + encodeURIComponent("FocusGate feedback")));
}

// One tab that tells the whole story: spend time HERE → those sites UNLOCK.
function renderEarnUnlock(s) {
  const tc = document.getElementById("tabContent");
  // Same sums the live painter uses, so the banner can't disagree with itself a
  // second after it's drawn.
  const t = todayTotals(s);
  const totalReq = t.req, totalSpent = t.spent;
  const pct = t.allDone ? 100 : (totalReq ? Math.round(100 * totalSpent / totalReq) : 0);
  const done = t.allDone || (totalReq > 0 && t.left <= 0);
  // Nothing to spend time on today: no targets at all, or every one switched off.
  const nothing = t.count <= 0;
  const lockedCount = (s.blockMode === "whitelist")
    ? (s.allowedSites || []).length
    : (s.blockedSites || []).length;

  tc.innerHTML = `
    <div class="flowbar ${done ? "done" : ""}${nothing ? " solo" : ""}" id="flowBar">
      <div class="flowstep">
        <div class="fnum">1</div>
        <div>
          <div class="ftitle" id="flowTitle1">⏳ Spend your time here</div>
          <div class="fsub" id="flowSpent">${nothing ? "Nothing added yet" : (done && totalReq === 0 ? "All goals completed today" : `${fmtDur(totalSpent)} of ${fmtDur(totalReq)} done today`)}</div>
        </div>
      </div>
      <div class="flowarrow">➜</div>
      <div class="flowstep">
        <div class="fnum">2</div>
        <div>
          <div class="ftitle" id="flowTitle2">${done ? "🔓 These are open now" : "🔒 To open these"}</div>
          <div class="fsub">${lockedCount ? lockedCount + " site" + (lockedCount === 1 ? "" : "s") : "No sites picked yet"}</div>
        </div>
      </div>
    </div>
    <!-- With nothing to earn today — no targets, or every one of them switched off
         — an empty bar reading "0% done" is just a bar measuring nothing, so it
         isn't shown at all. It comes back the moment there's work again. -->
    <div class="flowprog${done ? " done" : ""}" id="flowProg"${nothing ? " hidden" : ""}><div style="${barStyle(pct)}"></div></div>
    <div class="flowpct${done ? " done" : ""}" id="flowPct"${nothing ? " hidden" : ""}>${done ? "🎉 All done. Enjoy!" : pct + "% done"}</div>

  `;

  renderProductive(s);
  renderBlocked(s);
}

// Where to look for a site's logo, best guess first. Each one is tried in turn
// and the first that loads is kept; if none do, the row shows its kind emoji.
//
// The site's own /favicon.ico comes first because it's exact and it's a request
// to the site itself, nothing third-party. Chrome's cached favicon comes after:
// it knows where a site really keeps its icon (from <link rel="icon">), but when
// it has nothing for that address it answers with its grey globe placeholder
// instead of failing — which is why a single lookup looked "broken".
// Which entry in a row's candidate list last produced an actual picture.
//
// Keyed by the joined candidate list rather than by the row's id, so editing a target's address
// starts the search again from the top instead of inheriting the icon of the site it used to be.
//
// In memory only, and deliberately: it is worth nothing after a reload, when the browser's own HTTP
// cache is doing the same job, and storing it would be a write on every render.
const favAt = new Map();
function faviconCandidates(p) {
  let raw = p.url || "";
  if (p.type === "youtube_channel" || p.type === "youtube_playlist" || p.type === "youtube_video") raw = "youtube.com";
  raw = String(raw).trim().replace(/^https?:\/\//i, "");
  if (!raw) return [];
  const host = raw.split("/")[0].split("?")[0].toLowerCase();
  if (!host || !host.includes(".")) return [];
  const hosts = host.startsWith("www.") ? [host, host.slice(4)] : [host, "www." + host];
  const cached = page => {
    try { return chrome.runtime.getURL("/_favicon/?pageUrl=" + encodeURIComponent(page) + "&size=32"); }
    catch { return ""; }
  };
  const out = [];
  hosts.forEach(h => out.push(`https://${h}/favicon.ico`));
  out.push(`https://${hosts[0]}/apple-touch-icon.png`);
  out.push(cached("https://" + raw.replace(/\?.*$/, "")));   // the exact page
  hosts.forEach(h => out.push(cached(`https://${h}/`)));      // just the site
  return out.filter(Boolean);
}

// A news-ticker line: the message scrolls past instead of being cut off, so a
// long sentence fits under a heading without wrapping the card. The text is
// rendered twice and the pair slides by exactly one copy, which loops seamlessly.
// The crawl now quotes the names you typed, so it goes through an escape on the
// way in — a nickname or address with a < or & in it is text, never markup.
function escHtml(v) {
  return String(v)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
// A site name inside a ticker sentence, marked for highlighting.
//
// The names are wrapped in two control characters rather than in markup, and the swap for
// real markup happens after the whole sentence has been escaped — so there is still exactly
// ONE place that escapes, and a nickname someone types can never become HTML. Building the
// markup in the sentence itself would mean every builder had to remember to escape its own
// pieces, and the one that forgot would be an injection.
const TN_A = "\u0001", TN_SEP = "\u0003", TN_B = "\u0002";
const TN_STRIP = /[\u0001\u0002\u0003]/g;
const TN_RE = /\u0001([^\u0002\u0003]*)\u0003([^\u0002]*)\u0002/g;
function tName(name, url) {
  // Stripped from both first: a typed label containing a sentinel could otherwise close the
  // highlight early and leave the rest of the line inside it.
  const clean = String(name == null ? "" : name).replace(TN_STRIP, "");
  // Only a real web address becomes a link. A local file's address is a file:// one, which an
  // extension page is not allowed to open — a link to it would look live and do nothing, so
  // those names are highlighted without being clickable.
  const href = /^https?:\/\//i.test(String(url || "")) ? String(url).replace(TN_STRIP, "") : "";
  return TN_A + href + TN_SEP + clean + TN_B;
}
// The sentence with the markers taken out, for the aria-label — a screen reader wants the
// words, not the decoration, and certainly not the address twice.
function tickerPlain(text) {
  return String(text).replace(TN_RE, "$2");
}
// The sentence as markup: each name becomes a link to its own site.
//
// The pieces are escaped one at a time here rather than the whole line up front, and
// deliberately: the address has to be checked BEFORE escaping. After escaping, "javascript:"
// and "https://" are no longer reliably distinguishable by a simple test — the slashes may
// have been entity-encoded — and a scheme check that can be fooled is not a check. So the
// raw address is tested against http(s) first, and only then escaped into the attribute.
//
// `mute` is for the duplicate copy the marquee prints to make its loop seamless. That copy
// carries aria-hidden, and a focusable link inside an aria-hidden subtree is a keyboard trap:
// you tab into something a screen reader has been told does not exist.
function tickerRich(text, mute) {
  const s = String(text);
  let out = "", last = 0, m;
  TN_RE.lastIndex = 0;
  while ((m = TN_RE.exec(s))) {
    out += escHtml(s.slice(last, m.index));
    const href = /^https?:\/\//i.test(m[1]) ? m[1] : "";
    const name = escHtml(m[2]);
    out += href
      ? `<a class="tsite" href="${escHtml(href)}" target="_blank" rel="noopener noreferrer"` +
        `${mute ? ' tabindex="-1" aria-hidden="true"' : ""} title="Open ${name}">${name}</a>`
      : `<b class="tsite">${name}</b>`;
    last = m.index + m[0].length;
  }
  return out + escHtml(s.slice(last));
}
function tickerHtml(text, testid) {
  return `<div class="ticker"${testid ? ` data-testid="${testid}"` : ""} role="status" aria-label="${escHtml(tickerPlain(text))}">
            <span><i>${tickerRich(text)}</i><i aria-hidden="true">${tickerRich(text, true)}</i></span>
          </div>`;
}

// The two ticker sentences. Kept as plain functions so the same text can be
// rebuilt in place the moment a time changes, without re-rendering the tab and
// stealing focus from the box you're typing in.
// Short words, short sentences — a child should be able to read these.
// What stays shut while today's work is unfinished, said in the words that match
// the mode you picked in step 2 — one site, many sites, or "everything else".
function lockedStayPhrase(s) {
  if ((s.blockMode || "blacklist") === "whitelist") return "everything else stays blocked";
  const n = (s.blockedSites || []).length;
  if (!n) return "the sites in the locked list stay blocked";
  return n === 1 ? "the site in the locked list stays blocked" : "the sites in the locked list stay blocked";
}
// Everything that has to be done today, in the order the list shows it, each with
// the name you gave it.
function earnTargetPlan(s) {
  return (s.productiveSites || [])
    .filter(p => p.enabled !== false && (p.requiredSec !== undefined && p.requiredSec !== null && !isNaN(p.requiredSec) && p.requiredSec >= 0))
    // The address as well as the name, so the ticker can make the name a link to the site it
    // names. Through targetOpenUrl, the same helper the row's own clickable name uses — a
    // YouTube channel or playlist is not reachable at its bare pattern.
    .map(p => ({
      name: targetName(p),
      url: targetOpenUrl(p),
      sec: p.requiredSec || 0,
      order: p.order || 0,
      operator: p.operator === "OR" ? "OR" : "AND"
    }))
    .sort((a, b) => a.order - b.order);
}
// Join plan items respecting their AND / OR operators
function joinLogicPlan(plan) {
  if (!plan || !plan.length) return "";
  const fmt = x => x.sec > 0 ? `${fmtDur(x.sec)} on ${tName(x.name, x.url)}` : `${tName(x.name, x.url)} (0s completed ✓)`;
  let out = fmt(plan[0]);
  for (let i = 1; i < plan.length; i++) {
    const op = (plan[i].operator === "OR" ? "or" : "and");
    out += ` ${op} ${fmt(plan[i])}`;
  }
  return out;
}
function earnTickerText(s) {
  const t = todayTotals(s);
  const stay = lockedStayPhrase(s);
  if (!t.count) return `Add a site here in which you want to spend time. If you do not spend time in these websites that you set here, ${stay}.`;
  const goal = fmtDur(t.req);
  if (t.left > 0) {
    // Name every site you added, with its own time, so the line reads like your list.
    const plan = earnTargetPlan(s);
    const said = plan.length
      ? joinLogicPlan(plan)
      : `${goal} here`;
    const warn = plan.length === 1 ? "If you do not finish it" : `If you do not finish this ${goal}`;
    return `Spend ${said} today. ${warn}, ${stay}.`;
  }
  return `All done. The locked sites are open now.`;
}
function lockTickerText(s) {
  const t = todayTotals(s);
  const goal = t.count ? fmtDur(t.req) : "";
  const blocked = s.blockedSites || [], allowed = s.allowedSites || [];
  if ((s.blockMode || "blacklist") === "whitelist") {
    if (!allowed.length) {
      return goal
        ? `Nothing is open. Spend ${goal} on the sites above to open it.`
        : "Only the sites you add here will open. First set a time in step 1.";
    }
    const only = allowed.length === 1 ? "Only this site is open" : `Only these ${allowed.length} sites are open`;
    return goal
      ? `${only}. Everything else stays blocked until you spend ${goal} on the sites above.`
      : `${only}. First set a time in step 1.`;
  }
  // Nothing locked yet. If step 1 already has work in it, name it — "the above
  // site" only stands in while step 1 is still empty.
  if (!blocked.length) {
    const plan = earnTargetPlan(s);
    const said = plan.length
      ? joinLogicPlan(plan)
      : "time on the above site";
    return `Add a site here which will stay blocked until you spend ${said}.`;
  }
  const one = blocked.length === 1;
  const subj = one ? "This site" : `These ${blocked.length} sites`;
  if (!goal) return `${subj} ${one ? "opens" : "open"} when your work is done. First set a time in step 1.`;
  if (t.left > 0) return `${subj} ${one ? "stays" : "stay"} blocked until you spend ${goal} on the sites above. ${fmtDur(t.left)} to go.`;
  return `Work done. ${subj} ${one ? "is" : "are"} open until tomorrow.`;
}
// Rewrite both crawls from current state. Called whenever a goal changes, so the
// sentence follows the number you just typed.
async function refreshTickers() {
  const s = await getState();
  [["earn-ticker", earnTickerText(s)], ["lock-ticker", lockTickerText(s)]].forEach(([tid, text]) => {
    const el = document.querySelector(`.ticker[data-testid="${tid}"]`);
    if (!el) return;
    el.setAttribute("aria-label", tickerPlain(text));   // a real attribute, so plain text here
    el.innerHTML = `<span><i>${tickerRich(text)}</i><i aria-hidden="true">${tickerRich(text, true)}</i></span>`;
  });
}

// The rows that are part of TODAY'S work, in the order the user arranged them.
//
// The same filter the worker's activeTargets applies, repeated here because extension pages do not
// share modules with the service worker: switched off, no time set, or a weekday schedule that does
// not include today, and the row is not in play. Sorted, because two features now depend on the order
// rather than merely displaying it — the AND / OR grouping and sequence mode.
//
// Pulled out of todayTotals, which had it inline, the moment a second caller needed exactly this list.
// Two copies of "what counts today" is how a header ends up counting a row the blocking ignores.
function todayRows(s) {
  const day = FGSettings.weekdayNow((s || {}).dailyResetTime);
  return ((s || {}).productiveSites || [])
    .filter(p => p && p.enabled !== false && (p.requiredSec !== undefined && p.requiredSec !== null && !isNaN(p.requiredSec) && p.requiredSec >= 0) && FGSettings.onDay(p, day))
    .sort((a, b) => (a.order || 0) - (b.order || 0));
}

// How much time today's work adds up to, and how much of it is left. Counts the
// website targets that are switched on.
function todayTotals(s) {
  const sites = todayRows(s);
  if (self.FGSettings && self.FGSettings.calcTotals) {
    return self.FGSettings.calcTotals(sites);
  }
  const req = sites.reduce((a, p) => a + (p.requiredSec || 0), 0);
  const spent = sites.reduce((a, p) => a + Math.min(p.requiredSec || 0, p.spentSec || 0), 0);
  const allDone = sites.length > 0 && sites.every(p => (p.requiredSec === 0) || (p.spentSec || 0) >= (p.requiredSec || 0));
  return { req, spent, left: Math.max(0, req - spent), count: sites.length, allDone };
}

// Logic connector (AND / OR) between adjacent study sites
function logicConnectorHtml(p, strict) {
  const op = p.operator === "OR" ? "OR" : "AND";
  return `
    <div class="logic-row" data-logic-row="${escHtml(p.id)}">
      <div class="logic-line"></div>
      <div class="logic-toggle" role="group" aria-label="Logic between study sites">
        <button type="button" class="logic-btn ${op === 'AND' ? 'active and' : ''}" 
                data-logic-id="${escHtml(p.id)}" data-logic-op="AND" 
                title="AND — Both this site and the one above must be finished to unlock"
                aria-pressed="${op === 'AND' ? 'true' : 'false'}"
                data-testid="logic-and-${escHtml(p.id)}">AND</button>
        <button type="button" class="logic-btn ${op === 'OR' ? 'active or' : ''}" 
                data-logic-id="${escHtml(p.id)}" data-logic-op="OR" 
                title="OR — Finishing either this site or the one above counts towards unlocking"
                aria-pressed="${op === 'OR' ? 'true' : 'false'}"
                data-testid="logic-or-${escHtml(p.id)}">OR</button>
      </div>
      <div class="logic-line"></div>
    </div>`;
}

// Where a row sits in the sequence, or nothing at all when the list is not being read as one.
//
// Read out of lastState rather than taken as an argument, like the weekday and the phone bridge are:
// both callers are handed one row, and a row's position is a fact about the LIST.
//
// `step === 0` means this row is in no step — switched off, or not scheduled for today. That is not a
// gap to paper over: such a row is outside the sequence entirely, and it already says why in its own
// meta line.
function seqInfo(p) {
  const on = (lastState || {}).sequenceMode === true;
  if (!on || !p) return { on: false, rows: [], step: 0, total: 0, mine: true, met: false, locked: false };
  const rows = todayRows(lastState);
  const step = FGSettings.stepNumberOf(p, rows);
  const met = FGSettings.targetMet(p);
  const mine = step > 0 ? FGSettings.inCurrentStep(p, rows) : true;
  return {
    on: true, rows, step, total: FGSettings.stepCount(rows), mine, met,
    // Shut by the sequence: in it, not finished, and not its turn. A FINISHED row is also not its
    // turn and is deliberately not "locked" — its own full bar has already explained itself.
    locked: step > 0 && !met && !mine
  };
}

// The little chips after the figure on a row: its topic, its phone opt-out, its deadline, its step.
//
// Its own function because TWO things draw them. siteRowHtml builds the row, and paintTargetRow
// repaints the same meta line once a second as time is credited — and that repaint used to write the
// figure alone, which dropped every chip a second after the page loaded. Every one of these marks
// exists to answer "why is this row behaving like that", so a mark that vanishes while you watch is
// worse than no mark: it makes the answer look like a glitch.
function rowMarksHtml(p) {
  // Two marks for the two settings that used to be full rows on this card and are now
  // folded away inside it. A fold that hides everything and reports nothing is worse
  // than no fold: the topic especially, because the whole argument for having it out
  // in the open was that a promise nobody can see is one nobody keeps. So the card
  // still says "there is a topic here" and "your phone is waiting for this one" —
  // just in two glyphs instead of a text field and a switch.
  const marks = [];
  const topic = String(p.topic || "").trim();
  if (topic) {
    const off = p.topicCheck === false;
    marks.push(`<span class="rmark${off ? " off" : ""}" data-testid="mark-topic-${p.id}"
      title="${off ? "Topic set but not being checked" : "Checked against its topic"}: ${escHtml(topic.length > 90 ? topic.slice(0, 90) + "…" : topic)}">🎯</span>`);
  }
  // Only while the bridge is on, and only when this row is OUT of it. "On" is the
  // default and applies to nearly every row, so a mark for it would appear on all of
  // them and say nothing; the departure from the default is the thing worth a glyph.
  if ((lastState || {}).macrodroidEnabled === true && p.webhookOn === false) {
    marks.push(`<span class="rmark off" data-testid="mark-phone-${p.id}"
      title="Phone MacroDroid webhook blocking is off for this site — your phone does not wait for it">📱</span>`);
  }
  // Which step of the sequence this row is, and whether it is your turn.
  //
  // Printed rather than hinted, for the same reason the deadline below it is printed: a row sitting at
  // 0% whose Open link lands on a blocked screen is the list disagreeing with the extension, and "why
  // can't I open this" has to be answerable by looking. The number shows even when it IS your turn,
  // because "step 2 of 4, and it's your turn" is the sentence that explains the other three.
  //
  // Only while sequence mode is on: with it off the order is presentational, and a step number would be
  // claiming a rule that is not being enforced.
  const sq = seqInfo(p);
  if (sq.on && sq.step > 0) {
    marks.push(`<span class="rmark rseq${sq.met ? " done" : sq.mine ? " live" : " off"}" data-testid="mark-seq-${p.id}"
      title="${sq.met
        ? `Step ${sq.step} of ${sq.total}, finished. It is shut now — the sequence has moved on.`
        : sq.mine
          ? `Step ${sq.step} of ${sq.total}, and it is the one open right now. Finish it and the next step opens.`
          : `Step ${sq.step} of ${sq.total}. Locked until the steps before it are done — FocusGate is doing this list in order.`}">${
        sq.met ? "✓" : sq.mine ? "▶" : "🔒"} Step ${sq.step}/${sq.total}</span>`);
  }
  // The deadline, and this one cannot be left to the fold — nor to a tooltip.
  //
  // A row that finished outside its window reads as "Completed" with a full bar and
  // unlocks nothing, which is the single place on this page where the numbers and
  // reality disagree. So the HOURS are printed, not hinted at: a glyph with the times
  // hidden in its title is a glyph nobody hovers, and "why is this still locked" has to
  // be answerable by looking.
  if (FGSettings.hasWindow(p)) {
    const missed = FGSettings.windowMissed(p);
    const open = FGSettings.inWindow(p);
    marks.push(`<span class="rmark rwin${missed ? " miss" : open ? " live" : " off"}" data-testid="mark-win-${p.id}"
      title="${missed
        ? `Finished outside its ${FGSettings.windowLabel(p)} window, so it unlocked nothing today. The time still counted.`
        : open
          ? `The window is open now — finish inside it and your blocked sites open.`
          : `The window is shut. Finishing outside it will not unlock anything today.`}">⏰ ${escHtml(FGSettings.windowLabel(p))}${missed ? " · missed" : ""}</span>`);
  }
  // The stopwatch, and it earns a chip for a reason the window's does not quite cover: this one is
  // COUNTING. A window can be read off the settings once and remembered; "nineteen minutes left" cannot,
  // and it is the number that decides what somebody does next. paintTargetRow rebuilds these every
  // second, so the figure here is live rather than as-of-page-load.
  //
  // Only once the stopwatch is actually running. A row that has a limit but has not been opened today
  // has nothing to count down, and a chip reading "1h 10m left" before you had started would be claiming
  // an allowance was being spent while you were nowhere near it.
  if (FGSettings.graceStarted(p)) {
    const gMissed = FGSettings.graceMissed(p);
    const gGone = FGSettings.graceGone(p);
    const left = FGSettings.graceLeftSec(p);
    const bad = gMissed || gGone;
    marks.push(`<span class="rmark rgrace${bad ? " miss" : left > 0 ? " live" : " off"}" data-testid="mark-grace-${p.id}"
      title="${gMissed
        ? `Finished after its ${escHtml(fmtDur((p.requiredSec || 0) + (Number(p.graceSec) || 0)))} limit ran out, so it unlocked nothing today. The time still counted.`
        : gGone
          ? `Its ${escHtml(fmtDur((p.requiredSec || 0) + (Number(p.graceSec) || 0)))} limit ran out with work still to do. Nothing this goal unlocks will open today.`
          : `${escHtml(fmtDur(left))} left of the ${escHtml(fmtDur((p.requiredSec || 0) + (Number(p.graceSec) || 0)))} you get from first opening this site — the goal plus ${escHtml(fmtDur(Number(p.graceSec) || 0))} of grace.`}">⏳ ${
        bad ? "ran out" : escHtml(fmtDur(left)) + " left"}</span>`);
  }
  return marks.join("");
}

// One row in step 1's list: a website, an exact page, a channel, a playlist…
function siteRowHtml(p, strict) {
  const req = Math.max(0, p.requiredSec || 0);
  const spent = Math.min(p.spentSec || 0, req);
  const on = p.enabled !== false;
  // Which days this row is asked for, and whether today is one of them. The weekday comes from
  // lastState for the same reason cheatPanelHtml reads it from there: this builder is handed one
  // row, not the whole state, and the boundary it has to respect is a setting.
  const mask = FGSettings.dayMask(p.days === undefined ? FGSettings.DAY_ALL : p.days);
  const today = FGSettings.weekdayNow((lastState || {}).dailyResetTime);
  const todayOn = FGSettings.onDay(p, today);
  // The row shell wears the locked state so the whole row can be dimmed like an `off` one. The chip
  // alone says it, but a list of eight rows all drawn at full strength does not show at a glance that
  // seven of them are shut.
  const seqLocked = seqInfo(p).locked;
  // "Done" is about today's work.
  const done = on && todayOn && (req === 0 || spent >= req);
  const pct = done ? 100 : (req > 0 ? Math.round(100 * spent / req) : 0);
  const local = p.type === "local_file";
  // A file:/// address is far too long to be a name, so the row is headed by the
  // file's own name and the full path sits underneath it.
  const rawName = targetName(p);
  const name = escHtml(rawName);
  const kind = targetKind(p);
  const where = escHtml(local ? localDisplay(p.url || p.path)
                              : (p.url || p.channelId || p.playlistId || ""));
  const favs = faviconCandidates(p);
  // Start from whichever candidate worked last time this row was drawn — see favAt. On the first
  // render there is nothing remembered and this is 0, which is the behaviour it always had.
  //
  // `loading="lazy"` came off these at the same time. On an 18px icon it saves nothing, and it
  // costs something real: a lazily-loaded image may not have been fetched at all yet, so it is
  // neither loaded nor failed — and the check for an already-broken image in the wiring below
  // cannot tell that apart from a picture that is simply on its way.
  const favKey = favs.join("|");
  const favAtIdx = Math.max(0, Math.min(favs.length - 1, favAt.get(favKey) ?? 0));
  const openUrl = targetOpenUrl(p);
  return `<div class="item${done ? " done" : ""}${on ? "" : " off"}${on && !todayOn ? " notoday" : ""}${seqLocked ? " seqlock" : ""}${cheatOpenFor === p.id ? " open" : ""}${String(p.topic || "").trim() ? " has-topic" : ""}" data-id="${p.id}" data-testid="prod-item-${p.id}">
            <div class="grip" title="Drag up or down to reorder — or focus this and press ↑ / ↓"
                 aria-label="Reorder ${name}: drag, or press up and down arrows"
                 draggable="true" tabindex="0" role="button">⋮⋮</div>
            <button class="ikind" data-toggle="${p.id}" role="switch" aria-checked="${on ? "true" : "false"}"
                    title="${kind.label} — click to turn it ${on ? "off" : "on"}"
                    aria-label="${name}: ${kind.label}, click to turn ${on ? "off" : "on"}"
                    data-testid="toggle-${p.id}">${
              favs.length ? `<img class="fav" src="${favs[favAtIdx]}" data-fav="${favKey}" data-favi="${favAtIdx}" alt="" width="18" height="18" referrerpolicy="no-referrer"/><span class="favfb" hidden>${kind.icon}</span>`
                  : kind.icon}</button>
            <div class="ibody">
              <div class="name">${(() => {
                const isEditing = editingNameId === p.id;
                const pencilSvg = `<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/><path d="m15 5 4 4"/></svg>`;
                if (isEditing) {
                  return `<span class="inline-edit-form">
                    <input type="text" class="input inline-edit-input" id="inlineEditInput" value="${escHtml(p.label || rawName)}" maxlength="60" placeholder="${escHtml(rawName)}" aria-label="Edit display name" />
                    <button type="button" class="inline-edit-btn save" data-save-name="${p.id}" title="Save (Enter)" aria-label="Save">✓</button>
                    <button type="button" class="inline-edit-btn cancel" data-cancel-name="${p.id}" title="Cancel (Esc)" aria-label="Cancel">✕</button>
                  </span>`;
                }
                return `${openUrl
                  ? `<a class="nmlink" href="${escHtml(openUrl)}" target="_blank" rel="noopener noreferrer"
                         data-open-id="${p.id}" data-open-pattern="${escHtml(p.url || "")}"
                         title="Go to ${name} — the tab you already have open, or a new one"
                         aria-label="Open ${name}"
                         data-testid="open-${p.id}"><span class="linklabel">${name}</span><span class="openmark" aria-hidden="true">↗</span></a>`
                  : `<span>${name}</span>`}<button type="button" class="edit-name-btn" data-edit-name="${p.id}" title="Edit site name" aria-label="Edit display name for ${name}">${pencilSvg}</button>`;
              })()}<span class="livedot" data-live="${p.id}" title="checking whether it's open…"></span>${editingNameId !== p.id && (p.label || local) && where ? `<span class="where">${where}</span>` : ""}</div>
              <div class="meta">${!on ? '<span class="why">off — click the icon to turn it back on</span>'
                : !todayOn ? `<span class="why">not today — ${escHtml(FGSettings.daysLabel(mask))} only</span>`
                : req === 0 ? '<b>Completed</b> (0s goal)'
                : `<b>${fmtDur(spent)}</b> of ${fmtDur(req)}`}<!--
                -->${rowMarksHtml(p)}</div>
              <!-- Start-over sits with the bar it resets, rather than off in the
                   corner with the controls that do something else. -->
              <div class="progline">
                <!-- The bar and the ↺ beside it both only ever take time AWAY, so neither is
                     frozen by strict mode any more. Giving up an afternoon you have already
                     earned is the strictest thing on this page; refusing it while the settings
                     were frozen had the gate pointing the wrong way. -->
                <div class="progressMini" data-scrub="${p.id}" role="button" tabindex="0"
                     title="Click along the bar to wind today's time back to that point"
                     aria-label="Today's time on ${name} — click along the bar to wind it back"
                     data-testid="bar-${p.id}"><div class="${on && pct > 0 ? "" : "zero"}" style="${barStyle(pct, on)}"></div></div>
                <button class="iconbtn mini" data-reset="${p.id}" title="Start today over — put this bar back to zero"
                        aria-label="Start today over" data-testid="reset-${p.id}">↺</button>
              </div>
              <!-- Which days this site is asked for. Under the bar, inside the row, because it is a
                   property of this site and not of the extension — the same reason its time and its
                   own cheating prevention live here.
                   Seven chips rather than a dropdown of presets: "Mon–Fri" and "weekends" are two
                   of the answers people want and neither is all of them, and a list of named
                   combinations would be longer to read than the days themselves.
                   Not disabled by strict mode. Dropping a day is a loosening and adding one is a
                   tightening, and setStateP already knows the difference — greying them out would
                   also refuse you the direction strict mode exists to allow. -->
              <div class="dayrow" role="group" aria-label="Which days ${name} is asked for">
                ${FGSettings.DAY_ORDER.map(([bit, nm]) => {
                  const dayOn = (mask & (1 << bit)) !== 0;
                  return `<button class="daychip${dayOn ? " on" : ""}${bit === today ? " now" : ""}"
                          type="button" data-day="${p.id}:${bit}" aria-pressed="${dayOn ? "true" : "false"}"
                          title="${nm}${bit === today ? " — today" : ""}: ${dayOn ? "asked for" : "off"}"
                          aria-label="${nm}${bit === today ? ", today" : ""}, ${dayOn ? "asked for" : "off"}"
                          data-testid="day-${p.id}-${bit}">${nm.slice(0, 2)}</button>`;
                }).join("")}
              </div>
              <!-- The study topic and the phone switch used to sit here, in the open, on every row.
                   They have moved into this row's folded panel — see rowOptsHtml, called from
                   cheatPanelHtml. Both are per-site settings rather than part of what the row IS,
                   and a card that showed a text field and two switches for every site turned the
                   list into a form. The chevron in the corner opens them.
                   What stays out here is only what identifies the row: its name, where it points,
                   how long for, which days, and how far along today is. -->
            </div>
            ${hmsWells(req, u => `data-edit-${u}="${p.id}" data-testid="edit-${u}-${p.id}"`, { plain: true, icon: false })}
            <!-- Removing the whole row is a different kind of act from the controls
                 inside it, so it lives in the corner: small, red, and out of the
                 way until you look for it. It's positioned, so it costs no space.
                 Still greyed out by strict mode, and this one deserves to be: taking work off the
                 list only goes one way, so there is no direction to judge and nothing lost by
                 saying so with the cursor instead of with a toast. -->
            <button class="xdel" data-del="${p.id}" title="Take ${name} off the list"
                    aria-label="Take ${name} off the list" data-testid="del-${p.id}"
                    ${strict?"disabled style='opacity:.25;cursor:not-allowed'":""}>✕</button>
            <button type="button" class="cheat-expand-btn${cheatOpenFor === p.id ? " open" : ""}" data-cheat="${p.id}"
                    title="${cheatOpenFor === p.id ? "Collapse anti-cheating options" : "Expand anti-cheating options"}"
                    aria-label="${cheatOpenFor === p.id ? "Collapse anti-cheating options" : "Expand anti-cheating options"}"
                    aria-expanded="${cheatOpenFor === p.id ? "true" : "false"}"
                    data-testid="cheat-${p.id}">
              <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="6 9 12 15 18 9"></polyline></svg>
            </button>
          </div>
          ${cheatOpenFor === p.id ? cheatPanelHtml(p, strict) : ""}`;
}

// Which row's no-cheating panel is open, if any. One at a time: they're tall, and
// two open at once turns the list into a wall.
let cheatOpenFor = null;
let editingNameId = null;

// ---- the four groups of checks, folded ----
// One set of open/closed flags shared by the card in Setup and every target's own panel: they
// are the same four groups in both places, so a group you open in one is open in the other.
// Not stored — it is the state of a fold, not a setting.
//
// Closed by default. Eleven switches in a column was the complaint that made these groups
// exist; leaving them all open would have been the same wall with headings in it. Each shut
// header carries an "N/M on" badge, so a closed group still says what is running inside it —
// a fold that hides everything and reports nothing is worse than no fold.
// `site` is the odd one out and is listed first because it is drawn first: the other four are the
// anti-cheating template, which a row can inherit from Setup, while that one holds the two settings
// that belong to this row alone. Open by default, like `media`, because it is two rows rather than
// a wall and because the thing inside it — what you meant to do on this site — is the one setting
// here that is worth being reminded of every time you look.
const GRP_OPEN = { site: true, media: true, screen: false, glow: false, camera: false };
// How many of each group's switches are on, and how many there are. Written here rather than
// counted from the markup, so the badge and the rows come from one list.
function grpCount(key, c) {
  const on = (...vals) => vals.filter(Boolean).length;
  switch (key) {
    // Not read off the same `c` as the rest — see rowOptsHtml, which passes its own little object.
    // The total varies because the phone row is only drawn while the bridge is switched on, and a
    // badge reading "1/2 on" over a fold containing one row would be counting a row that is not
    // there.
    case "site": return [on(c.aiOn, c.winOn, c.graceOn), Math.max(1, c.siteRows || 1)];
    // All four `=== true` now, because all four ship off. This badge is the first thing anyone
    // sees on a fresh install, and while the two video rows shipped on it read "2/4 ON" over a
    // group whose actual checks were both off — which reads as "media tracking is on".
    case "media":  return [on(c.mediaPlayingRequired, c.mediaPauseEnabled === true,
                             c.mediaResumeEnabled === true, c.inactivityPauseEnabled), 4];
    case "screen": return [on(c.fullscreenOnlyEnabled !== false, c.splitViewBlockEnabled !== false), 2];
    case "glow":   return [on(c.pageGlowEnabled !== false), 1];
    // Five, not four: the timer speed is in this group too. It is not a check — it decides how
    // fast a second counts rather than whether it counts — but this badge reports what is
    // switched on inside the fold, and the media group already counts two rows that are not
    // checks either.
    case "camera": return [on(c.faceDetectionEnabled, c.eyeTrackingEnabled,
                              c.livenessEnabled === true, c.blinkRequired,
                              c.paceEnabled === true), 5];
  }
  return [0, 0];
}
// The opening tags of a fold. Paired with grpEnd() — split in two so the rows in between stay
// written out where they are, rather than being passed through as a string argument.
function grpOpen(key, icon, title, c, suffix) {
  const [on, total] = grpCount(key, c);
  const id = `grp_${key}${suffix || ""}`;
  const open = GRP_OPEN[key];
  return `<div class="sect grpsect">
      <button class="secthead" type="button" data-grp="${key}"
              aria-expanded="${open ? "true" : "false"}" aria-controls="${id}"
              data-testid="grp-${key}${suffix || ""}">
        ${CARET}
        <span class="ic" aria-hidden="true">${icon}</span>
        <span class="ttl">${title}</span>
        <span class="cnt" title="switched on in here">${on}/${total} on</span>
      </button>
      <div class="sectbody" id="${id}" ${open ? "" : "hidden"}>`;
}
function grpEnd() { return `</div></div>`; }
// Opening and closing them, wired once on the document rather than per element.
//
// These folds appear in TWO views — the card on the Setup tab and each target's panel on
// Earn & Unlock — which are built by two different render functions with two different wiring
// blocks. Binding this inside one of them is what left the panel's carets dead: they were
// drawn, they had the right attributes, and nothing anywhere was listening for them.
// Delegation also survives renderApp() replacing the whole page, which per-element listeners
// have to be re-attached after.
document.addEventListener("click", (e) => {
  const head = e.target && e.target.closest ? e.target.closest(".secthead[data-grp]") : null;
  if (!head) return;
  const key = head.getAttribute("data-grp");
  if (!(key in GRP_OPEN)) return;
  GRP_OPEN[key] = !GRP_OPEN[key];
  // A full re-render rather than just unhiding the one body: both views have to move together,
  // and the "N/M on" badges are built by the render.
  renderApp();
});

// The five sensitivity words, shared by the dials that all ask the same question:
// how much evidence of you is enough.
const SENS_WORDS = ["", "fussy", "firm", "normal", "kind", "easy"];
// The blink dial is the exception and needs its own, because its ends mean something
// different: it sets how faint a blink the camera will still catch, not how much effort
// you make. "easy" there would read as "the camera is easier to convince", which is the
// opposite of what a higher setting does — it catches MORE blinks.
const DIAL_WORDS = { blinkSensitivity: ["", "clear", "firm", "normal", "kind", "faint"] };
const dialWords = (key) => DIAL_WORDS[key] || SENS_WORDS;

// ---- the sliders that carry a number ----
// Everything else on this page that slides is a step on a five-point scale with a word for each
// step. These three are quantities: two timer speeds and the size of the focus box.
//
// One table, read by the markup that draws them, by the label beside each thumb, and by the
// handler that saves them — so a bound cannot be widened in one place and left behind in the
// other two. The numbers are the ones the settings validator and facecam.js clamp to; three
// copies of a limit is already one more than ideal, and a fourth that disagreed would show a
// value the camera was not actually using.
const PACE_DIAL = {
  paceFast:   { min: 1,   max: 4,  step: 0.1, dp: 1, unit: "×", fb: 1.5 },
  paceSlow:   { min: 0.1, max: 1,  step: 0.1, dp: 1, unit: "×", fb: 0.5 },
  paceBoxPct: { min: 30,  max: 85, step: 5,   dp: 0, unit: "%", fb: 55 }
};
// Read a stored value the way its own slider would: rounded to the places it shows, then held
// inside its bounds.
//
// The rounding is not cosmetic. 0.1 has no exact binary form, so a value that arrives as
// 1.4000000000000001 would be written straight back on the next save as a genuine change — and
// every write on this page now answers a gate, so the page would ask "make this stricter?" about
// a number nobody touched.
function paceVal(key, v) {
  const d = PACE_DIAL[key];
  if (!d) return Number(v) || 0;
  const n = Number(v);
  const raw = Number.isFinite(n) ? n : d.fb;
  const p = Math.pow(10, d.dp);
  return Math.max(d.min, Math.min(d.max, Math.round(raw * p) / p));
}
const paceText = (key, v) => paceVal(key, v).toFixed(PACE_DIAL[key].dp) + PACE_DIAL[key].unit;

// Above this box size, most webcams cannot satisfy the test at all.
//
// The arithmetic: being "in" needs the detected face to span 85% of the box (FOCUS_FIT in
// facecam.js), the box is a share of the picture's shorter side, and pico's box hugs the face
// rather than the whole head — a head filling the frame measures about 63% of its height. So
// 0.63 / 0.85 ≈ 0.74 is where a head that fills the entire picture only just clears it, and
// anything above that is unreachable however close you sit.
//
// A warning rather than a lower ceiling on the slider, because the 63% is a measurement off one
// webcam: a wider lens gives less, a tighter one more. Refusing a number that works on somebody's
// camera would be worse than telling everybody what to look out for.
// 65 rather than the 74 the arithmetic gives, because 74 is where it becomes *impossible* and the
// warning is worth having well before that: at 70 it takes a head filling essentially the whole
// picture, which is a posture nobody holds while working. The useful range ends around 60.
const PACE_BOX_REACH = 65;
// Shown under the box slider once it is past that. Also used by the per-target panel, which draws
// the same warning from the same number.
const paceBoxWarnText = (v) =>
  v > PACE_BOX_REACH
    ? "At " + v + "% you would have to fill almost the whole picture with your head, so the timer "
      + "would sit on the slow speed while you work. Try 50–60%. Open 👁 Preview and check the box "
      + "actually turns green where you normally sit."
    : "";

// ---- the live camera preview for those three sliders ----
// Three numbers about how much of a camera frame your head fills cannot be set from a slider
// alone. How close 55% is depends on your webcam's lens, how far back your chair is and how you
// sit — so the honest way to set it is to watch yourself in the box while you drag it.
//
// The preview is facecam.html itself, the same frame that runs on a work page, rather than a
// mock-up of it. A drawing of a square would be a second implementation of the geometry, and the
// first thing it would do is disagree with the real one.
//
// It lives on document.body rather than inside the card, so it survives the re-render that
// follows every save. Built inside the card it was destroyed and rebuilt on each slider release,
// which meant a fresh getUserMedia — the picture blinking out mid-drag.
const PACE_PV_SRC = "focusgate-pace-tune";
function pacePvQuery(v) {
  // The other camera checks are turned off for the preview, deliberately. This window is for
  // aiming the box; "move your head" and "blink" over the top of it would be answering a
  // question nobody asked here, and the pace reading does not depend on any of them.
  return "?" + new URLSearchParams({
    preview: "1",
    fs: String(v.fs || 3),
    eye: "0", es: "3", ea: "600",
    live: "0", li: "600", ms: "3",
    blink: "0", bi: "600", bs: "3",
    pace: "1",
    pf: String(v.fast), ps: String(v.slow), pb: String(v.box)
  }).toString();
}
const pacePv = {
  wrap: null, frame: null, num: null, say: null, dot: null,
  vals: { fast: 1.5, slow: 0.5, box: 55, fs: 3 },
  build() {
    const w = document.createElement("div");
    w.className = "pacepv";
    w.id = "pacePv";
    w.innerHTML = `
      <div class="pacepv-bar">
        <span class="pacepv-dot" id="pacePvDot"></span>
        <span class="pacepv-ttl">Camera preview</span>
        <b class="pacepv-num" id="pacePvNum">1.0×</b>
        <button class="pacepv-x" id="pacePvX" type="button"
                title="Close the preview and release the camera"
                aria-label="Close the preview and release the camera">✕</button>
      </div>
      <div class="pacepv-body"><iframe id="pacePvFrame" allow="camera"
           referrerpolicy="no-referrer" title="Camera preview"></iframe></div>
      <div class="pacepv-say" id="pacePvSay" role="status" aria-live="polite">starting camera…</div>`;
    document.body.appendChild(w);
    this.wrap = w;
    this.frame = w.querySelector("#pacePvFrame");
    this.num = w.querySelector("#pacePvNum");
    this.say = w.querySelector("#pacePvSay");
    this.dot = w.querySelector("#pacePvDot");
    w.querySelector("#pacePvX").addEventListener("click", () => this.close());
  },
  // Open it if it is shut, retune it if it is already up. One entry point, because every caller
  // wants the same thing — "show me this" — and none of them should have to know which.
  show(vals) {
    Object.assign(this.vals, vals || {});
    if (!this.wrap) this.build();
    this.wrap.hidden = false;
    if (!this.frame.getAttribute("src")) {
      // Re-sent once it is up. The camera takes about a second to come on, and everything dragged
      // during that second would otherwise be dropped on the floor — including, if you let go
      // quickly, the value you actually meant.
      this.frame.addEventListener("load", () => this.tune(), { once: true });
      this.frame.src = chrome.runtime.getURL("facecam.html") + pacePvQuery(this.vals);
      return;                        // the values it needs are in the address it is loading
    }
    this.tune();
  },
  tune() {
    if (!this.frame || !this.frame.contentWindow) return;
    try {
      this.frame.contentWindow.postMessage({
        source: PACE_PV_SRC, on: true,
        fast: this.vals.fast, slow: this.vals.slow, box: this.vals.box
      }, "*");
    } catch {}
  },
  // The camera goes off with the panel. Removing the iframe is what does it — the frame stops its
  // own tracks on pagehide, and a hidden iframe is still a running one.
  close() {
    if (!this.wrap) return;
    this.wrap.hidden = true;
    if (this.frame) { this.frame.removeAttribute("src"); this.frame.remove(); }
    const body = this.wrap.querySelector(".pacepv-body");
    if (body) {
      const f = document.createElement("iframe");
      f.id = "pacePvFrame";
      f.setAttribute("allow", "camera");
      f.setAttribute("referrerpolicy", "no-referrer");
      f.setAttribute("title", "Camera preview");
      body.appendChild(f);
      this.frame = f;
    }
    if (this.say) this.say.textContent = "starting camera…";
    if (this.num) { this.num.textContent = "1.0×"; this.num.className = "pacepv-num"; }
    if (this.dot) this.dot.className = "pacepv-dot";
  },
  // What the frame is reporting, as it reports it. The number here is the multiplier the timer
  // would actually be credited at, not a restatement of the sliders — which is the point of
  // showing it: it is the one place you can watch the ramp move as you lean in.
  report(d) {
    if (!this.wrap || this.wrap.hidden) return;
    if (d.type === "status") {
      const words = { cam: "allow the camera", model: "model error", lib: "lib error", ready: "looking…" };
      if (this.say) this.say.textContent = words[d.state] || "";
      return;
    }
    if (d.type !== "face") return;
    const p = Number(d.pace);
    if (this.num && Number.isFinite(p)) {
      this.num.textContent = p.toFixed(1) + "×";
      this.num.className = "pacepv-num " + (p >= 1.02 ? "up" : (p <= 0.98 ? "down" : ""));
    }
    if (this.dot) this.dot.className = "pacepv-dot " + (d.present ? "ok" : "bad");
    if (!this.say) return;
    // The box verdict is the useful sentence here, and it outranks the camera's own words: on
    // this panel "face ✓" is not news — you can see your face — whereas whether you are IN is
    // the entire question the panel exists to answer.
    if (d.boxed === true) { this.say.textContent = "in the box ✓ — this is the fast speed"; return; }
    if (!d.present) { this.say.textContent = d.reason || "no face"; return; }
    // With the number, because "outside the box" alone does not say whether you are nearly there
    // or whether the box is bigger than your camera can ever fill. At 70% and above most webcams
    // cannot, and this is where you find that out — the figure sits in the high eighties and will
    // not budge however far you lean in.
    const r = Number(d.reach);
    this.say.textContent = "outside the box — head at " + (Number.isFinite(r) ? r : 0) +
                           "% of the size needed";
  }
};
// The frame talks to whoever embedded it, so on this page that is us.
try {
  window.addEventListener("message", (e) => {
    const d = e.data;
    if (!d || d.source !== "focusgate-facecam-2") return;
    pacePv.report(d);
  });
  // Leaving the page, or hiding it, must not leave the camera on.
  window.addEventListener("pagehide", () => pacePv.close());
  document.addEventListener("visibilitychange", () => { if (document.hidden) pacePv.close(); });
} catch {}

// What actually applies to one target: the checks from Setup, with this row's own
// values on top when it keeps its own. Mirrors effectiveCheat in background.js.
function siteCheat(s, p) {
  // Same list as CHEAT_KEYS in background.js, and it has to stay the same list: if one
  // of the two names a key the other doesn't, the panel and the page disagree about
  // what this site is actually doing.
  const keys = ["mediaPlayingRequired",
                "inactivityPauseEnabled", "inactivityTimeoutSec", "fullscreenOnlyEnabled",
                "splitViewBlockEnabled", "faceDetectionEnabled", "faceSensitivity",
                "eyeTrackingEnabled", "eyeSensitivity", "eyeAwaySec",
                "livenessEnabled", "livenessIntervalSec", "moveSensitivity",
                "blinkRequired", "blinkIntervalSec", "blinkSensitivity",
                "paceEnabled", "paceFast", "paceSlow", "paceBoxPct",
                "mediaPauseEnabled", "mediaResumeEnabled", "mediaRewindSec", "pageGlowEnabled"];
  const out = {};
  for (const k of keys) out[k] = s[k];
  if (p && p.cheatCustom && p.cheat) {
    for (const k of keys) {
      const v = p.cheat[k];
      if (v !== undefined && v !== null) out[k] = v;
    }
  }
  return out;
}

// ---- this row's own two settings, at the top of its folded panel ----
//
// The study topic and the phone switch. Both used to sit in the open on every card, and both moved
// in here for the same reason: a list of twelve sites showed twelve text fields and up to
// twenty-four switches, which is a form rather than a list. Out in the card there is now only what
// identifies the row — name, address, how long, which days, how far along.
//
// They are NOT part of the "follows Setup / its own" copy below them, and that is the one thing to
// keep straight about this block. Those checks are a template a row can inherit; these two are
// facts about this row that no other row could supply — what you meant to do HERE, and whether
// your phone waits for THIS. So they are never disabled by `cheatCustom`, and they deliberately do
// not use the `.sub` class, which the stylesheet dims while a row is following Setup.
function rowOptsHtml(p, name) {
  const s = lastState || {};
  const hasTopic = !!String(p.topic || "").trim();
  // Same rule as everywhere else on this page: a switch that cannot do anything is worse than a
  // missing one, because you flick it and draw a conclusion. With the bridge off there is no phone
  // to wait for anything.
  const phoneBridge = s.macrodroidEnabled === true;
  const phoneOn = p.webhookOn !== false;
  // AI blocking counts as ON only when there is a sentence to check AND the row's switch is on.
  // A switch left on above an empty box is checking nothing, and a badge that counted it would say
  // this fold was doing something it is not.
  const aiOn = hasTopic && p.topicCheck !== false;
  // ---- the deadline, and the one distinction this row got wrong ----
  //
  // THREE facts, not one, and collapsing them is what made the feature invisible:
  //
  //   winSwOn   the switch is on. Nothing more.
  //   winOn     the switch is on AND the two times form a window that could ever be satisfied.
  //   winNow    that window is open at this moment.
  //
  // The bug was using `winOn` to decide whether to draw the two time boxes. A row created before this
  // feature existed has no winStart or winEnd at all — the schema only seeds them on import, not on
  // rows already in storage — so `hasWindow` answered false, the boxes were never drawn, and the only
  // controls that could have SET those times were hidden by those times being unset. Circular: you
  // could flick the switch all day and nothing would appear.
  //
  // So the boxes follow the switch, and the times fall back to the shipped pair when absent. (The
  // handler seeds them on the way on as well, so the stored row is valid rather than merely displayed
  // as if it were — see saveRowRule.)
  const winSwOn = p.winEnabled === true;
  const winStart = /^\d{1,2}:\d{2}$/.test(String(p.winStart || "")) ? p.winStart : "06:00";
  const winEnd = /^\d{1,2}:\d{2}$/.test(String(p.winEnd || "")) ? p.winEnd : "09:00";
  const winOn = FGSettings.hasWindow(p);
  const winNow = winOn && FGSettings.inWindow(p);
  const winMissed = FGSettings.windowMissed(p);
  // ---- the second deadline: the stopwatch ----
  //
  // Same three-way distinction as the window, and it matters here for the same reason: the switch being
  // on is not the same as the deadline being live. `graceOn` is the switch plus a goal to be late for,
  // and `graceRunning` is that plus having actually opened the site today.
  const graceSwOn = p.graceEnabled === true;
  const graceSec = Number.isFinite(Number(p.graceSec)) ? Math.max(0, Math.round(Number(p.graceSec))) : 600;
  const graceOn = FGSettings.hasGrace(p);
  const graceRunning = FGSettings.graceStarted(p);
  const graceMissed = FGSettings.graceMissed(p);
  const graceGone = FGSettings.graceGone(p);
  const graceLeft = graceRunning ? FGSettings.graceLeftSec(p) : 0;
  // Its own little counts object, in the shape grpCount wants. The other four folds read the
  // anti-cheat settings; this one is about the row.
  // Three rows in this fold now — AI blocking and the two deadlines. The phone's webhook is not one
  // of them, so it is neither counted here nor in the total.
  const counts = { aiOn, winOn, graceOn, siteRows: 3 };
  // Globally off is worth saying here rather than only in the tip: the switch is on, the sentence is
  // written, and nothing is happening — which looks like a bug unless the row admits it.
  const aiIdle = aiOn && s.aiTopicEnabled !== true;
  // "Site rules" rather than "Just this site". The old name answered the wrong question: it said where
  // these settings apply, which the panel's own heading already says, and left what they DO to be
  // guessed. Both rows in here are rules this site must satisfy — be about the right subject, be
  // finished by the right hour — so the name says that instead.
  return `${grpOpen("site", "🎛️", "Site rules", counts, "_" + p.id)}
      <!-- AI blocking: is this page about what you said you would do here?
           A target has always been an ADDRESS, and being at an address is all this list could
           describe: the channel you nominated because it teaches linear algebra also has a podcast,
           and every second of that counted. This is the other half of the promise.
           The label and the sentence are two rows rather than one. They answer different questions —
           "is this on" and "on WHAT" — and at the width this panel has, a label, a 300-character
           box and a switch on one line left the box too narrow to read a sentence in. -->
      <div class="srow ropt">
        <span class="ic" aria-hidden="true">🤖</span>
        <span class="lbl grow">AI blocking ${tip(`An AI checks each page on <b>${name}</b> against the sentence below, and the clock only runs while you are on topic. Off-topic pages earn nothing.<br/><br/>This is the other half of what a target means. A target is an <b>address</b>, and being at an address is all a list of sites can describe — the channel you nominated because it teaches linear algebra also has a podcast, and every second of that counted. The sentence is what you actually meant to do.<br/><br/><b>Leave the box empty</b> and nothing is checked; this site behaves exactly as it always has. The switch appears once there is a sentence, so you can suspend the check without deleting what you wrote.<br/><br/>Needs <b>Study topics</b> switched on in <b>⚙️ Setup → General</b>, with a key, before anything is checked anywhere.${aiIdle ? "<br/><br/><b style='color:#fca5a5'>Study topics is switched off globally right now, so this is not checking anything yet.</b>" : ""}`)}</span>
        <span class="ropt-state${aiIdle ? " idle" : ""}">${!hasTopic ? "no topic" : aiIdle ? "waiting" : aiOn ? "on" : "off"}</span>
        ${hasTopic ? `
        <label class="sw">
          <input type="checkbox" data-topicsw="${p.id}" ${p.topicCheck === false ? "" : "checked"}
                 title="${p.topicCheck === false
                   ? `Off — pages on ${name} are not checked against this topic, and all of them earn time as normal. The topic is kept so you can switch it back on.`
                   : `On — pages on ${name} are checked against this topic, and the clock only runs while you are on it.${s.aiTopicEnabled === true ? "" : " (Study topics is switched off in Settings → General, so nothing is being checked anywhere yet.)"}`}"
                 aria-label="AI blocking for ${name}"
                 data-testid="topicsw-${p.id}"/>
          <span class="track"></span>
        </label>` : ""}
      </div>
      <!-- The sentence itself, stepped in under the switch that governs it. A row that HAS one is
           marked in the card above with a 🎯, so a promise folded away is still a promise you can
           see without opening anything. -->
      <div class="srow ropt ind1">
        <span class="ic" aria-hidden="true" title="What you meant to do on this site">🎯</span>
        <input type="text" class="input tpin" data-topic="${p.id}" value="${escHtml(p.topic || "")}"
               maxlength="300" spellcheck="false" autocomplete="off"
               placeholder="What you mean to do here — optional"
               title="What you actually mean to do on ${name}, in your own words: &quot;class 12 physics — electrostatics&quot;.&#10;&#10;With Study topics switched on in Settings → General, an AI checks each page here against this sentence and the clock only runs while you are on topic.&#10;&#10;Leave it empty and this site behaves exactly as it always has."
               aria-label="What AI blocking checks ${name} against"
               data-testid="topic-${p.id}" />
      </div>
      <!-- The phone's webhook switch used to sit here. It is now the last row of the whole panel,
           below the camera fold — see phoneRowHtml, called at the end of cheatPanelHtml. It went
           there because it is the one setting in this panel that is not about this BROWSER at all:
           everything else decides what happens on the page in front of you, and that one reaches
           out to a different device. Grouping it with the browser checks put it in the middle of
           things it has nothing to do with. -->
      <!-- The deadline. Finish between these two times or the unlock is forfeit for the day.
           Not a schedule and not a second copy of the day chips: those decide WHICH DAYS the work is
           asked for, this decides whether finishing it counts. Time still accrues outside the window
           and the bar still fills — what the window governs is the reward, not the work, because a
           row that silently refused to move would read as broken rather than as strict. -->
      <div class="srow ropt">
        <span class="ic" aria-hidden="true">⏰</span>
        <span class="lbl grow">Finish inside a time window ${tip(`A deadline for <b>${name}</b>. Switch it on and the goal only unlocks things if you <b>finish it between these two times</b>.<br/><br/>What it unlocks, and therefore what it can withhold: your <b>blocked sites</b>, and the <b>phone webhook</b>. Finish at 9:10 am on a window that shut at 9:00 am and both stay shut for the rest of the day — the day resets at your usual hour and you start again.<br/><br/><b>Time still counts outside the window.</b> The bar fills whenever you work, and the card will say so. The window decides whether that work buys anything, not whether it is recorded — a goal that refused to move outside its hours would look broken rather than strict.<br/><br/>Windows may cross midnight: <span class='kbd'>10:00 pm</span> to <span class='kbd'>2:00 am</span> is read as the late evening and the two hours after it.<br/><br/><b>The window is always longer than the goal.</b> Thirty minutes of work cannot be finished inside one minute — or inside exactly thirty — so a <b>30-minute</b> goal needs a window of at least <b>31 minutes</b>. Set the end too close to the start and it is moved out to the shortest window that fits; move the start too close to the end and the end moves with it; raise the goal past the window and the window grows to match. The start always stays where you put it.<br/><br/>Switching this <b>on</b> adds a way to fail a day, so it goes through during a strict window. Switching it <b>off</b>, or making it longer, is a loosening and asks for your password.`)}</span>
        <span class="ropt-state${winMissed ? " idle" : ""}">${!winSwOn ? "off" : winMissed ? "missed" : winNow ? "open now" : "shut"}</span>
        <label class="sw">
          <input type="checkbox" data-winsw="${p.id}" ${winSwOn ? "checked" : ""}
                 title="${winSwOn
                   ? `On — ${name} must be finished between ${FGSettings.clock12(winStart)} and ${FGSettings.clock12(winEnd)} for your blocked sites and your phone to open.`
                   : `Off — finish ${name} whenever you like; the unlock is yours either way.`}"
                 aria-label="Deadline window for ${name}"
                 data-testid="winsw-${p.id}"/>
          <span class="track"></span>
        </label>
      </div>
      <!-- The two times, stepped in under the switch that governs them, and drawn whenever that switch
           is on — winSwOn, not winOn. That distinction is the fix: winOn also requires the times to be
           valid, so using it here hid the only controls that could set them the moment they were not,
           which is the state every row created before this feature existed starts in.
           (No backticks in this comment: the whole block is a template literal, so one would end the
           string here and turn the markup after it into code.) -->
      <!-- Four plain boxes rather than two <input type="time">, and that is the fix rather than a
           restyling.
           A native time field is ONE value wearing two or three sub-segments, and the browser owns
           every bit of how you move between them: it advances the caret by itself after two digits,
           it adds an am/pm segment on a 12-hour locale, and re-focusing it always drops you back on
           the hour. Setting an hour and then a minute was a fight with that widget, not with this
           page, and nothing in here could fix it from the outside — the segments are not in the DOM.
           So the widget is gone. An hour box and a minute box are ordinary inputs: they take focus
           where you click, they keep it until you leave, and they do not move the caret on their own.
           The cost is the little clock picker and the am/pm words, and the gain is that typing works.
           These are 24-HOUR — 21:00, not 9 pm — which is why the row says so out loud.
           (No backticks in this comment: the whole block is a template literal, so one would end the
           string here and turn the markup after it into code.) -->
      ${winSwOn ? `
      <div class="srow ropt ind1 wintimes" data-winrow="${p.id}">
        <span class="ic" aria-hidden="true">🕒</span>
        ${winFieldHtml(p.id, "start", winStart, "from", "Window opens at", name)}
        ${winFieldHtml(p.id, "end", winEnd, "to", "Window closes at", name)}
        <!-- The 24h badge that used to sit here is gone with the 24-hour boxes. It existed to warn that
             9 meant nine in the MORNING and there was no way to say otherwise; there is an am/pm button
             on each field now, so the warning has nothing left to warn about. -->
        <span class="lbl hint">${escHtml(winSpanText({ winEnabled: true, winStart, winEnd }))}</span>
      </div>
      <!-- Said plainly, because it is the one state where the numbers on the card disagree with what
           is happening: the bar reads 100%, the row says "Completed", and nothing is unlocked. -->
      ${winMissed ? `
      <div class="srow ropt ind1 winmiss">
        <span class="ic" aria-hidden="true">⚠️</span>
        <span class="lbl grow">Finished outside the window, so it didn't unlock anything today. The time still counted.</span>
      </div>` : ""}` : ""}
      <!-- The stopwatch. The goal plus a slack of your choosing, counted from the first moment you open
           this site today.
           A sibling of the window above rather than a variant of it, and the difference is what each one
           is a promise about: the window is a time of DAY, so it only means anything if you know when
           you will sit down. This is a promise about not dawdling once you have, and it means the same
           thing whenever that is. Both can be on; a row then has to satisfy both.
           Same rule as the window on earning, too: the allowance running out does not stop the clock or
           empty the bar. What it takes away is the unlock. -->
      <div class="srow ropt">
        <span class="ic" aria-hidden="true">⏳</span>
        <span class="lbl grow">Finish within a time limit ${tip(`A stopwatch for <b>${name}</b>, started the first time you open it today.<br/><br/>You get <b>the goal plus the grace time</b> to finish the goal in. One hour of work with ten minutes of grace means: from the moment you first open <b>${name}</b>, seventy minutes to put sixty in.<br/><br/>Miss it and this goal unlocks nothing for the rest of the day — your <b>blocked sites</b> and your <b>phone webhook</b> both stay shut — exactly like a missed window.<br/><br/><b>The stopwatch starts when the page is seen, not when the clock runs.</b> That is on purpose: if it waited for the camera to find you, looking away would be a way to postpone the deadline.<br/><br/><b>Time still counts after it runs out.</b> The bar keeps filling and the card says so. What the limit decides is whether finishing buys anything, not whether it is recorded.<br/><br/>Pressing <b>＋</b> on the card to add time extends the limit with it, since the limit is the goal plus your grace.<br/><br/>It resets at your daily reset, and <b>only</b> then — starting a row over with ↺ does not hand you a fresh allowance, because ↺ does not un-open the site.<br/><br/>Switching this <b>on</b> adds a way to fail a day, so it goes through during a strict window. Switching it <b>off</b>, or adding grace, is a loosening and asks for your password.`)}</span>
        <span class="ropt-state${graceMissed || graceGone ? " idle" : ""}">${
          !graceSwOn ? "off"
          : !graceOn ? "no goal"
          : graceMissed ? "missed"
          : graceGone ? "ran out"
          : graceRunning ? fmtDur(graceLeft) + " left"
          : "not started"}</span>
        <label class="sw">
          <input type="checkbox" data-gracesw="${p.id}" ${graceSwOn ? "checked" : ""}
                 title="${graceSwOn
                   ? `On — once you open ${name}, its goal plus ${fmtDur(graceSec)} is all the time you get to finish it in.`
                   : `Off — take as long as you like over ${name}; the unlock is yours whenever you finish.`}"
                 aria-label="Time limit for ${name}"
                 data-testid="gracesw-${p.id}"/>
          <span class="track"></span>
        </label>
      </div>
      <!-- The slack itself, stepped in under the switch that governs it. Drawn on graceSwOn rather than
           on graceOn, the same fix the window's boxes needed: graceOn also requires a goal above zero, so
           using it here would hide the control on exactly the rows whose owner is still setting them up.
           Minutes, not seconds. Seconds of grace is not a thing anybody means, and a box that accepted
           them would invite a value nobody could read back off the row.
           (No backticks in this comment: the whole block is a template literal, so one would end the
           string here and turn the markup after it into code.) -->
      ${graceSwOn ? `
      <div class="srow ropt ind1">
        <span class="ic" aria-hidden="true">⏳</span>
        <span class="lbl grow">Grace time on top of the goal</span>
        <span class="timeset plain">
          <label class="tfld"><input class="input" type="number" min="0" max="720" step="1"
                 value="${Math.round(graceSec / 60)}" data-gracemin="${p.id}"
                 title="Minutes of slack on top of ${name}'s goal. 0 means exactly the goal and not a second more."
                 aria-label="Grace minutes for ${name}" data-testid="gracemin-${p.id}"/><i>min</i></label>
        </span>
      </div>
      ${!graceOn ? `
      <div class="srow ropt ind1 winmiss">
        <span class="ic" aria-hidden="true">⚠️</span>
        <span class="lbl grow">Nothing to be late for — set a goal above 0 and this starts working.</span>
      </div>` : graceRunning ? `
      <div class="srow ropt ind1">
        <span class="ic" aria-hidden="true">${graceMissed || graceGone ? "⚠️" : "⏱️"}</span>
        <span class="lbl grow">${graceMissed
          ? "Finished after the limit ran out, so it didn't unlock anything today. The time still counted."
          : graceGone
            ? "The limit ran out with work still to do, so nothing it unlocks will open today."
            : `Started at ${escHtml(FGSettings.clock12(clockHHMM(p.graceFrom)))} — <b>${escHtml(fmtDur(graceLeft))}</b> left, until ${escHtml(FGSettings.clock12(clockHHMM(FGSettings.graceDeadline(p))))}.`}</span>
      </div>` : `
      <div class="srow ropt ind1">
        <span class="ic" aria-hidden="true">⏱️</span>
        <span class="lbl grow">Not started — the ${escHtml(fmtDur((p.requiredSec || 0) + graceSec))} begins the first time you open ${name} today.</span>
      </div>`}` : ""}${grpEnd()}`;
}

// An epoch stamp as "HH:MM", so FGSettings.clock12 can say it the way every other time on this page is
// said. Its own function because two screens need it and neither should own a second copy — blocked.js
// has the same three lines under the name clockOf, and these two files do not share modules.
function clockHHMM(ms) {
  const t = Number(ms) || 0;
  if (!t) return "";
  const d = new Date(t);
  return String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0");
}

// ---- the phone's webhook, at the very bottom of the panel ----
//
// Last, below the camera fold, and on its own rather than inside a group. Every other setting in this
// panel decides what happens in the BROWSER, on the page in front of you; this one reaches out to a
// different device entirely. Sitting among the browser checks it read as one of them.
//
// Drawn only while the bridge is switched on, which is this page's rule everywhere: a switch that
// cannot do anything is worse than a missing one, because you flick it and draw a conclusion.
function phoneRowHtml(p, name) {
  const s = lastState || {};
  if (s.macrodroidEnabled !== true) return "";
  const on = p.webhookOn !== false;
  return `
      <div class="srow ropt phonerow">
        <span class="ic" aria-hidden="true">📱</span>
        <span class="lbl grow">Phone MacroDroid webhook URL blocking ${tip(`Whether your phone's apps wait for <b>${name}</b>.<br/><br/><b>On</b> — the webhook keeps your phone's apps blocked until this site's time is finished, along with every other site that has this switched on.<br/><br/><b>Off</b> — the webhook ignores this site. It still earns time and still unlocks your blocked sites in Chrome; it is just not one of the goals your phone is holding out for. Useful for a reference page you dip into at odd hours, which would otherwise keep your phone locked all day.<br/><br/>The webhook addresses themselves are in <b>📱 Phone apps block</b>, on this page. Your phone has to be online to hear either call.`)}</span>
        <span class="ropt-state">${on ? "on" : "off"}</span>
        <label class="sw">
          <input type="checkbox" data-whsw="${p.id}" ${on ? "checked" : ""}
                 title="${on
                   ? `On — your phone's apps stay blocked until ${name} is finished, along with every other site that has this switched on.`
                   : `Off — the webhook does not wait for ${name}. It still earns time and still unlocks your sites; it is just not one of the goals the phone is holding out for.`}"
                 aria-label="Phone MacroDroid webhook blocking for ${name}"
                 data-testid="whsw-${p.id}"/>
          <span class="track"></span>
        </label>
      </div>`;
}

// How long a window is, in words. Written out because the two boxes on their own do not say it —
// "23:30 to 00:15" is forty-five minutes and does not look like it.
// "06:30" split for the two boxes that now hold it, and put back together again. Padded to two digits
// on the way out, because an hour box reading "6" next to a minute box reading "0" does not look like
// a time — and the stored value has to be HH:MM whatever was typed, since hasWindow and inWindow parse
// it with a strict pattern.
function hhOf(t) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(t || ""));
  return m ? String(Number(m[1])).padStart(2, "0") : "00";
}
function mmOf(t) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(t || ""));
  return m ? m[2] : "00";
}
// Whatever is in a box, as a number inside its range. Empty counts as 0 rather than as "leave it
// alone": a cleared box is a value you are replacing, and refusing to read it would store the old
// hour behind your back.
function winClamp(v, max) {
  const digits = String(v == null ? "" : v).replace(/\D+/g, "");
  if (!digits) return 0;
  return Math.max(0, Math.min(max, parseInt(digits, 10)));
}
function winPad(n) { return String(n).padStart(2, "0"); }

// Anything at all, as a valid "HH:MM".
//
// Four digit slots, filled left to right — so "0645" is 06:45 and "645" is 64:5, which then clamps to
// 23:05. That looks harsh written down and is not, because the box shows the colon as you type: you
// see "64:5" before you ever leave it. The typing mask below removes the common way of falling into it.
// ---- 24-hour underneath, 12-hour on screen ---------------------------------------------------
//
// Storage never changes: winStart and winEnd are "HH:MM" on a 24-hour clock, because that is the only
// form with no midnight ambiguity and it is what hasWindow and inWindow parse. Everything below is the
// translation layer for the row, which now reads "03:00 pm" the way a clock does.
//
// The hour box therefore holds 1–12, and the am/pm beside it is a separate control rather than two more
// characters to type. Twelve and zero are the pair worth naming: midnight is 12 am and noon is 12 pm, so
// hour 0 on the 24-hour clock shows as 12, not as 0.

// "15:30" -> { hh: "03", mm: "30", ap: "pm" }
function win12(v) {
  const t = /^(\d{1,2}):(\d{2})$/.exec(String(v || "")) || [, "0", "00"];
  const h24 = winClamp(t[1], 23), mi = winClamp(t[2], 59);
  return {
    hh: winPad(h24 % 12 === 0 ? 12 : h24 % 12),
    mm: winPad(mi),
    ap: h24 < 12 ? "am" : "pm"
  };
}
// "03:30" + "pm" -> "15:30". The display hour is 1–12, so 12 is the one that does not simply add 12.
function win24(hhmm, ap) {
  const t = /^(\d{1,2}):(\d{1,2})$/.exec(String(hhmm || "")) || [, "12", "00"];
  let h = winClamp(t[1], 12);
  const mi = winClamp(t[2], 59);
  if (h === 0) h = 12;                                  // an empty or 0 hour box means 12
  const h24 = String(ap).toLowerCase() === "pm" ? (h === 12 ? 12 : h + 12) : (h === 12 ? 0 : h);
  return winPad(h24) + ":" + winPad(mi);
}
// Whatever is in the box, as a valid 12-hour "hh:mm". Hours clamp into 1–12 rather than 0–23 now, and 0
// becomes 12 — on a 12-hour clock there is no zero o'clock.
function winNorm(v) {
  const text = String(v == null ? "" : v);
  const fix = (h) => { const n = winClamp(h, 12); return winPad(n === 0 ? 12 : n); };
  // A separator that is ALREADY there decides where the hour ends, and ignoring it was a real bug:
  // "6:45" stripped to digits is "645", which fills the four slots as 64:5 and then clamps — so a time
  // pasted in by hand came out as a completely different hour. The flat reading is only the fallback,
  // for when there is nothing to go on.
  const sep = /^\s*(\d{1,2})\s*[:.]\s*(\d{1,2})\s*$/.exec(text);
  if (sep) return fix(sep[1]) + ":" + winPad(winClamp(sep[2], 59));
  const d = text.replace(/\D+/g, "").slice(0, 4);
  return fix(d.slice(0, 2)) + ":" + winPad(winClamp(d.slice(2), 59));
}
// What the box should read while it is being typed in, and where the caret belongs afterwards.
//
// Kept apart from the event handler so it can be reasoned about — and tested — as a pure function,
// because caret arithmetic is where masked fields normally go wrong. The caret is tracked by counting
// DIGITS rather than characters: the colon appears and disappears under you, so a character offset
// drifts by one the moment it does.
function winMask(raw, caret) {
  const text = String(raw == null ? "" : raw);
  let d, before;
  // A single-digit hour followed by a separator: "6:45" pasted in, or a colon typed by hand after one
  // digit. The separator is the evidence that the 6 is the whole hour, so it is padded rather than
  // treated as the first of two hour digits — without this the paste read as 64:5. Only when the hour
  // part is ONE digit: "06:4" is what this function itself produces mid-typing, and that must keep
  // going down the ordinary path or every second keystroke would re-interpret the field.
  const sep = /^\s*(\d)\s*[:.]\s*(\d{0,2})\s*$/.exec(text);
  if (sep) {
    d = ("0" + sep[1] + sep[2]).slice(0, 4);
    before = d.length;                                  // a pasted or punctuated value is a whole value
  } else {
    d = text.replace(/\D+/g, "").slice(0, 4);
    before = text.slice(0, Math.max(0, caret || 0)).replace(/\D+/g, "").length;
    // A first digit that cannot begin an hour IS the hour: type 3 and it becomes 03, because on a
    // 12-hour clock the only hours with two digits are 10, 11 and 12 — so 1 is the single digit that
    // has to wait for a partner, and every other one is already complete. Saves the leading zero on
    // nine hours out of twelve, and it is what stops "9" then "30" from being read as 93:0.
    if (d.length === 1 && Number(d) > 1) { d = "0" + d; before += 1; }
  }
  const value = d.length > 2 ? d.slice(0, 2) + ":" + d.slice(2) : d;
  let pos = before <= 2 ? before : before + 1;          // +1 once the caret is past the colon
  if (pos > value.length) pos = value.length;
  return { value, caret: pos };
}
// Which half of "HH:MM" the caret is sitting in, so the arrows know what to step.
function winPart(el) {
  const at = typeof el.selectionStart === "number" ? el.selectionStart : 0;
  return at <= 2 ? "h" : "m";
}
// Step the half the caret is in, and leave the caret there so the next press stays on it.
//
// The arithmetic happens on the 24-HOUR value, which is what makes stepping the hour walk off the end of
// the morning and into the afternoon: 11 am up is 12 pm, and 11 pm up is 12 am. Doing it on the 1–12
// display number instead would have wrapped 11 round to 12 and left the am/pm where it was, so a third
// of the day would have been unreachable with the arrows.
//
// Minutes deliberately do NOT carry into the hour. The two ends of a window are separate decisions, and
// nudging 59 to 00 quietly moving the hour is a surprise nobody asked for.
function winBump(el, delta, apEl) {
  const part = winPart(el);
  const ap = apEl ? (apEl.getAttribute("data-ap") || "am") : "am";
  const cur = win24(winNorm(el.value), ap);
  let h = winClamp(cur.slice(0, 2), 23);
  let m = winClamp(cur.slice(3), 59);
  if (part === "h") h = (h + delta + 24) % 24;
  else m = (m + delta + 60) % 60;
  const shown = win12(winPad(h) + ":" + winPad(m));
  el.value = shown.hh + ":" + shown.mm;
  if (apEl) winSetAp(apEl, shown.ap);
  const pos = part === "h" ? 2 : 5;
  try { el.setSelectionRange(pos, pos); } catch {}
}
// The am/pm control carries its own state, so flipping it is one place rather than a label and a
// variable that can disagree.
function winSetAp(btn, ap) {
  const v = String(ap).toLowerCase() === "pm" ? "pm" : "am";
  btn.setAttribute("data-ap", v);
  btn.setAttribute("aria-pressed", v === "pm" ? "true" : "false");
  btn.textContent = v;
}

// One end of the window: the word, ONE box holding the whole time, its arrows, and the clock face.
//
// One box rather than two. The hour and the minute were separate fields with their own H and M letters
// and their own steppers, and that made four boxes and four arrow pairs in a row that already had a
// switch above it — a time is one thing you are setting, so it gets one place to set it.
//
// The arrows work on whichever half the caret is in, which is the only sane answer once there is a
// single pair of them. They are `tabindex="-1"` so Tab runs field to field rather than through the
// arrows, and their mousedown is cancelled so the click lands the caret in the BOX instead of on the
// button — which also keeps focus inside the row, and the row's "focus left, so save" rule is the only
// thing that ever writes. An arrow that quietly kept focus outside would change the time and never
// store it.
function winFieldHtml(id, which, value, word, what, name) {
  const key = `${id}:${which}`;
  const t = win12(value);
  return `<span class="winfld">${word}
        <input class="input wtime" type="text" inputmode="numeric" maxlength="5" autocomplete="off"
               spellcheck="false" data-win="${key}" value="${escHtml(t.hh + ":" + t.mm)}"
               aria-label="${what} for ${name} — hours and minutes"
               title="${what}. Up and down change whichever half the cursor is in."
               data-testid="win-${which}-${id}"/>
        <button class="wap" type="button" data-winap="${key}" data-ap="${t.ap}"
                aria-pressed="${t.ap === "pm" ? "true" : "false"}"
                aria-label="${what} for ${name} — morning or afternoon"
                title="Tap to swap between am and afternoon/evening (pm)"
                data-testid="winap-${which}-${id}">${t.ap}</button>
        <span class="wspin">
          <button class="wstep" type="button" data-winstep="${key}:1" tabindex="-1"
                  aria-label="${what}, one later" title="One later — hour or minute, whichever the cursor is in">▲</button>
          <button class="wstep" type="button" data-winstep="${key}:-1" tabindex="-1"
                  aria-label="${what}, one earlier" title="One earlier — hour or minute, whichever the cursor is in">▼</button>
        </span>
        <button class="wclock" type="button" data-winclock="${key}"
                aria-label="${what} for ${name} — pick it on a clock face"
                title="Pick it on a round clock instead" data-testid="winclock-${which}-${id}">🕐</button>
      </span>`;
}

// ---- the round clock -------------------------------------------------------------------------
//
// A real dial you drag, for the times typing two numbers is not what you want. Resolves to "HH:MM",
// or null if it was dismissed.
//
// Twelve hours on one ring, 12 at the top, with am/pm beside the readout — an ordinary clock face.
//
// It used to carry all 24 on two rings, 0–11 outside and 12–23 tucked inside, because the boxes had no
// am/pm and the inner ring had to stand in for one. The boxes have an am/pm button now, so the second
// ring was paying for something already paid for, and a real clock is easier to read than a clever one.
// Minutes keep the ring to themselves, labelled every five but landing on any single minute you drag to.
//
// Geometry is in one place and the SVG is drawn to it, so moving a radius moves the numbers, the hand
// and the hit test together — three copies of "where is 7 o'clock" is three chances to disagree.
const DIAL = { size: 240, c: 120, rOut: 96, numR: 15 };
function dialPos(i, steps, r) {
  const a = (i / steps) * Math.PI * 2 - Math.PI / 2;      // 0 at the top, clockwise
  return { x: DIAL.c + Math.cos(a) * r, y: DIAL.c + Math.sin(a) * r };
}
function openWinDial({ title, value }) {
  return new Promise(resolve => {
    // In and out in 24-hour, like storage; 12-hour plus am/pm while it is on screen.
    const start = win12(winPad(winClamp(hhOf(value), 23)) + ":" + winPad(winClamp(mmOf(value), 59)));
    let h12 = winClamp(start.hh, 12) || 12;                 // 1–12, never 0
    let m = winClamp(start.mm, 59);
    let ap = start.ap;
    let mode = "h";                                        // which segment the face is editing
    const out = () => win24(winPad(h12) + ":" + winPad(m), ap);

    const back = document.createElement("div");
    back.className = "sheetback";
    back.setAttribute("data-testid", "win-dial");
    back.innerHTML = `
      <div class="dialbox" role="dialog" aria-modal="true" aria-label="${escHtml(title)}">
        <div class="dialhead">
          <span class="dialttl">${escHtml(title)}</span>
          <div class="dialread">
            <button class="dialseg" type="button" data-dseg="h" data-testid="dial-seg-h"
                    aria-label="Set the hour">00</button>
            <b>:</b>
            <button class="dialseg" type="button" data-dseg="m" data-testid="dial-seg-m"
                    aria-label="Set the minute">00</button>
            <span class="dialap">
              <button class="dialapb" type="button" data-dap="am" data-testid="dial-am">am</button>
              <button class="dialapb" type="button" data-dap="pm" data-testid="dial-pm">pm</button>
            </span>
          </div>
        </div>
        <svg class="dialface" viewBox="0 0 ${DIAL.size} ${DIAL.size}" role="application"
             aria-label="Clock face — drag to set the time" data-testid="dial-face">
          <circle class="dialbg" cx="${DIAL.c}" cy="${DIAL.c}" r="${DIAL.c - 4}"/>
          <line class="dialhand" x1="${DIAL.c}" y1="${DIAL.c}" x2="${DIAL.c}" y2="${DIAL.c - DIAL.rOut}"/>
          <circle class="dialknob" cx="${DIAL.c}" cy="${DIAL.c - DIAL.rOut}" r="${DIAL.numR}"/>
          <circle class="dialhub" cx="${DIAL.c}" cy="${DIAL.c}" r="3.5"/>
          <g class="dialnums"></g>
        </svg>
        <div class="dialfoot">
          <span class="dialhint">Drag the hand, or tap a number.</span>
          <button class="btn sec" type="button" data-dial="no" data-testid="dial-cancel">Cancel</button>
          <button class="btn" type="button" data-dial="ok" data-testid="dial-ok">Set</button>
        </div>
      </div>`;
    document.body.appendChild(back);

    const svg = back.querySelector(".dialface");
    const nums = back.querySelector(".dialnums");
    const hand = back.querySelector(".dialhand");
    const knob = back.querySelector(".dialknob");
    const segH = back.querySelector('[data-dseg="h"]');
    const segM = back.querySelector('[data-dseg="m"]');
    const apBtns = Array.from(back.querySelectorAll("[data-dap]"));

    function paint() {
      segH.textContent = winPad(h12);
      segM.textContent = winPad(m);
      segH.classList.toggle("on", mode === "h");
      segM.classList.toggle("on", mode === "m");
      apBtns.forEach(b => b.classList.toggle("on", b.getAttribute("data-dap") === ap));
      // 12 sits at the top, which is index 0 on the ring — the one hour whose label and its position do
      // not share a number.
      const p = mode === "m" ? dialPos(m, 60, DIAL.rOut) : dialPos(h12 % 12, 12, DIAL.rOut);
      hand.setAttribute("x2", p.x.toFixed(2));
      hand.setAttribute("y2", p.y.toFixed(2));
      knob.setAttribute("cx", p.x.toFixed(2));
      knob.setAttribute("cy", p.y.toFixed(2));
      // A minute with no label of its own still needs the knob, so dragging to 07 shows something — but
      // a full-size disc over blank space reads as a mistake, so it shrinks to a dot. Set as an
      // attribute rather than by class: `r` as a CSS property is SVG2 and well supported in Chrome, but
      // the attribute is what every version honours and there is no reason to depend on the newer one.
      const bare = mode === "m" && m % 5 !== 0;
      knob.setAttribute("r", String(bare ? 5 : DIAL.numR));
      let out = "";
      const put = (label, pos, sel) =>
        `<text class="dialnum${sel ? " sel" : ""}" x="${pos.x.toFixed(2)}" y="${pos.y.toFixed(2)}"
               text-anchor="middle" dominant-baseline="central">${label}</text>`;
      if (mode === "h") {
        // Index 0 is the top of the ring and is labelled 12; 1 through 11 read as themselves.
        for (let i = 0; i < 12; i++) {
          const label = i === 0 ? 12 : i;
          out += put(String(label), dialPos(i, 12, DIAL.rOut), h12 === label);
        }
      } else {
        for (let i = 0; i < 60; i += 5) out += put(winPad(i), dialPos(i, 60, DIAL.rOut), m === i);
      }
      nums.innerHTML = out;
    }

    // Where the pointer is, in the face's own coordinates, so the maths is independent of how big the
    // SVG ended up on screen.
    function at(ev) {
      const r = svg.getBoundingClientRect();
      if (!r.width || !r.height) return null;
      const x = ((ev.clientX - r.left) / r.width) * DIAL.size - DIAL.c;
      const y = ((ev.clientY - r.top) / r.height) * DIAL.size - DIAL.c;
      let ang = (Math.atan2(y, x) * 180) / Math.PI + 90;
      if (ang < 0) ang += 360;
      return { ang, dist: Math.hypot(x, y) };
    }
    function grab(ev) {
      const q = at(ev);
      if (!q) return;
      if (mode === "h") {
        const i = Math.round(q.ang / 30) % 12;
        h12 = i === 0 ? 12 : i;                            // the top of the ring is 12, not 0
      } else {
        m = Math.round(q.ang / 6) % 60;
      }
      paint();
    }

    let down = false;
    svg.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      down = true;
      try { svg.setPointerCapture(e.pointerId); } catch {}
      grab(e);
    });
    svg.addEventListener("pointermove", (e) => { if (down) grab(e); });
    svg.addEventListener("pointerup", (e) => {
      if (!down) return;
      down = false;
      try { svg.releasePointerCapture(e.pointerId); } catch {}
      // Picking an hour moves you on to the minutes by itself. That is the whole reason a dial is
      // quicker than two boxes, and it is safe here in a way it was not in the native field: this is
      // a sheet, it writes nothing until Set, and the step is reversible by tapping the hour again.
      if (mode === "h") { mode = "m"; paint(); }
    });
    svg.addEventListener("pointercancel", () => { down = false; });

    segH.addEventListener("click", () => { mode = "h"; paint(); });
    segM.addEventListener("click", () => { mode = "m"; paint(); });
    apBtns.forEach(b => b.addEventListener("click", () => { ap = b.getAttribute("data-dap"); paint(); }));

    function close(v) {
      document.removeEventListener("keydown", onKey, true);
      back.remove();
      resolve(v);
    }
    function onKey(e) {
      if (e.key === "Escape") { e.stopPropagation(); e.preventDefault(); return close(null); }
      if (e.key === "Enter") { e.stopPropagation(); e.preventDefault(); return close(out()); }
      // Usable without a mouse: up and down move whichever segment is live, left and right swap which
      // one that is. A dial you can only drag is a dial half the people here cannot use.
      const step = e.key === "ArrowUp" ? 1 : e.key === "ArrowDown" ? -1 : 0;
      if (step) {
        e.stopPropagation(); e.preventDefault();
        if (mode === "h") {
          // Stepped on the 24-hour value so 11 am carries up into 12 pm, exactly as the row's arrows do.
          // Stepping the 1–12 number instead would wrap 11 back to 12 and leave am/pm alone, which puts
          // half the day out of reach.
          const t = win24(winPad(h12) + ":" + winPad(m), ap);
          const next = win12(winPad((winClamp(t.slice(0, 2), 23) + step + 24) % 24) + ":" + winPad(m));
          h12 = winClamp(next.hh, 12) || 12;
          ap = next.ap;
        } else {
          m = (m + step + 60) % 60;
        }
        return paint();
      }
      // "a" and "p" for the two halves of the day, since the face has no other keyboard way in.
      if (e.key === "a" || e.key === "A" || e.key === "p" || e.key === "P") {
        e.stopPropagation(); e.preventDefault();
        ap = (e.key === "a" || e.key === "A") ? "am" : "pm";
        return paint();
      }
      if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
        e.stopPropagation(); e.preventDefault();
        mode = mode === "h" ? "m" : "h";
        return paint();
      }
    }
    document.addEventListener("keydown", onKey, true);
    back.addEventListener("click", (e) => { if (e.target === back) close(null); });
    back.querySelector('[data-dial="no"]').addEventListener("click", () => close(null));
    back.querySelector('[data-dial="ok"]').addEventListener("click", () => close(out()));

    paint();
    setTimeout(() => back.querySelector('[data-dial="ok"]').focus(), 30);
  });
}

function winSpanText(p) {
  if (!FGSettings.hasWindow(p)) return "";
  const mins = (v) => {
    const m = /^(\d{1,2}):(\d{2})$/.exec(String(v || ""));
    return m ? Number(m[1]) * 60 + Number(m[2]) : -1;
  };
  const a = mins(p.winStart), b = mins(p.winEnd);
  if (a < 0 || b < 0) return "";
  const len = a < b ? b - a : (1440 - a) + b;
  const h = Math.floor(len / 60), m = len % 60;
  const span = h && m ? `${h}h ${m}m` : h ? `${h}h` : `${m}m`;
  // Naming the wrap, because an end time smaller than the start looks like a mistake otherwise.
  return a < b ? span : span + " · over midnight";
}

// The panel under a row. Same checks as the global card, in the same order, so
// there's nothing new to learn — plus one switch at the top deciding whether this
// row follows Setup or itself.
function cheatPanelHtml(p, strict) {
  const s = lastState || {};
  const c = siteCheat(s, p);
  const own = !!p.cheatCustom;
  const hasTopic = !!String(p.topic || "").trim();
  // Strict mode no longer disables this panel. Every control in it has a stricter direction,
  // so greying them out stopped you tightening a single site's checks while frozen. Easing one
  // off is refused by setStateP. What still disables them is the row FOLLOWING Setup rather than
  // keeping its own copy — a different rule, and one with no direction to it.
  const lock = "";
  // The glyph is a parameter with the hourglass as its default: every other number in
  // this panel is "how long until", but the rewind is "how far back", and an hourglass
  // beside it says the opposite of what it does.
  const num = (key, val, min, max, unit, title, icon = "⏳") => `
    <span class="timeset plain">
      <span class="gicon" aria-hidden="true">${icon}</span>
      <label class="tfld"><input class="input" type="number" min="${min}" max="${max}" value="${val}"
             data-ck="${p.id}|${key}" title="${title}" aria-label="${title}" ${own ? lock : "disabled"}/><i>${unit}</i></label>
    </span>`;
  const swx = (key, on, testid) => `<label class="sw"><input type="checkbox" data-ck="${p.id}|${key}"
      ${on ? "checked" : ""} ${own ? lock : "disabled"} data-testid="${testid}-${p.id}"/><span class="track"></span></label>`;
  // The four groups, as folds. Suffixed with this row's id so two panels can never share an
  // id — only one is ever open at a time, but ids outlive that by a render.
  const grp = (key, icon, title) => grpOpen(key, icon, title, c, "_" + p.id);
  // The words at the ends and the word beside the thumb are per-dial now. Three of the four
  // read "how much of you is enough" and share one vocabulary; the blink one reads "how faint
  // a blink will still be caught", which is a different question and would be actively
  // misleading in the shared words — "easy" on that dial means the check is easier to satisfy,
  // where on the others it means the camera is easier to convince.
  const DIAL_LABEL = {
    faceSensitivity: "Face detection sensitivity, 1 strict to 5 easy",
    eyeSensitivity: "Eye detection sensitivity, 1 fussy to 5 easy",
    moveSensitivity: "Movement sensitivity, 1 strict to 5 forgiving",
    blinkSensitivity: "Blink sensitivity, 1 needs a clear blink to 5 catches a flicker"
  };
  const dial = (key, val, lo, hi) => `
    <span class="sens">
      <span class="sensend" aria-hidden="true">${lo}</span>
      <!-- No class needed: the CSS reaches these through .sens input[type="range"],
           which is also how the dials in Setup are styled. -->
      <input type="range" min="1" max="5" step="1" value="${val}" data-ck="${p.id}|${key}"
             aria-label="${DIAL_LABEL[key] || key}" ${own ? lock : "disabled"}/>
      <span class="sensend" aria-hidden="true">${hi}</span>
      <b class="sensval">${dialWords(key)[Math.min(5, Math.max(1, val || 3))]}</b>
    </span>`;
  // The same control for a slider that carries a NUMBER rather than a step on a five-point
  // scale: the two timer speeds and the size of the focus box. Its own builder rather than an
  // argument on `dial`, because everything about it differs — the range, the step, and the fact
  // that the word beside the thumb is the value itself instead of a name for it. The five-point
  // dials read "fussy → easy"; there is no name for 1.7×, and inventing one would hide the only
  // thing that matters about it.
  const mult = (key, val, label) => {
    const d = PACE_DIAL[key];
    const v = paceVal(key, val);
    return `
    <span class="sens">
      <span class="sensend" aria-hidden="true">${d.min}${d.unit}</span>
      <input type="range" min="${d.min}" max="${d.max}" step="${d.step}" value="${v}"
             data-ck="${p.id}|${key}" aria-label="${label}" ${own ? lock : "disabled"}/>
      <span class="sensend" aria-hidden="true">${d.max}${d.unit}</span>
      <b class="sensval">${paceText(key, v)}</b>
    </span>`;
  };
  return `
    <div class="cheatpanel${own ? " own" : ""}${hasTopic ? " has-topic" : ""}" id="cheat_${p.id}" data-testid="cheat-panel-${p.id}">
      ${rowOptsHtml(p, targetName(p) ? escHtml(targetName(p)) : "this site")}
      <div class="srow head">
        <span class="ic" aria-hidden="true">🛡️</span>
        <span class="lbl grow">Its own cheating prevention ${tip(`Off means this site follows the checks in <b>⚙️ Setup</b> — change them there and every site follows.<br/><br/>On gives this site its own copy, starting from whatever Setup says right now. Useful when one target needs different treatment: a video lecture may want the camera and no split screen, while a reading site only needs the stillness check.<br/><br/>Switching it back off returns this site to the Setup values; the numbers you set here are kept in case you turn it on again.${strict ? "<br/><br/><b style='color:#fca5a5'>Strict mode is on: these can't be changed right now.</b>" : ""}`)}</span>
        <span class="lbl hint">${own ? "its own" : "following Setup"}</span>
        <label class="sw"><input type="checkbox" data-ck="${p.id}|cheatCustom" ${own ? "checked" : ""} ${lock} data-testid="cheat-own-${p.id}"/><span class="track"></span></label>
      </div>

      <!-- Eleven switches in one flat column was a wall: nothing said which of them were
           alternatives to one another, which needed a camera, or which were not checks at
           all. Each heading below is a QUESTION and its rows are the ways of answering it,
           so the four headings together are the whole of what this panel means. Same four
           groups, same order, as the card in Setup. -->
      ${grp("media", "▶️", "Media tracking")}
      <div class="srow sub">
        <span class="ic">▶️</span>
        <span class="lbl grow">Media tracking</span>
        ${swx("mediaPlayingRequired", c.mediaPlayingRequired, "cheat-media")}
      </div>
      <!-- Indented under media tracking, because they are about the same thing: that row
           decides whether a playing video is what earns you the time, these two decide what
           happens to that video when the time stops.
           Deliberately NOT hidden when media tracking is off, unlike the child row below.
           The indent groups them with it; it does not make them depend on it. Pausing a video
           when the clock stops works whether or not the video is what the clock is counting. -->
      <div class="srow sub ind1">
        <span class="ic">⏯️</span>
        <span class="lbl grow">Pause the video when the clock stops</span>
        ${num("mediaRewindSec", c.mediaRewindSec === undefined ? 5 : c.mediaRewindSec, 0, 120, "sec back", "Seconds to wind the video back when it pauses", "⏪")}
        ${swx("mediaPauseEnabled", c.mediaPauseEnabled === true, "cheat-mpause")}
      </div>
      <div class="srow sub ind2" ${c.mediaPauseEnabled === true ? "" : "hidden"}>
        <span class="ic">▶️</span>
        <span class="lbl grow">Auto resume</span>
        ${swx("mediaResumeEnabled", c.mediaResumeEnabled === true, "cheat-mresume")}
      </div>
      <div class="srow sub">
        <span class="ic">⏸️</span>
        <span class="lbl grow">Mouse cursor inactivity tracker</span>
        ${num("inactivityTimeoutSec", c.inactivityTimeoutSec || 30, 5, 600, "s", "Seconds of stillness before it pauses")}
        ${swx("inactivityPauseEnabled", c.inactivityPauseEnabled, "cheat-inact")}
      </div>

      ${grpEnd()}

      ${grp("screen", "🖥️", "Screen")}
      <div class="srow sub">
        <span class="ic">🖥️</span>
        <span class="lbl grow">Full screen forcer</span>
        ${swx("fullscreenOnlyEnabled", c.fullscreenOnlyEnabled !== false, "cheat-fs")}
      </div>
      <div class="srow sub">
        <span class="ic">🪟</span>
        <span class="lbl grow">Split screen prevention</span>
        ${swx("splitViewBlockEnabled", c.splitViewBlockEnabled !== false, "cheat-split")}
      </div>
      ${grpEnd()}

      <!-- Named as what it is: nothing here decides whether a second counts, these act on
           the page while you work. They used to sit among the checks, which made the panel's
           own title a claim about three rows that were never conditions.
           Above the camera group, not below it, because that is where they sit in Setup —
           the camera rows are the longest run in either view and read as the last thing. -->
      ${grp("glow", "✨", "Glow")}
      <div class="srow sub">
        <span class="ic">✨</span>
        <span class="lbl grow">Glow on the page</span>
        ${swx("pageGlowEnabled", c.pageGlowEnabled !== false, "cheat-glow")}
      </div>
      ${grpEnd()}

      ${grp("camera", "📷", "Camera")}
      <div class="srow sub">
        <span class="ic">📷</span>
        <span class="lbl grow">Face detection</span>
        ${swx("faceDetectionEnabled", c.faceDetectionEnabled, "cheat-face")}
      </div>
      <!-- Hidden, not greyed, while its check is off — the same rule as the card, decided
           inline here because this panel is rebuilt on every change rather than being
           updated in place. -->
      <div class="srow sub deep" ${c.faceDetectionEnabled ? "" : "hidden"}>
        <span class="ic">🎚️</span>
        <span class="lbl grow">Sensitivity</span>
        ${dial("faceSensitivity", c.faceSensitivity || 3, "strict", "easy")}
      </div>
      <div class="srow sub">
        <span class="ic">👀</span>
        <span class="lbl grow">Eye detection</span>
        ${num("eyeAwaySec", c.eyeAwaySec === undefined ? 10 : c.eyeAwaySec, 0, 600, "s", "How long you may look away, in seconds")}
        ${swx("eyeTrackingEnabled", c.eyeTrackingEnabled, "cheat-eye")}
      </div>
      <div class="srow sub deep" ${c.eyeTrackingEnabled ? "" : "hidden"}>
        <span class="ic">🎯</span>
        <span class="lbl grow">Sensitivity</span>
        ${dial("eyeSensitivity", c.eyeSensitivity || 3, "fussy", "easy")}
      </div>
      <div class="srow sub">
        <span class="ic">🙂</span>
        <span class="lbl grow">Head movement check</span>
        ${num("livenessIntervalSec", c.livenessIntervalSec === undefined ? 10 : c.livenessIntervalSec, 0, 1800, "s", "How long you may sit perfectly still, in seconds")}
        ${swx("livenessEnabled", c.livenessEnabled === true, "cheat-live")}
      </div>
      <div class="srow sub deep" ${c.livenessEnabled === true ? "" : "hidden"}>
        <span class="ic">🎚️</span>
        <span class="lbl grow">Sensitivity</span>
        ${dial("moveSensitivity", c.moveSensitivity || 3, "strict", "easy")}
      </div>
      <div class="srow sub">
        <span class="ic">😉</span>
        <span class="lbl grow">Blink check</span>
        ${num("blinkIntervalSec", c.blinkIntervalSec === undefined ? 10 : c.blinkIntervalSec, 0, 600, "s", "Blink at least this often, in seconds")}
        ${swx("blinkRequired", !!c.blinkRequired, "cheat-blink")}
      </div>
      <div class="srow sub deep" ${c.blinkRequired ? "" : "hidden"}>
        <span class="ic">🎚️</span>
        <span class="lbl grow">Sensitivity</span>
        ${dial("blinkSensitivity", c.blinkSensitivity || 3, "clear", "faint")}
      </div>
      <!-- Last in the group, and the only row in this panel that is not a check: the four above
           decide whether a second counts, this decides how fast. Per-target is where it earns
           its keep — leaning into the camera makes sense on something you read, and makes no
           sense on a lecture you watch from across the room. -->
      <div class="srow sub">
        <span class="ic">🚀</span>
        <span class="lbl grow">Speed up the timer when I face the camera</span>
        <button class="pvbtn" type="button" data-pacepv="${p.id}" ${own ? "" : "disabled"}
                title="Open your camera here and watch the box while you set it"
                aria-label="Open the camera preview">👁 Preview</button>
        ${swx("paceEnabled", c.paceEnabled === true, "cheat-pace")}
      </div>
      <div class="srow sub deep" ${c.paceEnabled === true ? "" : "hidden"}>
        <span class="ic">🚀</span>
        <span class="lbl grow">Head fills the box</span>
        ${mult("paceFast", c.paceFast, "Timer speed while your head fills the focus box")}
      </div>
      <div class="srow sub deep" ${c.paceEnabled === true ? "" : "hidden"}>
        <span class="ic">🐢</span>
        <span class="lbl grow">Head outside the box</span>
        ${mult("paceSlow", c.paceSlow, "Timer speed while your head is outside the focus box")}
      </div>
      <div class="srow sub deep" ${c.paceEnabled === true ? "" : "hidden"}>
        <span class="ic">🔲</span>
        <span class="lbl grow">Focus box size</span>
        ${mult("paceBoxPct", c.paceBoxPct, "Focus box size, as a percentage of the picture")}
      </div>
      <!-- Same warning as the card in Setup, from the same number — see PACE_BOX_REACH. Past the
           reachable point you are never in the box, so the clock sits at the slow speed all
           session and the feature looks broken rather than strict. -->
      <div class="srow sub deep" data-pacewarn="${p.id}"
           ${c.paceEnabled === true && paceBoxWarnText(paceVal("paceBoxPct", c.paceBoxPct)) ? "" : "hidden"}>
        <span class="ic">⚠️</span>
        <span class="lbl grow hint">${paceBoxWarnText(paceVal("paceBoxPct", c.paceBoxPct))}</span>
      </div>
      ${grpEnd()}
      <!-- The phone, last. Not in a fold and not inside the anti-cheat template above it: it is the
           only setting in this panel that acts on another device rather than on this browser. -->
      ${phoneRowHtml(p, targetName(p) ? escHtml(targetName(p)) : "this site")}
      <div class="cheatpanel-bottom">
        <button type="button" class="cheat-expand-btn open" data-cheat="${p.id}"
                title="Collapse anti-cheating options"
                aria-label="Collapse anti-cheating options"
                aria-expanded="true">
          <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="18 15 12 9 6 15"></polyline></svg>
        </button>
      </div>
    </div>`;
}

function renderProductive(s) {
  const tc = document.getElementById("tabContent");
  const sites = (s.productiveSites || []).slice().sort((a,b)=>(a.order||0)-(b.order||0));
  const strict = inStrictWindow(s);
  // Appends, so it can share a tab with the "locked sites" half.
  tc.insertAdjacentHTML("beforeend", `
    <div class="card">
      <div class="chead">
        <span class="ctile step" aria-hidden="true">1</span>
        <div class="ctitle">
          <div class="crow">
      <h2>Earn time on study sites ${tip(`Everything you must finish today.<br/><br/><b>To add:</b> a <b>website</b> (<span class='kbd'>duolingo.com</span>), an <b>exact page</b> (<span class='kbd'>drive.google.com/file/d/ABC/view</span>), a <b>YouTube channel</b> (<span class='kbd'>@veritasium</span>), a <b>playlist link</b>, or a <b>file on this computer</b> (<span class='kbd'>D:\\notes\\physics.pdf</span> — press <b>🗂️</b> to pick one you already have open). Set the time and press <b>➕</b>.<br/><br/><b>Files on this computer:</b> open the file in Chrome and the time counts there too. Point at a <b>folder</b> instead and every file inside it counts. Chrome hides local files from extensions until you switch on <b>Allow access to file URLs</b> on FocusGate's extension page. Your own files are never blocked.<br/><br/><b>Whole site vs exact page:</b><br/>• <span class='kbd'>duolingo.com</span> → the whole site counts, including <span class='kbd'>/learn</span> and <span class='kbd'>/lesson</span>.<br/>• <span class='kbd'>duolingo.com/lesson</span> → only that page <i>and anything deeper</i> counts, and <b>the rest of that site is locked</b> until you're done (homepage, <span class='kbd'>/learn</span>, everything).<br/><br/><b>In the list:</b> drag <b>⋮⋮</b> to reorder · change <b>h / m / s</b> for the time · <b>↺</b> resets today · <b>✕</b> deletes.<br/><br/>Everything resets at <span class='kbd'>${s.dailyResetTime || "00:00"}</span> each day.${strict ? "<br/><br/><b style='color:#fca5a5'>Strict mode is on, so you can't delete work or shorten the time right now.</b>" : ""}`)}</h2>
          </div>
          ${/* The running count lives in the strip at the top of the page, so this
                line is free to say what the step is actually for. */
            tickerHtml(earnTickerText(s), "earn-ticker")}
        </div>
        ${/* Is this list a sequence or a set?
              In the header rather than in Settings, and as a segmented pair rather than a switch, for
              the same reason step 2's blocklist / allowlist control sits here: it does not change any
              individual row, it changes how the whole list underneath is READ. A rule about a list
              belongs on that list, where you can see what it is about to do.
              Two named halves instead of one toggle because neither half is the absence of the other.
              "Any order" is a real policy — the one every profile has had until now — and a lone
              unchecked switch would read as "sequence mode: broken/off" rather than as a choice.
              Not frozen by strict mode: switching it ON is a tightening, and setStateP already knows
              the direction, so the password gate stands in the way of switching it off and nothing
              stands in the way of switching it on. Greying the pair out would refuse the direction
              strict mode exists to allow. */""}
        <span class="seg" role="group" aria-label="How this list has to be done">
          <input type="radio" name="seqmode" id="seq-any" value="0" ${s.sequenceMode === true ? "" : "checked"}/>
          <label for="seq-any" data-testid="seq-any" title="Today's work in whatever order suits you. Every site on the list is open, and your blocked sites release once all of it is finished."><span class="sgi" aria-hidden="true">🔀</span>Any order</label>
          <input type="radio" name="seqmode" id="seq-on" value="1" ${s.sequenceMode === true ? "checked" : ""}/>
          <label for="seq-on" data-testid="seq-in-order" title="One step at a time, top to bottom. Only the step you are on is open — the rest of your study sites are blocked until you reach them, and each one shuts again once it is finished. Sites joined by OR count as one step, so either of them will do."><span class="sgi" aria-hidden="true">🔢</span>In order</label>
        </span>
      </div>
      ${s.sequenceMode === true ? `
      <!-- What the mode is actually doing right now, in one line, directly above the list it applies
           to. The control above says what was chosen; this says what follows from it, which on this
           card is a different sentence: the step being worked on depends on today's progress, and the
           progress is what the user came here to look at. -->
      <div class="seqnote" data-testid="seq-note">${(() => {
        const rows = todayRows(s);
        const total = FGSettings.stepCount(rows);
        const idx = FGSettings.currentStepIndex(rows);
        if (!total) return `In order — but nothing is set for today, so there is no sequence to walk. The list below is open.`;
        if (idx < 0) return `In order — every step is behind you. Today's list is finished, so nothing here is holding anything shut.`;
        const step = FGSettings.currentStepGroup(rows);
        const names = step.map(x => `<b>${escHtml(targetName(x))}</b>`);
        const which = names.length === 1 ? names[0]
          : names.slice(0, -1).join(", ") + " or " + names[names.length - 1];
        return `In order — you are on <b>step ${idx + 1} of ${total}</b>: ${which}.` +
               (names.length > 1 ? ` Either one will do; they are joined by OR.` : ``) +
               ` The other study sites below are blocked until you get to them.`;
      })()}</div>` : ""}

      <div class="addrow">
        <span class="gicon" aria-hidden="true">🌐</span>
        <input class="input grow" id="newUrl" placeholder="duolingo.com, khanacademy.org, D:\notes\physics.pdf" title="A site, one page, a @channel, a video link — or a file on this computer (D:\notes\physics.pdf). Add several at once by putting commas between them; paths go one per line. Each gets the time you set here." data-testid="add-productive-url"/>
        <!-- The topic, right beside the address, because that is the moment somebody knows it.
             Optional, and narrower than the address box so it reads as the second half of one
             thought rather than a second requirement. Every row added in this go gets it — see
             the #addBtn handler for why that differs from how the nickname behaves. -->
        <input class="input topic" id="newTopic" maxlength="300" spellcheck="false" autocomplete="off"
               placeholder="topic (optional)"
               title="What you actually mean to do on these sites, in your own words: &quot;class 12 physics — electrostatics&quot;.&#10;&#10;With Study topics switched on in Settings → General, an AI checks each page against this sentence and the clock only runs while you are on topic. You can change it per site afterwards.&#10;&#10;Leave it empty and the sites behave exactly as they always have."
               aria-label="Study topic for the sites being added" data-testid="add-productive-topic"/>
        <button class="btn round" id="addBtn" data-testid="add-productive-btn" title="Add it" aria-label="Add it">➕</button>
        <button class="btn round ghost" id="pickLocal" data-testid="pick-local-btn"
                title="Add a file or folder from this computer — pick it from your files, or from a tab you already have open."
                aria-label="Add a file from this computer">🗂️</button>
        <!-- The two real dialogs, driven by the buttons in the panel below. Hidden because a bare
             file input cannot be styled to match anything else on this page, and the multiple and
             webkitdirectory attributes are the only way to ask Chrome for a file and for a folder.
             NO BACKTICKS in this comment: it lives inside a template literal, and one would end
             the string here and leave the rest of this function as broken syntax. -->
        <input type="file" id="pickFiles" multiple style="display:none" data-testid="pick-files-input"/>
        <input type="file" id="pickDir" webkitdirectory style="display:none" data-testid="pick-dir-input"/>
        ${hmsWells(1800, u => `id="new${u.toUpperCase()}" data-testid="add-productive-${u === "h" ? "hours" : u === "m" ? "minutes" : "seconds"}"`, { plain: true })}
      </div>
      <div id="localPick"></div>
      <div id="fileAccessNote"></div>

      <div class="list" id="prodList">
        ${sites.length === 0 ? '<div class="emptyhint">Nothing here yet. Add your first site above.</div>' : ""}
        ${sites.map((p, idx) => {
          const connector = idx > 0 ? logicConnectorHtml(p, strict) : "";
          return connector + siteRowHtml(p, strict);
        }).join("")}
      </div>
    </div>`);

  // Sequence mode on or off. "In order" is the tightening — it takes away every choice about what to
  // open next — so it goes through without a password, and going back to "Any order" is the loosening
  // that asks and that strict mode refuses. setStateP knows the direction from the STRICTER table; all
  // this has to do is write the value and say what happened.
  document.querySelectorAll('input[name="seqmode"]').forEach(r => r.addEventListener("change", async () => {
    const want = r.value === "1";
    try {
      await setStateP({ sequenceMode: want });
    } catch (e) {
      renderApp();
      return;
    }
    // Read back before the re-render rather than out of lastState afterwards. renderApp is async, so
    // the sentence below would otherwise be describing whichever state happened to win the race.
    const st = await getState();
    renderApp();
    // Tabs already open on a later step have to be sent away, and tabs shut by a sequence that has just
    // been switched off have to be let back in. Both are the same question — re-ask the blocking about
    // every open tab — and the count is what proves it happened rather than leaving you to guess.
    chrome.runtime.sendMessage({ type: "refreshBlockedTabs" }, (res) => {
      void chrome.runtime.lastError;
      const n = (res && res.locked) || 0;
      if (!want) return toast("Any order — every study site on the list is open again.");
      const rows = todayRows(st);
      const total = FGSettings.stepCount(rows);
      const idx = FGSettings.currentStepIndex(rows);
      if (!total) return toast("In order — nothing is set for today, so there is no sequence yet. Add some work and the top row becomes step 1.");
      if (idx < 0) return toast("In order — today's list is already finished, so nothing is shut. It starts at the top tomorrow.");
      const step = FGSettings.currentStepGroup(rows);
      const which = step.map(x => targetName(x)).join(" or ");
      toast(`In order — <b>step ${idx + 1} of ${total}</b> is <b>${escHtml(which)}</b>. The rest of your study sites are shut until you get to them.` +
            (n ? ` ${n === 1 ? "1 tab was" : n + " tabs were"} sent away just now.` : ""));
    });
  }));

  // ---- files on this computer ----
  // 🗂️ lists the local files you already have open, because a path typed by hand
  // is easy to get wrong and Chrome won't tell us the path of a file you pick from
  // a dialog. Choosing one drops its address into the box above.
  const pickWrap = document.getElementById("localPick");
  const PICK_CARD = "margin:6px 0 0;padding:8px;display:flex;flex-direction:column;gap:6px";
  const PICK_ROW = "display:flex;align-items:center;gap:8px;text-align:left;justify-content:flex-start;width:100%";
  // The panel watches for a file being opened while it is up, so browsing to one and coming back
  // shows it straight away. Stopped on close, so nothing polls behind a shut panel.
  let pickPoll = 0, pickShown = "";
  function closePick() {
    clearInterval(pickPoll); pickPoll = 0; pickShown = "";
    if (pickWrap) pickWrap.innerHTML = "";
  }

  // ---- picking files from the computer ----
  // A real dialog, with one thing about it worth knowing: Chrome will not say where the file came
  // from. A single file arrives as "physics.pdf" and nothing else; a folder pick arrives as
  // "notes/physics/ch1.pdf", relative to the folder you chose. The drive is never included, by
  // design — a page is not allowed to learn your directory layout from a file you handed it.
  //
  // That tail is enough. A target's job is to recognise the tab you open later, and
  // "…/notes/physics/ch1.pdf" recognises it — see fileCovers in background.js, which matches a
  // tail on whole path segments. The cost is that two files with the same name in different
  // folders both count, which is why picking the FOLDER is offered beside picking the file: it
  // hands over more of the path and makes the target that much more specific.
  function pickedTail(f) {
    // webkitRelativePath is "<chosen folder>/…/file" for a folder pick and "" for a single file.
    const rel = String(f.webkitRelativePath || "").replace(/\\/g, "/").replace(/^\/+/, "");
    return rel || String(f.name || "");
  }
  // The chosen folder itself, so a folder pick becomes ONE target covering everything inside it
  // rather than a target per file. A course folder with four hundred pages in it should be one
  // line on this page.
  function pickedRoot(files) {
    for (const f of files) {
      const rel = String(f.webkitRelativePath || "").replace(/\\/g, "/").replace(/^\/+/, "");
      const top = rel.split("/").filter(Boolean)[0];
      if (top) return top;
    }
    return "";
  }
  // Each item is { path, file } — the tail Chrome gave us, and the File itself when there is one.
  // The File is what makes the row openable: its bytes are copied into FocusGate's own storage so
  // viewer.html can serve them back, because the path alone leads nowhere. A folder pick has no
  // single File to keep, so it passes { path } only and keeps the behaviour it always had.
  async function addLocalTargets(items) {
    const list = (items || []).filter(it => it && it.path);
    if (!list.length) return;
    const st = await getState();
    const cur = st.productiveSites || [];
    // The same time boxes the ➕ button reads, so a file is added exactly like a site.
    const secs = Math.max(0, (parseInt($("#newH")?.value, 10) || 0) * 3600 +
                             (parseInt($("#newM")?.value, 10) || 0) * 60 +
                             (parseInt($("#newS")?.value, 10) || 0));
    const label = ($("#newLabel")?.value || "").trim().slice(0, 60);
    // Compared on the same plain form the matcher uses, so "Notes/A.PDF" is not added beside
    // "notes/a.pdf".
    const flat = (v) => String(v || "").replace(/\\/g, "/").replace(/^\/+|\/+$/g, "").toLowerCase();
    const seen = new Set(cur.map(p => flat(p.path || p.url)));
    const add = [];
    let dupes = 0;
    let uncopied = 0;
    for (const it of list) {
      const path = it.path;
      const k = flat(path);
      if (!k || seen.has(k)) { dupes++; continue; }
      seen.add(k);
      const t = {
        id: uid(), type: "local_file", url: "", path,
        label: list.length === 1 ? label : "",
        requiredSec: secs, spentSec: 0, enabled: true, order: cur.length + add.length,
        operator: "AND"
      };
      // The copy is kept against the target's id, so the row's link is just "viewer.html?t=<id>".
      // A file too big to keep, or a browser that refuses the write, leaves `stored` unset — the
      // row then behaves exactly as it did before copies existed, which is the honest fallback.
      if (it.file && await fgFileSave(t.id, it.file)) t.stored = true;
      else if (it.file) uncopied++;
      // Chrome's file dialog never says where the file lives — not even the drive. Try to discover
      // the real path from download history or an open tab, so the link can go straight to the file.
      if (it.file && it.file.name && !looksLocalPath(t.path)) {
        const real = await discoverOriginalPath(it.file.name);
        if (real) { t.url = real; t.path = localPath(real); }
      }
      add.push(t);
    }
    if (!add.length) return toast(addedToast(0, dupes));
    await setStateP({ productiveSites: [...cur, ...add] });
    if ($("#newLabel")) $("#newLabel").value = "";
    closePick();
    renderApp();
    if (uncopied) {
      // Said out loud, because it changes what the row can do: without a copy there is no link to
      // click, and the file has to be opened by hand once before FocusGate knows where it is.
      toast(uncopied === 1 && add.length === 1
        ? "Added — too big for FocusGate to open directly, so open it once yourself"
        : `Added — ${uncopied} too big to open directly, open ${uncopied === 1 ? "it" : "them"} once yourself`);
    } else {
      toast(addedToast(add.length, dupes));
    }
    if (!(await fileAccessAllowed())) {
      showFileAccessAlert();
    }
  }
  // There used to be a "Browse in a tab…" button here, which opened Chrome's own directory listing
  // so you could click through to a file and have this panel read its full address off the tab.
  //
  // Gone, along with the browseFiles() that drove it. It was a third route to the same place as the
  // two dialogs above it, and the slowest of the three: open a listing, navigate a folder tree, come
  // back. What it uniquely gave — the drive letter, which Chrome withholds from a file dialog — is
  // still available two other ways the panel already mentions: Ctrl+O in any tab, or typing the path.
  //
  // The worker's end of it stays. browseLocal / browseForLocal / browseRootUrl are the blocked
  // page's "find it" button as well, and that one has no alternative: it is shown for a target whose
  // full address FocusGate never learned.

  function pickBody(urls, allowed) {
    const rows = urls.map(u => `<button class="btn ghost" data-pick="${escHtml(u)}" style="${PICK_ROW}" title="${escHtml(localDisplay(u))}">
           <span aria-hidden="true">🗂️</span>
           <b style="flex:0 0 auto">${escHtml(localName(u))}</b>
           <span style="opacity:.6;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escHtml(localDisplay(u))}</span>
         </button>`).join("");
    // The permission is the first thing that has to be right. Without it Chrome hides file://
    // pages from the extension entirely, so browsing would open a tab this panel could not see
    // and a target added by hand would never earn a second. Shortened to the instruction and the
    // button that carries it out — the consequences are in the "?" with everything else.
    const gate = allowed ? "" : `<div class="emptyhint" style="margin:0;border-color:#f59e0b;color:#fed7aa">
        <b>Chrome is hiding your files.</b> Turn on <b>Allow access to file URLs</b> first.
        <button class="btn sec" id="pickAllow" style="margin-top:6px" data-testid="pick-allow">Open that page</button>
      </div>`;
    // Three buttons and a heading, and everything else behind the "?".
    //
    // This panel used to explain itself in five paragraphs: what a local target is, a subtitle under
    // each button, and sixty words on drives and copies and why a folder matches better than a file.
    // All of it true, none of it needed at the moment you are trying to pick a file — and the effect
    // of putting it here was that the two buttons you actually came for were the smallest part of the
    // panel. The page already has one place for this kind of detail, which is the bubble every other
    // wordy thing in FocusGate lives in, so nothing has been deleted; it has been moved to where it
    // is read on purpose rather than skipped in a hurry.
    return `<div class="card" style="${PICK_CARD}">
        <div style="font-size:12px;opacity:.75">Add from this computer ${tip("A file or folder on this computer earns time <b>exactly like a website</b> — the same countdown card, the same camera and stillness checks.<br/><br/><b>Choose files…</b> keeps a copy inside FocusGate, which is what lets you open it later by clicking its row. Chrome never says which <i>drive</i> a picked file came from, so it is matched on its name and folder.<br/><br/><b>Choose a folder…</b> counts everything inside it, at any depth, and matches more exactly — Chrome gives away more of the path for a folder. There is no copy of a folder though, so it wants opening by hand once.<br/><br/>Want the <b>drive letter</b> too? Open the file with <span class='kbd'>Ctrl</span>+<span class='kbd'>O</span> in any tab and it appears in the list below, or type the path yourself — <span class='kbd'>D:\\notes\\physics.pdf</span> — straight into the box.")}</div>
        ${gate}
        <button class="btn" id="pickChooseFiles" style="${PICK_ROW}" data-testid="pick-choose-files">
          <span aria-hidden="true">📄</span><b>Choose files…</b>
        </button>
        <button class="btn" id="pickChooseDir" style="${PICK_ROW}" data-testid="pick-choose-dir">
          <span aria-hidden="true">📁</span><b>Choose a folder…</b>
        </button>
        <!-- Only when there is something to list. The line that used to stand here when there was
             nothing open said "Nothing open in a tab" and then three other things you could do
             instead — a heading for an empty list, doing the job of the "?" above. -->
        ${urls.length ? `<div style="font-size:12px;opacity:.75;margin-top:2px">Open in a tab now — click one to use its address:</div>${rows}` : ""}
      </div>`;
  }

  async function paintPick() {
    if (!pickWrap || !pickPoll) return;
    const [urls, allowed] = await Promise.all([localTabsOpen(), fileAccessAllowed()]);
    // Only redraw when something actually changed, or the poll would take the button out from
    // under the pointer twice a second.
    const sig = (allowed ? "1" : "0") + "|" + urls.join("|");
    if (sig === pickShown) return;
    pickShown = sig;
    pickWrap.innerHTML = pickBody(urls, allowed);
    // The buttons only open the dialogs; the inputs themselves carry the handlers, bound once
    // outside this function — rebinding them on every poll would fire a pick several times over.
    pickWrap.querySelector("#pickChooseFiles")?.addEventListener("click", () => {
      const el = document.getElementById("pickFiles");
      if (el) { el.value = ""; el.click(); }      // cleared, or choosing the same file twice is silent
    });
    pickWrap.querySelector("#pickChooseDir")?.addEventListener("click", () => {
      const el = document.getElementById("pickDir");
      if (el) { el.value = ""; el.click(); }
    });
    pickWrap.querySelector("#pickAllow")?.addEventListener("click", () => {
      try { chrome.tabs.create({ url: "chrome://extensions/?id=" + chrome.runtime.id }); } catch {}
    });
    pickWrap.querySelectorAll("[data-pick]").forEach(b => {
      b.addEventListener("click", () => {
        const box = document.getElementById("newUrl");
        if (box) { box.value = b.getAttribute("data-pick") || ""; box.focus(); }
        closePick();
        toast("Set a time, then press ➕");
      });
    });
  }

  async function openPick() {
    if (!pickWrap) return;
    if (pickPoll) return closePick();
    pickPoll = setInterval(() => { paintPick().catch(() => {}); }, 700);
    await paintPick();
  }
  document.getElementById("pickLocal")?.addEventListener("click", openPick);
  // Bound to the inputs, not to the buttons that open them, and bound here rather than inside
  // paintPick — the panel redraws itself while it is open, and a handler added on each redraw
  // would add the same files two or three times.
  document.getElementById("pickFiles")?.addEventListener("change", (e) => {
    const files = Array.from(e.target.files || []);
    // The File goes along with the tail, so FocusGate can keep a copy and give the row a link.
    addLocalTargets(files.map(f => ({ path: pickedTail(f), file: f }))).catch(() => {});
  });
  document.getElementById("pickDir")?.addEventListener("change", (e) => {
    const files = Array.from(e.target.files || []);
    // One target for the folder, not one per file inside it. A course folder can hold hundreds of
    // pages and every one of them would otherwise become its own line with its own countdown.
    //
    // No copy is kept for a folder: there is no single file to serve, and copying a whole course
    // would be gigabytes. So a folder target keeps its original behaviour — matched by path, opened
    // by hand once.
    const root = pickedRoot(files);
    addLocalTargets(root ? [{ path: root }]
                         : files.map(f => ({ path: pickedTail(f), file: f }))).catch(() => {});
  });

  // Chrome keeps file:// hidden from every extension until you allow it, and
  // without it a local target can be neither timed nor opened. Said plainly, and
  // only when it actually matters — you've added one.
  (async () => {
    const el = document.getElementById("fileAccessNote");
    if (!el) return;
    const hasLocal = (s.productiveSites || []).some(p => p.type === "local_file" || (p.url && p.url.startsWith("file:")) || (p.path && p.path.length > 0));
    if (!hasLocal || await fileAccessAllowed()) { el.innerHTML = ""; return; }
    el.innerHTML = `<div class="card" style="margin:6px 0 0;padding:12px;background:linear-gradient(135deg,#7f1d1d,#450a0a);border:1.5px solid #ef4444;box-shadow:0 4px 18px rgba(239,68,68,0.25)">
        <div style="display:flex;gap:10px;align-items:flex-start">
          <div style="font-size:22px">⚠️</div>
          <div style="flex:1">
            <div style="font-weight:800;color:#fca5a5;font-size:13.5px">Let FocusGate see your local files</div>
            <div style="font-size:12px;color:#fecaca;margin-top:4px;line-height:1.5">Chrome hides <span class="kbd" style="background:#1e293b;border-color:#475569;color:#fca5a5">file:///</span> pages from extensions by default, so your local file won't earn any time yet. Turn on <b>Allow access to file URLs</b> on FocusGate's extension page.</div>
            <!-- The drawing folds out of the warning rather than sitting in it. This banner is on
                 screen for as long as the permission is off, which can be a long time on a profile
                 that has one local file and does not care — and a picture that large, permanently,
                 would push the list it belongs to off the screen. Open it when you are about to act.
                 Shown by default the first time this banner appears in a page's life: somebody
                 meeting it for the first time should not have to discover that there is help. -->
            <details id="faHow" style="margin-top:8px" open>
              <summary style="cursor:pointer;font-size:11.5px;color:#fca5a5;font-weight:700;list-style:none">Show me exactly where &#9662;</summary>
              <div style="margin-top:8px;padding:10px;background:#0b1020;border:1px solid #7f1d1d;border-radius:10px;max-width:420px">
                ${FGSettings.fileAccessGuideSvg()}
              </div>
            </details>
            <button class="btn danger" id="openExtPage" style="margin-top:8px;background:#dc2626;border-color:#ef4444" data-testid="open-ext-page">Open extension page</button>
          </div>
        </div>
      </div>`;
    document.getElementById("openExtPage")?.addEventListener("click", () => {
      try { chrome.tabs.create({ url: "chrome://extensions/?id=" + chrome.runtime.id }); } catch {}
    });
  })();

  $("#addBtn").addEventListener("click", async () => {
    // One or many: "duolingo.com, khanacademy.org" adds both, each with the time
    // typed beside the box. A path on this computer is one entry per line, since a
    // path can hold commas of its own.
    const raws = splitTargets($("#newUrl").value);
    const h = parseInt($("#newH").value, 10) || 0;
    const m = parseInt($("#newM").value, 10) || 0;
    const sec = parseInt($("#newS").value, 10) || 0;
    const requiredSec = h * 3600 + m * 60 + sec;
    const label = ($("#newLabel")?.value || "").trim();
    // A topic typed alongside the address applies to everything in this add, unlike the nickname above.
    //
    // The two are different in kind and that is why they are treated differently: a nickname names ONE
    // row, so sharing it across three would be three rows called the same thing. A topic is a subject,
    // and "khanacademy.org, brilliant.org — both for linear algebra" is exactly the thing somebody means
    // when they paste two addresses and type one topic.
    const topic = ($("#newTopic")?.value || "").trim().slice(0, 300);
    if (!raws.length) return toast("Type a site first");
    if (requiredSec < 0) return toast("Set a valid time");
    const cur = (await getState()).productiveSites || [];
    // A nickname can only belong to one row, so it is only used for a single add.
    const useLabel = raws.length === 1 ? label : "";
    // A local file is remembered by both its address and its plain path, so the
    // same file typed the other way round is still recognised as already there.
    const seen = new Set(cur.flatMap(p => [String(p.url || "").toLowerCase(),
                                           String(p.path || "").toLowerCase()]).filter(Boolean));
    const items = [];
    const bad = [];
    let dupes = 0;
    raws.forEach(raw => {
      const det = detectType(raw);
      const key = String(det.url || det.channelId || det.playlistId || "").toLowerCase();
      const pathKey = String(det.path || "").toLowerCase();
      // No key means normSite turned it away as not being a host name. Named rather than
      // dropped, for the same reason as in the two lists below: a target that silently
      // fails to be added is indistinguishable from one that was added and earns nothing.
      if (!key) { bad.push(raw); return; }
      if (seen.has(key) || (pathKey && seen.has(pathKey))) { dupes++; return; }   // already in the list, or twice in the paste
      seen.add(key);
      if (pathKey) seen.add(pathKey);
      items.push({ id: uid(), ...det, label: useLabel, topic, requiredSec, spentSec: 0, order: cur.length + items.length, operator: "AND" });
    });
    if (bad.length) {
      const shown = bad.slice(0, 3).map(b => `"${b}"`).join(", ");
      const more = bad.length > 3 ? ` and ${bad.length - 3} more` : "";
      toast(`${shown}${more} ${bad.length === 1 ? "isn't" : "aren't"} a site or a file — try something like duolingo.com`);
      if (!items.length) return;
    }
    if (!items.length) return toast(addedToast(0, dupes));
    await setStateP({ productiveSites: [...cur, ...items] });
    if ($("#newTopic")) $("#newTopic").value = "";
    renderApp();
    chrome.runtime.sendMessage({ type: "refreshBlockedTabs" });
    // A local file that Chrome is still hiding from us would silently earn nothing,
    // so that's said here as well as in the note the list now shows.
    if (items.some(i => i.type === "local_file" || (i.url && i.url.startsWith("file:")) || (i.path && looksLocalPath(i.path))) && !(await fileAccessAllowed())) {
      showFileAccessAlert();
      return toast("Added — allow access to file URLs to enable tracking");
    }
    toast(addedToast(items.length, dupes));
  });

  // edit time (h/m/s). In strict mode, disallow decreasing total required time.
  function readItemSec(id) {
    const gv = (sel) => parseInt((document.querySelector(sel) || {}).value, 10) || 0;
    return gv(`[data-edit-h="${id}"]`) * 3600 + gv(`[data-edit-m="${id}"]`) * 60 + gv(`[data-edit-s="${id}"]`);
  }
  // `mid` marks the half-second-after-a-keystroke save. On the way from 30 to 60 the minutes box
  // holds 6 for a moment, which is a real cut to the goal — so pausing mid-number would put a
  // password prompt in front of a value you had not finished typing. Both gates get their say,
  // but when you leave the box or press Enter. Same rule as autoNum in Setup.
  async function saveItemTime(id, quiet, mid) {
    // 0 is a real answer: it means "this doesn't count today". Blank boxes have
    // already become 0 by the time we read.
    let secVal = Math.max(0, readItemSec(id));
    // Saving is also when the boxes get tidied: "01" becomes 1, and 90 seconds
    // becomes 1m 30s. It happens half a second after you stop typing, so it reads
    // as the row settling rather than something fighting your keystrokes.
    writeHMS(secVal,
             document.querySelector(`[data-edit-h="${id}"]`),
             document.querySelector(`[data-edit-m="${id}"]`),
             document.querySelector(`[data-edit-s="${id}"]`));
    const st = await getState();
    const prev = (st.productiveSites || []).find(p => p.id === id);
    const prevSec = prev ? (prev.requiredSec || 0) : 0;
    if (secVal === prevSec) return;
    // No strict-mode check here any more, and no password check either. Both live in setStateP,
    // which reads the direction off the stored value — this handler used to carry a
    // hand-written `secVal < prevSec`, which was right, but it was also the only one on the page
    // that was. Every other row was blanket-refused in both directions.
    //
    // A refused write throws, so the toasts and the ticker refresh below do not run.
    //
    // A goal raised past its window takes the window with it, in the same write: the window always has to
    // be longer than the goal, so its END moves out to the shortest window the new goal fits in. The gate
    // reads that stretch as part of the raise rather than as a loosening — see targetsReason.
    let fitEnd = "";
    const next = (st.productiveSites || []).map(p => {
      if (p.id !== id) return p;
      const r = { ...p, requiredSec: secVal };
      if (FGSettings.hasWindow(r)) {
        fitEnd = FGSettings.fitWindowEnd(r);
        if (fitEnd) r.winEnd = fitEnd;
      }
      return r;
    });
    if (mid && FGSettings.changeDir("productiveSites", next, st.productiveSites) !== "") return;
    await setStateP({ productiveSites: next });
    if (fitEnd) {
      // The window boxes are in the folded panel and have to show the new end, so this one redraws.
      chrome.runtime.sendMessage({ type: "refreshBlockedTabs" });
      renderApp();
      toast(`⏰ ${targetName(prev)}'s window now closes at ${FGSettings.clock12(fitEnd)}, so the ` +
            `${fmtDur(secVal)} goal still fits inside it.`, { cls: "wide", ms: 6000 });
      return;
    }
    // The crawl under each heading quotes this total, so rewrite it now instead
    // of waiting for a re-render — which would take the focus out of this box.
    refreshTickers();
    // A row set to 0 stops counting as work, which changes what should be
    // locked, so the open tabs get re-checked.
    if ((secVal <= 0) !== (prevSec <= 0)) chrome.runtime.sendMessage({ type: "refreshBlockedTabs" });
    if (!quiet) toast(secVal <= 0 ? "Set to 0s — completed ✓" : "Updated");
  }
  // ---- the topic: what you actually meant to do on this site ----
  //
  // Saved on LEAVING the box or on Enter, and deliberately never half a second after a keystroke like
  // the time boxes above. Changing a topic is a loosening — see targetsReason — so it can raise a
  // password dialog, and a debounced writer would put that dialog in front of a sentence you were
  // halfway through typing. There is no equivalent of `mid` here that would help, because there is no
  // direction to read off a partial sentence: "class 12 phys" is not a smaller version of "class 12
  // physics", it is a different topic that happens to be a prefix.
  async function saveTopic(id, inp) {
    if (!inp) return;
    const val = String(inp.value || "").trim().slice(0, 300);
    const st = await getState();
    const prev = (st.productiveSites || []).find(p => p.id === id);
    if (!prev) return;
    const was = String(prev.topic || "").trim();
    if (val === was) return;                  // nothing changed; do not ask for a password
    const next = (st.productiveSites || []).map(p => p.id === id ? { ...p, topic: val } : p);
    try {
      await setStateP({ productiveSites: next });
    } catch (e) {
      // Refused — a strict window, or the password was not given. Put the box back to what is stored, so
      // the row never shows a promise that was not accepted.
      inp.value = was;
      return;
    }
    // A topic can decide whether a page is blocked (with the strict half switched on), so the tabs you
    // already have open are re-checked rather than left until the next minute tick.
    chrome.runtime.sendMessage({ type: "refreshBlockedTabs" });
    // Re-rendered because the row's own appearance follows this: `has-topic` marks a row that carries one.
    renderApp();
    toast(val ? `Topic set: "${val.length > 40 ? val.slice(0, 40) + "…" : val}"` : "Topic cleared");
  }
  document.querySelectorAll("[data-topic]").forEach(inp => {
    const id = inp.getAttribute("data-topic");
    inp.addEventListener("change", () => saveTopic(id, inp));
    inp.addEventListener("blur", () => saveTopic(id, inp));
    inp.addEventListener("keydown", (e) => {
      if (e.key === "Escape") { inp.blur(); return; }
      if (e.key !== "Enter" || e.isComposing) return;
      e.preventDefault();
      saveTopic(id, inp);
      inp.blur();
    });
  });

  // This row's own switch for the topic check.
  //
  // Switching it OFF is a loosening — every off-topic page on that site starts earning again — so
  // setStateP will ask for the password and refuse it inside a strict window, exactly as it does for
  // deleting the sentence. That is the point of it being judged there rather than here: the switch must
  // not be the free way to do what the box charges for.
  document.querySelectorAll("[data-topicsw]").forEach(box => box.addEventListener("change", async () => {
    const id = box.getAttribute("data-topicsw");
    const want = !!box.checked;
    const st = await getState();
    const row = (st.productiveSites || []).find(p => p.id === id);
    if (!row) return;
    if ((row.topicCheck !== false) === want) return;          // already there; nothing to write
    const next = (st.productiveSites || []).map(p => p.id === id ? { ...p, topicCheck: want } : p);
    try {
      await setStateP({ productiveSites: next });
    } catch (e) {
      box.checked = row.topicCheck !== false;                 // refused: put the switch back
      return;
    }
    // A topic can decide whether a page is blocked, so the tabs already open are re-checked rather than
    // left until the next minute tick — switching the check off is most often done because of a page you
    // want back right now.
    chrome.runtime.sendMessage({ type: "refreshBlockedTabs" });
    renderApp();
    const nm = targetName(row);
    toast(want ? `${nm} is checked against its topic again` : `${nm} isn't checked against its topic`);
  }));

  // This row's own switch for the phone.
  //
  // Switching it OFF is a loosening — it takes a goal off the list the phone is waiting for, which can
  // release the phone immediately — so it goes through setStateP and is judged there: the password is
  // asked for, and a strict window refuses it. Switching it back ON is a tightening and goes through.
  // The same rule as the topic switch above, and for the same reason: a switch must not be the free way
  // to do what the thing it governs charges for.
  document.querySelectorAll("[data-whsw]").forEach(box => box.addEventListener("change", async () => {
    const id = box.getAttribute("data-whsw");
    const want = !!box.checked;
    const st = await getState();
    const row = (st.productiveSites || []).find(p => p.id === id);
    if (!row) return;
    if ((row.webhookOn !== false) === want) return;           // already there; nothing to write
    const next = (st.productiveSites || []).map(p => p.id === id ? { ...p, webhookOn: want } : p);
    try {
      await setStateP({ productiveSites: next });
    } catch (e) {
      box.checked = row.webhookOn !== false;                  // refused: put the switch back
      return;
    }
    // Forced, not the ordinary sync. This changes WHICH goals the phone is waiting for, and the
    // reconciler compares against `mobileLockSent` — so dropping the last unfinished row out of the
    // set leaves the desired state identical to the last thing sent and the phone stays locked on a
    // rule that no longer exists. A forced push recomputes and sends regardless.
    chrome.runtime.sendMessage({ type: "macrodroidSync" });
    renderApp();
    const nm = targetName(row);
    if (want) {
      toast(`📱 Your phone now waits for ${nm}. Make sure your mobile phone has internet connectivity.`,
            { cls: "wide phone", ms: 5500 });
    } else {
      toast(`📱 Your phone no longer waits for ${nm} — it still earns time and still unlocks your sites.`,
            { cls: "wide", ms: 5000 });
    }
  }));

  // ---- this row's deadlines: the window, and the stopwatch ----
  //
  // One writer for every control in the Site rules fold — both of the window's boxes, its switch, the
  // stopwatch's switch and its minutes — because they are all the same kind of decision and all have to
  // be judged the same way. Tightening one (switching a deadline on, shortening it, taking grace away)
  // goes through during a strict window; loosening one (switching it off, lengthening it, adding grace)
  // asks for the password. setStateP makes that call from the patch — see targetsReason.
  //
  // Named for the rule rather than for the window now that it writes two of them. The extra work it does
  // after the write is what makes it worth sharing: a deadline decides whether a finished row unlocks
  // anything, so the tabs already open have to be re-checked and the phone re-pushed, and every one of
  // these controls needs both.
  async function saveRowRule(id, patch) {
    const st = await getState();
    const row = (st.productiveSites || []).find(p => p.id === id);
    if (!row) return false;
    const next = (st.productiveSites || []).map(p => p.id === id ? { ...p, ...patch } : p);
    try {
      await setStateP({ productiveSites: next });
    } catch (e) {
      renderApp();                            // refused: put every control back to what is stored
      return false;
    }
    // A deadline decides whether a finished row unlocks anything, so the tabs you already have open
    // are re-checked rather than left until the next minute tick — and the phone is re-pushed for the
    // same reason, forced, because the desired state can change without `mobileLockSent` changing.
    chrome.runtime.sendMessage({ type: "refreshBlockedTabs" });
    chrome.runtime.sendMessage({ type: "macrodroidSync" });
    renderApp();
    return true;
  }
  document.querySelectorAll("[data-winsw]").forEach(box => box.addEventListener("change", async () => {
    const id = box.getAttribute("data-winsw");
    const want = !!box.checked;
    const st = await getState();
    const row = (st.productiveSites || []).find(p => p.id === id);
    if (!row) return;
    if ((row.winEnabled === true) === want) return;           // already there; nothing to write
    // The two times are SEEDED here when they are missing, in the same write as the switch.
    //
    // Without this the feature could be switched on and do nothing at all, silently: the schema's
    // defaults are only applied to rows arriving from a file, so every row already in storage has no
    // winStart and no winEnd — and `hasWindow` reads an absent time as "no window", so the deadline
    // never applied however the switch looked. One write, so the row can never be half-configured.
    const patch = { winEnabled: want };
    const ok = (v) => /^\d{1,2}:\d{2}$/.test(String(v || ""));
    if (want) {
      if (!ok(row.winStart)) patch.winStart = "06:00";
      if (!ok(row.winEnd)) patch.winEnd = "09:00";
      // Both ends equal can never be satisfied, so a row that somehow arrived that way is repaired
      // rather than switched on into a state that blocks for ever.
      const a = patch.winStart || row.winStart, b = patch.winEnd || row.winEnd;
      if (a === b) { patch.winStart = "06:00"; patch.winEnd = "09:00"; }
      // And long enough to finish the goal in — the same rule the time boxes keep. A goal of nearly a
      // whole day fits no window at all, so the switch stays off rather than arming one that blocks for ever.
      if (FGSettings.windowMinFor(row.requiredSec) > FGSettings.winMaxMin()) {
        box.checked = false;
        toast(`⏰ A ${fmtDur(row.requiredSec || 0)} goal is too long to fit inside a time window.`, { ms: 4500 });
        return;
      }
      const fitEnd = FGSettings.fitWindowEnd(
        { winStart: patch.winStart || row.winStart, winEnd: patch.winEnd || row.winEnd }, row.requiredSec);
      if (fitEnd) patch.winEnd = fitEnd;
    }
    if (!(await saveRowRule(id, patch))) return;
    const nm = targetName(row);
    if (want) {
      const from = FGSettings.clock12(patch.winStart || row.winStart);
      const to = FGSettings.clock12(patch.winEnd || row.winEnd);
      toast(`⏰ ${nm} must now be finished between ${from} and ${to} to unlock anything. Change the hours just below.`,
            { cls: "wide", ms: 6000 });
    } else {
      toast(`⏰ ${nm} has no deadline now — finish it whenever.`, { cls: "wide", ms: 4000 });
    }
  }));
  // ---- the stopwatch: the switch ----
  //
  // Seeds the grace time in the same write, for the reason the window's switch seeds its two times: the
  // schema's default only applies to rows arriving from a file, so every row already in storage has no
  // graceSec at all — and a limit of "the goal plus nothing" is a row that fails the moment you pause
  // for anything. One write, so the row can never be half-configured.
  //
  // graceFrom is deliberately NOT touched here. Switching the limit on mid-session starts it the next
  // time the page ticks, which is a second away; seeding it here would be this page guessing at a
  // measurement, and guessing it EARLIER than the truth would hand back allowance nobody had spent.
  document.querySelectorAll("[data-gracesw]").forEach(box => box.addEventListener("change", async () => {
    const id = box.getAttribute("data-gracesw");
    const want = !!box.checked;
    const st = await getState();
    const row = (st.productiveSites || []).find(p => p.id === id);
    if (!row) return;
    if ((row.graceEnabled === true) === want) return;          // already there; nothing to write
    const patch = { graceEnabled: want };
    if (want && !Number.isFinite(Number(row.graceSec))) patch.graceSec = 600;
    if (!(await saveRowRule(id, patch))) return;
    const nm = targetName(row);
    if (want) {
      const grace = Number.isFinite(Number(row.graceSec)) ? Number(row.graceSec) : 600;
      const total = (row.requiredSec || 0) + grace;
      toast((row.requiredSec || 0) > 0
        ? `⏳ ${nm} must now be finished within ${fmtDur(total)} of opening it — its ${fmtDur(row.requiredSec || 0)} goal plus ${fmtDur(grace)} of grace. Change the grace just below.`
        : `⏳ ${nm} has a time limit now, but no goal to be late for. Give it some time above and the limit starts working.`,
        { cls: "wide", ms: 6000 });
    } else {
      toast(`⏳ ${nm} has no time limit now — take as long as you like.`, { cls: "wide", ms: 4000 });
    }
  }));
  // ---- the stopwatch: how much grace ----
  //
  // Committed on change, Enter or leaving the box, and deliberately NOT debounced while typing like the
  // h/m/s boxes above it are. Those save as you type because raising a goal is a tightening and goes
  // through unasked; this one is the other way round — ADDING grace is the loosening — so a save per
  // keystroke would put a password sheet in front of the "1" of "10" and take the box away mid-edit.
  document.querySelectorAll("[data-gracemin]").forEach(inp => {
    const id = inp.getAttribute("data-gracemin");
    const save = async () => {
      const mins = Math.max(0, Math.min(720, Math.round(Number(inp.value) || 0)));
      const st = await getState();
      const row = (st.productiveSites || []).find(p => p.id === id);
      if (!row) return;
      const was = Number.isFinite(Number(row.graceSec)) ? Number(row.graceSec) : 600;
      if (mins * 60 === was) { inp.value = String(Math.round(was / 60)); return; }   // clamped back
      if (!(await saveRowRule(id, { graceSec: mins * 60 }))) return;
      toast(mins > 0
        ? `⏳ ${targetName(row)}: ${fmtDur(mins * 60)} of grace on top of the goal.`
        : `⏳ ${targetName(row)}: no grace at all — exactly the goal and not a second more.`,
        { ms: 4000 });
    };
    inp.addEventListener("change", save);
    inp.addEventListener("keydown", (e) => {
      if (e.key !== "Enter" || e.isComposing) return;
      e.preventDefault();
      inp.blur();                                   // blur fires change, which saves
    });
  });
  // ---- the deadline's four boxes: one edit, saved when you leave the row ----
  //
  // The commit scope is the whole ROW, not a box and not a field, and that is the requirement rather
  // than an optimisation: "I'll set both hours and minutes and then tap anywhere outside, and it
  // should save." So moving between the four boxes — hour to minute, from to to, by click or by Tab —
  // writes nothing at all. Only focus landing somewhere outside this row ends the edit.
  //
  // Why it has to be that wide. Every write goes through setStateP, and lengthening a window is a
  // loosening that asks for the password. Committing per box would mean up to four writes and four
  // chances of a password sheet opening on top of a half-finished time, each one rebuilding the page
  // and taking away the box still being typed in. One edit, one write, one question.
  //
  // `relatedTarget` is what makes "leaving the row" answerable: on focusout it is the element about to
  // receive focus, so a null or outside target means the edit is over, and anything inside the row
  // means it is still going on. Clicking dead space gives null, which counts as leaving — that is the
  // "tap anywhere outside" case, and it is the common one.
  document.querySelectorAll("[data-winrow]").forEach(rowEl => {
    const id = rowEl.getAttribute("data-winrow");
    const boxes = Array.from(rowEl.querySelectorAll("[data-win]"));
    if (!boxes.length) return;
    const aps = Array.from(rowEl.querySelectorAll("[data-winap]"));
    const box = (which) => boxes.find(b => b.getAttribute("data-win") === `${id}:${which}`);
    const apOf = (which) => aps.find(b => b.getAttribute("data-winap") === `${id}:${which}`);
    // Everything on this row that a person can change, as one string.
    //
    // The am/pm buttons are in here and that is not decoration: flipping am to pm is a twelve-hour move
    // and nothing else about the row changes when you do it. Left out — as it was when the boxes held
    // the whole 24-hour time — the row would have compared equal to what was drawn and refused to save
    // the one edit the button exists to make.
    const sig = () => boxes.map(b => b.value)
      .concat(aps.map(b => b.getAttribute("data-ap") || "")).join("|");
    // What was on screen when this row was drawn, which is what is stored. An edit is told from a
    // stray click through the row by comparing against it: an untouched row must not write, because
    // even a no-op write can raise the password sheet.
    const rendered = sig();
    const readAt = (which) => {
      const el = box(which), ap = apOf(which);
      return win24(winNorm(el ? el.value : ""), ap ? ap.getAttribute("data-ap") : "am");
    };
    let busy = false;

    async function commit() {
      if (busy) return;
      if (sig() === rendered) return;                    // nothing touched
      busy = true;
      try {
        const from = readAt("start");
        let to = readAt("end");
        // Both ends the same is a window of zero length — never satisfiable — so it is refused here
        // rather than stored and then quietly ignored by hasWindow. Safe to re-render: the edit is
        // over by the time this runs.
        if (from === to) {
          toast("A window needs two different times", { ms: 3000 });
          renderApp();
          return;
        }
        const st = await getState();
        const row = (st.productiveSites || []).find(p => p.id === id);
        if (!row) return;
        // Long enough to finish the goal in, always. A window shorter than the goal — or exactly as long —
        // could never be met, so the END is moved out to the shortest one that fits: an end set too close
        // to the start is pushed back out, and a start moved too close to the end carries the end along.
        // See fitWindowEnd.
        const fitEnd = FGSettings.fitWindowEnd({ winStart: from, winEnd: to }, row.requiredSec);
        if (fitEnd) to = fitEnd;
        const sayFit = () => {
          if (!fitEnd) return;
          const goal = Number(row.requiredSec) || 0;
          toast(`⏰ The window has to be longer than ${targetName(row)}'s ${fmtDur(goal)} goal — at least ` +
                `${fmtDur(FGSettings.windowMinFor(goal) * 60)} — so it now closes at ${FGSettings.clock12(to)}.`,
                { cls: "wide", ms: 6500 });
        };
        // Only what actually moved. Sending both every time would look like a bigger change than it
        // was to the gate that judges whether this is a loosening.
        const patch = {};
        if (from !== row.winStart) patch.winStart = from;
        if (to !== row.winEnd) patch.winEnd = to;
        if (!Object.keys(patch).length) { sayFit(); renderApp(); return; }   // clamped back to what was stored
        if (await saveRowRule(id, patch)) sayFit();
      } finally {
        busy = false;
      }
    }

    // Leaving the row is the commit. Deferred by a task because focusout fires BEFORE focus lands, so
    // relatedTarget is consulted, but a click that moves focus within the row can still be in flight —
    // and because committing re-renders, doing it synchronously inside focusout would pull the DOM out
    // from under the click that caused it.
    let dialOpen = false;
    rowEl.addEventListener("focusout", (e) => {
      const to = e.relatedTarget;
      if (to && rowEl.contains(to)) return;                  // still inside: the edit continues
      setTimeout(() => {
        // The clock sheet lives on <body>, so opening it takes focus out of the row and would otherwise
        // read as "the edit is over" — committing and rebuilding the page under the open dial, leaving
        // it pointing at boxes that no longer exist.
        if (dialOpen) return;
        if (rowEl.contains(document.activeElement)) return;  // focus came back within the row
        commit();
      }, 0);
    });

    // ---- the arrows ----
    // They put focus in the BOX rather than on themselves. Two reasons, and the second is the one that
    // matters: you can carry on typing after nudging, and — since nothing here writes until focus
    // leaves the row — focus has to be somewhere inside the row for the edit to be saved at all. An
    // arrow that quietly kept focus outside would change the numbers and never store them.
    rowEl.querySelectorAll("[data-winstep]").forEach(btn => {
      const spec = btn.getAttribute("data-winstep").split(":");   // id : which : delta
      const target = box(spec[1]);
      const delta = Number(spec[2]) || 0;
      if (!target || !delta) return;
      btn.addEventListener("mousedown", (e) => e.preventDefault());   // don't take the focus
      btn.addEventListener("click", () => {
        // Focus FIRST, then step. Focusing runs the page's select-all-on-focus, and winBump puts the
        // caret back in the half it just changed — so pressing the same arrow again keeps working on
        // that half instead of jumping to the hour because everything was selected.
        target.focus();
        winBump(target, delta, apOf(spec[1]));
      });
    });

    // ---- am / pm ----
    // A two-state button rather than a dropdown of two things. Keeps focus in the row, like the arrows,
    // so the edit is still saved by leaving the row and nothing writes on the flip itself.
    aps.forEach(btn => {
      btn.addEventListener("mousedown", (e) => e.preventDefault());
      btn.addEventListener("click", () => {
        winSetAp(btn, (btn.getAttribute("data-ap") || "am") === "am" ? "pm" : "am");
        const el = box(btn.getAttribute("data-winap").split(":")[1]);
        if (el) el.focus();
      });
    });

    // ---- the round clock ----
    rowEl.querySelectorAll("[data-winclock]").forEach(btn => {
      const which = btn.getAttribute("data-winclock").split(":")[1];   // "start" or "end"
      const el = box(which), ap = apOf(which);
      if (!el) return;
      btn.addEventListener("click", async () => {
        dialOpen = true;
        let picked = null;
        try {
          // The dial talks 24-hour, like storage, and does its own am/pm on the face.
          picked = await openWinDial({
            title: which === "start" ? "Window opens at" : "Window closes at",
            value: win24(winNorm(el.value), ap ? ap.getAttribute("data-ap") : "am")
          });
        } finally {
          dialOpen = false;
        }
        if (!picked) { btn.focus(); return; }               // dismissed: nothing changed, nothing saved
        const shown = win12(picked);
        el.value = shown.hh + ":" + shown.mm;
        if (ap) winSetAp(ap, shown.ap);
        // "Set" means set, so this does not wait for you to click away. Straight to the row's own
        // writer, which is still the only thing that writes — same validation, same single patch.
        await commit();
      });
    });

    boxes.forEach(b => {
      // The typing mask: digits only, the colon put in and kept in the right place, and the caret moved
      // with it. Letters never reach the value at all, so there is nothing to validate later.
      b.addEventListener("input", () => {
        const r = winMask(b.value, b.selectionStart);
        if (r.value === b.value) return;                   // nothing to rewrite, so the caret is left alone
        b.value = r.value;
        try { b.setSelectionRange(r.caret, r.caret); } catch {}
      });
      b.addEventListener("keydown", (e) => {
        if (e.isComposing) return;
        // Enter means done. Blurring the box ends the row's edit, so the focusout above commits it.
        if (e.key === "Enter") { e.preventDefault(); b.blur(); return; }
        // Escape abandons the whole row: both boxes AND both am/pm buttons go back to what was drawn,
        // so the commit sees nothing changed and stays quiet. The order matches sig() — boxes first,
        // then the am/pm states.
        if (e.key === "Escape") {
          e.preventDefault();
          const was = rendered.split("|");
          boxes.forEach((x, i) => { x.value = was[i]; });
          aps.forEach((x, i) => winSetAp(x, was[boxes.length + i]));
          b.blur();
          return;
        }
        // Up and down step whichever half the caret is in, carrying am/pm with them.
        if (e.key === "ArrowUp" || e.key === "ArrowDown") {
          e.preventDefault();
          winBump(b, e.key === "ArrowUp" ? 1 : -1, apOf(b.getAttribute("data-win").split(":")[1]));
        }
      });
      // Filled out as soon as you leave the box, so "6" reads as "06:00" straight away rather than only
      // after the row is saved and redrawn. Purely cosmetic: it writes nothing.
      b.addEventListener("blur", () => { b.value = winNorm(b.value); });
    });
  });

  let rowTimer = 0;
  document.querySelectorAll('[data-edit-h],[data-edit-m],[data-edit-s]').forEach(inp => {
    const id = inp.getAttribute("data-edit-h") || inp.getAttribute("data-edit-m") || inp.getAttribute("data-edit-s");
    // While typing: save quietly half a second after you stop, so the sentence
    // above follows the number straight away.
    inp.addEventListener("input", () => {
      clearTimeout(rowTimer);
      rowTimer = setTimeout(() => saveItemTime(id, true, true), 500);
    });
    inp.addEventListener("change", () => { clearTimeout(rowTimer); saveItemTime(id); });
    inp.addEventListener("keydown", (e) => {
      if (e.key !== "Enter" || e.isComposing) return;
      e.preventDefault(); clearTimeout(rowTimer); saveItemTime(id); inp.blur();
    });
  });
  // delete + reset. Neither carries its own strict-mode check now: removing work is a loosening
  // and setStateP refuses it while strict mode holds, while starting a row over only ever costs
  // you progress, so it is allowed — it used to be refused, which meant a strict window also
  // stopped you throwing away an afternoon you had already earned.
  document.querySelectorAll('button[data-del]').forEach(b => b.addEventListener("click", async () => {
    const st = await getState();
    const id = b.getAttribute("data-del");
    const cur = st.productiveSites || [];
    const gone = cur.find(p => p && p.id === id);
    await setStateP({ productiveSites: cur.filter(p=>p.id!==id) });
    // The row is gone, so FocusGate's copy of its file goes too — it exists only to be opened from
    // that row. Awaited, so a file the user just removed is not still sitting in storage when this
    // returns. (The background sweeps for strays as well; this is the immediate one.)
    if (gone && gone.stored) { try { await fgFileDrop(id); } catch {} }
    // Taking work off the list changes what should be locked, so the open tabs are
    // re-checked at once — including any sitting on the blocked screen.
    chrome.runtime.sendMessage({ type: "refreshBlockedTabs" });
    renderApp();
  }));
  // ---- site display name editing (pencil icon) ----
  document.querySelectorAll('button[data-edit-name]').forEach(b => b.addEventListener("click", (e) => {
    e.stopPropagation();
    editingNameId = b.getAttribute("data-edit-name");
    renderApp();
  }));

  async function saveSiteName(id) {
    const inp = document.getElementById("inlineEditInput");
    const val = inp ? inp.value.trim() : "";
    editingNameId = null;
    const st = await getState();
    const cur = st.productiveSites || [];
    const next = cur.map(p => p.id === id ? { ...p, label: val } : p);
    await setStateP({ productiveSites: next });
    chrome.runtime.sendMessage({ type: "refreshBlockedTabs" });
    renderApp();
    toast(val ? `Name updated: "${val}"` : "Name reset to default");
  }

  document.querySelectorAll('button[data-save-name]').forEach(b => b.addEventListener("click", (e) => {
    e.stopPropagation();
    saveSiteName(b.getAttribute("data-save-name"));
  }));

  document.querySelectorAll('button[data-cancel-name]').forEach(b => b.addEventListener("click", (e) => {
    e.stopPropagation();
    editingNameId = null;
    renderApp();
  }));

  const inlineInp = document.getElementById("inlineEditInput");
  if (inlineInp && editingNameId) {
    inlineInp.focus();
    inlineInp.select();
    inlineInp.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        saveSiteName(editingNameId);
      } else if (e.key === "Escape") {
        e.preventDefault();
        editingNameId = null;
        renderApp();
      }
    });
  }
  document.querySelectorAll('button[data-reset]').forEach(b => b.addEventListener("click", async () => {
    const st = await getState();
    const id = b.getAttribute("data-reset");
    const cur = st.productiveSites || [];
    const row = cur.find(p => p.id === id);
    const name = row ? targetName(row) : "this site";
    const spent = fmtDur(Math.min(row ? row.spentSec || 0 : 0, row ? row.requiredSec || 0 : 0));
    if (!await confirmReset({
      title: "Start today over?",
      body: `${spent} already done on ${name} goes back to zero. This cannot be undone.`
    })) return;
    // Re-read: the dialog was open for a while and the day may have rolled over.
    const fresh = await getState();
    // Already confirmed: the sheet above asked about this exact change, and harder — it wanted
    // the words typed out. A second "are you sure you want to be stricter" on top of that is
    // one decision asked twice.
    // metAt with it: a row that is no longer finished has no finishing time, and leaving the stamp
    // behind would let it satisfy its deadline again the instant the bar refilled — even outside the
    // window it was supposed to be met in.
    //
    // graceFrom is deliberately NOT cleared, and it is the one field here whose absence from this list is
    // a decision rather than an omission. metAt is a PASS that would go stale; graceFrom is a stopwatch
    // that is already running, and ↺ does not un-open the site. Clearing it would make this button the
    // way out of a limit that had run out: press it, lose the afternoon's progress, and get a fresh
    // allowance — which is exactly the escape the limit exists to close, and one the window deadline has
    // no equivalent of, because its hours are fixed whatever anybody presses. The daily reset is the only
    // thing that starts a stopwatch over.
    //
    // The cost is real and correct: winding a row back with twenty minutes of a seventy-minute allowance
    // gone leaves fifty minutes to do sixty, so the row is beyond saving today. The sheet above already
    // says this cannot be undone.
    await setStateP({ productiveSites: (fresh.productiveSites || []).map(p => p.id===id ? { ...p, spentSec: 0, metAt: 0 } : p) }, { confirmed: true });
    // Back to zero means the locked list closes again, right now.
    chrome.runtime.sendMessage({ type: "refreshBlockedTabs" });
    renderApp();
    toast("Started over");
  }));
  // A site's own logo is its on/off switch. Off means it earns no time and doesn't
  // count towards "today is done" — but it stays in the list, so one click brings
  // it back.
  // Switching a row back ON is a tightening and goes through during strict mode; switching one
  // OFF is a loosening and is refused. One switch, two answers, decided by setStateP rather than
  // by a blanket refusal here that used to cover both.
  document.querySelectorAll('button[data-toggle]').forEach(b => b.addEventListener("click", async () => {
    const st = await getState();
    const id = b.getAttribute("data-toggle");
    const cur = st.productiveSites || [];
    const site = cur.find(p => p.id === id);
    if (!site) return;
    const on = site.enabled === false;   // flipping to this
    await setStateP({ productiveSites: cur.map(p => p.id === id ? { ...p, enabled: on } : p) });
    chrome.runtime.sendMessage({ type: "refreshBlockedTabs" });
    renderApp();
    toast(on ? "Counting again" : "Paused — click the icon to bring it back");
  }));
  // ---- logic operator toggle (AND / OR) ----
  document.querySelectorAll('button[data-logic-op]').forEach(b => b.addEventListener("click", async (e) => {
    e.stopPropagation();
    const id = b.getAttribute("data-logic-id");
    const op = b.getAttribute("data-logic-op");
    const st = await getState();
    const cur = st.productiveSites || [];
    const site = cur.find(p => p.id === id);
    if (!site || (site.operator || "AND") === op) return;
    const next = cur.map(p => p.id === id ? { ...p, operator: op } : p);
    await setStateP({ productiveSites: next });
    chrome.runtime.sendMessage({ type: "refreshBlockedTabs" });
    renderApp();
    toast(op === "OR" ? "Logic set to OR: finishing either site satisfies this step" : "Logic set to AND: both sites must be completed");
  }));
  // ---- per-site no-cheating rules -------------------------------------------
  // 🛡️ opens one row's panel (only one at a time — they're tall). Everything in it
  // writes at once, like every other switch on this page.
  // Per-row checks, and the same rule as everywhere else: tightening one goes through during a
  // strict window, easing one off is refused. The blanket refusal that used to be here meant a
  // frozen page could not have its checks made fussier either, which is backwards — strict mode
  // exists to hold you to your rules, not to stop you adding to them.
  // `extra` is for the handful of switches that cannot stand alone — the speed boost needs this
  // target's camera on. Folded into the same patch rather than saved separately, so the pair is
  // one decision at one gate instead of two, and cannot half-apply if the second is refused.
  async function saveCheat(id, key, value, extra) {
    const st = await getState();
    const sites = st.productiveSites || [];
    await setStateP({
      productiveSites: sites.map(p => {
        if (p.id !== id) return p;
        if (key === "cheatCustom") {
          // Switching it on starts from whatever Setup says right now, so the panel
          // opens where the defaults are instead of somewhere arbitrary. Anything
          // set before is kept, so turning it off and on again doesn't lose it.
          const seed = (p.cheat && Object.keys(p.cheat).length) ? p.cheat : siteCheat(st, null);
          return { ...p, cheatCustom: !!value, cheat: seed };
        }
        return { ...p, cheat: Object.assign({}, p.cheat, { [key]: value }, extra || {}) };
      })
    });
  }
  // ---- click along a bar to wind today's time back ---------------------------
  // Only backwards. Forwards would be handing yourself time you never spent, which
  // is the one thing this extension exists to prevent — so it's refused out loud.
  // The same speed bump as ↺ guards it, because it destroys the same thing.
  // No strict-mode refusal: this bar only ever moves backwards, and giving up time you have
  // already earned is the strictest thing on the page. It was blanket-refused during a strict
  // window, which is the same mistake the delete button made — freezing the settings should not
  // stop you making today harder.
  async function scrubTo(id, frac) {
    const st = await getState();
    const row = (st.productiveSites || []).find(p => p.id === id);
    if (!row) return;
    const req = row.requiredSec || 0;
    if (req <= 0) return;
    const cur = Math.min(req, row.spentSec || 0);
    const want = Math.max(0, Math.min(req, Math.round(Math.max(0, Math.min(1, frac)) * req)));
    if (cur <= 0) return;
    if (want >= cur) {
      return toast("The bar only winds back — it can't give you time you haven't spent");
    }
    const name = targetName(row);
    if (!await confirmReset({
      title: want === 0 ? "Start today over?" : "Wind today's time back?",
      body: want === 0
        ? `${fmtDur(cur)} already done on ${name} goes back to zero. This cannot be undone.`
        : `${name} goes from ${fmtDur(cur)} back to ${fmtDur(want)}. The ${fmtDur(cur - want)} in between is gone for good.`,
      go: want === 0 ? "Reset" : "Wind back"
    })) return;
    // Re-read: the dialog was open for a while and the clock kept running.
    const fresh = await getState();
    // Already confirmed by the sheet above, which asked about this exact wind-back.
    await setStateP({
      // The stamp is cleared whenever the bar is wound back below the goal, and kept when it isn't.
      // `want` can be anything from zero up to the goal, so this is the one wind-back that has to
      // ask rather than assume: dragging a finished row back to 90% un-finishes it, and the next
      // completion is a new event with a new time.
      //
      // graceFrom is untouched here too — see the note on the ↺ button above. Winding the bar back does
      // not un-open the site, so the stopwatch goes on running from where it started.
      productiveSites: (fresh.productiveSites || []).map(p => p.id === id
        ? { ...p, spentSec: want, metAt: want >= (p.requiredSec || 0) ? (p.metAt || 0) : 0 }
        : p)
    }, { confirmed: true });
    chrome.runtime.sendMessage({ type: "refreshBlockedTabs" });
    renderApp();
    toast(want === 0 ? "Started over" : "Wound back to " + fmtDur(want));
  }
  document.querySelectorAll("[data-scrub]").forEach(bar => {
    const id = bar.getAttribute("data-scrub");
    bar.addEventListener("click", (e) => {
      const box = bar.getBoundingClientRect();
      if (!box.width) return;
      scrubTo(id, (e.clientX - box.left) / box.width);
    });
    // From the keyboard there's no "where", so Enter means all the way back.
    bar.addEventListener("keydown", (e) => {
      if (e.key !== "Enter" && e.key !== " ") return;
      e.preventDefault();
      scrubTo(id, 0);
    });
  });

  document.querySelectorAll("button[data-cheat]").forEach(b => b.addEventListener("click", async (e) => {
    e.preventDefault();
    e.stopPropagation();
    const id = b.getAttribute("data-cheat");
    const willOpen = (cheatOpenFor !== id);
    cheatOpenFor = willOpen ? id : null;
    await renderApp({ anchorTargetId: id, willOpen });
  }));
  let ckTimer = 0;
  // What one target's panel currently says, read straight off its own controls. `el` is any
  // control inside the panel; the panel is found from it rather than passed in, so this works
  // from a slider, from the switch, and from the preview button without three variants.
  function panelPaceVals(el) {
    const panel = el && el.closest(".cheatpanel");
    const one = (key, dflt) => {
      const c = panel && panel.querySelector('[data-ck$="|' + key + '"]');
      return c ? paceVal(key, parseFloat(c.value)) : dflt;
    };
    const fsEl = panel && panel.querySelector('[data-ck$="|faceSensitivity"]');
    return {
      fast: one("paceFast", 1.5), slow: one("paceSlow", 0.5), box: one("paceBoxPct", 55),
      fs: fsEl ? Math.max(1, Math.min(5, parseInt(fsEl.value, 10) || 3)) : 3
    };
  }
  document.querySelectorAll("[data-pacepv]").forEach(b => b.addEventListener("click", () => {
    pacePv.show(panelPaceVals(b));
  }));
  // One day chip on one row. Toggles a single bit, so pressing three of them is three decisions —
  // which matters, because each one goes through setStateP and dropping a day asks for the password
  // while adding one asks for a confirmation.
  document.querySelectorAll("[data-day]").forEach(b => b.addEventListener("click", async () => {
    const [id, raw] = (b.getAttribute("data-day") || "").split(":");
    const bit = parseInt(raw, 10);
    if (!id || !(bit >= 0 && bit <= 6)) return;
    const st = await getState();
    const row = (st.productiveSites || []).find(p => p.id === id);
    if (!row) return;
    const cur = FGSettings.dayMask(row.days === undefined ? FGSettings.DAY_ALL : row.days);
    const next = cur ^ (1 << bit);
    // The last day cannot be cleared. A row active on no day at all can never be finished, so it
    // would hold the locked list shut for ever with nothing that could open it — and it would do
    // that silently, looking like an ordinary row. "Not at all" already has a control: the icon
    // beside the name, which is one click away and says what it did.
    if (!next) {
      return toast("A work site needs at least one day. Click the icon beside its name to switch it off entirely.");
    }
    await setStateP({
      productiveSites: (st.productiveSites || []).map(p => (p.id === id ? { ...p, days: next } : p))
    });
    // The whole list is redrawn rather than just this chip: changing the days changes today's
    // totals in the header, whether this row counts at all, and possibly whether anything is
    // blocked — none of which this button could update on its own.
    renderApp();
    chrome.runtime.sendMessage({ type: "refreshBlockedTabs" }, () => void chrome.runtime.lastError);
  }));
  document.querySelectorAll("[data-ck]").forEach(el => {
    const [id, key] = (el.getAttribute("data-ck") || "").split("|");
    if (!id || !key) return;
    if (el.type === "checkbox") {
      // A switch can change what the rest of the panel is allowed to do, so the
      // panel is redrawn from the saved state.
      el.addEventListener("change", async () => {
        // Read before the save. The render below replaces this panel, and with it the controls
        // these numbers are read from.
        const pace = key === "paceEnabled";
        const pv = pace ? panelPaceVals(el) : null;
        const want = pace ? el.checked : null;
        // The speed boost cannot work without this target's camera on, so switching it on
        // switches that on too — the same rule the card in Setup follows. Written in the same
        // patch rather than as a second save, so it is one decision at one gate.
        await saveCheat(id, key, el.checked, pace && el.checked ? { faceDetectionEnabled: true } : null);
        renderApp();
        if (want === true) pacePv.show(pv);
        else if (want === false) pacePv.close();
      });
      return;
    }
    if (el.type === "range") {
      // Two kinds of slider share this branch, and they cannot share a reader. The sensitivity
      // dials are integers 1-5 with a word per step; the pace sliders are quantities with their
      // own ranges and a fractional step, so parseInt on 1.5 would store 1. PACE_DIAL decides
      // which this is, from the key alone.
      const pacey = !!PACE_DIAL[key];
      const read = () => pacey
        ? paceVal(key, parseFloat(el.value))
        : Math.min(5, Math.max(1, parseInt(el.value, 10) || 3));
      // The word follows the thumb as you drag; the value is written when you let go.
      // It used to save on a 250ms debounce during the drag, which wrote every level you
      // paused on — three or four writes for one movement. Harmless while nothing watched
      // them, but each one now has to answer a gate, so a slow drag from "easy" to "strict"
      // would have asked "make this stricter?" at every step. One movement, one decision.
      el.addEventListener("input", () => {
        const v = read();
        const word = el.closest(".sens") && el.closest(".sens").querySelector(".sensval");
        if (word) {
          // Keyed off the dial rather than one shared list: the blink dial's ends say
          // "clear → faint", and labelling it "easy" would claim the opposite of what a
          // higher setting does. See dialWords. A pace slider has no word — it shows the
          // number, because there is no name for 1.7×.
          word.textContent = pacey ? paceText(key, v) : dialWords(key)[v];
        }
        // Live preview, same as the card in Setup. Read off this panel's own sliders rather than
        // off storage: mid-drag the slider under your finger has not been saved yet, and a
        // preview showing the value from before you moved it is worse than none.
        if (!pacey) return;
        pacePv.show(panelPaceVals(el));
        if (key !== "paceBoxPct") return;
        // The unreachable-box warning, live under the slider. The panel is only re-rendered when
        // you let go, and the warning has to appear as you pass the point, not afterwards.
        const panel = el.closest(".cheatpanel");
        const row = panel && panel.querySelector("[data-pacewarn]");
        if (!row) return;
        const warn = paceBoxWarnText(v);
        const say = row.querySelector(".lbl");
        if (say) say.textContent = warn;
        row.hidden = !warn;
      });
      el.addEventListener("change", () => {
        clearTimeout(ckTimer);
        if (pacey) pacePv.show(panelPaceVals(el));   // in case the drag's last step was lost
        saveCheat(id, key, read());
      });
      return;
    }
    // Numbers commit when you leave the box or press Enter, and no longer half a second after
    // a keystroke. Same reason as autoNum in Setup: on the way to 1800 the box passes through
    // values that are a real change in their own right, and a sheet in front of a half-typed
    // number is unusable. Nothing is lost — leaving the box is what saves it, as before.
    const read = () => parseInt(el.value, 10) || 0;
    el.addEventListener("change", () => { clearTimeout(ckTimer); saveCheat(id, key, read()); });
    el.addEventListener("keydown", (e) => {
      if (e.key !== "Enter" || e.isComposing) return;
      e.preventDefault(); clearTimeout(ckTimer); saveCheat(id, key, read()); el.blur();
    });
  });

  // Walk the list of places a logo might live; show the kind emoji only once
  // every one of them has failed.
  document.querySelectorAll("img.fav").forEach(img => {
    const key = img.getAttribute("data-fav") || "";
    const list = key.split("|").filter(Boolean);
    const at = () => parseInt(img.getAttribute("data-favi"), 10) || 0;
    img.addEventListener("error", () => {
      const i = at() + 1;
      if (i < list.length) {
        img.setAttribute("data-favi", String(i));
        img.src = list[i];
        return;
      }
      img.hidden = true;
      const fb = img.parentElement?.querySelector(".favfb");
      if (fb) fb.hidden = false;
    });
    // Remember which entry in the list actually produced a picture, so the next render of this row
    // starts there instead of walking the list again from the top.
    //
    // Without this, every re-render re-requested the first few candidates — and those are requests
    // to the site itself, not to anything local. This page re-renders on every switch, every dial
    // and every day chip, so pressing chips fired a burst of icon fetches at half a dozen sites,
    // and any one of them answering slowly or refusing left that row with no icon at all until the
    // page was reloaded. That is what "the favicon disappears when I click the days" was.
    img.addEventListener("load", () => { if (img.naturalWidth > 0) favAt.set(key, at()); });
    // An error can fire BEFORE the two listeners above exist. The src rides in the markup, so the
    // fetch begins as innerHTML is parsed and this wiring runs a moment later — a cached failure
    // can therefore be complete already, and an error listener attached afterwards never hears
    // about it. That left a row with neither a picture nor the emoji that stands in for one, which
    // is the other half of the same complaint. Asking the element whether it is already broken is
    // the only way to catch it.
    if (img.complete && img.naturalWidth === 0) img.dispatchEvent(new Event("error"));
  });
  // Drag-drop reorder (disabled in strict mode).
  // Only the ⋮⋮ grip starts a drag, so selecting text or using the controls in a
  // row never turns into an accidental reorder. The grip is the draggable
  // element; the row it lives in is what actually moves.
  if (!strict) {
    let draggedId = null;
    const rows = [...document.querySelectorAll(".item")];
    const clearHints = () => rows.forEach(r => r.classList.remove("drop-above", "drop-below"));
    rows.forEach(it => {
      const grip = it.querySelector(".grip");
      grip?.addEventListener("dragstart", (e) => {
        draggedId = it.dataset.id;
        it.classList.add("dragging");
        try {
          // Chrome refuses the drop when the drag carries no data at all, which is
          // why this looked dead: dragstart fired, drop never did.
          e.dataTransfer.setData("text/plain", draggedId);
          e.dataTransfer.effectAllowed = "move";
          e.dataTransfer.setDragImage(it, 20, 20);   // drag the row, not the handle
        } catch {}
      });
      grip?.addEventListener("dragend", () => {
        it.classList.remove("dragging");
        draggedId = null;
        clearHints();
      });
      // Show where it will land: a line above or below, depending on which half of
      // the row the pointer is in. Dropping "on" a row was ambiguous before.
      it.addEventListener("dragover", (e) => {
        e.preventDefault();
        try { e.dataTransfer.dropEffect = "move"; } catch {}
        if (!draggedId || draggedId === it.dataset.id) return;
        const box = it.getBoundingClientRect();
        const after = (e.clientY - box.top) > box.height / 2;
        clearHints();
        it.classList.add(after ? "drop-below" : "drop-above");
      });
      it.addEventListener("dragleave", (e) => {
        if (!it.contains(e.relatedTarget)) it.classList.remove("drop-above", "drop-below");
      });
      it.addEventListener("drop", async (e) => {
        e.preventDefault();
        const overId = it.dataset.id;
        // The id travels in the drag itself too, so nothing is lost if the page
        // re-renders while a row is in the air.
        let dragId = draggedId;
        if (!dragId) { try { dragId = e.dataTransfer.getData("text/plain"); } catch {} }
        const box = it.getBoundingClientRect();
        const after = (e.clientY - box.top) > box.height / 2;
        clearHints();
        if (!dragId || dragId === overId) return;
        await applyOrder(dragId, overId, after);
      });
      // Keyboard alternative: focus the handle and press ↑ / ↓.
      grip?.addEventListener("keydown", (e) => {
        if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
        e.preventDefault();
        nudgeTarget(it.dataset.id, e.key === "ArrowDown" ? 1 : -1);
      });
    });
  }
}

// Move one id to a new place in a list of ids. Split out so the drop handler can't
// get it wrong: dragging downwards used to land the row above the one it was
// dropped on, because the target index was read before the row was lifted out.
function reorderIds(ids, draggedId, overId, placeAfter) {
  const from = ids.indexOf(draggedId);
  if (from < 0) return ids.slice();
  const out = ids.slice();
  out.splice(from, 1);
  let to = out.indexOf(overId);
  if (to < 0) return ids.slice();
  if (placeAfter) to += 1;
  out.splice(to, 0, draggedId);
  return out;
}
// Today's order as one list of ids.
function orderedIds(s) {
  return (s.productiveSites || [])
    .map(p => ({ id: p.id, order: p.order || 0 }))
    .sort((a, b) => a.order - b.order)
    .map(x => x.id);
}
// Write a new order back to whichever thing owns each position.
//
// With sequence mode OFF the order is the one thing on this list that is neither stricter nor looser:
// it decides which row is drawn first and nothing else, so you cannot cheat by putting a row at the
// top. That is what setStateP still sees — targetsReason matches rows by id and deliberately ignores
// their positions — and it is why a drag never asks for your password.
//
// With sequence mode ON that stops being true: the order decides which row you are ALLOWED to open, so
// dragging the easy one to the top is a way to rewrite the commitment rather than to tidy the page. It
// does not shorten the day — every step still has to be finished before the locked list opens — but it
// is the same shape as retyping a study topic, which this file treats as a loosening.
//
// Guarded by the drag wiring rather than here, and it already was: the whole reorder block above is
// inside `if (!strict)`, so during a strict window there is nothing to drag and nothing to press ↑ on.
// Said here because this is where somebody looks for the rule, and a comment claiming the order
// changes nothing would now be wrong.
//
// Outside a strict window a reorder stays free, on purpose. Dragging is how the sequence gets BUILT,
// and the gesture that sets it up is the same gesture that would bend it — a password prompt on every
// drag would land on the setup far more often than on the escape, which is how a gate stops being
// taken seriously. Strict mode is the answer for anyone who wants the order held.
async function applyOrder(draggedId, overId, placeAfter) {
  const st = await getState();
  const next = reorderIds(orderedIds(st), draggedId, overId, placeAfter);
  await setStateP({ productiveSites: (st.productiveSites || []).map(p => ({ ...p, order: next.indexOf(p.id) })) });
  renderApp();
}
// One step up or down with the keyboard. Dragging with a mouse isn't available to
// everyone, and for a single step this is quicker anyway.
async function nudgeTarget(id, dir) {
  const st = await getState();
  const ids = orderedIds(st);
  const at = ids.indexOf(id);
  const to = at + dir;
  if (at < 0 || to < 0 || to >= ids.length) return;      // already at the end
  await applyOrder(id, ids[to], dir > 0);
  // Keep the focus on the handle you're holding, so ↑↓ can be pressed again.
  setTimeout(() => {
    const g = document.querySelector(`[data-id="${id}"] .grip`);
    if (g) g.focus();
  }, 0);
}

// ---- taking several sites off a list at once -------------------------------------------------
//
// A ✕ on every chip is the right control for one entry and the wrong one for forty. Pressing a group
// chip again already removes that whole group, so what was missing was an arbitrary handful, and a
// hundred-entry list to start over from.
//
// Picking is a MODE rather than a permanent row of checkboxes, because the chips already have a click:
// the name is a link that opens the site. A checkbox beside every one would either fight that link or
// shrink it. In picking mode the link and the ✕ both go and the whole chip becomes the checkbox, so
// there is never a chip with two things to click.
//
// One key, not a boolean per list: both lists are in the DOM at once (one merely hidden), and only one
// of them can be picking — which is also what keeps the `data-chippick` handles unambiguous.
let chipSelKey = null;                 // "blockedSites" | "allowedSites" | null
const chipSel = new Set();             // urls ticked; only meaningful for chipSelKey
function chipBoxHtml(list, key) {
  if (!list.length) return "";
  const picking = chipSelKey === key;
  const delAttr = key === "blockedSites" ? "data-delb" : "data-dela";
  const tid = key === "blockedSites" ? "blocked" : "allowed";
  const n = list.length;
  const chips = list.map(b => {
    const u = String(b.url || "");
    if (!picking) {
      return `<span class="chip"><a class="chiplink" href="${escHtml(siteOpenUrl(u))}" target="_blank" rel="noopener noreferrer" data-open-pattern="${escHtml(u)}" title="Go to ${escHtml(u)}">${escHtml(u)}</a><span class="x" ${delAttr}="${escHtml(u)}" title="Remove" aria-label="Remove ${escHtml(u)}" data-testid="del-${tid}-${escHtml(u)}">✕</span></span>`;
    }
    const on = chipSel.has(u);
    return `<span class="chip pick${on ? " on" : ""}" role="checkbox" tabindex="0"
                  aria-checked="${on ? "true" : "false"}" data-chippick="${escHtml(u)}"
                  aria-label="${escHtml(u)}" data-testid="pick-${tid}-${escHtml(u)}"
            ><span class="tick" aria-hidden="true">${on ? "✓" : ""}</span>${escHtml(u)}</span>`;
  }).join("");
  const head = picking
    ? `<span class="chipcount" data-chipn="${key}">${chipSel.size} of ${n} picked</span>
       <span class="grow"></span>
       <button class="chipbtn" type="button" data-chipall="${key}" data-testid="pick-all-${tid}">All</button>
       <button class="chipbtn" type="button" data-chipnone="${key}" data-testid="pick-none-${tid}">None</button>
       <button class="chipbtn danger" type="button" data-chipdel="${key}" data-testid="pick-del-${tid}"
               ${chipSel.size ? "" : "disabled"}>Remove${chipSel.size ? " " + chipSel.size : ""}</button>
       <button class="chipbtn" type="button" data-chipcancel="${key}" data-testid="pick-done-${tid}">Done</button>`
    : `<span class="chipcount">${n} site${n === 1 ? "" : "s"} on this list</span>
       <span class="grow"></span>
       <button class="chipbtn" type="button" data-chipsel="${key}" data-testid="pick-start-${tid}"
               title="Tick several, then remove them in one go">Pick several</button>
       <button class="chipbtn danger" type="button" data-chipclear="${key}" data-testid="pick-clear-${tid}"
               title="Take every site off this list">Clear all</button>`;
  return `<div class="chipbox">
        <div class="chiphead">${head}</div>
        <div class="chips">${chips}</div>
      </div>`;
}

// The phone-apps folder inside step 2 starts shut and remembers its state
// while the page is open.
let phoneOpen = false;
function renderBlocked(s) {
  const tc = document.getElementById("tabContent");
  const blocked = s.blockedSites || [];
  const allowed = s.allowedSites || [];
  const mode = s.blockMode || "blacklist";
  // The phone fields moved here from Setup and are locked during strict hours,
  // exactly as they were there.
  const strict = inStrictWindow(s);
  // Appends, so it can share a tab with the "earn time" half.
  tc.insertAdjacentHTML("beforeend", `
    <div class="card">
      <div class="chead">
        <span class="ctile step" aria-hidden="true">2</span>
        <div class="ctitle">
          <div class="crow">
            <h2>Blocked until I earn it ${tip("One list for everything. These stay blocked until <b>all</b> of step 1 is finished.<br/><br/>Type an address like <span class='kbd'>instagram.com</span> and press <b>➕</b>. Press <b>✕</b> on a chip to remove it.<br/><br/><b>🔒 Block list:</b> only the sites you list get blocked. Everything else stays open. Best for most people.<br/><br/><b>✅ Allow list:</b> the whole internet gets blocked <i>except</i> the sites you list. Very strict. Leave it <b>empty</b> and nothing at all is allowed.<br/><br/><b>How wide is one entry?</b> The two lists are deliberately different, because both err towards blocking.<br/>• Blocking <span class='kbd'>youtube.com</span> also blocks <span class='kbd'>m.youtube.com</span> and <span class='kbd'>music.youtube.com</span> — subdomains included.<br/>• Allowing <span class='kbd'>google.com</span> opens <b>only</b> google.com. <span class='kbd'>keep.google.com</span> and <span class='kbd'>gemini.google.com</span> stay blocked.<br/>• Want the subdomains open too? Write <span class='kbd'>*.google.com</span>.<br/><br/>Either way, your step 1 sites and browser pages always stay open.")}</h2>
          </div>
          ${tickerHtml(lockTickerText(s), "lock-ticker")}
        </div>
        <span class="seg" role="group" aria-label="Blocking mode">
          <input type="radio" name="mode" id="mode-bl" value="blacklist" ${mode==='blacklist'?'checked':''}/>
          <label for="mode-bl" data-testid="mode-blacklist" title="Only the sites you add here are blocked. Everything else stays open."><span class="sgi" aria-hidden="true">🔒</span>Blocklist</label>
          <input type="radio" name="mode" id="mode-wl" value="whitelist" ${mode==='whitelist'?'checked':''}/>
          <label for="mode-wl" data-testid="mode-whitelist" title="Everything is blocked except the sites you add here. Each entry opens that exact site only — write *.example.com for its subdomains too."><span class="sgi" aria-hidden="true">✅</span>Allowlist</label>
        </span>
      </div>

      <div id="blacklistCard" ${mode==='whitelist'?'hidden':''}>
        <div class="addrow">
          <span class="gicon" aria-hidden="true">🔒</span>
          <input class="input grow" id="newBlocked" placeholder="instagram.com, youtube.com, reddit.com" title="Add several at once by putting commas between them" data-testid="add-blocked-url"/>
          <button class="btn round" id="addBlocked" data-testid="add-blocked-btn" title="Lock this site" aria-label="Lock this site">➕</button>
        </div>
        <!-- What is on the list sits directly under the field that fills it, both indented to the same
             lead, so the two read as one thing. The category fold comes AFTER them: it is a full-width
             section like the phone fold below it, and putting it between the field and its own contents
             split that pair with a section bar. -->
        ${chipBoxHtml(blocked, "blockedSites")}
        ${catPickerHtml("blockedSites", blocked)}
      </div>

      <div id="whitelistCard" ${mode==='blacklist'?'hidden':''}>
        <div class="addrow">
          <span class="gicon" aria-hidden="true">✅</span>
          <!-- The placeholder carries the "*." form, because this is the one list where
               a bare entry means one site and there is no other hint on screen that a
               wider spelling exists. -->
          <input class="input grow" id="newAllowed" placeholder="docs.google.com, wikipedia.org, *.wikipedia.org" title="One entry opens that exact site only. Write *.example.com to open its subdomains too. Add several at once by putting commas between them." data-testid="add-allowed-url"/>
          <button class="btn round" id="addAllowed" data-testid="add-allowed-btn" title="Allow this site" aria-label="Allow this site">➕</button>
        </div>
        ${chipBoxHtml(allowed, "allowedSites")}
        ${catPickerHtml("allowedSites", allowed)}
      </div>

      <!-- Phone apps are just another thing to lock, so they live here rather
           than in a card of their own down in Setup. Folded away by default,
           because most people never wire up a phone. -->
      <div class="sect">
        <!-- The "?" is a sibling of the fold button, not inside it: a button inside
             a button is invalid, and clicking the bubble would fold the section. -->
        <div class="sechead">
          <button class="secthead" type="button" id="phoneHead" aria-expanded="${phoneOpen ? "true" : "false"}" aria-controls="phoneBody" data-testid="phone-fold">
            ${CARET}
            <span class="ic" aria-hidden="true">📱</span>
            <span class="ttl">Phone apps block</span>
            <span class="cnt" id="phoneState">${s.macrodroidEnabled ? "on" : "off"}</span>
          </button>
          ${tip(`<b>What this does</b><br/>Locks apps on your <b>Android phone</b> while today's work is unfinished — the same rule that locks the sites above. Finish step 1 and your phone unlocks itself.<br/><br/>
<b>📱 Your phone must be online</b><br/>This is the one part of FocusGate that reaches outside this computer, and a phone with no connection simply never hears the call. <b>Make sure your mobile phone has internet connectivity.</b> If it was offline, the next call goes out about a minute later and catches up by itself.<br/><br/>
<b>Per-site</b><br/>With this switched on, every site in step 1 grows a <b>📱 Phone waits for this</b> switch of its own. Turn it off on a site your phone shouldn't wait for — a reference page you dip into at odd hours — and that site still earns time and still unlocks your browser; it just stops holding your phone hostage.<br/><br/>
<b>Why it needs a helper app</b><br/>A browser extension cannot touch your phone. So FocusGate calls a web address, and a free app on your phone called <b>MacroDroid</b> listens for that call and does the blocking. Nothing else is needed — no account, no cable, no root.<br/><br/>
<b>Set it up once</b><ol>
<li>Install <b>MacroDroid</b> from the Play Store on your phone.</li>
<li>Tap <span class='kbd'>Add Macro</span>. For the <b>trigger</b> pick <span class='kbd'>Connectivity → Webhook (URL)</span> and name it <span class='kbd'>lock</span>.</li>
<li>For the <b>action</b> pick what blocking means for you — <span class='kbd'>Applications → Application Launch Blocker</span> and choose Instagram, games, whatever pulls you away. Save the macro.</li>
<li>Make a <b>second</b> macro exactly the same way, name its webhook <span class='kbd'>unlock</span>, and give it the action that <i>stops</i> blocking.</li>
<li>In MacroDroid, copy each macro's webhook address and paste them into the two boxes here — 🔒 for lock, 🔓 for unlock.</li></ol>
<b>What happens then</b><br/>While work is unfinished FocusGate calls your <b>lock</b> address; the moment everything in step 1 is done it calls <b>unlock</b>. It repeats the call about once a minute, so if your phone was offline or the app was asleep it catches up by itself.<br/><br/>
<b>📍 Only block me at home</b><br/>FocusGate cannot do this part — it runs on this computer and has no idea where your phone is. Your phone does, so the rule goes on the MacroDroid macro that does the blocking. <b>One constraint, no extra macros.</b><br/><br/>
On that macro add <span class='kbd'>Constraints → Location → Geofence</span>, name a zone over your home and pick <b>Inside Area</b>.<br/><br/>
<b>Tick "set constraint to true if no location is available."</b> That one checkbox decides what happens when the phone cannot get a fix, and left unticked it turns the location toggle into a one-tap way out of everything: no fix reads as "not at home", and nothing blocks. Ticked, a missing fix keeps the block on — annoying if you really are out, but it cannot be used as an escape. <b>Location Update Rate</b> of 5 minutes is plenty; the constraint reads the last background fix rather than taking a new one each time, so a faster rate spends battery for very little.<br/><br/>
<b>Mind the logic.</b> Constraints at the same level are combined with <b>AND</b>. So if your existing checks are joined by OR, put those under an <span class='kbd'>OR</span> logic constraint and leave the geofence beside it at the top level — logic constraints can be nested. Dropped into the OR list instead it would block you <i>because</i> you are home. To avoid nesting altogether, long-press the blocking action itself and put the constraint on just that action.<br/><br/>
<b>Cheaper alternative:</b> <span class='kbd'>Wifi State → Wifi is connected to → your home network</span>. No location permission, no battery, and indoors it is a better "am I home" signal than GPS. Choosing a named network rather than <i>Any</i> may need MacroDroid's Helper app on newer Android.<br/><br/>
Worth knowing before you rely on any of this: it is a way <b>out</b> of your own rules. A geofence that has not caught up, or Wi-Fi switched off, reads as "away".<br/><br/>
<b>Checking it</b><br/>Press <b>▶</b> beside a box to fire that address right now and watch your phone react. <b>🔄</b> sends today's real state again. Both boxes save themselves as you type — there is no Save button.<br/><br/>
<b>Worth knowing</b><br/>Your phone has to be online for a call to arrive. If it isn't, the next minute's call gets through instead. This blocks apps on the phone; the sites above are blocked in Chrome.${strict ? "<br/><br/><b style='color:#fca5a5'>Strict mode is on, so these boxes are locked right now.</b>" : ""}`)}
        </div>
        <div class="sectbody" id="phoneBody" ${phoneOpen ? "" : "hidden"}>
          <div class="srow sub">
            <span class="ic">📱</span>
            <span class="lbl grow">Lock apps on my phone too ${tip("Turn this on once the two web addresses below are filled in. The full how-to is in the <b>?</b> beside this section's title.")}</span>
            ${sw("mdEnabled", s.macrodroidEnabled, false, "md-enabled")}
          </div>
          <div class="srow sub">
            <span class="ic">🔒</span>
            <input class="input grow" id="mdLockUrl" type="url" inputmode="url" spellcheck="false"
                   placeholder="Lock web address"
                   aria-label="MacroDroid lock address"
                   title="${editLocked ? "Password needed to edit lock address 🔒" : "MacroDroid webhook that blocks your apps"}"
                   value="${escHtml(s.macrodroidLockUrl || "")}"
                   ${editLocked ? "readonly style='cursor:pointer;'" : ""} data-testid="md-lock-url"/>
            <button class="iconbtn" id="mdTestLock" data-testid="md-test-lock"
                    title="${editLocked ? "Password needed to test 🔒" : "Test the lock"}"
                    aria-label="Test the lock"
                    ${editLocked ? "style='opacity:.5;cursor:pointer;'" : ""}>▶</button>
          </div>
          <div class="srow sub">
            <span class="ic">🔓</span>
            <input class="input grow" id="mdUnlockUrl" type="url" inputmode="url" spellcheck="false"
                   placeholder="Unlock web address"
                   aria-label="MacroDroid unlock address"
                   title="${editLocked ? "Password needed to edit unlock address 🔒" : "MacroDroid webhook that stops blocking"}"
                   value="${escHtml(s.macrodroidUnlockUrl || "")}"
                   ${editLocked ? "readonly style='cursor:pointer;'" : ""} data-testid="md-unlock-url"/>
            <button class="iconbtn" id="mdTestUnlock" data-testid="md-test-unlock"
                    title="${editLocked ? "Password needed to test 🔒" : "Test the unlock"}"
                    aria-label="Test the unlock"
                    ${editLocked ? "style='opacity:.5;cursor:pointer;'" : ""}>▶</button>
          </div>
          <div class="srow sub controw">
            <span class="lbl grow hint" id="mdSaved"></span>
            <button class="iconbtn" id="mdSync" data-testid="md-sync"
                    title="${editLocked ? "Password needed to sync 🔒" : "Send the current state to the phone now"}"
                    aria-label="Send the current state to the phone now"
                    ${editLocked ? "style='opacity:.5;cursor:pointer;'" : ""}>🔄</button>
          </div>
        </div>
      </div>
    </div>`);

  // Swapping between Blocklist and Allowlist has a clear direction: switching to Allowlist blocks
  // the entire internet and is tightening (shows "Make this stricter?"); switching back to Blocklist
  // is loosening and asks for the password. Both directions are gated by setStateP.
  document.querySelectorAll('input[name="mode"]').forEach(r => r.addEventListener("change", async () => {
    const st = await getState();
    try {
      await setStateP({ blockMode: r.value });
    } catch (e) {
      renderApp();
      return;
    }
    renderApp();
    // Say what actually happened. An empty allow list means every open tab gets
    // locked at once, and the count proves it rather than leaving you guessing.
    const toAllow = r.value === "whitelist";
    const emptyAllow = !(st.allowedSites || []).length;
    chrome.runtime.sendMessage({ type: "refreshBlockedTabs" }, (res) => {
      const n = (res && res.locked) || 0;
      const tabs = n === 1 ? "1 tab" : n + " tabs";
      if (st.enabled === false) {
        return toast("FocusGate is switched off, so nothing is blocked. Turn it on from its toolbar icon.");
      }
      if (toAllow && emptyAllow) {
        return toast(n
          ? "Allowlist on · nothing is allowed yet, so " + tabs + " locked"
          : "Allowlist on · nothing is allowed yet, so every site is blocked");
      }
      toast(n ? "Saved · " + tabs + " locked" : "Saved");
    });
  }));
  // Both lists take one site or a whole comma-separated list in one go.
  //
  // No refusal message argument any more, and no strict-mode check. The two lists point in
  // opposite directions and setStateP already knows it: adding to the BLOCKED list shuts one more
  // site, so it goes through during a strict window, while adding to the ALLOWED list opens one,
  // so it is refused. One blanket refusal here could only ever have been right about one of them,
  // and it was wrong about the blocklist — being frozen also stopped you blocking anything new.
  async function addToList(key, boxId) {
    const st = await getState();
    const raws = splitSites($("#" + boxId).value);
    if (!raws.length) return;
    const cur = st[key] || [];
    const seen = new Set(cur.map(b => String(b.url || "").toLowerCase()));
    const add = [];
    const bad = [];
    let dupes = 0;
    raws.forEach(raw => {
      const v = normSite(raw);
      // normSite returns "" for anything that isn't a host name. Named rather than
      // dropped: a word that silently disappears looks like the box ate it, and a word
      // that silently becomes a chip is worse — you believe the site is covered when
      // nothing about it is.
      if (!v) { bad.push(raw); return; }
      const k = v.toLowerCase();
      if (seen.has(k)) { dupes++; return; }
      seen.add(k);
      add.push({ url: v });
    });
    if (bad.length) {
      const shown = bad.slice(0, 3).map(b => `"${b}"`).join(", ");
      const more = bad.length > 3 ? ` and ${bad.length - 3} more` : "";
      toast(`${shown}${more} ${bad.length === 1 ? "isn't" : "aren't"} a site — try something like youtube.com`);
    }
    if (!add.length) { if (!bad.length) toast(addedToast(0, dupes)); return; }
    await setStateP({ [key]: [...cur, ...add] });
    chrome.runtime.sendMessage({ type: "refreshBlockedTabs" });
    renderApp();
    // Only when there is something good to report; the refusal above has already spoken.
    if (!bad.length) toast(addedToast(add.length, dupes));
  }
  $("#addBlocked")?.addEventListener("click", () => addToList("blockedSites", "newBlocked"));
  $("#addAllowed")?.addEventListener("click", () => addToList("allowedSites", "newAllowed"));

  // ---- whole categories ----
  document.querySelectorAll("[data-catfold]").forEach(b => b.addEventListener("click", () => {
    const key = b.getAttribute("data-catfold");
    catOpenFor = catOpenFor === key ? null : key;
    renderApp();
  }));
  document.querySelectorAll("[data-cat]").forEach(b => b.addEventListener("click", async () => {
    const [key, catId] = String(b.getAttribute("data-cat") || "").split("|");
    const cat = (FGSettings.SITE_CATEGORIES || []).find(c => c.id === catId);
    if (!cat || (key !== "blockedSites" && key !== "allowedSites")) return;
    // Normalised through the same function the box uses, so what a chip adds and what the count
    // claims it added are the same strings.
    const want = cat.sites.map(normSite).filter(Boolean);
    const st = await getState();
    const cur = st[key] || [];
    const have = new Set(cur.map(x => String(x.url || "").toLowerCase()));
    const missing = want.filter(u => !have.has(u.toLowerCase()));
    // A chip is a toggle: with the whole set already in, press it to take the whole set back out.
    // A one-way chip would leave fifteen entries to remove by hand, which is the problem it exists
    // to solve, pointing the other way.
    const removing = missing.length === 0;
    // Direction, and it is opposite for the two lists — which is why this is decided here and not
    // assumed. Adding to the BLOCKED list shuts more doors and is a tightening; adding to the
    // ALLOWED list opens them and is a loosening. setStateP already knows, so this only has to hand
    // it the right patch and let it judge.
    let next;
    if (removing) {
      const drop = new Set(want.map(u => u.toLowerCase()));
      next = cur.filter(x => !drop.has(String(x.url || "").toLowerCase()));
    } else {
      next = [...cur, ...missing.map(url => ({ url }))];
    }
    try {
      await setStateP({ [key]: next });
    } catch (e) {
      return;                                  // refused: nothing written, nothing to put back
    }
    // Sites coming on or off either list changes what should be locked, so the tabs you already have
    // open are re-checked rather than left until the next minute tick.
    chrome.runtime.sendMessage({ type: "refreshBlockedTabs" }, (res) => {
      const n = (res && res.locked) || 0;
      const nm = cat.name.toLowerCase();
      if (removing) {
        return toast(key === "blockedSites"
          ? `${cat.icon} ${cat.name} unlocked — ${want.length} sites off the list`
          : `${cat.icon} ${cat.name} removed from the allowed list`);
      }
      const added = missing.length;
      if (key === "allowedSites") {
        return toast(`${cat.icon} ${added} ${nm} site${added === 1 ? "" : "s"} allowed`);
      }
      toast(n
        ? `${cat.icon} ${added} ${nm} site${added === 1 ? "" : "s"} locked · ${n} tab${n === 1 ? "" : "s"} shut now`
        : `${cat.icon} ${added} ${nm} site${added === 1 ? "" : "s"} locked`);
    });
    renderApp();
  }));

  // ---- the AI half of the category picker ----
  //
  // The master switch needs the Google origin, and it has to be asked for BEFORE the write, for the reason
  // the Study topics switch documents at length: setStateP can raise a password dialog, and awaiting that
  // first spends the user gesture that chrome.permissions.request needs.
  $("#aiCatSw")?.addEventListener("change", async () => {
    const want = !!$("#aiCatSw").checked;
    if (want && !(await askAiOrigin())) {
      $("#aiCatSw").checked = false;
      toast("Not switched on — it needs permission to reach Google's API");
      return;
    }
    try { await setStateP({ aiCatEnabled: want }); } catch (e) { renderApp(); return; }
    // Switching it on can shut sites that are open right now, and switching it off has to release them —
    // neither should wait for the next minute tick.
    chrome.runtime.sendMessage({ type: "refreshBlockedTabs" });
    renderApp();
    if (!want) return toast("AI category blocking off — only the addresses you listed are used");
    const st = await getState();
    if (!String(st.aiTopicKey || "").trim()) {
      return toast("On, but there's no Gemini API key yet — add one in Settings → General → 🎯 Study topics",
                   { cls: "wide", ms: 6500 });
    }
    toast("On — pick the categories below", { ms: 4000 });
  });
  document.querySelectorAll("[data-aicat]").forEach(b => b.addEventListener("click", async () => {
    const [key, catId] = String(b.getAttribute("data-aicat") || "").split("|");
    const cat = (FGSettings.SITE_CATEGORIES || []).find(c => c.id === catId);
    if (!cat) return;
    const listKey = key === "allowedSites" ? "aiCatAllow" : "aiCatBlock";
    const otherKey = listKey === "aiCatAllow" ? "aiCatBlock" : "aiCatAllow";
    const st = await getState();
    const cur = Array.isArray(st[listKey]) ? st[listKey] : [];
    const other = Array.isArray(st[otherKey]) ? st[otherKey] : [];
    // Refused rather than silently moved. A category on both lists is a rule that contradicts itself, and
    // quietly taking it off the other one would change a decision the user made elsewhere on this page.
    if (other.includes(catId)) {
      return toast(`${cat.icon} ${cat.name} is on the other AI list — take it off there first`,
                   { cls: "wide", ms: 4500 });
    }
    const had = cur.includes(catId);
    const next = had ? cur.filter(x => x !== catId) : [...cur, catId];
    try { await setStateP({ [listKey]: next }); } catch (e) { return; }
    chrome.runtime.sendMessage({ type: "refreshBlockedTabs" });
    renderApp();
    const verb = listKey === "aiCatAllow" ? "allowed" : "blocked";
    toast(had
      ? `${cat.icon} ${cat.name} no longer ${verb} by AI`
      : `${cat.icon} Every site the AI reads as ${cat.name.toLowerCase()} is now ${verb}`,
      { cls: "wide", ms: 4500 });
  }));

  // ---- Phone apps (MacroDroid), folded into this card ----
  $("#phoneHead")?.addEventListener("click", () => {
    phoneOpen = !phoneOpen;
    $("#phoneHead").setAttribute("aria-expanded", phoneOpen ? "true" : "false");
    const body = $("#phoneBody");
    if (body) body.hidden = !phoneOpen;
  });
  // No Save button here either: the switch writes at once, the two web
  // addresses write half a second after you stop typing.
  let mdTimer = 0;
  // Switching phone blocking on, or filling in the lock address for the first time, both make
  // more of your day unavailable — so both go through during a strict window. Switching it off,
  // or clearing the lock address (which stops the blocking while leaving the switch looking on),
  // is a loosening and is refused. The blanket check that used to sit here froze all four.
  async function saveMobile() {
    if (editLocked) {
      if (!(await requireUnlock())) {
        renderApp();
        return;
      }
    }
    const on = !!($("#mdEnabled") && $("#mdEnabled").checked);
    const lockUrl = ($("#mdLockUrl")?.value || "").trim();
    const unlockUrl = ($("#mdUnlockUrl")?.value || "").trim();
    // What was stored before this write, read BEFORE it. The connectivity reminder below has to
    // fire on the moment the switch goes on and not on every save, and this function is also the
    // debounced handler for both address boxes — so without a before-and-after the sentence would
    // reappear every half second while somebody pasted a URL.
    let was = false;
    try { was = !!(await getState()).macrodroidEnabled; } catch {}
    try {
      await setStateP({
        macrodroidEnabled: on,
        macrodroidLockUrl: lockUrl,
        macrodroidUnlockUrl: unlockUrl,
        mobileLockSent: null // force a fresh push on next sync
      });
    } catch (e) {
      renderApp();
      return;
    }
    const badge = $("#phoneState");
    if (badge) badge.textContent = on ? "on" : "off";
    const say = $("#mdSaved");
    if (say) {
      say.textContent = "saved ✓";
      clearTimeout(saveMobile._t);
      saveMobile._t = setTimeout(() => { if (say) say.textContent = ""; }, 1600);
    }
    chrome.runtime.sendMessage({ type: "macrodroidSync" });
    // The switch itself moved, as opposed to somebody typing in one of the address boxes.
    if (on !== was) {
      // Redrawn, because each site in step 1 carries a "📱 Phone waits for this" switch that is
      // only drawn while the bridge is on — so turning it on has to make those appear, and turning
      // it off has to take them away. Deliberately NOT done on the address-box path: this function
      // is also their debounced save, and re-rendering mid-sentence would take the box you are
      // typing in out from under the cursor. The fold state and the scroll position are both
      // remembered across a render, so the phone card stays open and in place.
      renderApp();
      // Switched ON: this is the one feature in FocusGate that depends on something outside this
      // computer, and the way it fails is silent — a phone with no connection never hears the call,
      // so nothing blocks and nothing says why. Saying it at the moment the feature is asked for is
      // the only point where it is still advice rather than a post-mortem.
      //
      // After renderApp, which rebuilds the tab and would otherwise be free to run over it — the
      // toast hangs off document.body rather than the tab, but the order is what makes that
      // guarantee rather than a coincidence. Longer than the default 2.5s because it is a sentence
      // to read, not a result to glance at.
      if (on) {
        toast("📱 Phone blocking is on. Make sure your mobile phone has internet connectivity — " +
              "it has to be online to hear FocusGate. If it is offline, the next try goes out about a minute later.",
              { cls: "wide phone", ms: 7000 });
      }
    }
  }
  $("#mdEnabled")?.addEventListener("change", saveMobile);
  ["mdLockUrl", "mdUnlockUrl"].forEach(id => {
    const el = $("#" + id);
    if (!el) return;
    el.addEventListener("pointerdown", async (e) => {
      if (editLocked) {
        e.preventDefault();
        if (await requireUnlock()) {
          renderApp();
          $("#" + id)?.focus();
        } else {
          toast("Password needed to edit webhook URL 🔒");
        }
        return;
      }
    });
    el.addEventListener("focus", async () => {
      if (editLocked) {
        el.blur();
        if (await requireUnlock()) {
          renderApp();
          $("#" + id)?.focus();
        } else {
          toast("Password needed to edit webhook URL 🔒");
        }
        return;
      }
    });
    el.addEventListener("input", () => { clearTimeout(mdTimer); mdTimer = setTimeout(saveMobile, 500); });
    el.addEventListener("change", () => { clearTimeout(mdTimer); saveMobile(); });
    el.addEventListener("keydown", (e) => {
      if (e.key !== "Enter" || e.isComposing) return;
      e.preventDefault(); clearTimeout(mdTimer); saveMobile(); el.blur();
    });
  });
  $("#mdTestLock")?.addEventListener("click", async () => {
    if (editLocked) {
      if (!(await requireUnlock())) {
        toast("Password needed to test webhook 🔒");
        return;
      }
      renderApp();
    }
    const url = ($("#mdLockUrl")?.value || "").trim();
    if (!url) return toast("Put the lock web address in first");
    chrome.runtime.sendMessage({ type: "macrodroidTest", url, locked: true }, (r) => {
      toast(r && r.ok ? "Lock sent to your phone" : "Could not reach your phone");
    });
  });
  $("#mdTestUnlock")?.addEventListener("click", async () => {
    if (editLocked) {
      if (!(await requireUnlock())) {
        toast("Password needed to test webhook 🔒");
        return;
      }
      renderApp();
    }
    const url = ($("#mdUnlockUrl")?.value || "").trim();
    if (!url) return toast("Put the unlock web address in first");
    chrome.runtime.sendMessage({ type: "macrodroidTest", url, locked: false }, (r) => {
      toast(r && r.ok ? "Unlock sent to your phone" : "Could not reach your phone");
    });
  });
  $("#mdSync")?.addEventListener("click", async () => {
    if (editLocked) {
      if (!(await requireUnlock())) {
        toast("Password needed to sync webhook 🔒");
        return;
      }
      renderApp();
    }
    chrome.runtime.sendMessage({ type: "macrodroidSync" }, () => toast("Sent to your phone"));
  });

  document.querySelectorAll('[data-delb]').forEach(b => b.addEventListener("click", async () => {
    const url = b.getAttribute("data-delb");
    const cur = (await getState()).blockedSites || [];
    await setStateP({ blockedSites: cur.filter(x=>x.url!==url) });
    // Off the locked list means open now, not on the next sweep.
    chrome.runtime.sendMessage({ type: "refreshBlockedTabs" });
    renderApp();
  }));
  document.querySelectorAll('[data-dela]').forEach(b => b.addEventListener("click", async () => {
    const url = b.getAttribute("data-dela");
    const cur = (await getState()).allowedSites || [];
    await setStateP({ allowedSites: cur.filter(x=>x.url!==url) });
    chrome.runtime.sendMessage({ type: "refreshBlockedTabs" });
    renderApp();
  }));

  // ---- picking several, and clearing the lot ----
  //
  // One writer for both, because they are the same act at two sizes and both have to be judged the same
  // way: taking sites off either list is a LOOSENING, so setStateP can refuse it outright during a
  // strict window. On a refusal the page is redrawn so every chip goes back to what is actually stored,
  // rather than leaving a list on screen that does not exist.
  async function chipRemove(key, gone) {
    if (!gone.size) return;
    const cur = (await getState())[key] || [];
    const next = cur.filter(x => !gone.has(String(x.url || "")));
    if (next.length === cur.length) { renderApp(); return; }   // nothing matched; put the view straight
    try {
      await setStateP({ [key]: next });
    } catch (e) {
      renderApp();                                             // refused: setStateP has said why
      return;
    }
    chipSelKey = null;
    chipSel.clear();
    // Off the locked list means open now, not on the next sweep — and off the ALLOW list means shut now.
    chrome.runtime.sendMessage({ type: "refreshBlockedTabs" });
    renderApp();
    const n = cur.length - next.length;
    toast(`Removed ${n} site${n === 1 ? "" : "s"}`);
  }
  // The header's own count and the Remove button, patched in place.
  //
  // In place rather than through renderApp, and that is the point: a list of a hundred chips redrawn on
  // every tick is a list that feels stuck. Nothing else on the page is derived from which chips are
  // ticked, so there is nothing else to keep in step.
  function paintChipHead() {
    const key = chipSelKey;
    if (!key) return;
    const lab = document.querySelector(`[data-chipn="${key}"]`);
    const total = document.querySelectorAll("[data-chippick]").length;
    if (lab) lab.textContent = `${chipSel.size} of ${total} picked`;
    const del = document.querySelector(`[data-chipdel="${key}"]`);
    if (del) {
      del.disabled = chipSel.size === 0;
      del.textContent = "Remove" + (chipSel.size ? " " + chipSel.size : "");
    }
  }
  document.querySelectorAll("[data-chipsel]").forEach(b => b.addEventListener("click", () => {
    chipSelKey = b.getAttribute("data-chipsel");
    chipSel.clear();
    renderApp();
  }));
  document.querySelectorAll("[data-chipcancel]").forEach(b => b.addEventListener("click", () => {
    chipSelKey = null;
    chipSel.clear();
    renderApp();
  }));
  document.querySelectorAll("[data-chipall]").forEach(b => b.addEventListener("click", () => {
    document.querySelectorAll("[data-chippick]").forEach(el => chipSel.add(el.getAttribute("data-chippick")));
    renderApp();
  }));
  document.querySelectorAll("[data-chipnone]").forEach(b => b.addEventListener("click", () => {
    chipSel.clear();
    renderApp();
  }));
  document.querySelectorAll("[data-chippick]").forEach(el => {
    const pick = (e) => {
      if (e) { e.preventDefault(); e.stopPropagation(); }
      const url = el.getAttribute("data-chippick");
      if (chipSel.has(url)) chipSel.delete(url); else chipSel.add(url);
      const on = chipSel.has(url);
      el.classList.toggle("on", on);
      el.setAttribute("aria-checked", on ? "true" : "false");
      const t = el.querySelector(".tick");
      if (t) t.textContent = on ? "✓" : "";
      paintChipHead();
    };
    el.addEventListener("click", pick);
    el.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") pick(e); });
  });
  // No confirmation here on purpose: ticking each chip WAS the confirmation, and a sheet on top of a
  // decision somebody just made by hand is one question asked twice.
  document.querySelectorAll("[data-chipdel]").forEach(b => b.addEventListener("click", async () => {
    await chipRemove(b.getAttribute("data-chipdel"), new Set(chipSel));
  }));
  // This one does ask, because a single press stands for every entry and nothing on screen says which.
  document.querySelectorAll("[data-chipclear]").forEach(b => b.addEventListener("click", async () => {
    const key = b.getAttribute("data-chipclear");
    const cur = (await getState())[key] || [];
    if (!cur.length) return;
    const allow = key === "allowedSites";
    const okGo = await confirmAsk({
      title: `Clear all ${cur.length} sites?`,
      body: allow
        ? `Every site comes off your allow list. With the allow list empty and that mode on, <b>nothing at all is allowed</b> until you add something back.`
        : `Every site comes off your locked list, so all of them open again straight away.`,
      go: "Clear all", no: "Keep them", danger: true
    });
    if (!okGo) return;
    await chipRemove(key, new Set(cur.map(x => String(x.url || ""))));
  }));
}

// The website anti-cheat checks are folded away by default — they're set once
// and rarely touched. Remembered while the page is open.
let cheatOpen = false;
// The four groups inside it fold too — see GRP_OPEN, which the per-site panel shares.
function renderGeneral(s) {
  const tc = document.getElementById("tabContent");
  const strict = inStrictWindow(s);
  // Is a deadline running? Its own question, separate from `strict` above — which is
  // "frozen right now, for either reason". A running deadline makes `strict` true as well,
  // so the times are frozen by it; what this one adds is that the deadline's OWN switch and
  // its boxes are locked.
  const deadline = FGStrict.strictDeadlineActive(s);
  const untilTime = FGStrict.strictUntilTime(s);
  const untilNow = FGStrict.strictUntil(s);
  const leftText = FGStrict.strictLeftText(s);
  // The boxes open on the commitment if there is one, otherwise on today. Either way the
  // row shows a real date you can read straight away, and an arrow press moves from
  // somewhere sensible rather than from an empty box. A commitment that has already run
  // out seeds today, not the day it ended — opening on a date in the past would mean the
  // row greeting you with a complaint about a number you never typed.
  const todayStamp = FGStrict.todayStamp(s);
  // FGStrict.fin, not a local `num` helper — this page has never had one. Digits come off
  // date strings and out of number boxes in several places below, and every one of them
  // must read a stray "" or "1e3" the same way the guard does.
  const seed = ((untilNow && untilNow >= todayStamp) ? untilNow : todayStamp).split("-").map(FGStrict.fin);
  const thisYear = FGStrict.fin(todayStamp.slice(0, 4));
  // Day, then month, then year — the order the date is spoken in.
  const untilBox = (id, label, value, min, max, off) => `
    <span class="dpart${off ? " off" : ""}">
      <button class="dspin" type="button" data-dstep="${id}:1" aria-label="${label} up" ${off ? "disabled" : ""}>▲</button>
      <input class="input dnum" id="until${id}" type="number"
             min="${min}" max="${max}" step="1" value="${value}"
             inputmode="numeric" aria-label="${label}" ${off ? "disabled" : ""} data-testid="strict-until-${label}"/>
      <button class="dspin" type="button" data-dstep="${id}:-1" aria-label="${label} down" ${off ? "disabled" : ""}>▼</button>
      <i>${label}</i>
    </span>`;
  // The month by name, in a list you can drop open.
  //
  // Deliberately not a number box like the two either side of it. A number is the one part
  // of a date that cannot be read without knowing which convention it was written in: 8 is
  // August here and the 8th in half the world's date formats — on the control that sets how
  // long you cannot let yourself off, which is the last place for a value that can be
  // misread. The name AND the number, because the number is what every date written down
  // anywhere else uses, and with only the name this box was the one part of the row you
  // could not check against one.
  const untilMonthBox = (value, off) => `
    <span class="dpart wide-m${off ? " off" : ""}">
      <button class="dspin" type="button" data-dstep="M:1" aria-label="month up" ${off ? "disabled" : ""}>▲</button>
      <select class="input dsel" id="untilM" aria-label="month" ${off ? "disabled" : ""} data-testid="strict-until-month">
        ${FGStrict.MONTHS_LONG.map((nm, i) =>
          `<option value="${i + 1}"${(i + 1) === value ? " selected" : ""}>${escHtml(nm)} · ${i + 1}</option>`).join("")}
      </select>
      <button class="dspin" type="button" data-dstep="M:-1" aria-label="month down" ${off ? "disabled" : ""}>▼</button>
      <i>month</i>
    </span>`;
  // The same four folds as a target's own panel, from the same builder — so the two views
  // cannot drift apart in their names, their order or which of them is open.
  const cgrp = (key, icon, title) => grpOpen(key, icon, title, s, "");
  // The three number sliders, read through the one table that also draws them in a target's own
  // panel and saves them from both places. Pulled out here because each appears twice in the
  // markup below — once as the slider's value, once as the label beside its thumb — and the two
  // disagreeing would be a puzzle with no way to tell which was the real setting.
  const paceFast = paceVal("paceFast", s.paceFast);
  const paceSlow = paceVal("paceSlow", s.paceSlow);
  const paceBox = paceVal("paceBoxPct", s.paceBoxPct);
  const autoLockPresets = [
    { label: "Immediate", sec: 0 },
    { label: "30 sec", sec: 30 },
    { label: "1 min", sec: 60 },
    { label: "5 min", sec: 300 }
  ];
  const curDelay = s.autoLockDelaySec || 0;
  tc.innerHTML = `
    <div class="card">
      <h2><span class="ic">🔐</span> Auto-lock ${tip("When you close this page or the little popup, FocusGate locks itself again and asks for your password next time.<br/><br/>Pick how soon that happens. <b>Now</b> is the safest. There's no manual lock button — it's automatic.")}</h2>
      <div class="toolbar">
        ${autoLockPresets.map(p => `<button class="btn ${curDelay===p.sec?'':'sec'}" data-lock="${p.sec}" data-testid="autolock-${p.sec}">${p.label}</button>`).join("")}
        <span class="timeset plain">
          <span class="gicon" aria-hidden="true">⏳</span>
          <label class="tfld"><input class="input" id="customLock" type="number" min="0" max="3600" value="${curDelay}" title="Or type your own number of seconds — it saves itself" aria-label="Or type your own number of seconds" data-testid="autolock-custom-input"/><i>s</i></label>
        </span>
      </div>
    </div>

    <div class="card">
      <button class="cardfold" id="cheatHead" type="button" aria-expanded="${cheatOpen ? "true" : "false"}" aria-controls="cheatBody" data-testid="cheat-fold">
        ${CARET}
        <span class="ic" aria-hidden="true">🛡️</span>
        <span class="ttl">Cheating prevention (conditions)</span>
        <span class="cnt" id="cheatCount">${
          [s.mediaPlayingRequired,
           s.inactivityPauseEnabled, s.fullscreenOnlyEnabled !== false, s.splitViewBlockEnabled !== false,
           s.faceDetectionEnabled, s.eyeTrackingEnabled, s.livenessEnabled === true].filter(Boolean).length
        }/7 on</span>
      </button>
      ${tip(`These checks apply to your <b>work websites</b>.<br/><br/>They make sure you're really there instead of leaving a page open.<br/><br/><b>These are the defaults.</b> Any one site can keep its own copy instead — press the <b>🛡️</b> on its row in <b>🎯 Earn &amp; Unlock</b>. A video lecture may want the camera and no split screen while a reading site only needs the stillness check.<br/><br/>Everything here saves itself the moment you change it.${strict ? "<br/><br/><b style='color:#fca5a5'>Strict mode is on: these checks are frozen, so you can't weaken them now.</b>" : ""}`)}

      <div class="cbody" id="cheatBody" ${cheatOpen ? "" : "hidden"}>
      <!-- The same four groups, in the same order, as a target's own panel in
           🎯 Earn &amp; Unlock. Each heading is the QUESTION its rows answer, so switching one
           on tells you what the others in that group would add on top of it. -->
      ${cgrp("media", "▶️", "Media tracking")}
      <div class="srow">
        <span class="ic">▶️</span>
        <span class="lbl grow">Media tracking ${tip("<b>Only counts while a video or audio is playing.</b> For targets where the work <b>is</b> watching or listening — a lecture on YouTube, a talks site — an open tab proves nothing. With this on, the clock only moves while a <b>video or audio is actually playing</b> on the page.<br/><br/>Pause it and the timer stops; press play and it starts again.<br/><br/><b>Muted doesn't count.</b> A muted video is usually an ad loop or a background clip, not something you're following.<br/><br/>Leave it <b>off</b> for reading sites — there's nothing to play there, so it would never let the clock run.<br/><br/>Most people want this on one or two targets rather than everywhere: press the <b>🛡️</b> on that site's row in <b>🎯 Earn &amp; Unlock</b> and set it there instead.")}</span>
        ${sw("mediaOnly", s.mediaPlayingRequired, false, "media-only")}
      </div>
      <!-- Nested under media tracking, because they are about the same thing: that row
           decides whether a playing video is what earns you the time, these two decide what
           happens to that video when the time stops.
           Deliberately NOT hidden when media tracking is off, unlike the child row below it,
           which is why this one is absent from KIDS.
           The indent groups them with it; it does not make them depend on it — pausing a
           video when the clock stops works whether or not the video is what is being
           counted. Neither is a condition either, so strict mode leaves both alone and the
           badge above does not count them. -->
      <div class="srow ind1">
        <span class="ic">⏯️</span>
        <span class="lbl grow">Pause the video when the clock stops ${tip("<b>Off by default</b> — it reaches into the page and stops what is playing there, so it is asked for rather than assumed. Whenever your time stops counting — your face left the camera, your eyes went off the screen, the window isn't full screen, you took a break, you went still, you switched tab — whatever is playing on the work page is <b>paused too</b>.<br/><br/>Without it, getting up from the desk leaves the clock correctly frozen and the lecture running on to an empty chair. You come back to a video twenty minutes further along and a timer that hasn't moved. The minutes you can earn back; the part of the video that went past, you can't.<br/><br/>It's <b>not a fight.</b> It asks a couple of times and then stops, so if you press play again on purpose it leaves you alone.<br/><br/>Reaches a <code>video</code> or <code>audio</code> on the page itself. A video inside an <b>embedded frame</b> can't be controlled from outside, which is the same limit <b>Media tracking</b> has.<br/><br/>Nothing happens once that target is finished — the gate has been satisfied and your media is your business.<br/><br/><b>sec back</b> = how far the video is wound back as it pauses. The last few seconds before you looked away were played, not taken in, so resuming exactly where it stopped means resuming into a gap. <b>5</b> is about one sentence of a lecture. Set it to <b>0</b> to pause where it is and not move.<br/><br/>You can flip this switch from the camera window too — it's the fourth disc in the sliders menu, which is where you are when it matters.")}</span>
        <span class="timeset plain">
          <span class="gicon" aria-hidden="true">⏪</span>
          <!-- "sec back", not the bare "s" every other number well on this page uses.
               Those all measure how long something lasts, so seconds is the only thing
               they could mean; this one is a direction as well as a duration, and a lone
               "s" next to a pause switch reads as "wait this long before pausing". -->
          <label class="tfld"><input class="input" id="mediaBack" type="number" min="0" max="120" value="${s.mediaRewindSec === undefined ? 5 : s.mediaRewindSec}" title="Seconds to wind the video back when it pauses" aria-label="Seconds to wind the video back when it pauses" data-testid="media-back"/><i>sec back</i></label>
        </span>
        ${sw("mediaPause", s.mediaPauseEnabled === true, false, "media-pause")}
      </div>

      <!-- A child of the switch above, because it undoes that switch's work and means
           nothing without it. -->
      <div class="srow ind2" id="mediaResumeRow" hidden>
        <span class="ic">▶️</span>
        <span class="lbl grow">Auto resume ${tip("Once every condition is satisfied again — you look back at the camera, the window goes back to full screen, the break ends — whatever was paused <b>carries on by itself</b>, from <b>sec back</b> earlier than where it stopped.<br/><br/>So looking away and looking back costs you nothing but the seconds you were away. Without this you get the clock back and press play yourself.<br/><br/>Only ever the players FocusGate paused. A video you stopped on purpose is left exactly as you left it.")}</span>
        ${sw("mediaResume", s.mediaResumeEnabled === true, false, "media-resume")}
      </div>

      <div class="srow">
        <span class="ic">⏸️</span>
        <span class="lbl grow">Mouse cursor inactivity tracker ${tip("<b>Pauses when you stop moving.</b> If you don't touch the mouse, keyboard, or scroll for a while, the timer freezes. Move the mouse and it starts again.<br/><br/>Stops the \"leave the page open and walk away\" trick. The number is how many seconds of stillness before it pauses — it saves itself as you type.<br/><br/>Watching a video counts as being there, but only while the camera check is on and can see you — otherwise you could start a lecture and walk away.")}</span>
        <span class="timeset plain">
          <span class="gicon" aria-hidden="true">⏳</span>
          <label class="tfld"><input class="input" id="inactTimeout" type="number" min="5" max="600" value="${s.inactivityTimeoutSec || 30}" title="Seconds of stillness before it pauses" aria-label="Seconds of stillness before it pauses" data-testid="inact-timeout"/><i>s</i></label>
        </span>
        ${sw("inactEnabled", s.inactivityPauseEnabled, false, "inact-enabled")}
      </div>

      ${grpEnd()}

      ${cgrp("screen", "🖥️", "Screen")}
      <div class="srow">
        <span class="ic">🖥️</span>
        <span class="lbl grow">Full screen forcer ${tip("The timer runs only while this browser window <b>fills the whole screen</b> and is the window you're clicked into.<br/><br/>Shrink it to half the screen, snap it to one side, or click over to another app or browser, and the timer <b>pauses</b> straight away.<br/><br/>This closes the trick of leaving a work page open at your face while you actually play or work in something else beside it.<br/><br/>Maximise the window (or press <span class='kbd'>F11</span>) to keep earning.")}</span>
        ${sw("fullscreenOnly", s.fullscreenOnlyEnabled !== false, false, "fullscreen-only")}
      </div>

      <div class="srow">
        <span class="ic">🪟</span>
        <span class="lbl grow">Split screen prevention ${tip("<b>The work page must have the whole window.</b> A <b>maximised</b> window can still be showing two pages side by side, and the check above can't tell: as far as the browser is concerned the window fills the screen.<br/><br/>This one measures how much of the window your <b>work page</b> actually gets, and it is deliberately unforgiving — <b>a strip of anything beside it is enough</b>, because a strip is enough to watch a video in. Chrome's <b>split view</b> (even while you're still picking the second tab), Edge's split screen, a side panel or <b>DevTools</b> docked beside the page all pause the timer until the page has the window to itself.<br/><br/>Page zoom is accounted for, so working at 125% or 150% is fine.<br/><br/>Turn it off if you genuinely need two pages open — notes beside a lecture, say.")}</span>
        ${sw("splitBlock", s.splitViewBlockEnabled !== false, false, "split-block")}
      </div>


      <!-- Last group, and named as what it is: nothing here decides whether a second
           counts. These act on the page while you work, and they used to sit among the
           checks — which made the card's own title a claim about three rows that were
           never conditions. Not frozen by strict mode and not in the badge either: they
           ask nothing of you and cannot hand you time you haven't spent.
           Same group, same place, as in a target's own panel. -->
      ${grpEnd()}

      ${cgrp("glow", "✨", "Glow")}
      <div class="srow">
        <span class="ic">✨</span>
        <span class="lbl grow">Glow on the page ${tip("A soft edge around the work page that says what the clock is doing without you having to look at it: <b>green</b> while time is counting, <b>red</b> while something has stopped it, <b>blue</b> once that target is finished.<br/><br/><b>On by default</b>.<br/><br/>It only ever appears on your work pages, it can't be clicked through by mistake, and it doesn't move a single pixel of the page's own layout.<br/><br/>This one is on the camera window too — the third disc in the sliders menu.")}</span>
        ${sw("pageGlow", s.pageGlowEnabled !== false, false, "page-glow")}
      </div>
      ${grpEnd()}

      <!-- The camera group. It was already the one fold in this card, under its own
           camOpen flag; it now comes from the same builder as the other three, so all four
           share one set of open/closed flags and one naming. -->
      ${cgrp("camera", "📷", "Camera")}
      <div class="sectbody-note">
        ${tip("Everything the camera watches for, in one place: that you're <b>there</b>, that your <b>eyes are on the screen</b>, and that you're a <b>real person</b> and not a photo.<br/><br/>Your video <b>never leaves your computer</b> — nothing is uploaded, recorded or saved. The browser asks permission the first time on each site.<br/><br/>The two sliders are for when the camera gets it wrong: move them if the clock stops while you <i>are</i> working, or if it keeps counting when you're not.<br/><br/>The beep that tells you the clock stopped is switched on and off from the camera window itself, next to the eye button.")}
      </div>
          <!-- How big the camera window is drawn. First in the group and not indented under
               anything, because it is the only row here that is not a check: it decides what YOU
               can see, not what the camera can. It is also the only one that keeps working when
               every check below it is off — the preview is still there, and still the wrong size.
               Never disabled by strict mode, and setStateP waves it through, because there is no
               strict direction to it. A smaller box does not make the face check easier to fool;
               the detector reads the camera stream at its own resolution either way. -->
          <div class="srow sub">
            <span class="ic">🔍</span>
            <span class="lbl grow">Camera window size ${tip("How big the camera preview is drawn on your work pages, in pixels across. The floating timer card is sized to match it.<br/><br/>There is no right answer, which is why it is a slider: the box sits on top of whatever you are working on, so a preview big enough to <b>aim by</b> on one screen is in the way on another. Drag it and the box resizes on every page you have open, straight away.<br/><br/><b>It costs nothing either way.</b> The camera is read at its own resolution, so the size of this box changes what you can see and <i>nothing</i> about what the checks can. Making it tiny does not make the face check easier to fool.<br/><br/>The smallest setting is about where you can no longer tell whether your face is centred, which is the only thing the picture is for. The largest is where the card stops being a card.")}</span>
            <span class="sens">
              <span class="sensend" aria-hidden="true">small</span>
              <input type="range" id="camSize" min="72" max="1280" step="2"
                     value="${camSizeVal(s)}"
                     aria-label="Camera window width in pixels, 72 to 1280" data-testid="cam-size"/>
              <span class="sensend" aria-hidden="true">large</span>
              <!-- id deliberately not "camSizeVal": that is the name of the function it calls, and
                   an element id becomes a property of the window object. A global function
                   declaration does win over named element access, so it would have worked — but
                   "works because of a precedence rule" is not a thing to leave in a file.
                   (No backticks in this comment: the whole block is a template literal, so one
                   would end the string here and turn the markup after it into code.) -->
              <b class="sensval" id="camSizeOut">${camSizeText(camSizeVal(s))}</b>
            </span>
          </div>
          <!-- Each check owns its own dial, indented under it, so it's obvious which
               slider belongs to which check. -->
          <div class="srow sub">
            <span class="ic">📷</span>
            <span class="lbl grow">Face detection ${tip("The timer only runs while your camera can see a face. Move out of shot and it stops <b>the same moment</b> — there is no countdown to set.<br/><br/>This beats auto-clickers and mouse-jigglers.<br/><br/>Your video never leaves your computer.")}</span>
            ${sw("faceEnabled", s.faceDetectionEnabled, false, "face-enabled")}
          </div>
          <!-- Every sub-option row ships hidden and is revealed by syncKidRows off the switch
               above it. See KIDS: one table, so the markup cannot disagree with it. -->
          <div class="srow sub kid" id="faceSensRow" hidden>
            <span class="ic">🎚️</span>
            <span class="lbl grow">Sensitivity ${tip("<b>What counts as you being there.</b> Each step accepts one weaker kind of evidence, so slide right if the timer keeps stopping while you <b>are</b> sitting and working.<br/><br/><b>strict</b> — upright and facing the camera, nothing else.<br/><b>firm</b> — a <b>tilted head</b> counts too.<br/><b>normal</b> — and your <b>head down</b> over a notebook, for as long as the picture keeps changing.<br/><b>kind</b> — and simply <b>being in the chair</b>, in any position, even completely still.<br/><b>easy</b> — the same, far more patient before it decides you've gone.<br/><br/>The bottom two work by learning what your room looks like <b>empty</b> — which it can only do once you've left it — and treating a picture that no longer matches as somebody sitting there. Until it has seen the room empty it falls back on waiting instead.<br/><br/><b>Leaving your desk stops the clock at every setting, including easy.</b> The camera keeps the picture as it was the last time your face was in it, and getting up changes most of that picture at once — your head, shoulders and arms all go, and the wall behind you arrives. Your head bent over a notebook changes only a small part of it. That difference is what separates a posture from an absence, and it is noticed within a fraction of a second, not waited out.<br/><br/>There is also a limit on how long any of these will carry you with <b>no face visible at all</b>, as a backstop for when that comparison has nothing to work with: about <b>1 minute</b> on normal, <b>2½</b> on kind, <b>7</b> on easy. One glance up at the screen starts it over.<br/><br/>Whenever one of these is carrying you rather than a real face, the <b>eye and blink checks pause</b>: there are no pupils to read from a scalp. On <b>kind</b> and <b>easy</b> the movement check pauses too, since sitting still is the whole point of them. Stay on <b>firm</b> or <b>normal</b> if you want those to keep applying.")}</span>
            <span class="sens">
              <span class="sensend" aria-hidden="true">strict</span>
              <input type="range" id="faceSens" min="1" max="5" step="1" value="${Math.min(5, Math.max(1, s.faceSensitivity || 3))}"
                     aria-label="Face detection sensitivity, 1 strict to 5 forgiving" data-testid="face-sens"/>
              <span class="sensend" aria-hidden="true">easy</span>
              <b class="sensval" id="faceSensVal">${["", "strict", "firm", "normal", "kind", "easy"][Math.min(5, Math.max(1, s.faceSensitivity || 3))]}</b>
            </span>
          </div>

          <div class="srow sub">
            <span class="ic">👀</span>
            <span class="lbl grow">Eye detection ${tip("Stricter than <b>Face detection</b>: your eyes must be <b>open and pointed at the screen</b>.<br/><br/><b>How long you may look away</b> is the number beside it. Look back at any point and you have the full time again; spend the whole time not looking at the screen and the clock waits until you do. So a blink, a glance at your keyboard or a look out of the window costs nothing.<br/><br/>How it works: the camera finds each eye and looks for the dark pupil inside it. A pupil near the middle means you're facing the screen; pushed to an edge means you're looking aside. Closed eyelids flatten the dark spot away.<br/><br/>Needs <b>Face detection</b> on as well. It's a webcam heuristic, not lab gaze tracking — it catches shut eyes and looking away, not a glance at the corner of the screen.")}</span>
            <span class="timeset plain">
              <span class="gicon" aria-hidden="true">⏳</span>
              <label class="tfld">
                <input class="input" id="eyeAway" type="number" min="0" max="600" value="${s.eyeAwaySec === undefined ? 10 : s.eyeAwaySec}"
                       title="How long you may look away, in seconds (0 to 600)"
                       aria-label="How long you may look away, in seconds" data-testid="eye-away"/>
                <i>s</i>
              </label>
            </span>
            ${sw("eyeEnabled", s.eyeTrackingEnabled, false, "eye-enabled")}
          </div>
          <div class="srow sub kid" id="eyeSensRow" hidden>
            <span class="ic">🎯</span>
            <span class="lbl grow">Sensitivity ${tip("<b>How fussy the eye check is.</b> Slide <b>left</b> to catch even a small glance away — the clock stops the moment your eyes leave the screen, and it waits barely a second before doing it.<br/><br/>Slide <b>right</b> if it stops while you <i>are</i> reading: glasses, dim light or a low camera angle all make pupils harder to see. Then only obvious looking away counts, and a longer glance is forgiven.<br/><br/>Works on your study sites.")}</span>
            <span class="sens">
              <span class="sensend" aria-hidden="true">fussy</span>
              <input type="range" id="eyeSens" min="1" max="5" step="1" value="${Math.min(5, Math.max(1, s.eyeSensitivity || 3))}"
                     aria-label="Eye detection sensitivity, 1 fussy to 5 easy" data-testid="eye-sens"/>
              <span class="sensend" aria-hidden="true">easy</span>
              <b class="sensval" id="eyeSensVal">${["", "fussy", "firm", "normal", "kind", "easy"][Math.min(5, Math.max(1, s.eyeSensitivity || 3))]}</b>
            </span>
          </div>

          <div class="srow sub">
            <span class="ic">🙂</span>
            <span class="lbl grow">Head movement check ${tip("<b>How long you may sit perfectly still.</b> Go this long without moving and the clock waits until you do. A photo propped in front of the lens never moves, so this blocks the photo trick.<br/><br/>The deadline slides forward every time you move, so if you're working normally you will never see it. At <b>5s</b>: move at 3s and you have until 8s; move again at 7s and you have until 12s.<br/><br/><b>Any</b> movement counts — a nod, a shift in your seat, leaning nearer or further. Nothing is ever demanded of you on a schedule; this only notices stillness. It no longer asks you to lean left and then right: turning your head far enough to cross the frame usually stops it being detected as a face at all, so obeying broke the measurement.<br/><br/>Anything from <b>0</b> to <b>1800</b> seconds. <b>0</b> means the clock only counts while you are actually moving. It saves itself as you type.")}</span>
            <!-- An hourglass and the unit beside the box, like the h / m / s wells
                 elsewhere, so the number isn't a bare 10 with no clue what it
                 counts. Every "seconds" box on this page looks like this one. -->
            <span class="timeset plain">
              <span class="gicon" aria-hidden="true">⏳</span>
              <label class="tfld">
                <input class="input" id="liveInterval" type="number" min="0" max="1800" value="${s.livenessIntervalSec === undefined ? 10 : s.livenessIntervalSec}"
                       title="How long you may sit still, in seconds (0 to 1800)" aria-label="How long you may sit perfectly still, in seconds" data-testid="live-interval"/>
                <i>s</i>
              </label>
            </span>
            ${sw("liveEnabled", s.livenessEnabled === true, false, "live-enabled")}
          </div>
          <!-- Directly under the check it belongs to. These sensitivity rows are indented
               children of the switch above them, so the order IS the labelling — put this
               below the blink row and it reads as the blink check's dial. -->
          <div class="srow sub kid" id="moveSensRow" hidden>
            <span class="ic">🎚️</span>
            <span class="lbl grow">Movement sensitivity ${tip("<b>How much counts as moving.</b> Slide right if the clock keeps waiting on you while you're sitting there working normally — small shifts and a nod will then be enough.<br/><br/>Slide left to demand a real change of position. Stricter is harder for a photograph being jiggled by hand to fake, but it also asks more of you.")}</span>
            <span class="sens">
              <span class="sensend" aria-hidden="true">strict</span>
              <input type="range" id="moveSens" min="1" max="5" step="1" value="${Math.min(5, Math.max(1, s.moveSensitivity || 3))}"
                     aria-label="Movement sensitivity, 1 strict to 5 forgiving" data-testid="move-sens"/>
              <span class="sensend" aria-hidden="true">easy</span>
              <b class="sensval" id="moveSensVal">${["", "strict", "firm", "normal", "kind", "easy"][Math.min(5, Math.max(1, s.moveSensitivity || 3))]}</b>
            </span>
          </div>

          <div class="srow sub">
            <span class="ic">😉</span>
            <span class="lbl grow">Blink check ${tip("<b>How long you may go without blinking.</b> Blink at any point and you have the full time again; go the whole time without one and the clock waits until you do.<br/><br/>This is the strongest proof the camera can get that a real person is sitting there. A photo can't blink at all, and a looping video blinks on a schedule — head movement can be faked by nudging a photo, but nothing short of a real face does this.<br/><br/>It only counts a proper blink: eyes closing <b>and opening again</b> soon after. Closing them and leaving them closed is what falling asleep looks like, so that doesn't count.<br/><br/>Needs <b>Face detection</b> on. If your blinks aren't being caught, the <b>Blink sensitivity</b> dial below tunes it.")}</span>
            <span class="timeset plain">
              <span class="gicon" aria-hidden="true">⏳</span>
              <label class="tfld">
                <input class="input" id="blinkEvery" type="number" min="0" max="600" value="${s.blinkIntervalSec === undefined ? 10 : s.blinkIntervalSec}"
                       title="Blink at least this often, in seconds (0 to 600)"
                       aria-label="Blink at least this often, in seconds" data-testid="blink-every"/>
                <i>s</i>
              </label>
            </span>
            ${sw("blinkEnabled", !!s.blinkRequired, false, "blink-enabled")}
          </div>
          <div class="srow sub kid" id="blinkSensRow" hidden>
            <span class="ic">🎚️</span>
            <span class="lbl grow">Blink sensitivity ${tip("<b>How much of a dip counts as an eyelid.</b> Slide right if your blinks aren't being noticed — glasses, dim light, deep-set eyes or a camera looking up at you all flatten the difference between an open eye and a closed one.<br/><br/>Slide left if something other than a blink is satisfying it.<br/><br/>It doesn't use a fixed brightness: it learns what <b>your</b> eyes look like open, in the light you're actually in, and watches for a drop from that. So it adapts to your setup rather than needing you to match a number.")}</span>
            <span class="sens">
              <span class="sensend" aria-hidden="true">clear</span>
              <input type="range" id="blinkSens" min="1" max="5" step="1" value="${Math.min(5, Math.max(1, s.blinkSensitivity || 3))}"
                     aria-label="Blink sensitivity, 1 needs a clear blink to 5 catches a flicker" data-testid="blink-sens"/>
              <span class="sensend" aria-hidden="true">faint</span>
              <b class="sensval" id="blinkSensVal">${["", "clear", "firm", "normal", "kind", "faint"][Math.min(5, Math.max(1, s.blinkSensitivity || 3))]}</b>
            </span>
          </div>

          <!-- Last in the camera group, and the only row in this card that changes how fast a
               second counts rather than whether it counts at all. Below the four checks because
               it reads as a different kind of thing, and inside the camera group because it is
               the same camera answering — it cannot work without Face detection on, so switching
               it on switches that on too. -->
          <div class="srow sub">
            <span class="ic">🚀</span>
            <span class="lbl grow">Speed up the timer when I face the camera ${tip("Lean in and the clock runs <b>faster</b>; sit back and it runs <b>slower</b>. A dashed square appears on the camera preview — fill it with your head and you are in.<br/><br/>Press <b>👁 Preview</b> to open your camera right here and watch the box while you set it. Moving the sliders changes the square live.<br/><br/>It is the same idea as the rest of the camera checks, pointed the other way round: instead of only stopping the clock when you are gone, this <b>rewards</b> being properly at your desk and paying attention. Ten minutes of real work at <b>1.5×</b> pays fifteen minutes off today's goal.<br/><br/>The box turns <b>green</b> when you are in it and <b>amber</b> when you are not, and it tells you which way to move — <i>COME CLOSER</i>, <i>MOVE LEFT</i>. The badge in the corner shows the speed you are being credited at right now.<br/><br/>Two things have to be true to be 'in': your head has to <b>fill</b> the box, and it has to be roughly <b>centred</b> in it. Both, separately — a small face dead centre is not the same as sitting up close.<br/><br/>A <b>tilted head</b>, a <b>head down</b> over a notebook, and simply <b>being in the chair</b> all count as the slow speed, however forgiving the sensitivity dial is. Those keep the clock <i>running</i>; they are not you facing the camera.<br/><br/>Needs <b>Face detection</b> on. <b>Off by default</b> — it is the one setting here that can finish a goal in less time than the goal asks for.")}</span>
            <button class="pvbtn" id="pacePreview" type="button"
                    title="Open your camera here and watch the box while you set it"
                    aria-label="Open the camera preview">👁 Preview</button>
            ${sw("paceEnabled", s.paceEnabled === true, false, "pace-enabled")}
          </div>
          <div class="srow sub kid" id="paceFastRow" hidden>
            <span class="ic">🚀</span>
            <span class="lbl grow">Head fills the box ${tip("How fast the clock runs while your head is <b>inside</b> the dashed box.<br/><br/><b>1×</b> is normal speed, so leaving it there turns the whole thing into a penalty and nothing else. <b>2×</b> means a minute of leaning in pays two minutes off the goal.<br/><br/>Nothing stops you setting this <i>below</i> the slow speed — the two are read as a range either way round — but it is worth knowing that is what you have done.")}</span>
            <span class="sens">
              <span class="sensend" aria-hidden="true">1×</span>
              <input type="range" id="paceFast" min="${PACE_DIAL.paceFast.min}" max="${PACE_DIAL.paceFast.max}"
                     step="${PACE_DIAL.paceFast.step}" value="${paceFast}"
                     aria-label="Timer speed while your head fills the focus box" data-testid="pace-fast"/>
              <span class="sensend" aria-hidden="true">4×</span>
              <b class="sensval" id="paceFastVal">${paceText("paceFast", paceFast)}</b>
            </span>
          </div>
          <div class="srow sub kid" id="paceSlowRow" hidden>
            <span class="ic">🐢</span>
            <span class="lbl grow">Head outside the box ${tip("How fast the clock runs while your head is <b>outside</b> the box — sitting back, turned away, or too far off to fill it.<br/><br/><b>1×</b> is normal speed, so leaving it there turns the whole thing into a bonus with no penalty: you earn extra for leaning in and lose nothing for not.<br/><br/><b>0.5×</b> means two minutes of sitting back pays one minute off the goal. The clock is still <b>running</b> either way — it is the camera checks above that stop it, not this.")}</span>
            <span class="sens">
              <span class="sensend" aria-hidden="true">0.1×</span>
              <input type="range" id="paceSlow" min="${PACE_DIAL.paceSlow.min}" max="${PACE_DIAL.paceSlow.max}"
                     step="${PACE_DIAL.paceSlow.step}" value="${paceSlow}"
                     aria-label="Timer speed while your head is outside the focus box" data-testid="pace-slow"/>
              <span class="sensend" aria-hidden="true">1×</span>
              <b class="sensval" id="paceSlowVal">${paceText("paceSlow", paceSlow)}</b>
            </span>
          </div>
          <div class="srow sub kid" id="paceBoxRow" hidden>
            <span class="ic">🔲</span>
            <span class="lbl grow">Focus box size ${tip("How big the dashed square is, as a share of the shorter side of the picture. This is what decides <b>how close you have to sit</b>.<br/><br/><b>Bigger box</b> — your head has to fill more of the frame, so you sit nearer. <b>Smaller box</b> — a head further back still counts.<br/><br/>Move it while the camera preview is open and watch the square change: that is the honest way to set it, since how much of the frame your head fills depends on your camera, your desk and how you sit.")}</span>
            <span class="sens">
              <span class="sensend" aria-hidden="true">30%</span>
              <input type="range" id="paceBox" min="${PACE_DIAL.paceBoxPct.min}" max="${PACE_DIAL.paceBoxPct.max}"
                     step="${PACE_DIAL.paceBoxPct.step}" value="${paceBox}"
                     aria-label="Focus box size, as a percentage of the picture" data-testid="pace-box"/>
              <span class="sensend" aria-hidden="true">85%</span>
              <b class="sensval" id="paceBoxVal">${paceText("paceBoxPct", paceBox)}</b>
            </span>
          </div>
          <!-- The top of that slider asks for more than a webcam can give, and there is no way to
               know that from the number. The detector's box hugs the face rather than the head, so
               a head filling the whole picture measures about 63% of its height — which clears a
               box of 74% and nothing above it. Set 80% and you are simply never in, the clock sits
               at the slow speed all session, and the feature reads as broken.
               Said here, on the row, rather than by clamping the slider: the reachable point
               depends on your camera's lens, so a hard ceiling would be wrong for somebody. -->
          <div class="srow sub kid" id="paceBoxWarnRow" hidden>
            <span class="ic">⚠️</span>
            <span class="lbl grow hint" id="paceBoxWarn"></span>
          </div>
      ${grpEnd()}
      </div>
    </div>

    <div class="card">
      <h2><span class="ic">🛑</span> Strict mode ${strict ? '<span class="st off">ON NOW</span>' : ""} ${tip("<b>Two switches, and they are independent.</b> Either one being active freezes your settings; use one, the other, or both.<br/><br/><b>Freeze settings every day</b> is a schedule: settings lock between two clock times and lift again each morning. For an evening routine.<br/><br/><b>Keep strict mode on until</b> is a stretch: on continuously, day and night, until a date and time you pick. It does not lift, so nothing — including this switch and the one above — can be loosened before it expires. For the week before an exam.<br/><br/>While either is active the rule is simple: <b>nothing can be loosened.</b><br/><br/>You <b>can</b> raise a target's time, add work sites, take sites off the locked list, and make the camera dials fussier.<br/><br/>You <b>cannot</b> lower a target's time, delete work, wind today's time back, unblock a site, swap the locked/allowed lists, ease the anti-cheat checks off, switch FocusGate off, change the day boundary, or turn either of these two switches off.")}</h2>

      <!-- Part one: the daily freeze. Its own switch now, rather than the single Turn on /
           Turn off button this card used to end with — the card does two things, and one
           button at the bottom could only ever have meant one of them. -->
      <div class="srow">
        <span class="ic">🕒</span>
        <span class="lbl grow">Freeze settings every day ${tip("The window of the day when your settings are locked, so you can't ease your own rules mid-session.<br/><br/>Example: <span class='kbd'>15:00</span> → <span class='kbd'>08:00</span> is 3 PM tonight until 8 AM tomorrow.<br/><br/>It lifts by itself each morning and comes back the next day. Switching it off is one of the things the date below can prevent.")}</span>
        <!-- Disabled only when it is ON and frozen. Disabling it whenever strict mode is
             active would also refuse you the one direction strict mode is for: switching a
             freeze ON mid-session is a tightening, and tightening is always allowed. -->
        ${sw("strictEn", !!s.strictModeEnabled, strict && !!s.strictModeEnabled, "strict-toggle")}
      </div>
      <div class="srow" style="padding-top:0">
        <span class="ic"></span>
        <span class="lbl">From</span>
        <input class="input" id="strictStart" type="time" value="${escHtml(strictTime(s.strictStart, STRICT_FROM))}" style="width:130px" ${strict?"disabled":""} data-testid="strict-start"/>
        <span class="lbl">to</span>
        <input class="input" id="strictEnd" type="time" value="${escHtml(strictTime(s.strictEnd, STRICT_TO))}" style="width:130px" ${strict?"disabled":""} data-testid="strict-end"/>
        <!-- The window saves itself, so there is no Save button. This says so once
             you've changed something, rather than a label sitting there forever. -->
        <span class="lbl grow hint" id="strictSaved" role="status" aria-live="polite"></span>
      </div>

      <!-- Part two: a deadline. Not a schedule and not a sub-option of the one above — a
           single continuous stretch from now until a moment you pick, during which nothing
           can be loosened. It stands on its own, and once it is running its switch is
           locked ON, which is the entire feature. -->
      <div class="srow">
        <span class="ic">⏳</span>
        <span class="lbl grow">Keep strict mode on until ${tip("<b>A stretch you cannot talk yourself out of.</b> Strict mode stays on continuously — day and night, not just inside a window — from now until the date and time you set.<br/><br/>Set the moment in the boxes, then <b>flip the switch</b>. There is no Save button: the switch is what starts it, and it asks you to confirm first.<br/><br/>Until it expires nothing can be loosened: a target's time cannot be lowered, today's time cannot be wound back, sites cannot be unblocked, the camera checks cannot be eased off, FocusGate cannot be switched off, and this cannot be turned off. Making things stricter is always allowed.<br/><br/>While it runs the boxes are locked, showing what you committed to — a commitment you can keep editing is not one. Pushing it further out is allowed; pulling it closer is refused.<br/><br/>This works <b>on its own</b> — it does not need the daily freeze above. Use that one for an evening routine, and this one for the week before an exam.<br/><br/>The boxes start on <b>today</b>, so each arrow press is one day, one month or one year further out. The time defaults to <b>23:59</b>, so leaving the date on today means the rest of today.<br/><br/>There is no undo, so pick a moment you actually want.")}</span>
        ${sw("strictUntilEn", !!s.strictUntilEnabled, deadline, "strict-until-toggle")}
      </div>
      <div class="srow dateset" style="padding-top:0">
        <span class="ic"></span>
        <span class="dstep">
          ${untilBox("D", "day", seed[2], 1, 31, deadline)}
          ${untilMonthBox(seed[1], deadline)}
          ${untilBox("Y", "year", seed[0], thisYear, thisYear + YEARS_AHEAD, deadline)}
        </span>
        <!-- The clock time on that date. A plain time input, not a fourth spinner: hours
             and minutes together are one value, and the browser's own control already
             knows how to type one. -->
        <span class="dpart wide${deadline ? " off" : ""}">
          <input class="input" id="untilT" type="time" value="${escHtml(untilTime)}"
                 style="width:118px" aria-label="Time on that date" ${deadline ? "disabled" : ""} data-testid="strict-until-time"/>
          <i>time</i>
        </span>
      </div>
      <!-- Three numbers are harder to read than one date, so the date is spelled out. It
           also has to be: the day is clamped to the month you land on, so 31 plus one
           month is the 28th or the 30th and the boxes alone would not tell you which. -->
      <div class="srow dpreview" style="padding-top:0">
        <span class="ic"></span>
        <span class="lbl hint" id="untilPreview" role="status" aria-live="polite"></span>
      </div>
      ${deadline ? `<div class="srow" style="padding-top:0">
        <span class="ic">🔒</span>
        <span class="lbl hint">Strict mode is held on until <b>${escHtml(FGStrict.strictUntilLabel(untilNow))}, ${escHtml(untilTime)}</b>${leftText ? " — " + escHtml(leftText) + " left" : ""}. Nothing can be loosened until then.</span>
      </div>` : ""}
    </div>

    <!-- ---- study topics -------------------------------------------------------
         The card for the other half of a target. Every row on Earn & Unlock can carry a topic —
         what you actually meant to DO there — and this is where the machinery that judges it is
         set up. Deliberately one card and not a fold: with the switch off it is four rows, and
         with it on it is the only place in the extension that sends anything to a third party, so
         it should be read rather than tucked away. -->
    <div class="card">
      <h2><span class="ic">🎯</span> Study topics ${tip("<b>A work site is an address. A topic is what you meant to do there.</b><br/><br/>FocusGate has only ever been able to check <i>where</i> you are. That works for a PDF and it does not work for a video site: the channel you added because it teaches linear algebra also has a podcast, a Q&amp;A and an hour of bloopers — and every second of those counted towards your maths.<br/><br/>So each site on <b>Earn &amp; Unlock</b> has a <b>🎯 topic</b> box. Write what you actually sat down to do, in your own words. With this switched on, an AI reads each page on that site against your sentence and <b>the clock only runs while you're on topic</b>.<br/><br/><b>What it can and cannot do:</b><ul><li>It can only ever <b>withhold time on a site you nominated</b>. It cannot unlock anything, block anything you hadn't already made a target, or hand you time.</li><li>If anything goes wrong — no key, no internet, quota spent, Google having a bad day — <b>every page counts as normal</b>. It fails open, because time you really did spend is not recoverable.</li><li>A site with an <b>empty topic</b> behaves exactly as it always has. Nothing changes until you write one.</li></ul><b>You need your own free Gemini API key.</b> Get one at <span class='kbd'>aistudio.google.com/apikey</span> and paste it below. It stays on this computer, it is never put in a settings backup, and it is <b>never given to the page</b> — the request is made by FocusGate itself.<br/><br/><b>Read this before switching it on.</b> With this on, the title — and, depending on the depth below, the description, the subtitles or the readable text — of pages on your <b>work sites only</b> is sent to Google. Nothing from any other site is ever read. That is still a real change: with this off, nothing about what you read leaves this machine. If that isn't a trade you want, leave it off.<br/><br/>One question per page, cached, so re-opening something costs nothing.")}</h2>
      <div class="srow">
        <span class="ic">🎯</span>
        <span class="lbl grow">Check each page against its site's topic</span>
        <span class="lbl hint" id="aiTopicVal" role="status" aria-live="polite" style="flex:0 0 auto"></span>
        ${sw("aiTopic", s.aiTopicEnabled === true, false, "ai-topic")}
      </div>
      <!-- The headline, directly under the master switch, because it is the half people actually mean when
           they ask for this: a topic that only governs sites you already called work cannot keep you off
           the ones you did not. -->
      <div class="srow ind1" id="aiTopicVideoGateRow" hidden>
        <span class="ic">📺</span>
        <span class="lbl grow">Only allow videos about my topics ${tip("<b>Every YouTube video is checked against your topics before it plays.</b> About one of them, it opens. About none of them, it is blocked like any other distraction — until today's work is done.<br/><br/>This is the half that works <i>off</i> your study sites. Without it a topic can only ever decide whether time on <b>that site</b> counts, which is no use at all against YouTube: it isn't a study site, and it probably isn't on your locked list either, so nothing would look at it.<br/><br/><b>Which topics?</b> All of them, from every study site that is switched on and asked for today. Matching <b>any one</b> counts. So \"linear integrated circuits\" on one row and \"German A1\" on another means both open and a cricket highlights reel does not.<br/><br/><b>What exactly is gated:</b><ul><li><b>Videos</b> — <span class='kbd'>youtube.com/watch</span>, Shorts, embeds. These are checked.</li><li><b>YouTube videos inside Google Search</b> — a trailer, a short video or a clip that Google plays in its own page. Checked the same way, held while it decides, and covered right there if it is off-topic.</li><li>The <b>home feed</b>, <b>search</b> and <b>channel pages</b> — <i>not</i> checked. They stay governed by your locked list, exactly as before. Search has to keep working or you couldn't go and find the video you're allowed.</li><li>Any other website — <i>not</i> checked. Putting a model between you and every address you type is a much bigger promise than this one.</li></ul><b>A video on a site you listed as work is never caught by this.</b> You called it work; if you gave that row its own topic, that topic decides instead.<br/><br/><b>While it is deciding</b> — a second or two the first time you open a video — the video is <b>held paused</b> rather than blocked. Nothing is taken away on a verdict that doesn't exist yet, and nothing plays that might be about to be. Once it decides, it either lets go or the tab goes to the blocked page.<br/><br/><b>It opens again</b> the moment today's work is finished, like everything else here.<br/><br/>Switching this off makes every video watchable again whatever your topics say, so it asks for your password.")}</span>
        ${sw("aiTopicVideoGate", s.aiTopicVideoGate !== false, false, "ai-topic-videogate")}
      </div>
      <!-- Earn your study time BY watching the right videos. The mirror of the gate above: that one decides
           what plays, this one decides what counts. -->
      <div class="srow ind1" id="aiTopicVideoEarnRow" hidden>
        <span class="ic">⏱️</span>
        <span class="lbl grow">Count matching videos toward my study time ${tip("<b>A YouTube video the check finds is about one of your topics earns time for the site card that owns that topic — exactly as if you had spent it on the site itself.</b><br/><br/>Set a card to <b>“German — 30 min”</b> with a topic, switch this on, and twenty minutes of a German lesson on YouTube leaves that card twenty minutes closer to done. The model says which of your topics the video matched, so the right card is credited when you have several.<br/><br/><b>Only the video's own watch page earns.</b> A video playing on in the miniplayer while you scroll the feed is still <i>checked</i> — and covered if it is off-topic — but it does not count, because reading the feed is not watching it.<br/><br/><b>It obeys the same rules as time on the site does:</b> the camera and stillness checks still apply, and a card with a <b>⏰ time window</b> only earns from YouTube inside that window. Off-topic videos earn nothing.<br/><br/>This <b>credits time</b>, so it is off until you ask for it — unlike blocking a distraction, handing yourself study time is a claim worth opting into. Needs <b>Study topics</b> on, with a key, like everything in this card.")}</span>
        ${sw("aiTopicVideoEarn", s.aiTopicVideoEarn === true, false, "ai-topic-videoearn")}
      </div>
      <div class="srow ind1" id="aiTopicKeyRow" hidden>
        <span class="ic">🔑</span>
        <input class="input grow" id="aiTopicKey" type="password" spellcheck="false" autocomplete="off"
               placeholder="Gemini API key — free from aistudio.google.com/apikey"
               aria-label="Gemini API key" value="${escHtml(s.aiTopicKey || "")}" data-testid="ai-topic-key"/>
        <!-- Show the key. A password field is right by default — this box sits on a page somebody may
             have open while sharing a screen — but a key you cannot read is a key you cannot check
             against the one in AI Studio, and "did I paste it wrong" is the first question anyone asks
             when ▶ Test fails. So it reveals on demand, never by default, and the icon says which state
             it is in rather than what pressing it will do. -->
        <button class="iconbtn eye" id="aiTopicKeyEye" type="button" aria-pressed="false"
                title="Show the key" aria-label="Show the API key" data-testid="ai-topic-key-eye">${EYE_SHOW}</button>
        <button class="btn sec" id="aiTopicTest" type="button"
                title="Ask Gemini one question right now and show what came back" data-testid="ai-topic-test">▶ Test</button>
      </div>
      <div class="srow ind1" id="aiTopicPctRow" hidden>
        <span class="ic">📊</span>
        <span class="lbl grow">How on-topic a page has to be ${tip("The score a page must reach for its time to count, out of 100.<br/><br/><b>50</b> is the default and the right place to start: more than half a match counts, less does not.<br/><br/>The model is told what the numbers mean, so they behave consistently:<ul><li><b>0</b> — nothing to do with your topic. Entertainment, news, another subject.</li><li><b>25</b> — same broad area, different thing.</li><li><b>50</b> — genuinely useful for the topic without being it.</li><li><b>75</b> — about the topic, among other things.</li><li><b>100</b> — squarely the thing you sat down to do.</li></ul>Raise it to demand a closer match; <b>lowering it means more pages count</b>, which is the loosening — so it asks for your password.")}</span>
        <label class="tfld"><input class="input" id="aiTopicPct" type="number" min="0" max="100" step="5" value="${Math.max(0, Math.min(100, FGStrict.fin(s.aiTopicMinPct === undefined ? 50 : s.aiTopicMinPct)))}" title="The score out of 100 a page must reach" aria-label="How on-topic a page has to be, out of 100" data-testid="ai-topic-pct"/><i>%</i></label>
      </div>
      <div class="srow ind1" id="aiTopicModeRow" hidden>
        <span class="ic">🔎</span>
        <span class="lbl grow">How deeply to check ${tip("<b>How much of a page the AI is allowed to look at before it decides.</b><br/><br/>A title is the weakest evidence there is — it was written to make you click, so it is the one part of a page that can be dressed up, and plenty of honest lectures are called <i>“Lec 14”</i> and say nothing at all.<br/><br/><b>Just the title</b><ul><li>The page or video title alone.</li><li>Fastest, about a second, and the least of your business that leaves this machine.</li><li>Wrong in both directions: it passes a vlog named like a lecture and refuses a real lecture with a useless name.</li></ul><b>The details</b> <i>(recommended)</i><ul><li>On a <b>YouTube video</b>: the channel, the description, the tags and the video's own <b>subtitles</b> — what it actually says, transcribed by YouTube. No title can lie its way past those.</li><li>On <b>any other page</b>: the description and the readable text near the top. Same idea by the only route an ordinary page offers.</li><li>A few seconds per page, and only for pages on a site you gave a topic.</li></ul><b>Watch the video</b><ul><li><b>YouTube videos only.</b> Nothing on the page is read: the <b>link</b> goes to Gemini and the model opens the video itself. On any other page this quietly falls back to <i>the details</i>, and what was actually read is always reported.</li><li>The strongest reading available — a video with no title, no description and no subtitles is still judged properly.</li><li><b>Slow and expensive.</b> Up to a minute or two on a long video, and one video request is worth many text ones against a free daily allowance.</li></ul><b>None of these change the bar.</b> The score still has to reach the percentage above. What changes is how well informed it is — which is why more evidence both rescues a page the title refused and catches one the title would have passed.<br/><br/>Free to change at any time: strict mode does not freeze it, and it does not ask for your password.")}</span>
        ${(() => {
          // Normalised once, here, rather than compared three times in the markup. An install that
          // predates this key, or one whose value was hand-edited, lands on the default instead of on a
          // group of three buttons with none pressed — which looks broken and, worse, gives no clue
          // what is actually in force.
          const cur = FGAi.normalizeMode(s.aiTopicMode);
          return `<span class="seg" role="group" aria-label="How deeply the AI checks a page">` +
            FGAi.MODES.map(k => {
              const spec = FGAi.MODE_LABELS[k];
              const on = k === cur;
              return `<button type="button" class="segbtn${on ? " on" : ""}" data-aidepth="${k}"` +
                     ` title="${escHtml(spec.hint)}" aria-pressed="${on ? "true" : "false"}"` +
                     ` data-testid="ai-depth-${k}">${escHtml(spec.label)}</button>`;
            }).join("") + `</span>`;
        })()}
      </div>
      <!-- The three fields "The details" may read. Their own rows rather than one row of checkboxes,
           because they cost genuinely different things: two are already on the page and free, and the
           third is a separate request to YouTube that needs its own permission. Shown only in that
           depth; see syncTopicRows. -->
      <div class="srow ind2" id="aiTopicSDescRow" hidden>
        <span class="ic">📝</span>
        <span class="lbl grow">Read the description ${tip("A video's description, or an ordinary page's <span class='kbd'>&lt;meta&gt;</span> description — as far as the first ~1400 characters.<br/><br/><b>Worth reading:</b> it is where a lecture says which chapter, class or syllabus it covers, often the only place the real topic is written down.<br/><br/><b>Worth knowing:</b> it is also where channels put their Telegram links and four paragraphs of boilerplate, so only the top of it is sent — that is where the subject lives.<br/><br/>Costs nothing extra: it is already on the page.")}</span>
        ${sw("aiTopicSDesc", (s.aiTopicScope || {}).description !== false, false, "ai-scope-desc")}
      </div>
      <div class="srow ind2" id="aiTopicSTagsRow" hidden>
        <span class="ic">🏷️</span>
        <span class="lbl grow">Read the tags ${tip("The uploader's own keyword list, hidden from viewers and used by YouTube's search.<br/><br/><b>The weakest of the three</b>, and the first one to turn off if something you expected to be refused keeps counting. Tags are frequently keyword spam — a hundred subjects listed in the hope of matching any search — and keyword spam is exactly the kind of evidence that makes a model more confident and less right.<br/><br/>Most modern uploads have none at all, in which case this reads nothing and changes nothing.<br/><br/>Costs nothing extra: it is already on the page.")}</span>
        ${sw("aiTopicSTags", (s.aiTopicScope || {}).tags !== false, false, "ai-scope-tags")}
      </div>
      <div class="srow ind2" id="aiTopicSTextRow" hidden>
        <span class="ic">💬</span>
        <span class="lbl grow">Read the subtitles, or the page's text ${tip("<b>What the thing actually says.</b> This is the one that makes the difference.<br/><br/>On a <b>YouTube video</b>: its subtitles. YouTube has already transcribed nearly every lecture on the site, automatically where the uploader didn't — so those subtitles are the video in text, and a title, a description and a tag list can all be dressed up where the subtitles cannot. The AI is told outright that where they disagree, it should believe the subtitles.<br/><br/>Up to about <b>fifteen minutes' worth</b> is sent, and on a longer video it is <b>sampled across the whole thing</b> — some from the start, the middle and the end. Not the first fifteen minutes: the opening of a lecture is <i>“hello everyone, welcome back”</i>, which is the part that says least.<br/><br/>On <b>any other page</b>: its headings and the readable text near the top, up to about 2,500 characters. Same question, only route available.<br/><br/><b>Nothing to allow, and nothing to set up.</b> The subtitles are read by a small part of FocusGate that runs inside the YouTube page itself, which is the only way it works — a caption URL fetched from outside the page comes back empty, because it needs a token only YouTube's own player can make. So FocusGate waits for the player to fetch its own captions and reads those.<br/><br/><b>The line beside this switch says what actually happened</b> on the last video checked: <i>reading them</i>, <i>none on that video</i>, or <i>YouTube refused them</i>. If it says <i>not loaded</i>, reload the YouTube tab.<br/><br/><b>If a video has no subtitles at all</b>, there is nothing to read and the check says so rather than pretending it looked. For those, <b>Watch the video</b> above is the answer.")}</span>
        <span class="lbl hint" id="aiTopicTextVal" role="status" aria-live="polite" style="flex:0 0 auto"></span>
        ${sw("aiTopicSText", (s.aiTopicScope || {}).transcript !== false, false, "ai-scope-text")}
      </div>
      <div class="srow ind1" id="aiTopicModelRow" hidden>
        <span class="ic">⚙️</span>
        <span class="lbl" style="flex:0 0 auto">Model ${tip("<b>Which Gemini model answers, and how many pages a day it will answer for.</b><br/><br/>That second half is the one that decides. Google's free tier is metered <b>per model, per day</b>, and the spread is enormous — and this check asks one question per page you open on a site with a topic. So:<ul><li><b>Flash Lite</b> — about <b>500</b> checks a day. Quick, and enough for real browsing.</li><li><b>Flash</b> — about <b>20</b> checks a day. Noticeably better at the judgement calls (a study vlog that is <i>about</i> your subject without teaching it), and then it stops until tomorrow.</li></ul><b>Twenty is twenty pages.</b> After that nothing is checked — and because this feature fails open, that means every page counts again for the rest of the day. Weaker judgement all day beats perfect judgement until mid-morning, which is why a Lite model is the default.<br/><br/>Pick <b>Something else…</b> to type a name that isn't listed. Model names are Google's to retire and new ones appear between updates of this extension, so the box is always there.<br/><br/><b>Watch the video</b> needs a model that can open a YouTube link. <span class='kbd'>gemini-3.5-flash-lite</span> can; if you choose one that can't, the error beside the switch above will say so.<br/><br/>A name that doesn't exist comes back as an error you'll see beside that switch too.")}</span>
        ${(() => {
          // The stored value decides which option is selected, and anything the list does not know about
          // selects "Something else…" and fills the box. That is what keeps a hand-edited file, an older
          // install, or a model Google adds next month from being silently rewritten to the default the
          // moment somebody opens this page.
          const cur = String(s.aiTopicModel || "").trim() || FGAi.MODEL_DEFAULT;
          const known = FGAi.isKnownModel(cur);
          const opts = FGAi.GEMINI_MODELS.map(m =>
            `<option value="${escHtml(m.id)}"${m.id === cur ? " selected" : ""} title="${escHtml(m.note)}">${escHtml(m.label)}</option>`
          ).join("");
          return `<select class="input grow" id="aiTopicModelSel" aria-label="Which Gemini model answers"
                          data-testid="ai-topic-model-sel">
                    ${opts}
                    <option value="${FGAi.MODEL_CUSTOM}"${known ? "" : " selected"}>Something else… (type a name)</option>
                  </select>
                  <input class="input" id="aiTopicModelBox" type="text" spellcheck="false" autocomplete="off"
                         style="flex:1 1 160px;min-width:120px" ${known ? "hidden" : ""}
                         placeholder="model name" aria-label="Gemini model name"
                         value="${known ? "" : escHtml(cur)}"
                         data-testid="ai-topic-model"/>`;
        })()}
      </div>
      <div class="srow ind1" id="aiTopicStrictRow" hidden>
        <span class="ic">⏸️</span>
        <span class="lbl grow">Hold the clock while it's deciding ${tip("What happens during the second or two a <b>new</b> page is being judged.<br/><br/><b>Off</b> (default): the clock keeps running while the answer travels, and stops if the answer comes back off-topic. Every page is judged once and the verdict is remembered, so this is only ever the first couple of seconds of something you have just opened.<br/><br/><b>On</b>: the clock waits for the verdict.<br/><br/><b>Why off is the default.</b> Holding the clock means every legitimate video you open starts by refusing to pay you — friction pointed at the person doing the work. Letting it run means a deliberate cheat (open something, take five seconds, open something else) can collect a trickle of time. The cheat is laborious and self-defeating; the friction lands on everybody, every time.<br/><br/>Turn it on if you know you'd do exactly that to yourself.")}</span>
        ${sw("aiTopicStrictSw", s.aiTopicStrict === true, false, "ai-topic-strict")}
      </div>
      <div class="srow ind1" id="aiTopicBlocksRow" hidden>
        <span class="ic">🚫</span>
        <span class="lbl grow">Block off-topic pages, don't just stop the clock ${tip("<b>Off</b> (default): an off-topic page on a work site simply doesn't earn you time. The card on the page freezes and says which topic it missed. You can still read it.<br/><br/><b>On</b>: the page is taken away, like a site on your locked list, and the blocked screen explains which topic it missed and what the AI thought it was.<br/><br/><b>Why off is the default.</b> Stopping the clock is a statement about what counts. Redirecting the tab is taking a page off you — and the page in question is on a site <i>you</i> nominated as work. A model that has misread a lecture should cost you a stopped clock you can see and argue with, not the thing you were reading.<br/><br/>Only ever fires on a settled verdict. While a page is still being judged, or if anything went wrong, it stays open.")}</span>
        ${sw("aiTopicBlocksSw", s.aiTopicBlocks === true, false, "ai-topic-blocks")}
      </div>
    </div>

    <div class="card">
      <h2><span class="ic">💾</span> Backup &amp; restore ${tip("Saves everything you have set up to a small <b>.json</b> file: your work sites and their times, the locked and allowed lists, every check you switched on, all the dials, strict mode, the day boundary and the phone bridge.<br/><br/>Use it to move your setup to another computer, or to keep a copy before you change a lot at once.<br/><br/><b>What is deliberately not in it:</b><ul><li>Your <b>password</b>. A hash in a backup file is your door in a backup file — restore onto a fresh profile and it asks you to make a new one.</li><li><b>Today's progress</b> — the minutes already spent on each site. A backup would otherwise be a way to hand yourself an afternoon you didn't spend.</li><li>Your <b>streak, XP and level</b>. Earned, not configured.</li></ul>Every value is re-checked on the way back in and put back inside the range its own control allows, so a hand-edited file can't loosen a check past what this page would let you set.<br/><br/><b>Importing is frozen while strict mode is on</b>, because replacing all your settings at once is the loosest thing anyone could do.")}</h2>
      <div class="srow">
        <span class="ic">⬇️</span>
        <span class="lbl grow">Save your settings to a file</span>
        <button class="btn sec" id="expSettings" data-testid="export-settings">⬇ Export</button>
      </div>
      <div class="srow">
        <span class="ic">⬆️</span>
        <span class="lbl grow">Load settings from a file ${strict ? '<b style="color:#fca5a5">— frozen by strict mode</b>' : ""}</span>
        <!-- A hidden file input driven by the button beside it: the browser's own file
             button cannot be labelled or styled, and this row has to read like the one
             above it. -->
        <input type="file" id="impFile" accept=".json,application/json" style="display:none"/>
        <button class="btn sec" id="impSettings" ${strict ? "disabled style='opacity:.4;cursor:not-allowed'" : ""} data-testid="import-settings">⬆ Import</button>
      </div>
      <div class="srow" style="padding-top:0">
        <span class="ic"></span>
        <span class="lbl hint" id="backupSaid" role="status" aria-live="polite"></span>
      </div>
      <!-- Reset lives in this card rather than in one of its own, and that is the point: it is the
           third way of moving all your settings at once, beside saving them and loading them, and
           the one you want after reading the two rows above is a way back to the start. In its own
           card at the bottom of the page it would read as unrelated.
           Named for what it does rather than for how it feels — "reset settings to default" is the
           phrase people arrive looking for, so it is the phrase on the row. -->
      <div class="srow">
        <span class="ic">♻️</span>
        <span class="lbl grow">Reset settings to default ${strict ? '<b style="color:#fca5a5">— frozen by strict mode</b>' : ""} ${tip("Everything on this page goes back to the day you installed FocusGate: every check off or at its default, every dial at normal, strict mode off, the day boundary back to midnight, the phone bridge cleared — and your <b>work sites, locked list and allowed list emptied</b>.<br/><br/><b>Three things survive, on purpose:</b><ul><li>Your <b>password</b>. A reset is not a way to take the door off — and it is the thing you just proved to get here.</li><li>Your <b>streak, XP and level</b>. Earned, not configured. Putting the checks back to normal is not a reason to lose them.</li><li><b>Today's progress</b> on any site — although the sites themselves are gone, so there is nothing left for it to be progress towards. Winding it back is its own control under <b>New day starts at</b>.</li></ul><b>There is no undo.</b> Press <b>⬇ Export</b> first if there is any chance you want your setup back.<br/><br/>Frozen while strict mode is on, like importing, because wiping every rule at once is the loosest thing anyone could do.")}</span>
        <button class="btn danger" id="resetAll" ${strict ? "disabled style='opacity:.4;cursor:not-allowed'" : ""} data-testid="reset-all">♻ Reset</button>
      </div>
    </div>

    <div class="card">
      <h2><span class="ic">🔄</span> New day starts at ${tip("Every day your work time goes back to zero and your sites get locked again. This is the clock time when that happens.<br/><br/><span class='kbd'>00:00</span> means midnight.<br/><br/><b>Reset now</b> wipes today's progress straight away.")}</h2>
      <div class="srow">
        <span class="ic">🕛</span>
        <input class="input" id="resetTime" type="time" value="${s.dailyResetTime||"00:00"}" style="width:130px" ${strict?"disabled":""} data-testid="reset-time-input"/>
        <button class="btn sec" id="saveTime" ${strict?"disabled style='opacity:.4;cursor:not-allowed'":""} data-testid="save-reset-time">💾 Save</button>
        <button class="btn sec" id="resetNow" data-testid="reset-now-btn">↺ Reset now</button>
      </div>
    </div>`;

  document.querySelectorAll('[data-lock]').forEach(b => b.addEventListener("click", async () => {
    const sec = parseInt(b.dataset.lock, 10);
    await setStateP({ autoLockDelaySec: sec });
    toast("Saved");
    renderApp();
  }));
  // (the custom seconds box saves itself — see autoNum below)

  // ---- The website anti-cheat card folds away ----
  $("#cheatHead")?.addEventListener("click", () => {
    cheatOpen = !cheatOpen;
    $("#cheatHead").setAttribute("aria-expanded", cheatOpen ? "true" : "false");
    const body = $("#cheatBody");
    if (body) body.hidden = !cheatOpen;
  });
  // The four group folds are wired once, at the bottom of this file, by a delegated listener
  // on the document — not here. See the note there for why.
  // Keep the card's own badge honest while it's open, so a folded card still tells you how
  // many checks are running without re-rendering the tab.
  //
  // The per-group badges are deliberately NOT updated here. They are built by grpCount from
  // stored state, and every switch in a group already re-renders after it writes — so a second
  // copy of the counting rule reading the DOM would be one more thing to keep in step, and the
  // one that drifted would be the one on screen.
  const CHEAT_SW = ["mediaOnly", "inactEnabled", "fullscreenOnly", "splitBlock",
                    "faceEnabled", "eyeEnabled", "liveEnabled", "blinkEnabled"];
  function refreshCheatBadge() {
    const el = $("#cheatCount");
    if (el) el.textContent = CHEAT_SW.filter(id => $("#" + id) && $("#" + id).checked).length + "/" + CHEAT_SW.length + " on";
  }
  CHEAT_SW.forEach(id => $("#" + id)?.addEventListener("change", refreshCheatBadge));

  // Numbers save themselves: quietly half a second after you stop typing, and at
  // once when you leave the box or press Enter. No Save buttons anywhere.
  function autoNum(id, key, lo, hi, fallback) {
    const box = $("#" + id);
    if (!box) return;
    let timer = 0;
    const clamp = () => {
      const raw = parseInt(box.value, 10);
      return Math.max(lo, Math.min(hi, Number.isFinite(raw) ? raw : fallback));
    };
    // `mid` marks the half-second-after-a-keystroke save, as opposed to leaving the box or
    // pressing Enter.
    //
    // That save must never be allowed to open a dialog. On the way from 180 to 1800 the box
    // passes through 1, which clamps to 30 — a tightening — so pausing for half a second
    // mid-number would put a sheet in front of a value you had not finished typing. Both gates
    // get their say, but at a commit rather than at a keystroke.
    //
    // In practice every key autoNum drives has a direction, so this makes the debounced save a
    // no-op for all four of them. Said plainly rather than deleted, because the debounce is
    // still right for a number box with no direction, and the next one added may be one.
    const save = async (quiet, mid) => {
      const v = clamp();
      const st = await getState();
      if ((st[key] || fallback) === v) return;      // nothing changed, nothing to say
      if (mid && FGSettings.changeDir(key, v, st[key]) !== "") return;
      await setStateP({ [key]: v });
      if (!quiet) toast("Saved");
    };
    // What was stored is what the box should read. Only on the way out, never
    // mid-keystroke: snapping "3" to "5" while you're still typing "30" would be
    // maddening.
    const settle = () => {
      const v = clamp();
      if (String(box.value) !== String(v)) box.value = String(v);
    };
    box.addEventListener("input", () => { clearTimeout(timer); timer = setTimeout(() => save(true, true), 500); });
    box.addEventListener("change", () => { clearTimeout(timer); settle(); save(false); });
    box.addEventListener("blur", () => { clearTimeout(timer); settle(); save(true); });
    box.addEventListener("keydown", (e) => {
      if (e.key !== "Enter" || e.isComposing) return;
      e.preventDefault(); clearTimeout(timer); save(false); box.blur();
    });
  }
  autoNum("inactTimeout", "inactivityTimeoutSec", 5, 600, 30);
  // The floor is 0 on all three of the sliding deadlines. 0 is a real setting — "the moment you
  // stop" — and the old floor of 30 on this one came from the movement check being hard to
  // satisfy back when it demanded a lean left and then a lean right. Any movement clears it now.
  autoNum("liveInterval", "livenessIntervalSec", 0, 1800, 10);
  autoNum("eyeAway", "eyeAwaySec", 0, 600, 10);
  autoNum("blinkEvery", "blinkIntervalSec", 0, 600, 10);
  autoNum("customLock", "autoLockDelaySec", 0, 3600, 0);
  autoNum("mediaBack", "mediaRewindSec", 0, 120, 5);
  autoNum("aiTopicPct", "aiTopicMinPct", 0, 100, 50);

  // ---- study topics ----------------------------------------------------------
  //
  // Which rows belong to the master switch, and which of those belong to a depth as well. Written
  // here rather than folded into KIDS above because the second level is one condition more than that
  // table can express — the same reason the media pause/resume pair is handled by hand.
  const AI_TOPIC_KIDS = ["aiTopicVideoGateRow", "aiTopicVideoEarnRow", "aiTopicKeyRow", "aiTopicPctRow", "aiTopicModeRow",
                         "aiTopicSDescRow", "aiTopicSTagsRow", "aiTopicSTextRow",
                         "aiTopicModelRow", "aiTopicStrictRow", "aiTopicBlocksRow"];
  // Which depth the buttons are showing. Read off the DOM rather than out of storage, like every
  // other control on this page: the switches save asynchronously, and this runs in the same tick as
  // the click that moved one. Storage is a moment behind; the button is now.
  function aiDepthNow() {
    const on = document.querySelector("[data-aidepth].on");
    const v = on ? on.getAttribute("data-aidepth") : "";
    return FGAi.MODE_LABELS[v] ? v : "details";
  }
  function syncTopicRows() {
    const on = !!($("#aiTopic") && $("#aiTopic").checked);
    AI_TOPIC_KIDS.forEach(id => { const el = $("#" + id); if (el) el.hidden = !on; });
    // The three field rows say which parts of a page "The details" may read, so under either of the
    // other depths they describe nothing. In "Just the title" there is nothing extra to read; in
    // "Watch the video" the page is deliberately not read at all, and leaving three switches about
    // scraping it on screen would flatly contradict what that depth promises.
    const deep = on && aiDepthNow() === "details";
    ["aiTopicSDescRow", "aiTopicSTagsRow", "aiTopicSTextRow"].forEach(id => {
      const el = $("#" + id); if (el) el.hidden = !deep;
    });
  }
  syncTopicRows();

  // Permission to reach Google's API — the one and only origin this feature sends anything to.
  //
  // ALREADY GRANTED on today's manifest, and it is worth being clear about that rather than implying a
  // prompt nobody will see: FocusGate declares `host_permissions: ["<all_urls>"]` because it has to run its
  // clock on every site you might nominate as work. That covers this, so `contains` answers true and
  // `request` is never reached.
  //
  // They are asked anyway, and stay asked, for two reasons:
  //
  //   The worker CHECKS it before every call (see aiHasOrigin), so the two sides
  //   already agree that a missing origin means "don't send". If `<all_urls>` is ever narrowed — and it
  //   should be, it is far more than this extension needs — the feature keeps working with an ordinary
  //   optional-permission prompt instead of quietly going silent.
  //
  //   A revoked origin is a real state today. A user can take `<all_urls>` away in chrome://extensions
  //   by setting site access to "on click", and then `contains` really does answer false.
  //
  // Asked from a PAGE rather than from the worker because chrome.permissions.request needs a live user
  // gesture and a service worker never has one. The function itself now lives at the top of this file —
  // two different tabs need it (this card, and the AI category picker on Earn & Unlock), and a copy in
  // each would be two chances to ask for a different origin.
  // There is deliberately no second one of these for youtube.com.
  //
  // There was, on the belief that reading a video's subtitles needed permission to read the site. It did,
  // while the WORKER was fetching them — and that fetch never worked, because the caption URL needs a token
  // only YouTube's own player can mint. The subtitles are now fetched by a script running in the page, as
  // the page, from a document the user already has open, so there is nothing to ask for. The prompt that
  // used to appear here was asking permission for a request that was never going to succeed.

  // What the two status lines say. Both come from the worker, because "is this working" is the switch
  // AND a key AND a granted origin AND at least one target carrying a topic — and a page working that
  // out for itself would be a second implementation, free to disagree with the one that judges.
  async function paintTopicStatus() {
    const main = $("#aiTopicVal"), sub = $("#aiTopicTextVal");
    const set = (el, text, cls, title) => {
      if (!el) return;
      el.textContent = text;
      el.className = "lbl hint" + (cls ? " " + cls : "");
      if (title) el.setAttribute("title", title); else el.removeAttribute("title");
    };
    if (!($("#aiTopic") && $("#aiTopic").checked)) { set(main, "", "", ""); set(sub, "", "", ""); return; }
    const r = await new Promise(res => {
      try {
        chrome.runtime.sendMessage({ type: "aiTopicStatus" }, (x) => { void chrome.runtime.lastError; res(x || null); });
      } catch (e) { res(null); }
    });
    if (!r || !r.ok) { set(main, "", "", ""); set(sub, "", "", ""); return; }
    // The subtitles line first, so it is painted whatever the main line ends up saying: the subtitles
    // can be unreachable while everything else is fine, and that is equally worth knowing while the
    // main line is reporting a bad key.
    if (r.mode !== "details" || !r.scope || r.scope.transcript !== true) set(sub, "", "", "");
    else if (r.transcriptWhy) {
      // What actually happened on the last video checked, rather than whether a permission is granted.
      //
      // That is the whole point of this line existing: the previous version reported a permission, the
      // permission was always fine, and the subtitles were not being read at all — so the one place you
      // would go to check said everything was well. An outcome cannot lie in that direction.
      const short = FGAi.transcriptWhyShort(r.transcriptWhy);
      set(sub, "on · " + short, "", FGAi.transcriptWhyText(r.transcriptWhy));
    } else {
      set(sub, "on", "",
          "A video's own subtitles, or an ordinary page's text — the evidence a title cannot fake. " +
          "Once a video has been checked, this line says what happened to its subtitles.");
    }

    if (!r.hasKey) {
      set(main, "no key", "",
          "Switched on, but there's no API key in the box below — so nothing is being asked and every page counts as normal.");
      return;
    }
    if (!r.hasOrigin) {
      set(main, "no permission", "",
          "Switched on, but permission to reach Google's API wasn't granted. Turn the switch off and on again to be asked for it.");
      return;
    }
    // A failure is the loudest thing this line says, and it outranks "no topics set": a bad key is a
    // thing to fix, while an empty topic box is a thing you fix by deciding what you meant to do.
    if (r.lastError) { set(main, "error", "", r.lastError.text); return; }
    if (!r.topics) {
      // Two different nothings, and they need two different sentences: one is a decision you have not
      // made yet, the other is one you have.
      if (r.muted) {
        const one = r.muted === 1;
        set(main, "all muted", "",
            "Ready, and nothing to check: " +
            (one ? "the one site that has a 🎯 topic has it" : `all ${r.muted} sites that have a 🎯 topic have it`) +
            " switched off with the toggle beside it. Turn one back on to start judging that site's pages.");
        return;
      }
      set(main, "no topics set", "",
          "Ready, and nothing to check: none of your work sites has a 🎯 topic yet. Add one on Earn & Unlock and " +
          "this starts judging that site's pages.");
      return;
    }
    const said = (FGAi.MODE_LABELS[r.mode] || FGAi.MODE_LABELS.details).said;
    set(main, `on · ${r.topics} of ${r.total}`, "",
        `Working. Pages on the ${r.topics === 1 ? "site" : r.topics + " sites"} with a topic are judged on ${said} ` +
        `by ${r.model}, and count while they reach ${r.need}%.` +
        (r.muted ? ` ${r.muted === 1 ? "One more site has" : r.muted + " more sites have"} a topic switched off with the toggle beside it.` : ""));
  }
  paintTopicStatus().catch(() => {});

  $("#aiTopic")?.addEventListener("change", async () => {
    const wantOn = !!$("#aiTopic").checked;
    // The permission FIRST, and only on the way on. Two reasons, and the second is the binding one:
    //
    //   A refused prompt then costs nothing — the switch goes back and nothing was stored, rather than
    //   the setting being saved as on and the feature silently never working.
    //
    //   chrome.permissions.request needs a live user gesture, and setStateP can put a PASSWORD DIALOG
    //   on screen. Awaiting that first would spend the gesture, and the browser would then refuse the
    //   permission request without ever showing it. So the browser's prompt has to come before ours.
    if (wantOn && !(await askAiOrigin())) {
      $("#aiTopic").checked = false;
      syncTopicRows();
      toast("Not switched on — it needs permission to reach Google's API");
      return;
    }
    try {
      await setStateP({ aiTopicEnabled: wantOn });
    } catch (e) {
      // Refused. setStateP has already put the page back to what is stored, so only the rows need
      // re-syncing against it.
      syncTopicRows();
      return;
    }
    syncTopicRows();
    paintTopicStatus().catch(() => {});
    toast(wantOn
      ? "On — pages on a site with a topic are checked against it"
      : "Off — every page on a work site counts again");
  });

  // The key box. Its own writer rather than part of a group save, because it is a credential: it must
  // not be re-written every time something else on this card is touched, and STRICTER marks it "url"
  // so every write asks for the password.
  let aiKeyTimer = 0;
  async function saveAiKey() {
    const box = $("#aiTopicKey");
    if (!box) return;
    const next = String(box.value || "").trim();
    const st = await getState();
    if (next === String(st.aiTopicKey || "")) return;     // nothing changed; do not ask for a password
    try {
      await setStateP({ aiTopicKey: next });
    } catch (e) {
      box.value = String(st.aiTopicKey || "");
      return;
    }
    toast(next ? "Key saved" : "Key cleared");
    paintTopicStatus().catch(() => {});
  }
  const aiKeyBox = $("#aiTopicKey");
  if (aiKeyBox) {
    // Longer than the number boxes' half second. A key is forty characters of pasted gibberish, and a
    // writer that fired mid-paste would ask for the password about half a credential.
    aiKeyBox.addEventListener("input", () => {
      clearTimeout(aiKeyTimer);
      aiKeyTimer = setTimeout(() => saveAiKey().catch(() => {}), 1200);
    });
    aiKeyBox.addEventListener("blur", () => { clearTimeout(aiKeyTimer); saveAiKey().catch(() => {}); });
    aiKeyBox.addEventListener("keydown", (e) => {
      if (e.key !== "Enter" || e.isComposing) return;
      e.preventDefault(); clearTimeout(aiKeyTimer); saveAiKey().catch(() => {}); aiKeyBox.blur();
    });
  }
  // Show the key.
  //
  // Purely local: it changes one attribute on one input and stores nothing, so the revealed state does
  // not survive a re-render or a reload. That is deliberate rather than lazy — a "keep it visible"
  // preference would mean a credential sitting in plain text on a page somebody leaves open, and the
  // reason to look at it at all (checking a paste against AI Studio) is over in seconds.
  $("#aiTopicKeyEye")?.addEventListener("click", () => {
    const box = $("#aiTopicKey"), btn = $("#aiTopicKeyEye");
    if (!box || !btn) return;
    const showing = box.type === "text";
    box.type = showing ? "password" : "text";
    btn.innerHTML = showing ? EYE_SHOW : EYE_HIDE;
    btn.setAttribute("aria-pressed", showing ? "false" : "true");
    btn.title = showing ? "Show the key" : "Hide the key";
    btn.setAttribute("aria-label", showing ? "Show the API key" : "Hide the API key");
    // Focus goes back to the box, so revealing a key to read it does not also mean clicking back into it
    // to fix it. Only when it was already the active element's neighbour, i.e. never steals focus on load.
    try { box.focus({ preventScroll: true }); } catch (e) {}
  });

  // The three depth buttons.
  document.querySelectorAll("[data-aidepth]").forEach(btn => btn.addEventListener("click", async () => {
    const want = btn.getAttribute("data-aidepth") || "details";
    if (!FGAi.MODE_LABELS[want]) return;
    if (want === aiDepthNow()) return;
    // Painted before the write. Every other control here does the same, and aiDepthNow() reads the DOM,
    // so syncTopicRows below needs this to have happened already.
    document.querySelectorAll("[data-aidepth]").forEach(b => {
      const on = b === btn;
      b.classList.toggle("on", on);
      b.setAttribute("aria-pressed", on ? "true" : "false");
    });
    syncTopicRows();
    try { await setStateP({ aiTopicMode: want }); } catch (e) { renderApp(); return; }
    paintTopicStatus().catch(() => {});
    toast("Checking " + FGAi.MODE_LABELS[want].said);
  }));

  // The three fields. Written as one object, because that is how it is stored — and read from the
  // boxes rather than merged into what is stored, so a stale value cannot come back with it.
  async function saveAiScope() {
    const scope = {
      description: !($("#aiTopicSDesc") && $("#aiTopicSDesc").checked === false),
      tags: !($("#aiTopicSTags") && $("#aiTopicSTags").checked === false),
      transcript: !($("#aiTopicSText") && $("#aiTopicSText").checked === false)
    };
    try { await setStateP({ aiTopicScope: scope }); } catch (e) { return; }
    paintTopicStatus().catch(() => {});
  }
  ["aiTopicSDesc", "aiTopicSTags"].forEach(id => {
    $("#" + id)?.addEventListener("change", () => { saveAiScope().catch(() => {}); });
  });
  // The subtitles, which no longer ask for anything: they are fetched by a script running inside the page,
  // as the page, so there is no permission involved. The status line beside the switch reports what
  // actually happened on the last video instead, which is the thing worth knowing.
  $("#aiTopicSText")?.addEventListener("change", () => {
    saveAiScope().catch(() => {});
  });

  // The model: a picker, with a box that appears for a name the picker does not know.
  //
  // One writer for both controls, because they are two ways of saying the same thing and a second copy
  // of "what does this store" is how a dropdown and a text box end up disagreeing about which model is
  // in force.
  const aiModelSel = $("#aiTopicModelSel");
  const aiModelBox = $("#aiTopicModelBox");
  async function saveAiModel(next) {
    const checked = FGSettings.checkOne("aiTopicModel", String(next || "").trim());
    // An empty or malformed box is not a reason to write anything. Storing the default instead would
    // silently move somebody off a model they had chosen because they mistyped while editing it.
    if (!checked.ok || !checked.value) return false;
    const st = await getState();
    if (checked.value === String(st.aiTopicModel || "")) return true;   // nothing changed, nothing to say
    try { await setStateP({ aiTopicModel: checked.value }); } catch (e) { return false; }
    paintTopicStatus().catch(() => {});
    const spec = FGAi.modelSpec(checked.value);
    toast(spec ? "Model: " + spec.label : "Model set to " + checked.value);
    return true;
  }
  if (aiModelSel) {
    aiModelSel.addEventListener("change", () => {
      const v = aiModelSel.value;
      if (v === FGAi.MODEL_CUSTOM) {
        // Nothing is stored yet: the name does not exist until it is typed. The box is revealed and
        // focused, and whatever was in force stays in force until it is.
        if (aiModelBox) { aiModelBox.hidden = false; aiModelBox.focus(); }
        return;
      }
      if (aiModelBox) { aiModelBox.hidden = true; aiModelBox.value = ""; }
      saveAiModel(v).catch(() => {});
    });
  }
  if (aiModelBox) {
    const save = async () => {
      const raw = String(aiModelBox.value || "").trim();
      if (!raw) return;                       // an empty custom box is a question not yet answered
      const checked = FGSettings.checkOne("aiTopicModel", raw);
      if (!checked.ok) { toast("That isn't a model name — letters, digits, dots and dashes only"); return; }
      await saveAiModel(raw);
      // A typed name that turns out to BE one of the listed ones snaps the picker onto it, so the two
      // controls never end up describing the same model two different ways.
      if (aiModelSel && FGAi.isKnownModel(checked.value)) {
        aiModelSel.value = checked.value;
        aiModelBox.hidden = true;
        aiModelBox.value = "";
      }
    };
    aiModelBox.addEventListener("change", () => { save().catch(() => {}); });
    aiModelBox.addEventListener("blur", () => { save().catch(() => {}); });
    aiModelBox.addEventListener("keydown", (e) => {
      if (e.key !== "Enter" || e.isComposing) return;
      e.preventDefault(); save().catch(() => {}); aiModelBox.blur();
    });
  }

  $("#aiTopicVideoGate")?.addEventListener("change", async () => {
    const on = !!$("#aiTopicVideoGate").checked;
    try { await setStateP({ aiTopicVideoGate: on }); } catch (e) { renderApp(); return; }
    // Turning it off has to release any video it is currently holding, and that must not wait for the
    // minute tick — releasing a page you just asked for is the whole reason anybody presses this.
    chrome.runtime.sendMessage({ type: "refreshBlockedTabs" });
    paintTopicStatus().catch(() => {});
    toast(on ? "Only videos about your topics will open" : "Every video opens again");
  });
  $("#aiTopicVideoEarn")?.addEventListener("change", async () => {
    const on = !!$("#aiTopicVideoEarn").checked;
    // A loosening to switch on (a new way to reach a goal), so setStateP asks and a strict window refuses;
    // renderApp on refusal puts the switch back to what is stored.
    try { await setStateP({ aiTopicVideoEarn: on }); } catch (e) { renderApp(); return; }
    // Nothing to re-block — this changes what COUNTS, not what plays — and the tick picks it up within a
    // second on its own, so there is nothing to poke.
    paintTopicStatus().catch(() => {});
    toast(on ? "Matching videos now earn their card's time" : "Matching videos no longer earn time");
  });
  $("#aiTopicStrictSw")?.addEventListener("change", async () => {
    const on = !!$("#aiTopicStrictSw").checked;
    try { await setStateP({ aiTopicStrict: on }); } catch (e) { return; }
    toast(on ? "The clock waits for the verdict" : "The clock runs while it decides");
  });
  $("#aiTopicBlocksSw")?.addEventListener("change", async () => {
    const on = !!$("#aiTopicBlocksSw").checked;
    try { await setStateP({ aiTopicBlocks: on }); } catch (e) { return; }
    chrome.runtime.sendMessage({ type: "refreshBlockedTabs" });
    toast(on ? "Off-topic pages get blocked" : "Off-topic pages just don't earn time");
  });

  // ▶ Test. One real request, right now — the whole point of pressing it is to find out whether the key
  // works at this moment.
  $("#aiTopicTest")?.addEventListener("click", async () => {
    // Whatever is in the box, not whatever was last stored: somebody who has just pasted a key and
    // pressed ▶ inside the debounce window means "test this".
    clearTimeout(aiKeyTimer);
    await saveAiKey().catch(() => {});
    if (!(String(($("#aiTopicKey") || {}).value || "").trim())) return toast("Paste your Gemini API key in first");
    if (!(await askAiOrigin())) return toast("It needs permission to reach Google's API");
    const btn = $("#aiTopicTest");
    if (btn) { btn.disabled = true; btn.textContent = "⏳ Asking…"; }
    const r = await new Promise(res => {
      try {
        chrome.runtime.sendMessage({ type: "aiTopicTest" }, (x) => {
          void chrome.runtime.lastError;
          res(x || { ok: false, error: "FocusGate didn't answer." });
        });
      } catch (e) { res({ ok: false, error: "FocusGate didn't answer." }); }
    });
    if (btn) { btn.disabled = false; btn.textContent = "▶ Test"; }
    if (!r.ok) {
      toast(r.error === "locked" ? "Password needed to test the key 🔒" : (r.error || "That didn't work"));
    } else {
      // Says which question was asked, because the button deliberately asks the cheap one. It proves the
      // key is accepted, the model exists and it answers in the shape this code parses — every failure
      // fixable from this screen — without spending a video-understanding request to re-prove them.
      const tail = r.mode && r.mode !== "title" ? " · the title check works, so the deeper one will too" : "";
      toast(r.usedTopic
        ? `Working — it scored a sample video ${r.pct}% against your own topic${tail}`
        : `Working — ${r.pct}% on a sample topic. Give a site a 🎯 topic to test with your own${tail}`);
    }
    paintTopicStatus().catch(() => {});
  });

  // Pause the page's video when the clock stops. Deliberately not gated by strict
  // mode, and not counted in the badge above: it asks nothing of you and can't be
  // used to earn time you haven't spent, so it is a preference rather than a rule.
  // Putting the password in front of a convenience is how a gate stops being taken
  // seriously.
  $("#mediaPause")?.addEventListener("change", async () => {
    const on = $("#mediaPause").checked;
    await setStateP({ mediaPauseEnabled: on });
    // The resume row below undoes this one's work, so it goes with it rather than sitting
    // there looking like it still applies.
    syncKidRows();
    toast(on ? "The video pauses when the clock stops" : "The video keeps playing when the clock stops");
  });
  $("#mediaResume")?.addEventListener("change", async () => {
    const on = $("#mediaResume").checked;
    await setStateP({ mediaResumeEnabled: on });
    toast(on ? "The video carries on when the clock does" : "You'll press play yourself");
  });
  $("#pageGlow")?.addEventListener("change", async () => {
    const on = $("#pageGlow").checked;
    await setStateP({ pageGlowEnabled: on });
    toast(on ? "Your work pages will glow while the clock runs" : "Glow off");
  });

  // Anti-cheat: something has to be playing
  // Like every other check on this card: switching it ON goes through during a strict window,
  // switching it OFF is refused there. Two of these switches carried a blanket refusal and the
  // rest carried none, which is the drift a table exists to prevent — so neither does now.
  $("#mediaOnly")?.addEventListener("change", async () => {
    const on = $("#mediaOnly").checked;
    await setStateP({ mediaPlayingRequired: on });
    refreshCheatBadge();
    toast(on ? "Only counts while a video or audio is playing"
             : "Play-something check OFF");
  });

  // Anti-cheat: inactivity pause
  $("#inactEnabled")?.addEventListener("change", async () => {
    await setStateP({ inactivityPauseEnabled: $("#inactEnabled").checked });
    toast($("#inactEnabled").checked ? "Pause when still: ON" : "Pause when still: OFF");
  });
  // The beep switch lives on the camera window itself now, next to the eye button —
  // that's where you are when the beep matters, and it keeps this card short.

  // Anti-cheat: the work page must have the whole window, not half of it
  $("#splitBlock")?.addEventListener("change", async () => {
    const on = $("#splitBlock").checked;
    await setStateP({ splitViewBlockEnabled: on });
    refreshCheatBadge();
    toast(on ? "Split screen won't earn time — the page needs the whole window"
             : "Split screen allowed — half a window still earns time");
  });

  // Anti-cheat: window must fill the screen and be focused
  $("#fullscreenOnly")?.addEventListener("change", async () => {
    const on = $("#fullscreenOnly").checked;
    await setStateP({ fullscreenOnlyEnabled: on });
    toast(on ? "Full-screen window required — half screen pauses the timer" : "Window size check OFF");
  });

  // Anti-cheat: face detection
  $("#faceEnabled")?.addEventListener("change", async () => {
    const on = $("#faceEnabled").checked;
    const patch = { faceDetectionEnabled: on };
    // The eye check rides on the same camera, so it can't outlive it. Switch it
    // off with the camera instead of leaving a switch on that does nothing.
    if (!on) patch.eyeTrackingEnabled = false;
    await setStateP(patch);
    if (!on && $("#eyeEnabled")) $("#eyeEnabled").checked = false;
    refreshCheatBadge();
    syncKidRows();
    toast(on ? "Face detection ON. Say yes to the camera on your work sites." : "Face detection OFF");
  });
  // ---- rows that belong to the switch above them ----
  // A switch id, and the rows that only mean anything while it is on. One table, so the
  // markup and the behaviour cannot disagree: every row named here ships `hidden` and is
  // revealed from here, rather than each one carrying its own condition twice.
  //
  // They used to be greyed out instead of hidden, which left a column of things that looked
  // like settings and did nothing — and a slider you can see but not use invites you to drag
  // it and wonder why nothing happened. Gone is clearer than greyed: when the check is off
  // its dial is not a setting at all.
  const KIDS = {
    faceEnabled: ["faceSensRow"],
    eyeEnabled: ["eyeSensRow"],
    liveEnabled: ["moveSensRow"],
    blinkEnabled: ["blinkSensRow"],
    // Three rows for this one, and they are worth more than the dials above: two speeds and a
    // box size are the whole of what the feature does, so with the switch off there is nothing
    // to read and with it on there is everything.
    paceEnabled: ["paceFastRow", "paceSlowRow", "paceBoxRow"],
    // Putting the video back is meaningless with nothing taking it away, so the row goes
    // with its parent.
    mediaPause: ["mediaResumeRow"]
  };
  function syncKidRows() {
    for (const [swId, rows] of Object.entries(KIDS)) {
      const box = $("#" + swId);
      const on = !!(box && box.checked);
      rows.forEach(id => { const el = $("#" + id); if (el) el.hidden = !on; });
    }
  }
  // Once now, because the rows ship hidden and the switches may already be on.
  syncKidRows();
  // There is no "wait this long" number any more: the camera check stops the clock
  // the moment it loses you, which is the whole point of it.
  // Sensitivity saves itself as you drag — the cameras pick it up straight away
  // through storage.onChanged, so there's nothing to press and nothing to reload.
  // ---- how big the camera window is ----
  // Unlike every other slider in this group, this one writes WHILE you drag rather than only on
  // release. That is the entire point of it: the thing being sized is on another page, so the only
  // way to judge a width is to watch the card change as the thumb moves. Debounced just enough that
  // a drag is a handful of writes rather than one per pixel, and every page's content script picks
  // the new value up through storage.onChanged.
  //
  // setStateP, like the rest of this page, even though camSizePx is classified "free" and cannot be
  // refused — going through the same writer is what keeps it inside strict mode's accounting and the
  // export file, rather than being a setting that quietly lives outside both.
  let camSizeTimer = 0;
  const camSizeNow = () => camSizeClamp(parseInt($("#camSize")?.value, 10));
  $("#camSize")?.addEventListener("input", () => {
    const v = camSizeNow();
    const out = $("#camSizeOut");
    if (out) out.textContent = camSizeText(v);
    clearTimeout(camSizeTimer);
    camSizeTimer = setTimeout(() => { setStateP({ camSizePx: v }).catch(() => {}); }, 110);
  });
  // The last word, so letting go always lands on exactly what the thumb shows even if the final
  // debounced write was still pending.
  $("#camSize")?.addEventListener("change", async () => {
    clearTimeout(camSizeTimer);
    const v = camSizeNow();
    try { await setStateP({ camSizePx: v }); } catch { return; }
    toast(`Camera window: ${camSizeText(v)}`);
  });

  const SENS_WORD = ["", "strict", "firm", "normal", "kind", "easy"];
  $("#faceSens")?.addEventListener("input", () => {
    const v = Math.max(1, Math.min(5, parseInt($("#faceSens").value, 10) || 3));
    const out = $("#faceSensVal");
    if (out) out.textContent = SENS_WORD[v];
  });
  $("#faceSens")?.addEventListener("change", async () => {
    const v = Math.max(1, Math.min(5, parseInt($("#faceSens").value, 10) || 3));
    await setStateP({ faceSensitivity: v });
    toast(v >= 4 ? "Camera is more forgiving now" : v <= 2 ? "Camera is stricter now" : "Camera set to normal");
  });
  // Eyes on the screen. It needs the camera, so turning it on turns that on too —
  // otherwise the switch would look on while nothing watched.
  $("#eyeEnabled")?.addEventListener("change", async () => {
    const on = $("#eyeEnabled").checked;
    const patch = { eyeTrackingEnabled: on };
    if (on) patch.faceDetectionEnabled = true;
    await setStateP(patch);
    if (on && $("#faceEnabled") && !$("#faceEnabled").checked) $("#faceEnabled").checked = true;
    refreshCheatBadge();
    syncKidRows();
    toast(on ? "Eye detection ON. Look at the screen to keep earning." : "Eye detection OFF");
  });
  const EYE_WORD = ["", "fussy", "firm", "normal", "kind", "easy"];
  $("#eyeSens")?.addEventListener("input", () => {
    const v = Math.max(1, Math.min(5, parseInt($("#eyeSens").value, 10) || 3));
    const out = $("#eyeSensVal");
    if (out) out.textContent = EYE_WORD[v];
  });
  $("#eyeSens")?.addEventListener("change", async () => {
    const v = Math.max(1, Math.min(5, parseInt($("#eyeSens").value, 10) || 3));
    await setStateP({ eyeSensitivity: v });
    toast(v <= 2 ? "Eye check is fussier now" : v >= 4 ? "Eye check is easier now" : "Eye check set to normal");
  });
  $("#liveEnabled")?.addEventListener("change", async () => {
    const on = $("#liveEnabled").checked;
    await setStateP({ livenessEnabled: on });
    syncKidRows();
    toast(on ? "Head movement check ON. Sitting perfectly still pauses the clock." : "Head movement check OFF");
  });
  // Its dial reads the same way round as the face one — 1 asks for a real shift of position,
  // 5 takes almost anything — so it borrows the same five words.
  $("#moveSens")?.addEventListener("input", () => {
    const v = Math.max(1, Math.min(5, parseInt($("#moveSens").value, 10) || 3));
    const out = $("#moveSensVal");
    if (out) out.textContent = SENS_WORD[v];
  });
  $("#moveSens")?.addEventListener("change", async () => {
    const v = Math.max(1, Math.min(5, parseInt($("#moveSens").value, 10) || 3));
    await setStateP({ moveSensitivity: v });
    toast(v >= 4 ? "A nod is enough now" : v <= 2 ? "It wants a real shift of position now" : "Movement check set to normal");
  });
  // The blink check. Like the eye check it rides on the same camera, so switching it on
  // switches that on too — otherwise the switch would look on while nothing watched.
  $("#blinkEnabled")?.addEventListener("change", async () => {
    const on = $("#blinkEnabled").checked;
    const patch = { blinkRequired: on };
    if (on) patch.faceDetectionEnabled = true;
    await setStateP(patch);
    if (on && $("#faceEnabled") && !$("#faceEnabled").checked) $("#faceEnabled").checked = true;
    refreshCheatBadge();
    syncKidRows();
    toast(on ? "Blink check ON. A photo can't blink, so this is the strongest check there is." : "Blink check OFF");
  });
  // Its own words, because its ends mean something different from the others: this dial is
  // about how faint a blink the camera will still catch, not about how much effort you make.
  const BLINK_WORD = ["", "clear", "firm", "normal", "kind", "faint"];
  $("#blinkSens")?.addEventListener("input", () => {
    const v = Math.max(1, Math.min(5, parseInt($("#blinkSens").value, 10) || 3));
    const out = $("#blinkSensVal");
    if (out) out.textContent = BLINK_WORD[v];
  });
  $("#blinkSens")?.addEventListener("change", async () => {
    const v = Math.max(1, Math.min(5, parseInt($("#blinkSens").value, 10) || 3));
    await setStateP({ blinkSensitivity: v });
    toast(v >= 4 ? "Fainter blinks will be caught now" : v <= 2 ? "It wants an unmistakable blink now" : "Blink check set to normal");
  });

  // ---- the timer speed ----
  // Like the eye and blink checks, it rides on the same camera, so switching it on switches that
  // on too — otherwise the switch would look on while nothing was looking. Unlike them, it is not
  // a check, so it stays out of the "N/8 on" badge above.
  // Whatever the three sliders in THIS card currently say, for the preview.
  const paceCardVals = () => ({
    fast: paceVal("paceFast", parseFloat($("#paceFast")?.value)),
    slow: paceVal("paceSlow", parseFloat($("#paceSlow")?.value)),
    box: paceVal("paceBoxPct", parseFloat($("#paceBox")?.value)),
    fs: Math.max(1, Math.min(5, parseInt($("#faceSens")?.value, 10) || 3))
  });
  // The "you may never fill this box" row. Two conditions, not one — the box has to be past the
  // reachable point AND the feature has to be on — so it is deliberately NOT in the KIDS table,
  // which knows about switches only.
  function syncPaceWarn() {
    const el = $("#paceBox"), row = $("#paceBoxWarnRow"), say = $("#paceBoxWarn");
    if (!el || !row) return;
    const warn = paceBoxWarnText(paceVal("paceBoxPct", parseFloat(el.value)));
    if (say) say.textContent = warn;
    row.hidden = !warn || !$("#paceEnabled")?.checked;
  }
  $("#paceEnabled")?.addEventListener("change", async () => {
    const on = $("#paceEnabled").checked;
    const patch = { paceEnabled: on };
    if (on) patch.faceDetectionEnabled = true;
    await setStateP(patch);
    if (on && $("#faceEnabled") && !$("#faceEnabled").checked) $("#faceEnabled").checked = true;
    syncKidRows();
    // Opened on the way on, because the first thing anyone needs after switching this on is to
    // find out where the box is and whether they are in it. Closed on the way off, so the camera
    // is not left running for a feature that no longer exists.
    if (on) pacePv.show(paceCardVals()); else pacePv.close();
    syncPaceWarn();
    toast(on ? "Lean into the camera to earn time faster. Fill the dashed box on the preview."
             : "Timer speed boost OFF");
  });
  $("#pacePreview")?.addEventListener("click", () => pacePv.show(paceCardVals()));
  // The three number sliders. Same shape as the dials above — the label follows the thumb as you
  // drag, the value is written when you let go, one movement one decision — but read through
  // PACE_DIAL, so the bounds here cannot drift from the ones the markup drew or the ones a
  // target's own panel saves.
  function bindPace(id, outId, key, say) {
    const el = $("#" + id);
    if (!el) return;
    const paint = () => {
      const out = $("#" + outId);
      if (out) out.textContent = paceText(key, parseFloat(el.value));
      if (key === "paceBoxPct") syncPaceWarn();
    };
    el.addEventListener("input", () => {
      paint();
      // Live, on every step of the drag. This is the whole reason the preview exists: the box
      // size is a number about your room, and the only way to pick it is to watch the square
      // change on your own face while you move the slider.
      pacePv.show(paceCardVals());
    });
    el.addEventListener("change", async () => {
      const v = paceVal(key, parseFloat(el.value));
      // Snapped back to what was actually stored, so the thumb never sits at a value the clamp
      // refused. It matters at the ends: drag past 4× and the slider stops there anyway, but a
      // typed or scripted value would not.
      el.value = String(v);
      paint();
      pacePv.show(paceCardVals());   // the released value, in case the drag's last step was lost
      await setStateP({ [key]: v });
      toast(say(v));
    });
  }
  bindPace("paceFast", "paceFastVal", "paceFast", (v) =>
    v <= 1 ? "No bonus for leaning in now — 1× is normal speed"
           : "Facing the camera now counts at " + paceText("paceFast", v));
  bindPace("paceSlow", "paceSlowVal", "paceSlow", (v) =>
    v >= 1 ? "No penalty for sitting back now — 1× is normal speed"
           : "Sitting back now counts at " + paceText("paceSlow", v));
  bindPace("paceBox", "paceBoxVal", "paceBoxPct", (v) =>
    v > PACE_BOX_REACH ? "Careful — at " + v + "% your head may never fill the box. Watch the preview."
    : v >= 65 ? "You'll have to sit quite close now"
    : v <= 40 ? "A head further back will do now"
    : "Focus box set to " + paceText("paceBoxPct", v));
  // Once now: the row ships hidden and the stored value may already be past the reachable point,
  // which is exactly the case that needs telling.
  syncPaceWarn();


  // ---- Strict mode: the window saves itself, the switch asks first ----------
  // Two boxes and one switch. Setting a time is harmless on its own — it only
  // means anything once the switch is on — so it writes straight through with no
  // Save button, like the anti-cheat numbers and the phone addresses.
  let strictTimer = 0;
  // Another blanket refusal that stays, and for the same reason as the mode swap: a time of day
  // has no stricter direction. Moving the start earlier lengthens the window if the end is fixed
  // and shortens it once you have crossed midnight, so the table marks both times "free" — which
  // means setStateP would let them through, and moving the goalposts while the window is running
  // is the one thing it exists to stop. So it is refused here, where the answer is certain.
  async function saveStrictWindow() {
    const st = await getState();
    if (inStrictWindow(st)) { renderApp(); return toast("Strict mode is on. Change these times later."); }
    // Through the same parser the guard uses, so a half-cleared time box cannot store
    // something the guard would read differently from what the card shows.
    const from = strictTime($("#strictStart")?.value, STRICT_FROM);
    const to   = strictTime($("#strictEnd")?.value, STRICT_TO);
    if (from === strictTime(st.strictStart, STRICT_FROM) && to === strictTime(st.strictEnd, STRICT_TO)) return;
    await setStateP({ strictStart: from, strictEnd: to });
    const say = $("#strictSaved");
    if (say) {
      // An empty window is the one case worth speaking up about: identical times
      // mean strict mode can never actually be in force, which is not obvious.
      say.textContent = from === to ? "same time — nothing would be locked" : "saved ✓";
      clearTimeout(saveStrictWindow._t);
      saveStrictWindow._t = setTimeout(() => { if (say) say.textContent = ""; }, 2000);
    }
  }
  ["strictStart", "strictEnd"].forEach(id => {
    const el = $("#" + id);
    if (!el) return;
    // `input` fires while the clock is still being nudged, so it's debounced;
    // `change` and Enter mean "I'm done", and write at once.
    el.addEventListener("input", () => { clearTimeout(strictTimer); strictTimer = setTimeout(saveStrictWindow, 500); });
    el.addEventListener("change", () => { clearTimeout(strictTimer); saveStrictWindow(); });
    el.addEventListener("keydown", (e) => {
      if (e.key !== "Enter" || e.isComposing) return;
      e.preventDefault(); clearTimeout(strictTimer); saveStrictWindow(); el.blur();
    });
  });

  // ---- the commitment date ----
  // Three boxes and six arrows rather than a native date input, so the date reads in the
  // order it is spoken and one press is one day.
  const dPad = (n) => String(n).padStart(2, "0");
  const thisYearNow = () => new Date().getFullYear();
  // What the boxes currently say, as a date that exists. The day is clamped rather than
  // refused: if you are on the 31st and step the month to February, the honest answer is
  // the 28th, not an error about a day you never typed.
  function readUntilBoxes() {
    // The year is held to the range the box advertises. A max attribute is a hint a
    // spinner honours and a typed digit ignores, so without this you could type 9999 and
    // the box would keep it — a ceiling that only applies to the arrows is not a ceiling.
    const y = Math.max(thisYearNow(), Math.min(thisYearNow() + YEARS_AHEAD,
                                               FGStrict.fin($("#untilY")?.value) || thisYearNow()));
    const m = Math.max(1, Math.min(12, FGStrict.fin($("#untilM")?.value) || 1));
    const d = Math.max(1, Math.min(FGStrict.lastDayOf(y, m), FGStrict.fin($("#untilD")?.value) || 1));
    return { y, m, d, iso: y + "-" + dPad(m) + "-" + dPad(d) };
  }
  function readUntilTime() { return FGStrict.hhmm($("#untilT")?.value, FGStrict.strictUntilTime(null)); }
  // Written back after every change, so the boxes always show the date that would be
  // saved. Without this the day box could sit on 31 while the date being committed to was
  // the 28th.
  function paintUntilBoxes(v) {
    if ($("#untilY")) $("#untilY").value = String(v.y);
    if ($("#untilM")) $("#untilM").value = String(v.m);
    if ($("#untilD")) $("#untilD").value = String(v.d);
  }
  async function paintUntilPreview() {
    const el = $("#untilPreview");
    if (!el) return;
    const v = readUntilBoxes();
    const st = await getState();
    const running = FGStrict.strictDeadlineActive(st);
    // How long it is for, in red. It is the number that matters here and the only one with
    // a consequence attached — the date is just where that number lands. In the same grey
    // as the date, "68 days" reads as a footnote to a date picker rather than as the length
    // of a commitment you cannot take back.
    //
    // innerHTML rather than textContent, because a colour needs an element to hang off.
    // Both parts are escaped even though they come from strict.js and are built from digits
    // and month names: this line is rewritten on every keystroke, and "the source is
    // trusted" stops being true the first time someone adds a field to it.
    const red = (t) => `<span class="dred">${escHtml(t)}</span>`;
    if (running) {
      // The boxes are showing the committed moment and are dead, so this reports the
      // stretch rather than previewing a change to it.
      const left = FGStrict.strictLeftText(st);
      el.innerHTML = escHtml("On until " + FGStrict.strictUntilLabel(FGStrict.strictUntil(st)) +
                             ", " + FGStrict.strictUntilTime(st)) +
                     (left ? " · " + red(left + " left") : "");
      return;
    }
    // Measured as a moment, not a day, because that is what is being set. Through the same
    // helper the lock itself uses, so this line and the hint below cannot disagree.
    const probe = { ...st, strictUntil: v.iso, strictUntilTime: readUntilTime() };
    const at = FGStrict.strictDeadlineAt(probe);
    const when = FGStrict.strictUntilLabel(v.iso) + ", " + readUntilTime();
    if (!at || at <= Date.now()) { el.innerHTML = escHtml(when) + " · " + red("already gone"); return; }
    const leftNew = FGStrict.strictLeftText(probe);
    el.innerHTML = escHtml(when) + (leftNew ? " · " + red(leftNew) : "");
  }
  document.querySelectorAll("[data-dstep]").forEach(b => b.addEventListener("click", () => {
    const [id, stepRaw] = String(b.getAttribute("data-dstep") || "").split(":");
    const step = FGStrict.fin(stepRaw);
    const v = readUntilBoxes();
    if (id === "D") {
      // Clamped, not wrapped. The 31st stepping up to the 1st would move the commitment a
      // month BACKWARDS, which is the one direction this control must never take.
      v.d = Math.max(1, Math.min(FGStrict.lastDayOf(v.y, v.m), v.d + step));
    } else if (id === "M") {
      v.m = Math.max(1, Math.min(12, v.m + step));
      v.d = Math.min(v.d, FGStrict.lastDayOf(v.y, v.m));
    } else {
      v.y = Math.max(thisYearNow(), Math.min(thisYearNow() + YEARS_AHEAD, v.y + step));
      v.d = Math.min(v.d, FGStrict.lastDayOf(v.y, v.m));   // 29 Feb only exists some years
    }
    paintUntilBoxes(v);
    paintUntilPreview();
  }));
  ["untilD", "untilM", "untilY"].forEach(id => {
    const el = $("#" + id);
    if (!el) return;
    el.addEventListener("input", paintUntilPreview);
    // Tidied when you leave the box, not while typing: clamping mid-keystroke turns "1" on
    // its way to "12" into "1", and then the next digit makes it "11".
    el.addEventListener("change", () => { paintUntilBoxes(readUntilBoxes()); paintUntilPreview(); });
  });
  $("#untilT")?.addEventListener("input", paintUntilPreview);
  $("#untilT")?.addEventListener("change", paintUntilPreview);
  paintUntilPreview();

  // ---- one warning, for both halves ----
  // Same words, same shape, for both switches. The only thing that differs is the sentence
  // saying WHEN it applies, which is the only real difference between them. Two different
  // dialogues for two switches on one card would read as two unrelated features, and the
  // lighter one would teach you to click through the heavier one without reading it.
  const STRICT_LOSSES =
    "a target's time cannot be lowered, work cannot be deleted, today's time cannot be wound "
    + "back, sites cannot be unblocked, the anti-cheat checks cannot be eased off, FocusGate "
    + "cannot be switched off, and neither of these two switches can be turned off";
  function confirmStrictOn({ title, when, tail }) {
    return confirmAsk({
      title,
      body: `${escHtml(when)} ${STRICT_LOSSES}.<br/><br/>${tail}<br/><br/>Making things
             <b>stricter</b> stays possible at any time: raising a target's time, adding work,
             taking sites off the locked list, tightening the camera dials.`,
      go: "Lock it",
      no: "Cancel",
      danger: true
    });
  }

  // ---- the daily freeze's own switch ----
  $("#strictEn")?.addEventListener("change", async () => {
    const st = await getState();
    const want = !!$("#strictEn")?.checked;
    if (!want) {
      // One refusal covers both reasons, because inStrictWindow covers both. The message
      // names which one, since "it cannot be switched off" with no reason given is the kind
      // of thing people assume is a bug.
      if (inStrictWindow(st)) {
        renderApp();
        if (FGStrict.strictDeadlineActive(st)) {
          const left = FGStrict.strictLeftText(st);
          return toast("Strict mode is held until " + FGStrict.strictUntilLabel(FGStrict.strictUntil(st)) +
                       ", " + FGStrict.strictUntilTime(st) + (left ? " — " + left + " left." : "."));
        }
        return toast("Strict mode is active right now — it cannot be switched off until the window ends");
      }
      await setStateP({ strictModeEnabled: false });
      renderApp();
      return toast("Daily freeze off");
    }
    // Turning it ON stores the times the card is displaying, not just the flag. Storing
    // only the flag left the times absent, the guard fell back to a zero-length window, and
    // strict mode was armed in the UI and inert in fact.
    clearTimeout(strictTimer);
    const from = strictTime($("#strictStart")?.value, strictTime(st.strictStart, STRICT_FROM));
    const to = strictTime($("#strictEnd")?.value, strictTime(st.strictEnd, STRICT_TO));
    if (from === to) {
      renderApp();
      return toast("Pick two different times first — a window that starts and ends together never opens.");
    }
    if (!await confirmStrictOn({
      title: "Freeze settings from " + from + " to " + to + " every day?",
      when: "Between those two times, every day:",
      // The one thing this switch has to say that its neighbour does not: it does end on
      // its own.
      tail: `The window lifts by itself when it reaches <b>${escHtml(to)}</b>, and comes back the next day.`
    })) { renderApp(); return; }
    // Already confirmed: confirmStrictOn spells out what the window costs, in far more detail
    // than a generic "make this stricter" could.
    await setStateP({ strictStart: from, strictEnd: to, strictModeEnabled: true }, { confirmed: true });
    renderApp();
    toast("Settings will freeze from " + from + " to " + to);
  });

  // ---- the deadline's own switch ----
  // The only control this row has. On reads the boxes, warns, and starts the stretch; off
  // ends it, and is refused while it is running, which is the whole point of it.
  $("#strictUntilEn")?.addEventListener("change", async () => {
    const st = await getState();
    const want = !!$("#strictUntilEn")?.checked;
    if (!want) {
      if (FGStrict.strictDeadlineActive(st)) {
        renderApp();
        const left = FGStrict.strictLeftText(st);
        return toast("You committed until " + FGStrict.strictUntilLabel(FGStrict.strictUntil(st)) +
                     ", " + FGStrict.strictUntilTime(st) + (left ? " — " + left + " left." : ".") +
                     " It cannot be ended early.");
      }
      // Expired, or never really started. Clearing the switch is free.
      await setStateP({ strictUntilEnabled: false });
      renderApp();
      return toast("Commitment off");
    }
    // Flipping it on is what starts the stretch. There is no Save button: the boxes are the
    // value, the switch is the action, and the warning in between is what makes it
    // deliberate.
    const want_ = readUntilBoxes().iso;
    const wantT = readUntilTime();
    const at = FGStrict.strictDeadlineAt({ strictUntil: want_, strictUntilTime: wantT });
    if (!at) { renderApp(); return toast("That isn't a real date and time."); }
    if (at <= Date.now()) { renderApp(); return toast("That moment has already gone. Pick a later one."); }
    // A commitment already in place may only be pushed further out. Reaching here with one
    // running should be impossible — the switch is locked on — but this is the rule the
    // whole feature rests on, so it is checked where it is acted on rather than trusted to
    // a disabled attribute.
    const curAt = FGStrict.strictDeadlineAt(st);
    if (FGStrict.strictDeadlineActive(st) && at < curAt) {
      renderApp();
      return toast("A commitment can only be pushed further out, never pulled closer.");
    }
    const leftNew = FGStrict.strictLeftText({ strictUntil: want_, strictUntilTime: wantT });
    if (!await confirmStrictOn({
      title: "Keep strict mode on until " + FGStrict.strictUntilLabel(want_) + ", " + wantT + "?",
      when: "From now until then, continuously — day and night, not just inside a window:",
      // The one thing this switch has to say that its neighbour does not: it does not lift
      // by itself, and it cannot be moved.
      tail: `That is <b>${escHtml(leftNew || "less than a minute")}</b> from now. It cannot be
             shortened afterwards, and there is <b>no undo</b>.`
    })) { renderApp(); return; }
    // The switch and the moment are written together. One without the other would look like
    // a lock and hold nothing — strictDeadlineActive needs both.
    // Already confirmed, and by a sheet that says "no undo" in as many words.
    await setStateP({ strictUntil: want_, strictUntilTime: wantT, strictUntilEnabled: true }, { confirmed: true });
    renderApp();
    toast("Strict mode is on until " + FGStrict.strictUntilLabel(want_) + ", " + wantT);
  });

  // ---- backup & restore ----
  const backupSay = (msg) => {
    const el = $("#backupSaid");
    if (!el) return;
    el.textContent = msg;
    clearTimeout(backupSay._t);
    backupSay._t = setTimeout(() => { if (el) el.textContent = ""; }, 6000);
  };
  $("#expSettings")?.addEventListener("click", async () => {
    const st = await getState();
    const file = FGSettings.exportFrom(st, { version: chrome.runtime.getManifest().version });
    const body = JSON.stringify(file, null, 2);
    // A blob URL and a synthetic click, because an extension page has no Save dialog of its
    // own. Revoked straight after: the URL holds the whole file in memory until it is.
    let url = "";
    try {
      url = URL.createObjectURL(new Blob([body], { type: "application/json" }));
      const a = document.createElement("a");
      a.href = url;
      // Dated, so a folder of backups sorts itself and you can tell which is which.
      a.download = `focusgate-settings-${FGStrict.todayStamp(st)}.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
    } catch {
      return toast("Could not save the file");
    } finally {
      if (url) setTimeout(() => { try { URL.revokeObjectURL(url); } catch {} }, 10000);
    }
    const n = Object.keys(file.settings).length;
    backupSay(`Saved ${n} settings. Your password and today's progress are deliberately not in the file.`);
    toast("Settings saved to a file ✓");
  });
  // The button opens the picker; the input does the reading. Two elements for one action,
  // because a file input cannot be styled to match the button above it.
  //
  // Import stays refused outright during a strict window, and it is the one refusal here that is
  // not about a missing direction. A backup replaces forty settings at once, so it will almost
  // always tighten some and ease others — the direction table would call that a loosening and
  // refuse it, which is right, but "almost always" is not a rule. Turning the whole file away is,
  // and it means a strict window cannot be ended by restoring yesterday's file.
  $("#impSettings")?.addEventListener("click", async () => {
    const st = await getState();
    if (inStrictWindow(st)) return toast("Strict mode is on. You cannot import settings now.");
    $("#impFile")?.click();
  });

  // ---- put everything back to how it shipped ----
  // Three gates, in this order, and the order is the whole of it.
  //
  // Strict mode first, because it is the one answer no password can overrule: a reset switches off
  // every check at once, which is the largest loosening the extension has, so being able to do it
  // mid-window would make strict mode a suggestion. Refused here as well as disabled in the markup,
  // since a disabled attribute is a hint and this is a rule — and the window can open between the
  // page being drawn and the button being pressed.
  //
  // Then the password, for the same reason it guards easing any single rule off. This eases all of
  // them off at once.
  //
  // Then the typed phrase and the countdown, which are not about discipline at all — they are about
  // the work. The rules can be set again in a minute; a list of work sites with their times cannot,
  // and there is no undo. Same sheet the other irreversible things on this page use.
  $("#resetAll")?.addEventListener("click", async () => {
    const st = await getState();
    if (inStrictWindow(st)) return toast(strictRefusal({ enabled: false }, st));
    if (!(await requireUnlock())) return toast("Password needed to reset your settings 🔒");
    // Counted the same way the worker counts a live target — switched on and with time on it.
    // Written out rather than borrowed: activeTargets lives in background.js and this page has
    // never had it, so calling it here would have thrown at the moment the button was pressed.
    const sites = (st.productiveSites || [])
      .filter(p => p && p.enabled !== false && (Number(p.requiredSec) || 0) >= 0).length;
    const locked = (st.blockedSites || []).length;
    // Counted and named, because "all your settings" is not a quantity anyone can picture. Being
    // told two work sites and eleven locked sites are about to go is what makes this a decision
    // rather than a guess.
    const bits = [];
    if (sites) bits.push(sites === 1 ? "1 work site" : sites + " work sites");
    if (locked) bits.push(locked === 1 ? "1 locked site" : locked + " locked sites");
    if (!await confirmReset({
      title: "Reset settings to default?",
      body: (bits.length ? bits.join(" and ") + " will be deleted, and every " : "Every ")
            + "check, dial and rule goes back to its default. Strict mode, the day boundary and the "
            + "phone bridge are cleared too.\n\n"
            + "Your password, your streak and your XP are kept.\n\n"
            + "This cannot be undone. Export first if you might want your setup back.",
      go: "Reset settings"
    })) return;
    // Re-read and re-check: the sheet was open for at least the length of its countdown, and a
    // strict window can begin inside that. This is the write that matters.
    const fresh = await getState();
    if (inStrictWindow(fresh)) return toast(strictRefusal({ enabled: false }, fresh));
    let ok = false;
    try {
      ok = await new Promise(res => {
        chrome.runtime.sendMessage({ type: "resetSettings" }, (r) => {
          void chrome.runtime.lastError;
          res(!!(r && r.ok));
        });
      });
    } catch {}
    // The worker owns DEFAULTS, so it does the writing — see the handler there. If it could not,
    // nothing was written, and saying so is better than a page that redraws looking unchanged.
    if (!ok) return toast("Could not reset. Try reloading the extension.");
    renderApp();
    toast("Settings reset to default");
  });
  $("#impFile")?.addEventListener("change", async (e) => {
    const input = e.target;
    const f = input.files && input.files[0];
    // Cleared straight away, so choosing the same file twice in a row still fires a change.
    const clear = () => { try { input.value = ""; } catch {} };
    if (!f) return clear();
    // Re-checked here, not just on the button: the window could have opened between the
    // click and the file being chosen, and this is the write that matters.
    const fresh = await getState();
    if (inStrictWindow(fresh)) { clear(); return toast("Strict mode is on. You cannot import settings now."); }
    let parsed;
    try {
      parsed = JSON.parse(await f.text());
    } catch {
      clear();
      return toast("That file isn't readable JSON");
    }
    const res = FGSettings.importFrom(parsed);
    if (!res.ok) { clear(); return toast(res.reason); }
    // Replacing everything at once is worth a confirmation, and the count is the honest
    // way to say how much: "settings" alone could be two values or forty.
    const okGo = await confirmAsk({
      title: `Replace your settings with this file?`,
      body: `It holds <b>${res.took}</b> settings, including your work sites and locked lists.
             Everything currently set up here is overwritten.
             <br/><br/>Your <b>password</b> and <b>today's progress</b> are not touched — they were
             never in the file.
             ${res.skipped.length ? `<br/><br/><b>${res.skipped.length}</b> entr${res.skipped.length === 1 ? "y was" : "ies were"}
                skipped: either not a FocusGate setting, or not a value its own control could produce.` : ""}`,
      go: "Replace them",
      no: "Cancel",
      danger: true
    });
    clear();
    if (!okGo) return;
    const again = await getState();
    if (inStrictWindow(again)) return toast("Strict mode is on. You cannot import settings now.");
    // Already confirmed by the sheet above, which named the count and said what it overwrites.
    // A file that eases anything off still meets the password gate — `confirmed` only silences
    // the duplicate question, it cannot skip the password.
    await setStateP(res.patch, { confirmed: true });
    // What is blocked follows from what was just replaced, so don't wait for the next poll.
    chrome.runtime.sendMessage({ type: "refreshBlockedTabs" });
    renderApp();
    backupSay(`Restored ${res.took} settings${res.skipped.length ? `, skipped ${res.skipped.length}` : ""}.`);
    toast("Settings restored ✓");
    const hasLocal = (res.patch.productiveSites || []).some(p => p.type === "local_file" || (p.url && p.url.startsWith("file:")) || (p.path && p.path.length > 0));
    if (hasLocal && !(await fileAccessAllowed())) {
      setTimeout(showFileAccessAlert, 300);
    }
  });

  // Stays refused. Where the day boundary sits is "free" in the table — it makes no goal bigger
  // or smaller — but moving it mid-window resets every counter early, which is a way out of
  // today's work that does not look like one. No direction to judge, so refuse it outright.
  $("#saveTime")?.addEventListener("click", async () => {
    const st = await getState();
    if (inStrictWindow(st)) return toast("Strict mode: cannot change reset time");
    await setStateP({ dailyResetTime: $("#resetTime").value || "00:00" });
    toast("Saved");
  });
  // Allowed during a strict window, like the two smaller reset buttons: starting the day over
  // throws away time you have already earned and re-locks everything, which is as strict as this
  // page gets. It was refused, which is the wrong way round.
  $("#resetNow")?.addEventListener("click", async () => {
    const st = await getState();
    const t = todayTotals(st);
    if (!await confirmReset({
      title: "Start the whole day over?",
      body: `${fmtDur(t.spent)} done today goes back to zero on every site, and the locked sites lock again. This cannot be undone.`,
      go: "Reset the day"
    })) return;
    const fresh = await getState();
    // Already confirmed, and by the sheet that makes you type the words out.
    //
    // graceFrom stays, for the same reason it stays on the single-row ↺ above: the stopwatches are running
    // because the sites were opened, and this button throws away progress rather than rewriting history.
    // Only the daily reset starts them over — see maybeReset in background.js.
    await setStateP({ productiveSites: (fresh.productiveSites || []).map(p => ({...p, spentSec: 0, metAt: 0})) }, { confirmed: true });
    toast("The day started over");
    renderApp();
  });
}

function renderSecurity(s) {
  const tc = document.getElementById("tabContent");
  const strict = inStrictWindow(s);
  const pwOn = s.passwordProtectionEnabled !== false;
  // Guard the default: an unset delay used to render as "undefineds".
  const lockDelay = Math.max(0, s.autoLockDelaySec || 0);
  tc.innerHTML = `
    <div class="card">
      <div class="chead">
        <span class="ctile" aria-hidden="true">🔑</span>
        <div class="ctitle">
          <div class="crow">
            <h2>Password ${tip(`When this is <b>on</b>, your password is needed to <b>ease a rule off</b> — lower a goal, switch a check off, unblock a site — so you can't quickly undo your own rules in a weak moment.<br/><br/>You can always <b>open and read</b> this page without it, and you can always make a rule <b>stricter</b> without it. Only the loosening direction asks.<br/><br/><b>The switch is the only control.</b> Turning it on is one click. Turning it off asks for your password first, because that is the weak-moment act this whole feature exists to slow down.<br/><br/>Your password is kept when you switch it off, so turning it back on never means setting a new one.<br/><br/>FocusGate also <b>locks itself</b> when you close it — there's no lock button on purpose. Change how soon in the ⚙️ Setup tab.${strict ? "<br/><br/><b style='color:#fca5a5'>Strict mode: you can't change any of this right now.</b>" : ""}`)}</h2>
          </div>
          <div class="csub">${pwOn
            ? `on · asked when you ease a rule off · locks itself ${lockDelay === 0 ? "as soon as you close it" : `${lockDelay}s after you close it`}`
            : (s.passwordHash
                ? `<span class="why">off</span> · anyone here can change your rules`
                : `<span class="why">off</span> · set one below to protect your rules`)}</div>
        </div>
        ${sw("pwOn", pwOn, strict, "pw-on")}
      </div>

      ${pwOn ? `
      <!-- One line, one job. Changing the password is a rare act, so it asks for
           the two boxes in a sheet rather than parking them on the card. -->
      <div class="srow" style="padding-top:0">
        <button class="btn sec" id="changePw" ${strict?"disabled style='opacity:.4;cursor:not-allowed'":""} data-testid="change-pw-btn">✏️ Change password</button>
      </div>`
      : (s.passwordHash ? "" : `
      <!-- No password exists yet, so the switch has nothing to turn on. This is
           the only case that still needs a box on the card. -->
      <div class="addrow" id="pwNewRow">
        <span class="gicon" aria-hidden="true">🔒</span>
        <input class="input grow" id="newProtPw" type="password" placeholder="Choose a password (4+ characters)" data-testid="new-prot-pw"/>
        <button class="btn round" id="enableProt" title="Turn the password on" aria-label="Turn the password on" data-testid="enable-prot-btn">✓</button>
      </div>
      <div class="err" id="protErr"></div>`)}
    </div>

    ${pwOn ? `<div class="card">
      <div class="chead">
        <span class="ctile" aria-hidden="true">🔒</span>
        <div class="ctitle">
          <div class="crow">
            <h2>Lock full settings page ${tip(`When this is <b>on</b>, opening the settings page shows <b>only a password prompt</b> — nothing is visible until you enter your password. Not the work targets, not the blocklist, not the streak.<br/><br/>When <b>off</b> (the default), the settings page opens normally and only asks for your password when you try to ease a rule off.<br/><br/>While this is on and the page is locked, the webhook URLs cannot be edited either.${strict ? "<br/><br/><b style='color:#fca5a5'>Strict mode: you can't change this right now.</b>" : ""}`)}</h2>
          </div>
          <div class="csub">${s.fullPageLockEnabled ? "on · page is hidden until unlocked" : `<span class="why">off</span> · page is read-only when locked`}</div>
        </div>
        ${sw("fpLockOn", !!s.fullPageLockEnabled, strict, "fp-lock-on")}
      </div>
    </div>` : ""}`;

  // The switch is the only on/off control. Turning it ON is free when a password
  // already exists. Turning it OFF is the weak-moment act the whole feature
  // exists to slow down, so it asks for the password in a sheet and the switch
  // springs back to on until that succeeds.
  $("#pwOn")?.addEventListener("change", async () => {
    const st = await getState();
    if (inStrictWindow(st)) { renderApp(); return toast("Strict mode: cannot change password settings"); }
    const wantOn = $("#pwOn").checked;

    if (wantOn) {
      if (!st.passwordHash) {
        $("#pwOn").checked = false;              // nothing to protect with yet
        renderApp();
        return toast("Choose a password first");
      }
      // Raw, and unlocked: switching protection back on is the stricter direction, so it must
      // not be refused, and this session has just proved it is allowed to touch the setting.
      await setStateRaw({ passwordProtectionEnabled: true, sessionUnlocked: true });
      editLocked = false;
      renderRoot();
      return toast("Password needed again 🔒");
    }

    $("#pwOn").checked = true;                   // stays on unless this succeeds
    const done = await secretPrompt({
      title: "Turn the password off?",
      body: `Then the popup and this settings page open with one click, and anyone at
             this computer — including you in a weak moment — can change your rules
             or switch FocusGate off.<br/><br/>Your password is kept, so you can turn
             this back on any time without setting it again.`,
      fields: [{ label: "Your password", placeholder: "Password", testid: "disable-prot-pw" }],
      go: "Turn it off",
      verify: async ([pw], say) => {
        if (!pw) { say("Enter your password"); return false; }
        const fresh = await getState();
        if (inStrictWindow(fresh)) { say("Strict mode is on — not now"); return false; }
        if ((await sha256(pw)) !== fresh.passwordHash) { say("Wrong password"); return false; }
        // Raw: this form IS the password check, and turning protection off is exactly the
        // loosening the gate would otherwise ask about — twice, for one decision.
        await setStateRaw({ passwordProtectionEnabled: false, sessionUnlocked: true });
        editLocked = false;
        return true;
      }
    });
    if (done) { renderRoot(); toast("Password protection is off"); }
    else renderRoot();                           // put the switch back where it was
  });

  $("#changePw")?.addEventListener("click", async () => {
    const st = await getState();
    if (inStrictWindow(st)) return toast("Strict mode: cannot change password");
    const done = await secretPrompt({
      title: "Change your password",
      body: "The current one first, so a password left unlocked on screen can't be swapped by someone else.",
      fields: [
        { label: "Current password", placeholder: "Current", testid: "old-pw" },
        { label: "New password", placeholder: "At least 4 characters", testid: "new-pw" }
      ],
      go: "Save it",
      verify: async ([oldP, newP], say) => {
        if (!oldP || !newP) { say("Fill both boxes"); return false; }
        const fresh = await getState();
        if (inStrictWindow(fresh)) { say("Strict mode is on — not now"); return false; }
        if ((await sha256(oldP)) !== fresh.passwordHash) { say("Wrong current password"); return false; }
        if (newP.length < 4) { say("The new one needs 4 characters or more"); return false; }
        if (oldP === newP) { say("That's the same password"); return false; }
        // Raw: the old password was just typed and checked two lines up. Swapping one password
        // for another is neither looser nor stricter, so there is nothing for the gate to weigh
        // — and passwordHash is not a setting, so the table has no opinion on it either.
        await setStateRaw({ passwordHash: await sha256(newP) });
        return true;
      }
    });
    if (done) toast("Password updated ✓");
  });

  // The one box that still lives on the card: there's no password yet, so there's
  // nothing to ask for before setting one.
  $("#enableProt")?.addEventListener("click", async () => {
    const err = $("#protErr");
    const np = $("#newProtPw")?.value || "";
    if (np.length < 4) { if (err) err.textContent = "Use at least 4 characters"; return; }
    // Raw, both halves: there is no password to ask for yet — this line is the one making it —
    // and switching protection on is the stricter direction anyway.
    await setStateRaw({ passwordHash: await sha256(np), passwordProtectionEnabled: true, sessionUnlocked: true });
    if (err) err.textContent = "";
    editLocked = false;
    renderRoot();
    toast("Password protection is on 🔒");
  });

  // ---- full-page lock toggle ----
  // Turning it ON is the stricter direction: it hides the whole page instead of just gating edits.
  // Turning it OFF is a loosening and goes through setStateP, which asks for the password.
  $("#fpLockOn")?.addEventListener("change", async () => {
    const st = await getState();
    if (inStrictWindow(st)) { renderRoot(); return toast("Strict mode: cannot change this right now"); }
    const wantOn = $("#fpLockOn").checked;
    if (wantOn) {
      // Stricter direction — free.
      await setStateRaw({ fullPageLockEnabled: true });
      toast("Full-page lock on 🔒");
    } else {
      // Loosening — password gate handles it.
      try {
        await setStateP({ fullPageLockEnabled: false });
        toast("Full-page lock off");
      } catch (e) {
        renderRoot();
        return;
      }
    }
    renderRoot();
  });
}

// ---------------------------------------------------------------------------
// Live progress. The background credits a second at a time, and this page used
// to only find out when you reloaded it. Re-rendering the tab every second isn't
// an option — it would take the focus out of whatever box you're typing in — so
// only the numbers, the bars and the row colours are repainted.
// ---------------------------------------------------------------------------
function paintTargetRow(p) {
  const el = document.querySelector(`.item[data-id="${p.id}"]`);
  if (!el) return;
  const req = Math.max(0, p.requiredSec || 0);
  const spent = Math.min(p.spentSec || 0, req);
  const on = p.enabled !== false;
  const done = on && (req === 0 || spent >= req);
  const pct = done ? 100 : (req > 0 ? Math.round(100 * spent / req) : 0);
  el.classList.toggle("done", done);
  el.classList.toggle("off", !on);
  const meta = el.querySelector(".meta");
  if (meta) {
    // The chips after the figure are rebuilt, not dropped. This used to write the figure alone, which
    // took the topic, the phone opt-out and the deadline off every row one second after the page
    // loaded — three marks that exist to explain the row, disappearing while you looked at them.
    // Rebuilding rather than preserving matters for the sequence chip in particular: finishing a step
    // is exactly the moment this repaint runs, and it is exactly the moment the chip has to change.
    meta.innerHTML = (!on ? '<span class="why">off — click the icon to turn it back on</span>'
      : req === 0 ? '<b>Completed</b> (0s goal)'
      : `<b>${fmtDur(spent)}</b> of ${fmtDur(req)}`) + rowMarksHtml(p);
  }
  // The row dims and undims as the sequence moves past it, for the same reason as above: this is the
  // repaint that runs on the tick a step is completed.
  el.classList.toggle("seqlock", seqInfo(p).locked);
  paintBar(el.querySelector(".progressMini > div"), pct, on);
}
function paintScore(s) {
  const strip = document.querySelector(".score");
  if (!strip) return;
  const xp = s.xp || 0, level = s.level || 1;
  const pct = Math.round(((xp % 500) / 500) * 100);
  const sites = (s.productiveSites || []).filter(p => p.enabled !== false && (p.requiredSec !== undefined && p.requiredSec !== null && !isNaN(p.requiredSec) && p.requiredSec >= 0));
  const totals = (self.FGSettings && self.FGSettings.calcTotals) ? self.FGSettings.calcTotals(sites) : null;
  const done = totals ? totals.done : sites.filter(p => (p.requiredSec === 0) || (p.spentSec || 0) >= (p.requiredSec || 0)).length;
  const total = totals ? totals.total : sites.length;
  const mins = Math.floor(sites.reduce((a, b) => a + (b.spentSec || 0), 0) / 60);
  const set = (tid, text) => { const el = strip.querySelector(`[data-testid="${tid}"]`); if (el) el.textContent = text; };
  set("score-level", "Lv " + level);
  set("score-streak", String(s.streakCount || 0));
  set("score-done", `${done}/${total}`);
  set("score-mins", mins + "m");
  const bar = strip.querySelector(".xpbar > span");
  if (bar) bar.style.width = pct + "%";
  const doneChip = strip.querySelector('[data-testid="score-done"]')?.parentElement;
  if (doneChip) {
    const all = total > 0 && done >= total;
    doneChip.classList.toggle("ok", all);
    doneChip.innerHTML = doneChip.innerHTML.replace(/^\s*(✅|☑️)/, all ? "✅" : "☑️");
  }
}
function paintFlow(s) {
  const bar = document.getElementById("flowBar");
  if (!bar) return;
  const t = todayTotals(s);
  const nothing = t.count <= 0;
  const done = t.allDone || (t.req > 0 && t.left <= 0);
  const pct = done ? 100 : (t.req ? Math.round(100 * t.spent / t.req) : 0);
  bar.classList.toggle("done", done);
  // Switching the last target off takes the bar away; switching one back on brings
  // it straight back, without re-rendering the tab.
  bar.classList.toggle("solo", nothing);
  const spentLine = document.getElementById("flowSpent");
  if (spentLine) spentLine.textContent = nothing ? "Nothing added yet" : (done && t.req === 0 ? "All goals completed today" : `${fmtDur(t.spent)} of ${fmtDur(t.req)} done today`);
  const t2 = document.getElementById("flowTitle2");
  if (t2) t2.textContent = done ? "🔓 These are open now" : "🔒 To open these";
  const track = document.getElementById("flowProg");
  if (track) {
    track.hidden = nothing;
    track.classList.toggle("done", done);
  }
  paintBar(document.querySelector("#flowProg > div"), pct);
  const pctLine = document.getElementById("flowPct");
  if (pctLine) {
    pctLine.hidden = nothing;
    pctLine.classList.toggle("done", done);
    pctLine.textContent = done ? "🎉 All done. Enjoy!" : pct + "% done";
  }
}
async function paintLive(state) {
  if (lockedNow) return;
  const s = state || await getState();
  // The row painters read whole-state facts out of lastState — the phone bridge, the day boundary, and
  // now the sequence position, which is derived from every row's progress rather than from this one's.
  // Leaving it at whatever the last full render saw meant a chip that could only ever be one tick
  // behind: the sequence would advance and the row would go on claiming it was still step 1's turn.
  lastState = s;
  paintScore(s);
  (s.productiveSites || []).forEach(paintTargetRow);
  paintFlow(s);
}
// ---------------------------------------------------------------------------
// The dot beside each name: green when you have that site open in a tab right
// now, red when you don't. Clicking the name goes to that tab.
// ---------------------------------------------------------------------------
let openDotsTimer = 0;
function paintOpenDotsSoon(ms = 60) {
  clearTimeout(openDotsTimer);
  openDotsTimer = setTimeout(() => { paintOpenDots().catch(() => {}); }, ms);
}
async function paintOpenDots() {
  const dots = document.querySelectorAll("[data-live]");
  if (!dots.length) return;
  const r = await new Promise(res => {
    try { chrome.runtime.sendMessage({ type: "openTargets" }, x => { void chrome.runtime.lastError; res(x); }); }
    catch { res(null); }
  });
  const open = (r && r.open) || {};
  dots.forEach(d => {
    const isOpen = !!open[d.getAttribute("data-live")];
    d.classList.toggle("on", isOpen);
    d.classList.toggle("off", !isOpen);
    d.title = isOpen ? "Open in a tab right now — click the name to jump to it"
                     : "Not open — click the name to open it";
  });
}
// Tabs opening, closing and navigating are what move those dots, so listen for
// exactly that instead of asking on a timer.
["onCreated", "onRemoved", "onUpdated", "onReplaced", "onActivated"].forEach(ev => {
  try { chrome.tabs && chrome.tabs[ev] && chrome.tabs[ev].addListener(() => paintOpenDotsSoon(150)); } catch {}
});

// Clicking a name (a target, or a chip in step 2) goes to the tab you already
// have open on it, and only opens a new one when there isn't one. Ctrl / middle
// click keep the browser's own behaviour, so power users aren't fought.
document.addEventListener("click", (e) => {
  const a = e.target.closest && e.target.closest("a.nmlink, a.chiplink");
  if (!a) return;
  if (e.ctrlKey || e.metaKey || e.shiftKey || e.altKey || e.button !== 0) return;
  e.preventDefault();
  try {
    chrome.runtime.sendMessage({
      type: "openTarget",
      id: a.getAttribute("data-open-id") || "",
      pattern: a.getAttribute("data-open-pattern") || "",
      url: a.getAttribute("href") || ""
    }, () => void chrome.runtime.lastError);
  } catch {}
});

// Keys that change while you're just sitting there working. The ticker
// sentences are deliberately left alone: rewriting them restarts their scroll.
const LIVE_KEYS = ["productiveSites", "xp", "level", "streakCount", "enabled"];
let livePaintTimer = 0;
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  // The session locking or unlocking from outside this page — the auto-lock delay running out
  // while it sits open, or a second settings tab unlocking — re-arms the edit gate and puts
  // the banner back or takes it away.
  if (changes.sessionUnlocked || changes.passwordProtectionEnabled || changes.passwordHash || changes.fullPageLockEnabled) {
    // Unless this page is the one that just unlocked. The edit that asked for the password is
    // still in flight, and rebuilding the DOM under it would take away the very controls it is
    // about to write from. Cleared here so the NEXT change is acted on normally.
    if (selfUnlock) { selfUnlock = false; return; }
    renderRoot().catch(() => {});
    return;
  }
  // The power switch changes what the whole page means, banner included, and it's a
  // deliberate one-off act — so that one gets a full redraw rather than a repaint.
  if (changes.enabled) { renderRoot().catch(() => {}); return; }
  // Strict mode changing anywhere — another settings tab arming it, or a served deadline being
  // cleared — changes what this page will and will not accept, and the banner that says so. A
  // repaint cannot express that, so it is a full redraw, which also re-aims the watcher at the
  // new edge.
  if (changes.strictModeEnabled || changes.strictStart || changes.strictEnd ||
      changes.strictUntilEnabled || changes.strictUntil || changes.strictUntilTime) {
    renderRoot().catch(() => {});
    return;
  }
  // A local file learning where it actually lives changes the row's LINK, and paintLive below
  // only refreshes the numbers — so the href would keep pointing at viewer.html until the page
  // was reloaded by hand. That is the whole symptom this exists to avoid: the address is correct
  // in storage and stale on screen. Either side can be the one that learned it (this page's own
  // scan, or the worker watching the tabs), so it is detected from the change record rather than
  // from whoever wrote it.
  if (changes.productiveSites && localAddrSig(changes.productiveSites.oldValue) !==
                                 localAddrSig(changes.productiveSites.newValue)) {
    renderRoot().catch(() => {});
    return;
  }
  // A window's times moving from outside this page — the ＋ on a card stretching a window to fit the bigger
  // goal, or the worker stretching one that was too short — changes boxes paintLive does not touch, so the
  // page is redrawn rather than left showing the old end.
  if (changes.productiveSites && winTimesSig(changes.productiveSites.oldValue) !==
                                 winTimesSig(changes.productiveSites.newValue)) {
    renderRoot().catch(() => {});
    return;
  }
  if (!LIVE_KEYS.some(k => k in changes)) return;
  clearTimeout(livePaintTimer);
  livePaintTimer = setTimeout(() => { paintLive().catch(() => {}); }, 120);
});
// Just the addresses of the local rows, in order. Only these: every other edit to the list is
// already covered by the repaint, and a signature that moved when a second was credited would
// rebuild the whole page once a second.
function localAddrSig(list) {
  return (Array.isArray(list) ? list : [])
    .filter(p => p && p.type === "local_file")
    .map(p => `${p.id}:${p.url || ""}:${p.path || ""}`)
    .join("|");
}
// Each row's window — the switch and both times — and nothing else, so the clock's per-second writes never
// match it.
function winTimesSig(list) {
  return (Array.isArray(list) ? list : [])
    .map(p => p ? `${p.id}:${p.winEnabled === true ? 1 : 0}:${p.winStart || ""}:${p.winEnd || ""}` : "")
    .join("|");
}

// ---------------------------------------------------------------------------
// The finish line. When the last thing on today's list is done, the background
// tells every open page, and this draws the trophy card and the confetti.
// ---------------------------------------------------------------------------
function partyConfetti(count) {
  const colors = ["#f97316", "#eab308", "#22c55e", "#3b82f6", "#a855f7", "#ec4899", "#06b6d4"];
  const box = document.createElement("div");
  box.className = "fgparty";
  for (let i = 0; i < count; i++) {
    const p = document.createElement("i");
    p.style.left = (Math.random() * 100) + "%";
    p.style.background = colors[i % colors.length];
    p.style.animationDelay = (Math.random() * 0.6).toFixed(2) + "s";
    p.style.animationDuration = (2.2 + Math.random() * 2).toFixed(2) + "s";
    p.style.setProperty("--rot", Math.floor(Math.random() * 720 - 360) + "deg");
    box.appendChild(p);
  }
  document.body.appendChild(box);
  setTimeout(() => box.remove(), 5600);
}
function partySound() {
  try {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    const ctx = new AC();
    [523.25, 659.25, 783.99, 1046.5, 1318.5].forEach((freq, i) => {
      const osc = ctx.createOscillator(), gain = ctx.createGain();
      osc.type = "triangle";
      osc.frequency.value = freq;
      const at = ctx.currentTime + i * 0.12;
      gain.gain.setValueAtTime(0, at);
      gain.gain.linearRampToValueAtTime(0.25, at + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.001, at + 0.4);
      osc.connect(gain).connect(ctx.destination);
      osc.start(at); osc.stop(at + 0.45);
    });
  } catch {}
}
let partyUp = false;
function celebrateAllDone(payload) {
  if (partyUp) return;
  partyUp = true;
  const p = payload || {};
  const back = document.createElement("div");
  back.className = "fgwin";
  back.setAttribute("data-testid", "all-done-celebration");
  back.innerHTML = `
    <div class="fgwincard" role="alertdialog" aria-live="assertive">
      <div class="fgtrophy" aria-hidden="true">🏆</div>
      <h2>${escHtml(p.title || "Everything is done! 🏆")}</h2>
      <p>${escHtml(p.subtitle || "All of today's work is finished. Your locked sites are open.")}</p>
      ${p.xp ? `<div class="fgxp">+${p.xp} XP</div>` : ""}
      <button class="btn" id="fgwinClose" data-testid="all-done-close">Nice 🎉</button>
    </div>`;
  document.body.appendChild(back);
  const close = () => { partyUp = false; back.remove(); };
  back.querySelector("#fgwinClose").addEventListener("click", close);
  back.addEventListener("click", (e) => { if (e.target === back) close(); });
  requestAnimationFrame(() => back.classList.add("show"));
  partyConfetti(120);
  partySound();
  // The page behind it should already show everything as finished.
  paintLive().catch(() => {});
  setTimeout(() => { if (partyUp) close(); }, 12000);
}
chrome.runtime.onMessage.addListener((msg) => {
  if (msg && msg.type === "celebrateAll") celebrateAllDone(msg.payload);
});

// A refused write is not a fault, and it has already said so on screen. Kept out of the
// console so the errors that do matter are still worth reading.
window.addEventListener("unhandledrejection", (e) => {
  if (e && e.reason && e.reason.name === "EditLocked") e.preventDefault();
});

// Discover real paths for local files that only know a filename tail.
//
// Chrome's file dialog never says where a picked file lives, so such a target starts out knowing
// only its own name — enough to recognise the file, not enough to link to it, which is why its
// Open goes through viewer.html instead of to the address in the address bar. discoverOriginalPath
// asks the two places that DO know: Chrome's download history, and any tab that has the file open.
//
// Not a one-off any more, and that was the bug. It ran once, at page load, and the moment it
// wanted had not happened yet: you add the file, the download record is missing or does not match,
// so nothing is found — then later you open the file in a tab, come back to this page to see why
// the link still points at the viewer, and nothing has re-asked. One row on the list ends up
// knowing its full path while the row under it, added the same way, does not.
//
// So it also runs whenever this page becomes visible again, which is exactly the moment after
// "open the file, come back and look". The worker learns the same thing from its own side (see
// learnLocalPaths in background.js) — two independent routes to the same answer, because the one
// that fires first depends on the order the user does things in.
//
// Both writes are only ever an upgrade: a target that already knows its full path is filtered out
// and never touched.
let localPathScanBusy = false;
async function discoverMissingLocalPaths() {
  if (localPathScanBusy) return;
  localPathScanBusy = true;
  try {
    const st = await chrome.storage.local.get("productiveSites");
    const list = st.productiveSites || [];
    // `stored` is deliberately NOT required. It used to be, which skipped the one target that
    // needs this most: a file too big to copy has no viewer link either, so without a real path
    // its row is plain text with nothing to click.
    const need = list.filter(p =>
      p && p.type === "local_file" &&
      !looksLocalPath(p.url || "") && !looksLocalPath(p.path || ""));
    if (!need.length) return;
    let changed = false;
    for (const p of need) {
      const name = String(p.path || "").replace(/\\/g, "/").split("/").pop()
                || String(p.label || "");
      if (!name) continue;
      const real = await discoverOriginalPath(name);
      if (real) {
        p.url = real;
        p.path = localPath(real);
        changed = true;
      }
    }
    if (!changed) return;
    await chrome.storage.local.set({ productiveSites: list });
    // Re-render so the links pick up the new URLs.
    if (typeof renderApp === "function") renderApp();
  } catch {} finally { localPathScanBusy = false; }
}
discoverMissingLocalPaths();
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) discoverMissingLocalPaths();
});

renderRoot();
