// Popup: today's state at a glance, a power switch, and the way into settings.
// Keep-alive port so background knows when popup closes -> auto-lock
try { chrome.runtime.connect({ name: "popup" }); } catch {}

async function sha256(str) {
  const enc = new TextEncoder().encode(str);
  const buf = await crypto.subtle.digest("SHA-256", enc);
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, "0")).join("");
}

const $ = (sel) => document.querySelector(sel);
const root = document.getElementById("root");

function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

// One info bubble, in the top bar. Everything else explains itself through
// plain-language rows, with the detail on hover (title attributes).
function tip(html) {
  return `<span class="tip" tabindex="0" role="button" aria-label="More information">
    <span class="tip-i" aria-hidden="true">?</span>
    <span class="tip-box" role="tooltip">${html}</span>
  </span>`;
}
// Tap-to-open for the bubbles lives in tip.js, which this page loads.

function fmt(sec) {
  sec = Math.max(0, sec | 0);
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  if (h) return `${h}h ${m}m`;
  if (m) return `${m}m ${String(s).padStart(2, "0")}s`;
  return `${s}s`;
}

// ---------------------------------------------------------------------------
// One colour ramp for every progress bar in FocusGate: red at the start, through
// orange and yellow, to green when it's full. The same three functions live in
// options.js and blocked.js — extension pages don't share modules, so the ramp is
// copied rather than imported. Keep them identical.
// ---------------------------------------------------------------------------
function barHue(pct) {
  const p = Math.max(0, Math.min(100, pct)) / 100;
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
  return `0 0 5px hsla(${barHue(pct)}, 90%, 50%, .4)`;
}
function paintBar(fill, pct) {
  if (!fill) return;
  const p = Math.max(0, Math.min(100, Math.round(pct || 0)));
  fill.style.width = p + "%";
  fill.style.background = barFill(p);
  fill.style.boxShadow = p > 0 ? barGlow(p) : "none";
}
function barStyle(pct) {
  const p = Math.max(0, Math.min(100, Math.round(pct || 0)));
  return `width:${p}%;background:${barFill(p)};box-shadow:${p > 0 ? barGlow(p) : "none"}`;
}

async function getState() { return await chrome.storage.local.get(null); }
async function setState(p) { return await chrome.storage.local.set(p); }

// Strict mode freezes the escape hatches, including the power switch.
//
// From strict.js, not worked out here. This was the second copy of the rule, and its
// fallback for a missing time differed from the settings page's — so the two could
// disagree about whether strict mode was running, and the copy that decides whether the
// power switch works is the worst place for that. It also knew nothing about the
// commitment date, so the power switch would have been available during a stretch that
// exists to make it unavailable.
function inStrictWindow(s) {
  return FGStrict.strictNow(s);
}
// A file on this computer goes by its own name, not the whole path.
function localName(v) {
  const p = String(v || "").trim().split("#")[0].split("?")[0]
    .replace(/^file:\/*/i, "").replace(/\\/g, "/").replace(/\/+$/, "");
  let last = p.split("/").filter(Boolean).pop() || p;
  try { last = decodeURIComponent(last); } catch {}
  return last || "Local file";
}
function localDisplay(v) {
  let s = String(v || "").trim().replace(/^file:\/*/i, "");
  try { s = decodeURIComponent(s); } catch {}
  return s;
}

// Where a target opens. Addresses are stored without their protocol, and YouTube
// targets keep an id rather than a link, so each kind is turned back into
// something a tab can load.
// Where FocusGate's own copy of a picked file opens. Mirrors fgViewerUrl in filestore.js; the
// popup never reads or writes a copy, so it repeats the one line it needs rather than loading the
// rest. Keep the two in step.
function viewerUrl(id) {
  if (!id) return "";
  try { return chrome.runtime.getURL("viewer.html") + "?t=" + encodeURIComponent(id); }
  catch { return ""; }
}
function targetOpenUrl(p) {
  if (!p) return "";
  if (p.type === "local_file") {
    // The real file:// address first, when FocusGate knows it. The background learns the full
    // path the first time the file is opened in a tab, at which point p.url holds the file:// URL.
    // Opening the original file is what the user expects from a link.
    if (p.url) return p.url;
    // No real path yet — Chrome's file dialog never says which drive a picked file came from.
    // If a copy was kept, the viewer is the fallback: it is also the only address where the
    // camera and stillness checks can run on a local file.
    if (p.stored) return viewerUrl(p.id);
    return "";
  }
  if (p.type === "youtube_video" && p.videoId) return "https://www.youtube.com/watch?v=" + encodeURIComponent(p.videoId);
  if (p.type === "youtube_playlist" && p.playlistId) return "https://www.youtube.com/playlist?list=" + encodeURIComponent(p.playlistId);
  if (p.type === "youtube_channel") {
    const raw = String(p.url || p.channelId || "").trim();
    if (!raw) return "";
    if (/^https?:\/\//i.test(raw)) return raw;
    if (raw.includes("youtube.com")) return "https://" + raw;
    if (raw.startsWith("@")) return "https://www.youtube.com/" + raw;
    if (/^UC[\w-]{20,}$/.test(raw)) return "https://www.youtube.com/channel/" + raw;
    return "https://www.youtube.com/@" + raw;
  }
  const u = String(p.url || "").trim();
  if (!u) return "";
  return /^https?:\/\//i.test(u) ? u : "https://" + u;
}

// ---------------- password ----------------
// The popup itself is just a read-out, so it opens straight away. One door here still asks:
// switching FocusGate off, which stops every gate at once.
//
// Opening Settings used to ask too. It does not any more — that page shows everything and asks
// on the writes that ease a rule off, so a question here would have put the password back in
// front of reading, and asked twice for one edit.
async function needsPassword(s) {
  if (s.passwordProtectionEnabled === false) return false;
  if (!s.passwordHash) return false;      // nothing to check against yet
  return !s.sessionUnlocked;
}

function askPassword(why) {
  return new Promise(resolve => {
    const back = document.createElement("div");
    back.className = "pwask";
    back.setAttribute("data-testid", "popup-password-gate");
    back.innerHTML = `
      <div class="pwcard" role="dialog" aria-modal="true" aria-label="Password needed">
        <div class="glyph" aria-hidden="true">🔒</div>
        <h2>Password needed</h2>
        <p>${esc(why || "")}</p>
        <input id="pwAsk" type="password" placeholder="Password" data-testid="popup-password-input" />
        <div class="err" id="pwAskErr"></div>
        <div class="pwrow">
          <button class="btn" id="pwAskNo" data-testid="popup-password-cancel">Cancel</button>
          <button class="btn primary" id="pwAskGo" data-testid="popup-unlock-btn">Unlock</button>
        </div>
      </div>`;
    document.body.appendChild(back);
    const box = back.querySelector("#pwAsk"), err = back.querySelector("#pwAskErr");
    const close = (ok) => { back.remove(); resolve(ok); };
    const submit = async () => {
      const pw = box.value || "";
      if (!pw) { err.textContent = "Password required"; return; }
      const s = await getState();
      if ((await sha256(pw)) !== s.passwordHash) { err.textContent = "Wrong password"; box.select(); return; }
      await setState({ sessionUnlocked: true });
      close(true);
    };
    back.querySelector("#pwAskGo").addEventListener("click", submit);
    back.querySelector("#pwAskNo").addEventListener("click", () => close(false));
    back.addEventListener("click", (e) => { if (e.target === back) close(false); });
    box.addEventListener("keydown", (e) => {
      if (e.key === "Enter") submit();
      else if (e.key === "Escape") close(false);
    });
    setTimeout(() => box.focus(), 20);
  });
}
// True when you may go ahead: no password set up, already unlocked this session,
// or you just typed it correctly.
async function unlockedFor(why) {
  const s = await getState();
  if (!(await needsPassword(s))) return true;
  return await askPassword(why);
}

// ---------------- a line the popup says and then forgets ----------------
// Deliberately not askConfirm. There is nothing here to answer — the thing being reported has
// already happened — and a dialog with an OK button under a statement is how people learn to
// dismiss the next dialog without reading it.
//
// Takes HTML, like askConfirm's body, because the one thing it currently says wants a word in
// bold. Anything variable that goes in here must be run through esc() by the caller.
let popToastTimer = 0;
function popToast(html, cls, ms) {
  // One at a time. Two of these stacked in a 320px popup would cover the list they are about.
  document.querySelectorAll(".pop-toast").forEach(n => n.remove());
  const el = document.createElement("div");
  el.className = "pop-toast" + (cls ? " " + cls : "");
  el.setAttribute("role", "status");
  el.innerHTML = html;
  document.body.appendChild(el);
  requestAnimationFrame(() => el.classList.add("show"));
  clearTimeout(popToastTimer);
  popToastTimer = setTimeout(() => {
    el.classList.remove("show");
    setTimeout(() => { try { el.remove(); } catch {} }, 250);
  }, Math.max(1200, ms || 5200));
}

// ---------------- the phone, and the one thing it needs ----------------
// The webhook bridge is the only part of FocusGate that depends on something outside this
// computer: a call goes out to MacroDroid on your phone, and a phone with no connection never
// hears it. That failure is silent and looks exactly like the extension being broken — you switch
// FocusGate off, your phone stays locked, and nothing anywhere says why.
//
// So it is said out loud, at the two moments it can bite: switching FocusGate off (the call that
// releases the phone) and switching it back on (the call that locks it). Only when the bridge is
// actually switched on — on a profile that has never touched the phone feature this sentence is
// noise about a thing that does not exist, which is the whole reason it is gated rather than
// always shown.
const PHONE_NET_LINE = "Make sure your <b>mobile phone is connected to the internet</b> " +
                       "so it hears this. If it was offline, FocusGate tries again about once a minute.";
// The bridge counts as on only with somewhere to call. A switch turned on above two empty boxes
// sends nothing, so a warning about connectivity would be about a call that is never made.
function phoneBridgeLive(s) {
  return !!(s && s.macrodroidEnabled && (s.macrodroidLockUrl || s.macrodroidUnlockUrl));
}

// ---------------- "are you sure?" ----------------
// The power switch is one click from stopping every gate FocusGate has, and a checkbox is the
// easiest thing in a popup to hit by accident — it is the first control in the bar, it is large,
// and it acts the instant it is touched. So it now asks.
//
// A separate question from the password rather than a step in front of it. The password answers
// "is this you"; this answers "did you mean to". Where a password will be asked anyway that is
// question enough and this one is skipped — see the handler — because two dialogs stacked over one
// click is the kind of friction people learn to click through without reading.
//
// Built like askPassword and wearing its stylesheet on purpose: same backdrop, same card, same
// ways out (the button, the backdrop, Escape). One shape for "FocusGate is asking you something".
let modalOpen = 0;
function askConfirm(opts) {
  const o = opts || {};
  return new Promise(resolve => {
    modalOpen++;
    const back = document.createElement("div");
    back.className = "pwask";
    back.setAttribute("data-testid", "popup-confirm");
    back.innerHTML = `
      <div class="pwcard" role="dialog" aria-modal="true" aria-label="${esc(o.title || "Are you sure?")}">
        <div class="glyph" aria-hidden="true">${esc(o.glyph || "❓")}</div>
        <h2>${esc(o.title || "Are you sure?")}</h2>
        <p>${o.body || ""}</p>
        <div class="pwrow">
          <button class="btn" id="cfNo" data-testid="popup-confirm-no">${esc(o.no || "Cancel")}</button>
          <button class="btn ${o.danger ? "danger" : "primary"}" id="cfYes" data-testid="popup-confirm-yes">${esc(o.yes || "Yes")}</button>
        </div>
      </div>`;
    document.body.appendChild(back);
    // Nothing outlives the answer: the listeners go with the element, and the counter comes back
    // down whichever way it was closed. A modal that leaks its count would freeze the live
    // repainter for the rest of the popup's life.
    const close = (ok) => { modalOpen = Math.max(0, modalOpen - 1); back.remove(); resolve(ok); };
    back.querySelector("#cfYes").addEventListener("click", () => close(true));
    back.querySelector("#cfNo").addEventListener("click", () => close(false));
    back.addEventListener("click", (e) => { if (e.target === back) close(false); });
    // On the backdrop rather than on the document: a popup is one document, and a keydown listener
    // left on it would still be there after the dialog had gone.
    back.addEventListener("keydown", (e) => {
      if (e.key === "Escape") { e.preventDefault(); close(false); }
      else if (e.key === "Enter") { e.preventDefault(); close(true); }
    });
    back.tabIndex = -1;
    // Focus lands on Cancel, not on the confirming button. Enter and Space are how a popup gets
    // dismissed by muscle memory, and the safe answer is the one that should be under them.
    setTimeout(() => { try { back.querySelector("#cfNo").focus(); } catch {} }, 20);
  });
}

// ---------------- dashboard ----------------
// "Why isn't my timer moving?" — the background stamps this every few seconds
// while you're on a work page. Older than 15s means you're not on one.
// How long the clock has been stopped for, right now. 0 when it isn't.
//
// pauseSinceAt is the start of the current unbroken stretch, written by the worker; the worker also
// ends the stretch by writing 0, so a figure here is always about a pause that is still running.
function pausedForSec(s) {
  const since = s.pauseSinceAt || 0;
  if (!since) return 0;
  return Math.max(0, Math.round((Date.now() - since) / 1000));
}
function liveLine(s) {
  const held = pausedForSec(s);
  // "for 3m 20s" only once there is something worth reporting. Under about five seconds it is a
  // number that changes faster than it can be read, and every glance at the popup during normal
  // work would catch one.
  const held_ = held >= 5 ? " for " + fmt(held) : "";
  // A break you asked for outranks every other explanation.
  if (s.userPaused) return { text: "On a break" + held_ + " — nothing is counting", cls: "warn" };
  const age = Date.now() - (s.timerPauseAt || 0);
  if (!s.timerPauseAt || age > 15000) return { text: "Open a work page to start earning", cls: "" };
  // The page you are on has already had all the time it asked for.
  //
  // Its own branch, before the two below, because both of those would be wrong about it. "Paused —
  // play the video" made a finished goal sound like a problem and asked for something that could not
  // earn a second, and the bare "Counting now" is simply untrue: nothing is being counted, because
  // there is nothing left to count. Green rather than amber — this is the good outcome, not a warning.
  //
  // Matched as a literal, the same way the break is on the line above. The string is written in one
  // place — PAUSE_DONE in background.js — and these two pages do not share modules.
  if (s.timerPauseReason === "this one is finished") {
    return { text: "This page is done — nothing left to count here", cls: "on" };
  }
  return s.timerPauseReason
    ? { text: "Paused" + held_ + " — " + s.timerPauseReason, cls: "warn" }
    : { text: "Counting now", cls: "on" };
}

// ---------------- how much of today went nowhere ----------------
// The other half of "why isn't my timer moving". The line above answers it for this moment; this
// answers it for the day, which is the figure that actually changes behaviour — twenty minutes lost
// to looking away is not something you notice four seconds at a time.
//
// Split into the two kinds the worker tracks separately, because they mean different things: a
// break is a decision, everything else is the checks declining to credit you.
function pauseSummary(s) {
  let stopped = s.pausedTodaySec || 0;
  let brk = s.breakTodaySec || 0;
  // The worker flushes these every few seconds, so the tail of a stretch that is still running has
  // not landed yet. Added on here, or the number would sit still and then jump — which reads as
  // broken on a figure you are watching precisely because it is moving.
  //
  // timerPauseAt is the moment of the last flush (it is written by the same call), so the gap since
  // is exactly what is missing. Capped, so a stamp left behind by a tab that stopped reporting
  // cannot inflate the total for the rest of the day.
  const reason = s.userPaused ? "on a break" : (s.timerPauseReason || "");
  if (reason && s.pauseSinceAt) {
    const unflushed = Math.max(0, Math.min(15, Math.floor((Date.now() - (s.timerPauseAt || 0)) / 1000)));
    if (s.userPaused || reason === "on a break") brk += unflushed; else stopped += unflushed;
  }
  const parts = [];
  if (stopped > 0) parts.push(fmt(stopped) + " paused");
  if (brk > 0) parts.push(fmt(brk) + " on breaks");
  return { stopped, brk, text: parts.length ? "⏸ Today: " + parts.join(" · ") : "" };
}

// Everything the dashboard shows, worked out once. Both the full render and the
// live repaint read this, so they can never disagree.
function computeView(s) {
  const on = s.enabled !== false;
  const strict = inStrictWindow(s);
  // No time on a row means it isn't part of today's work, exactly as in settings — and neither
  // does a row whose weekday schedule doesn't include today. Both through the same rule the worker
  // filters on, because everything below is derived from this list: the total, the percentage, the
  // "everything is done" state and the rows themselves. A popup that listed Saturday work on a
  // Tuesday would be showing a goal that nothing was counting towards.
  const day = FGSettings.weekdayNow(s.dailyResetTime);
  const sites = (s.productiveSites || [])
    .filter(p => p.enabled !== false && (p.requiredSec !== undefined && p.requiredSec !== null && !isNaN(p.requiredSec) && p.requiredSec >= 0) && FGSettings.onDay(p, day))
    .sort((a, b) => (a.order || 0) - (b.order || 0));

  const totals = (self.FGSettings && self.FGSettings.calcTotals) ? self.FGSettings.calcTotals(sites) : null;
  const totalReq = totals ? totals.req : sites.reduce((a, b) => a + (b.requiredSec || 0), 0);
  const totalSpent = totals ? totals.spent : sites.reduce((a, b) => a + Math.min(b.requiredSec || 0, b.spentSec || 0), 0);
  const totalLeft = totals ? totals.left : Math.max(0, totalReq - totalSpent);
  const allDone = totals ? totals.allDone : (sites.length > 0 && sites.every(p => (p.requiredSec === 0) || (p.spentSec || 0) >= (p.requiredSec || 0)));
  const pct = totals ? totals.pct : (allDone ? 100 : (totalReq ? Math.round(100 * totalSpent / totalReq) : 0));

  // Sequence mode, worked out once for the list. `sites` above is already the worker's own set —
  // switched on, some time set, scheduled for today, in the user's order — so it is the right list to
  // ask, and asking it here rather than per row keeps one answer for the whole popup.
  const seqOn = s.sequenceMode === true &&
    !!(self.FGSettings && FGSettings.inCurrentStep && FGSettings.stepNumberOf && FGSettings.stepCount);
  const seqTotal = seqOn ? FGSettings.stepCount(sites) : 0;

  const rows = [];
  for (const p of sites) {
    const isLocal = p.type === "local_file";
    // Not its turn, and not finished either — a finished row is also "not its turn" and needs no
    // warning, because its own bar has already said so.
    const seqStep = seqOn ? FGSettings.stepNumberOf(p, sites) : 0;
    const seqLocked = seqOn && seqStep > 0 && !FGSettings.targetMet(p) && !FGSettings.inCurrentStep(p, sites);
    rows.push({
      key: p.id,
      seqStep, seqTotal, seqLocked,
      seqMine: seqOn && seqStep > 0 && FGSettings.inCurrentStep(p, sites),
      name: p.label || (isLocal ? localName(p.url || p.path) : p.url) || (p.type === "youtube_channel" ? "YouTube channel"
        : p.type === "youtube_playlist" ? "YouTube playlist"
        : p.type === "youtube_video" ? "YouTube video" : "Site"),
      spent: Math.min(p.requiredSec || 0, p.spentSec || 0),
      required: p.requiredSec || 0,
      open: targetOpenUrl(p),
      pattern: p.url || "",
      title: isLocal ? "Open " + localDisplay(p.url || p.path) : (p.url ? "Go to " + p.url : ""),
      operator: p.operator === "OR" ? "OR" : "AND",
      // The deadline, in the one line this row already has for saying something unusual.
      //
      // The missed case is not optional here. That row shows a full bar and "done", and nothing is
      // unlocked — so without a sentence the popup is the screen that makes the extension look
      // broken. The other two states are quieter: a window still open is a reminder, a window shut
      // on unfinished work is the last warning that will be useful.
      // The stopwatch comes FIRST, and only because a row has one line. Where both deadlines are set and
      // both have something to say, the countdown is the one that changes what you do in the next minute
      // — "19m left" is actionable and "finish by 9:00 am" is a fact you already knew. A failed window
      // still wins over a running stopwatch, because a row that has already lost the day should not be
      // shown a countdown it cannot spend.
      ...(FGSettings.windowMissed(p)
        ? { note: `Finished after ${FGSettings.clock12(p.winEnd)} — didn't unlock`, noteWarn: true }
        : FGSettings.graceMissed(p)
          ? { note: `Finished after its time limit — didn't unlock`, noteWarn: true }
          : FGSettings.graceGone(p)
            ? { note: `Time limit ran out — it won't unlock today`, noteWarn: true }
            : (FGSettings.graceStarted(p) && !FGSettings.targetDone(p))
              ? { note: `${FGSettings.fmtDur(FGSettings.graceLeftSec(p))} left of your time limit`, noteWarn: true }
              : FGSettings.hasWindow(p)
                ? (FGSettings.targetDone(p)
                    ? { note: `Done inside ${FGSettings.windowLabel(p)} ✓` }
                    : FGSettings.inWindow(p)
                      ? { note: `Finish by ${FGSettings.clock12(p.winEnd)} or it won't unlock`, noteWarn: true }
                      : { note: `Window shut — opens ${FGSettings.clock12(p.winStart)}`, noteWarn: true })
                : (FGSettings.graceStarted(p) && FGSettings.targetDone(p))
                  ? { note: `Done inside its time limit ✓` }
                  : {})
    });
  }

  // Whether the phone should be locked, from the goals the phone is actually waiting on — which is
  // not the same list as `sites` now that a row can opt out of the bridge. Falls back to "nothing
  // to wait for, so open" when every row has opted out, matching what the worker does with an empty
  // set. `allDone` above stays the whole-list figure, because the bar and the "Unlocked" heading
  // are about your browser and those never opted out of anything.
  const phoneSites = sites.filter(p => p.webhookOn !== false);
  const phoneTotals = (self.FGSettings && self.FGSettings.calcTotals && phoneSites.length)
    ? self.FGSettings.calcTotals(phoneSites) : null;
  const phoneDone = !phoneSites.length ? true
    : (phoneTotals ? phoneTotals.allDone
       : phoneSites.every(p => (p.requiredSec === 0) || (p.spentSec || 0) >= (p.requiredSec || 0)));
  const phone = s.macrodroidEnabled
    ? (!on ? false : ((s.mobileLockSent === null || s.mobileLockSent === undefined) ? !phoneDone : s.mobileLockSent))
    : null;

  return {
    on, strict, rows, totalReq, totalSpent, totalLeft, pct, allDone, phone,
    paused: !!s.userPaused,
    live: liveLine(s),
    pause: pauseSummary(s),
    xp: s.xp || 0, level: s.level || 1, streak: s.streakCount || 0,
    resetAt: s.dailyResetTime || "00:00"
  };
}

function rowHtml(r) {
  const done = r.required === 0 || (r.required > 0 && Math.max(0, r.required - r.spent) === 0);
  const pct = done ? 100 : (r.required > 0 ? Math.min(100, Math.round(100 * r.spent / r.required)) : 0);
  const left = Math.max(0, r.required - r.spent);
  // The name is the way in: it opens the site in a new tab.
  //
  // …unless the sequence has not reached this row. The link would still navigate and the tab would be
  // sent straight to the lock screen, and a way in that is not one is worse than none — so it becomes
  // plain text that says why. The row keeps its bar and its time, because what it will ask for when its
  // turn comes has not changed.
  const nm = (r.open && !r.seqLocked)
    ? `<a class="nm link" href="${esc(r.open)}" target="_blank" rel="noopener noreferrer"
             data-open-id="${esc(r.key)}" data-open-pattern="${esc(r.pattern || "")}"
             title="${esc(r.title || "")}" data-testid="popup-open-${r.key}"><span class="lbl">${esc(r.name)}</span><span class="ext" aria-hidden="true">↗</span></a>`
    : `<span class="nm"${r.seqLocked ? ` title="Step ${r.seqStep} of ${r.seqTotal}. Your work list is being done in order, so this opens once the steps before it are finished."` : ""}>${esc(r.name)}</span>`;
  // Which step, on the rows where it is worth saying: the one you can act on, and the ones you cannot.
  // A finished row gets nothing — the "done" beside it is the whole story.
  const seqTag = r.seqLocked
    ? `<span class="seqtag" data-testid="popup-seq-locked">🔒 ${r.seqStep}/${r.seqTotal}</span>`
    : (r.seqMine && !done ? `<span class="seqtag mine">▶ ${r.seqStep}/${r.seqTotal}</span>` : "");
  return `
    <div class="item${r.seqLocked ? " seqlock" : ""}" data-row="${esc(r.key)}">
      <div class="top">
        ${nm}
        ${seqTag}
        <span class="rt ${done ? "done" : ""}">${done ? "done" : fmt(left) + " left"}</span>
      </div>
      <div class="bar-track"><i class="${done ? "full" : ""}" style="${barStyle(pct)}"></i></div>
      <div class="note ${r.noteWarn ? "warn" : ""}"${r.note ? "" : " hidden"}>${esc(r.note || "")}</div>
    </div>`;
}

// What's on screen right now, so the repainter knows when a full redraw is due.
function fileSchemeAllowed() {
  return new Promise(resolve => {
    try {
      if (chrome.extension && chrome.extension.isAllowedFileSchemeAccess) {
        chrome.extension.isAllowedFileSchemeAccess(r => resolve(r !== false));
      } else resolve(true);
    } catch { resolve(true); }
  });
}

// What the popup's STRUCTURE depends on, as one string. When it changes, paintLive gives up and
// rebuilds rather than patching numbers.
//
// The ids alone used to be enough, because the only structural change was a row appearing or going.
// Sequence mode adds a second one: when a step is finished the next row's name turns from plain text
// into a link and its badge changes, and neither of those is a number paintLive knows how to write. So
// the step state joins the signature, and finishing a step redraws the popup — which is also the moment
// somebody is most likely to be looking at it.
function rowSig(v) {
  return v.rows.map(r => `${r.key}:${r.seqLocked ? "L" : r.seqMine ? "M" : "-"}${r.seqStep || 0}/${r.seqTotal || 0}`).join("|");
}

let shownKeys = "";

async function renderDashboard() {
  const s = await getState();
  const v = computeView(s);
  const hasLocal = (s.productiveSites || []).some(p => p.type === "local_file" || (p.url && p.url.startsWith("file:")) || (p.path && p.path.length > 0));
  const fileAllowed = hasLocal ? await fileSchemeAllowed() : true;
  shownKeys = rowSig(v);

  document.body.className = !v.on ? "off" : (v.allDone ? "done" : "");

  const stateTxt = !v.on ? "Off" : v.allDone ? "Unlocked" : "Locked";
  const stateSub = !v.on ? "nothing is blocked or tracked"
    : v.allDone ? "work done — enjoy" : `resets at ${v.resetAt}`;

  root.innerHTML = `
    <div class="bar">
      <div class="state">
        <span class="dot"></span>
        <span class="col">
          <div class="txt"><span id="stateTxt">${stateTxt}</span>${tip(`<b>Locked</b> means your fun sites stay blocked until the work below is finished.<br/><br/>The switch turns FocusGate <b>off completely</b> — no blocking, no tracking. Turn it back on any time.<br/><br/>Switching it off asks for your password, so a weak moment costs more than one click.${v.strict ? "<br/><br/><b style='color:#fca5a5'>Strict mode is on: the switch is frozen.</b>" : ""}`)}</div>
          <div class="sub" id="stateSub">${esc(stateSub)}</div>
        </span>
      </div>
      <label class="pw" title="${v.on ? "Turn FocusGate off" : "Turn FocusGate on"}">
        <input type="checkbox" id="power" ${v.on ? "checked" : ""} ${v.strict ? "disabled" : ""} data-testid="popup-power"/>
        <span class="track"></span>
        <span class="knob"></span>
      </label>
    </div>

    ${hasLocal && !fileAllowed ? `
      <div class="file-alert" id="fileAlert">
        <span class="file-alert-ic">⚠️</span>
        <div class="file-alert-txt">
          <b>Allow File URLs Access</b>
          <span>Chrome is hiding local files from FocusGate</span>
        </div>
        <button class="file-alert-btn" id="openExtFileBtn">Enable</button>
      </div>` : ""}

    <div class="hero">
      <div class="hero-header">
        <div class="hero-main">
          <div class="hero-rem-label">TODAY'S REMAINING</div>
          <div class="hero-rem-val" id="heroLeftVal">${v.rows.length ? (v.allDone ? "All Done ✓" : fmt(v.totalLeft) + " left") : "—"}</div>
        </div>
        <div class="n" id="heroPct">${v.rows.length ? v.pct + "%" : "—"}</div>
      </div>
      <div class="bar-track hero-track"><i id="heroBarFill" class="${v.allDone ? "full" : ""}" style="${barStyle(v.pct)}"></i></div>
      <div class="hero-grid">
        <div class="hero-col"><span class="lbl">Total Goal (All Sites)</span><b id="heroTotalReq">${v.totalReq ? fmt(v.totalReq) : "0s"}</b></div>
        <div class="hero-col"><span class="lbl">Completed</span><b id="heroTotalSpent">${v.totalReq ? fmt(v.totalSpent) : "0s"}</b></div>
      </div>
      <div class="of" id="heroOf" style="display:none">${v.rows.length ? (v.allDone ? "All goals completed today" : `${fmt(v.totalSpent)} of ${fmt(v.totalReq)} today`) : "Nothing to do yet"}</div>
      <div class="live ${v.live.cls}" id="heroLive"${v.on && v.totalReq ? "" : " hidden"}>${esc(v.live.text)}</div>
      <div class="pauseline" id="heroPause"${v.on && v.pause.text ? "" : " hidden"}>${esc(v.pause.text)}${tip(`How much of today the clock spent <b>not</b> counting while you were on a work page.<br/><br/><b>paused</b> is every time a check declined the second — you looked away, the window lost focus or left full screen, the video stopped, the mouse went still.<br/><br/><b>on breaks</b> is time you asked for with the ⏸ button.<br/><br/>Both reset with your day, like your goals do.`)}</div>
    </div>

    <div class="list" id="list">${
      v.rows.length ? v.rows.map((r, i) => {
        const connector = i > 0 ? `<div class="popup-logic-row"><span class="popup-logic-tag ${r.operator === "OR" ? "or" : "and"}">${r.operator || "AND"}</span></div>` : "";
        return connector + rowHtml(r);
      }).join("")
        : `<div class="empty">No work set yet — open Settings to add a site.</div>`
    }</div>

    <div class="stats">
      <span>⭐ <b id="statXp">${v.xp}</b> · <span id="statLvl">Lv ${v.level}</span></span>
      <span>🔥 <b id="statStreak">${v.streak}</b> <span id="statDays">day${v.streak === 1 ? "" : "s"}</span></span>
      ${v.phone === null ? "" : `<span title="Phone apps via MacroDroid">📱 <b id="statPhone">${v.phone ? "locked" : "open"}</b></span>`}
    </div>

    <div class="foot">
      <button class="btn primary" id="openOptions" data-testid="popup-open-options">Settings</button>
      <button class="btn icon ${v.paused ? "onbreak" : ""}" id="brk" data-testid="popup-break"
              title="${v.paused ? "Back to work — start counting again" : "Take a break — stop the clock and the camera"}">${v.paused ? "▶" : "⏸"}</button>
      <button class="btn icon" id="help" title="Email feedback to sinhanikhil549@gmail.com">✉</button>
    </div>`;

  bindDashboard();
}

// Repaint the numbers without rebuilding the popup, so time earned on the page
// behind it shows up here as it happens.
function paintLive(s) {
  const v = computeView(s);
  const keys = rowSig(v);
  if (keys !== shownKeys) return renderDashboard();   // a row appeared, went, or changed step

  document.body.className = !v.on ? "off" : (v.allDone ? "done" : "");
  const set = (id, text) => { const el = document.getElementById(id); if (el && el.textContent !== text) el.textContent = text; };
  set("stateTxt", !v.on ? "Off" : v.allDone ? "Unlocked" : "Locked");
  set("stateSub", !v.on ? "nothing is blocked or tracked"
    : v.allDone ? "work done — enjoy" : `resets at ${v.resetAt}`);
  set("heroPct", v.rows.length ? v.pct + "%" : "—");
  set("heroLeftVal", v.rows.length ? (v.allDone ? "All Done ✓" : fmt(v.totalLeft) + " left") : "—");
  set("heroTotalReq", v.totalReq ? fmt(v.totalReq) : "0s");
  set("heroTotalSpent", v.totalSpent ? fmt(v.totalSpent) : "0s");
  set("heroOf", v.rows.length ? (v.allDone ? "All goals completed today" : `${fmt(v.totalSpent)} of ${fmt(v.totalReq)} today`) : "Nothing to do yet");
  const heroBarFill = document.getElementById("heroBarFill");
  if (heroBarFill) {
    paintBar(heroBarFill, v.pct);
    heroBarFill.classList.toggle("full", v.allDone);
  }
  const live = document.getElementById("heroLive");
  if (live) {
    live.hidden = !(v.on && v.totalReq);
    live.textContent = v.live.text;
    live.className = "live " + v.live.cls;
  }
  const pause = document.getElementById("heroPause");
  if (pause) {
    pause.hidden = !(v.on && v.pause.text);
    // The first child node is the text; the tip bubble after it is markup and has to survive the
    // repaint, so this writes the node rather than textContent — which would take the bubble with it
    // and leave a "?" that does nothing for the rest of the popup's life.
    const first = pause.firstChild;
    if (first && first.nodeType === 3) { if (first.nodeValue !== v.pause.text) first.nodeValue = v.pause.text; }
    else pause.insertBefore(document.createTextNode(v.pause.text), pause.firstChild);
  }
  set("statXp", String(v.xp));
  set("statLvl", "Lv " + v.level);
  set("statStreak", String(v.streak));
  set("statDays", "day" + (v.streak === 1 ? "" : "s"));
  if (v.phone !== null) set("statPhone", v.phone ? "locked" : "open");

  const power = document.getElementById("power");
  // Left alone while a dialog is up. The switch is flipped by the click and put back by the answer,
  // so writing the stored value over it in between would drag the knob back under the question that
  // is still asking about it.
  if (power && !modalOpen) { power.checked = v.on; power.disabled = v.strict; }

  for (const r of v.rows) {
    const el = document.querySelector(`.item[data-row="${CSS.escape(String(r.key))}"]`);
    if (!el) continue;
    const done = r.required === 0 || (r.required > 0 && Math.max(0, r.required - r.spent) === 0);
    const pct = done ? 100 : (r.required > 0 ? Math.min(100, Math.round(100 * r.spent / r.required)) : 0);
    const left = Math.max(0, r.required - r.spent);
    const rt = el.querySelector(".rt");
    if (rt) { rt.textContent = done ? "done" : fmt(left) + " left"; rt.classList.toggle("done", done); }
    const fill = el.querySelector(".bar-track > i");
    if (fill) { paintBar(fill, pct); fill.classList.toggle("full", done); }
    const note = el.querySelector(".note");
    if (note) {
      note.hidden = !r.note;
      note.textContent = r.note || "";
      note.classList.toggle("warn", !!r.noteWarn);
    }
  }
}

function bindDashboard() {
  // Switching FocusGate off is the escape hatch, so it costs a password.
  // Switching it back on is free — that direction only ever helps you.
  $("#power").addEventListener("change", async (e) => {
    const st = await getState();
    if (inStrictWindow(st)) { renderDashboard(); return; }
    const want = e.target.checked;

    // Ask before either direction. A `change` event means the box has ALREADY flipped, so every
    // way out of here has to put it back — hence the `= !want` on each refusal rather than the
    // `= true` this used to carry, which was only ever right for the off direction.
    //
    // Which question gets asked depends on what else is about to be asked. Switching off with a
    // password set already has a door in front of it, and stacking a second one teaches people to
    // click through both; so in that case the password IS the confirmation and this step is
    // skipped. Every other case — switching on, or switching off on a profile with no password —
    // had nothing in front of it at all until now.
    const willAskPassword = !want && await needsPassword(st);
    // Whether this switch is about to reach for the phone as well as the browser. Read once, from
    // the state this handler already has, because both the question below and the reminder after it
    // must be about the same answer — and the second of those runs after an await.
    const phone = phoneBridgeLive(st);
    // Folded into the question rather than only shown afterwards, on the path where a question is
    // asked. It changes what you might decide: "off" on a locked phone with no signal is a phone
    // that stays locked, and that is worth knowing BEFORE pressing it, not after.
    const phoneAsk = phone
      ? (want
          ? "<br/><br/>📱 Your phone's apps get locked again too — make sure it is <b>connected to the internet</b>."
          : "<br/><br/>📱 Your phone's apps are released too — make sure it is <b>connected to the internet</b>, or it stays locked until the next try.")
      : "";
    if (!willAskPassword) {
      const ok = want
        ? await askConfirm({
            glyph: "🛡️",
            title: "Turn FocusGate on?",
            body: "Your blocked sites lock again straight away, and time on your work pages starts counting." + phoneAsk,
            yes: "Turn on", no: "Not now"
          })
        : await askConfirm({
            glyph: "⚠️",
            title: "Turn FocusGate off?",
            body: "Nothing will be blocked and nothing will be tracked until you switch it back on. Today's progress is kept." + phoneAsk,
            yes: "Turn off", no: "Keep it on", danger: true
          });
      if (!ok) { e.target.checked = !want; return; }
    }

    if (!want && !(await unlockedFor("Enter your password to switch FocusGate off."))) {
      e.target.checked = true;                 // stays on until you prove it's you
      return;
    }
    await setState({ enabled: want });
    // Turning it on should lock the tabs that should be locked, right away.
    try { chrome.runtime.sendMessage({ type: "refreshBlockedTabs" }); } catch {}
    // Switching OFF releases the phone, and it has to happen NOW rather than on the next
    // heartbeat: "off" means nothing of FocusGate's is holding anything, and a phone still locked
    // a minute later is the extension's rule outliving the switch that turns the rule off.
    //
    // A dedicated message rather than leaning on the sync, because the sync's job is to reconcile
    // and it is allowed to decide nothing needs sending — it short-circuits on `mobileLockSent`,
    // and the one state where that flag is least trustworthy is the one where the phone was locked
    // by a worker that has since been shut down and restarted. This asks for the unlock outright.
    //
    // ONE of the two, never both: a forced sync on a disabled FocusGate resolves to the same unlock
    // call, so sending both would fire the webhook twice for one press of the switch.
    try {
      chrome.runtime.sendMessage(
        { type: (!want && phone) ? "macrodroidUnlock" : "macrodroidSync" },
        () => void chrome.runtime.lastError
      );
    } catch {}
    renderDashboard();
    // After the render, which rebuilds the popup's markup and would throw this away if it went
    // first. Shown on BOTH directions and on every path — including the one where a password was
    // asked instead of a question, which is precisely the path that had nothing to say.
    if (phone) {
      popToast((want ? "📱 Locking your phone's apps again. " : "📱 Releasing your phone's apps. ") +
               PHONE_NET_LINE, "phone");
    }
  });

  // A break: the clock and the camera stop everywhere until you press play. No
  // password needed — pausing can only ever cost you time, never earn it.
  $("#brk")?.addEventListener("click", async () => {
    const st = await getState();
    await setState({ userPaused: !st.userPaused });
    renderDashboard();
  });

  // Settings opens with no question asked. It used to be the second door that wanted the
  // password, and that has moved: the settings page now shows everything and asks only when a
  // rule is being eased off — see setStateP in options.js. Asking here as well would put the
  // password back in front of reading, which is what that change was for, and would ask twice
  // for one loosening edit.
  $("#openOptions").addEventListener("click", () => {
    chrome.runtime.openOptionsPage();
    window.close();
  });

  // "Enable" cannot enable anything, and that is the whole problem this button has always had.
  // The switch belongs to Chrome, on Chrome's own page, which an extension may not script, scroll or
  // read — so all this can do is open that page and hope. The page that opens is long and has four
  // other switches on it, none of which is the one we mean.
  //
  // So it shows the row first. The dialog is the last moment anything of ours is on screen, which
  // makes it the only place a picture can help; once the tab opens we have no further say.
  $("#openExtFileBtn")?.addEventListener("click", async () => {
    await askConfirm({
      glyph: "📂",
      title: "Turn on one Chrome switch",
      body: "On the page that opens, find <b>Allow access to file URLs</b> and switch it on. " +
            "It is the row ringed below." +
            `<span style="display:block;margin-top:10px;padding:8px;background:#0b1020;` +
            `border:1px solid #2b3b57;border-radius:9px">${FGSettings.fileAccessGuideSvg()}</span>`,
      yes: "Open that page", no: "Not now"
    }).then((ok) => {
      if (!ok) return;
      try { chrome.tabs.create({ url: "chrome://extensions/?id=" + chrome.runtime.id }); } catch {}
      window.close();
    });
  });

  // Clicking a target's name goes there, in a new tab.
  $("#list")?.addEventListener("click", (e) => {
    const link = e.target.closest("a.nm");
    if (!link) return;
    // Go to the tab you already have open on it; only open a new one if there
    // isn't one. A second tab on the same site is never what you meant.
    e.preventDefault();
    try {
      chrome.runtime.sendMessage({
        type: "openTarget",
        id: link.getAttribute("data-open-id") || "",
        pattern: link.getAttribute("data-open-pattern") || "",
        url: link.getAttribute("href") || ""
      }, () => void chrome.runtime.lastError);
    } catch {}
    window.close();
  });

  // A mailto: link needs a mail app registered with Windows, and inside an
  // extension popup it usually does nothing at all. Open Gmail's compose window
  // instead — already addressed, subject filled in.
  $("#help").addEventListener("click", () => {
    const url = "https://mail.google.com/mail/?view=cm&fs=1" +
      "&to=" + encodeURIComponent("sinhanikhil549@gmail.com") +
      "&su=" + encodeURIComponent("FocusGate feedback") +
      "&body=" + encodeURIComponent("\n\n---\nFocusGate " +
        (chrome.runtime.getManifest ? chrome.runtime.getManifest().version : ""));
    try {
      if (chrome.tabs && chrome.tabs.create) chrome.tabs.create({ url });
      else window.open(url, "_blank");
    } catch { window.open(url, "_blank"); }
    window.close();
  });
}

// ---------------- live updates ----------------
const LIVE_KEYS = ["productiveSites", "xp", "level", "streakCount",
                   "enabled", "userPaused", "timerPauseReason", "timerPauseAt", "mobileLockSent",
                   "pauseSinceAt", "pausedTodaySec", "breakTodaySec"];

let liveTimer = 0;
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (!LIVE_KEYS.some(k => k in changes)) return;
  clearTimeout(liveTimer);
  liveTimer = setTimeout(async () => {
    if (!document.getElementById("list")) return;   // a dialog is up
    try { paintLive(await getState()); } catch {}
  }, 150);
});

// A beat of its own, once a second, for the two figures that move without storage moving: how long
// this pause has been running and how much of today has gone the same way. The worker writes those
// at most every five seconds — deliberately, since a write a second per tab is not worth it — so
// waiting for a storage change would show a clock that stood still and then jumped five.
//
// Only while the popup is actually up, which is the whole life of this script: a popup is torn down
// the moment it closes, and the interval goes with it.
setInterval(async () => {
  if (!document.getElementById("list")) return;     // a dialog is up
  try { paintLive(await getState()); } catch {}
}, 1000);

// ---------------- the finish line ----------------
function partyConfetti(count) {
  const colors = ["#f97316", "#eab308", "#22c55e", "#3b82f6", "#a855f7", "#ec4899", "#06b6d4"];
  const box = document.createElement("div");
  box.className = "fgparty";
  for (let i = 0; i < count; i++) {
    const p = document.createElement("i");
    p.style.left = (Math.random() * 100) + "%";
    p.style.background = colors[i % colors.length];
    p.style.animationDelay = (Math.random() * 0.5).toFixed(2) + "s";
    p.style.animationDuration = (2 + Math.random() * 1.8).toFixed(2) + "s";
    p.style.setProperty("--rot", Math.floor(Math.random() * 720 - 360) + "deg");
    box.appendChild(p);
  }
  document.body.appendChild(box);
  setTimeout(() => box.remove(), 5200);
}
let partyUp = false;
function celebrateAllDone(payload) {
  if (partyUp) return;
  partyUp = true;
  const p = payload || {};
  const back = document.createElement("div");
  back.className = "fgwin";
  back.setAttribute("data-testid", "popup-all-done");
  back.innerHTML = `
    <div class="fgwincard" role="alertdialog" aria-live="assertive">
      <div class="fgtrophy" aria-hidden="true">🏆</div>
      <h2>${esc(p.title || "Everything is done! 🏆")}</h2>
      <p>${esc(p.subtitle || "All of today's work is finished.")}</p>
      ${p.xp ? `<div class="fgxp">+${p.xp} XP</div>` : ""}
      <button class="btn primary" id="fgwinClose">Nice 🎉</button>
    </div>`;
  document.body.appendChild(back);
  const close = () => { partyUp = false; back.remove(); renderDashboard(); };
  back.querySelector("#fgwinClose").addEventListener("click", close);
  requestAnimationFrame(() => back.classList.add("show"));
  partyConfetti(90);
  setTimeout(() => { if (partyUp) close(); }, 10000);
}
chrome.runtime.onMessage.addListener((msg) => {
  if (msg && msg.type === "celebrateAll") celebrateAllDone(msg.payload);
});

// The popup is only ever a read-out, so it never asks for a password to open.
renderDashboard();
