// Reloading or updating the extension leaves this page open with its link to the
// extension already gone, and then every poll throws "Extension context
// invalidated" into the console. Asked before anything is sent, so the page just
// goes quiet instead.
function extensionAlive() {
  try { return !!(chrome.runtime && chrome.runtime.id); } catch { return false; }
}
function fmt(s){s=Math.max(0,s|0);const m=Math.floor(s/60),x=s%60;return `${m}m ${String(x).padStart(2,"0")}s`;}
function esc(v){return String(v==null?"":v).replace(/[&<>"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));}

const QUOTES = [
  "Discipline is choosing between what you want now and what you want most.",
  "You don't rise to your goals, you fall to your systems.",
  "Small daily improvements compound into staggering results.",
  "Focus is saying no to a thousand good things.",
  "The pain of discipline weighs ounces; the pain of regret weighs tons.",
];
document.getElementById("quote").textContent = `"${QUOTES[Math.floor(Math.random()*QUOTES.length)]}"`;
const params = new URLSearchParams(location.search);
const fromUrl = params.get("from") || "";

// Why the topic check refused this page, read off THIS page's own address.
//
// Not asked of the worker, and that is not laziness. Every other reason here can be re-derived by handing
// the URL back — "is reddit.com blocked" has the same answer a minute later — but this one was decided
// from the page's own title, description and subtitles, and by the time this page is running the tab has
// left it. The worker knew it at the moment it decided, so the worker writes it down. See blockedPageUrl.
//
// All four are clamped and escaped at every use site: they arrive in an address bar, which anybody can
// type into.
const offTopicTargetId = (params.get("tg") || "").slice(0, 40);
const offTopic = params.get("tp") || "";
const offTopicPct = (() => {
  const n = parseInt(params.get("ap"), 10);
  return Number.isFinite(n) ? Math.max(0, Math.min(100, n)) : -1;
})();
const offTopicNeed = (() => {
  const n = parseInt(params.get("an"), 10);
  return Number.isFinite(n) ? Math.max(0, Math.min(100, n)) : -1;
})();
const offTopicReason = (params.get("ar") || "").slice(0, 160);
const offTopicRead = (params.get("ad") || "").slice(0, 120)
  .split(",").map(s => s.trim()).filter(Boolean).slice(0, 6);

// The AI category verdict, the same way and for the same reason. Clamped and escaped at every use site.
const catId = (params.get("ct") || "").slice(0, 40);
const catReason = (params.get("cr") || "").slice(0, 90);
// The category's own name and icon, looked up in the shared table rather than sent in the address — an id
// is short and safe to put in a URL, a display name is neither.
function catInfoOf(id) {
  const all = (self.FGSettings && self.FGSettings.SITE_CATEGORIES) || [];
  return all.find(c => c.id === id) || null;
}

// "It watched the video and put it at 20%, against the 50% you asked for" — one clause, and worth its own
// function because it has to say nothing at all when there was no score. Every other sentence on this page
// is about an address; this is the only one about a judgement.
function offTopicClause() {
  if (offTopicPct < 0 || offTopicNeed < 0) return "";
  const read = offTopicRead.length
    ? (offTopicRead.length === 1
        ? offTopicRead[0]
        : offTopicRead.slice(0, -1).join(", ") + " and " + offTopicRead[offTopicRead.length - 1])
    : "the title";
  const looked = read === "the video itself" ? "watched the video itself" : `read ${esc(read)}`;
  return ` The AI ${looked} and put it at <b>${offTopicPct}%</b> on topic, against the <b>${offTopicNeed}%</b> you asked for.` +
         (offTopicReason ? ` Its verdict: “${esc(offTopicReason)}”.` : "");
}

// The site you were trying to reach, said the way you'd say it out loud.
function hostOf(u) {
  try { return new URL(u).hostname.replace(/^www\./, ""); } catch { return ""; }
}
const blockedHost = hostOf(fromUrl);

// The headline already carries the site's name, so the line under it only shows
// what the headline can't: the exact page you were opening. Heading for the front
// page means there's nothing to add, and the line stays away entirely.
(function showFromPath() {
  const wrap = document.getElementById("fromWrap");
  const el = document.getElementById("from");
  if (!wrap || !el) return;
  let path = "";
  try {
    const u = new URL(fromUrl);
    const p = (u.pathname || "") + (u.search || "");
    if (p && p !== "/") path = p;
  } catch { path = ""; }
  if (!path) return;
  el.textContent = path;
  wrap.hidden = false;
})();

// Two names for the same place — "duolingo.com" and "https://www.duolingo.com/" —
// count as one, so a row never says it twice.
function sameTarget(a, b) {
  const n = v => String(v == null ? "" : v).trim().toLowerCase()
    .replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/+$/, "");
  const x = n(a);
  return !!x && x === n(b);
}

// "youtube.com is blocked" — the site once, and why you're here. The name is the
// loud part; "is blocked" is said quietly beside it.
function headHtml(tail) {
  const said = tail ? ` ${tail}` : "";
  if (!blockedHost) return `This site<span class="hword">${said || " is blocked"}</span>`;
  return `${esc(blockedHost)}<span class="hword">${said || " is blocked"}</span>`;
}

// The single sentence under the headline: where to go, and that it opens the site
// named above. No times here — every figure lives on its own row below, with its
// own bar, so nothing is said twice.
function leadHtml(rows) {
  // `met`, not "is the clock full". A row finished after its window is not a row that is out of the
  // way, and counting it as one is what let this sentence say "work's done" on a page that was never
  // going to send anybody back — the one claim on this screen that could be flatly disproved by the
  // screen itself still being there.
  const unfinished = rows.filter(r => !r.met);
  if (!unfinished.length) return `Work's done — this page will send you back in a moment.`;
  const it = blockedHost ? "it" : "this site";
  return `Spend your time on the ${unfinished.length > 1 ? "sites" : "site"} below to open ${it}.`;
}

// "You didn't finish Anki between 06:00 and 09:00" — the sentence this page owes you when a deadline,
// rather than a shortfall, is what is keeping the site shut.
//
// Said here rather than only on the rows because the rows answer "which one" and this answers "why am
// I looking at this page", and somebody who set a window three days ago and forgot needs the second
// question answered first. The names come from the storage rows, so this deliberately re-derives the
// display name the same way todaysRows does.
function missLeadHtml(missed, resetAt, doomed) {
  const nameOf = (p) => esc(p.label || p.url || p.path || "your goal");
  const F = self.FGSettings;
  const label = (p) => (F && F.windowLabel ? F.windowLabel(p) : "");
  const it = blockedHost ? "it" : "this site";
  // Which KIND of deadline each row failed, because the two need different sentences and a row can only
  // be described by one of them at a time. A row that failed both is called a window miss, which is the
  // right way round: the window is the fixed thing, and the hours are what somebody would go and change.
  const byWindow = (p) => !!(F && ((F.windowMissed && F.windowMissed(p)) || (F.windowGone && F.windowGone(p))));
  // FGSettings.fmtDur, not the local fmt: this is prose, and fmt writes an hour as "60m 00s". Falls back
  // to fmt if settings.js never loaded, which is ugly and readable rather than absent.
  const dur = (sec) => esc(F && F.fmtDur ? F.fmtDur(sec) : fmt(sec));
  // What a stopwatch row was allowed, in words: the goal plus its grace.
  const allowOf = (p) => dur((Number(p.requiredSec) || 0) + (Number(p.graceSec) || 0));
  const wins = missed.filter(byWindow);
  const limits = missed.filter(p => !byWindow(p));
  const clause = (list) => {
    const names = list.map(p => byWindow(p)
      ? `<b>${nameOf(p)}</b> (${esc(label(p))})`
      : `<b>${nameOf(p)}</b> (within ${allowOf(p)} of opening it)`);
    return names.length === 1 ? names[0]
      : names.length === 2 ? names.join(" and ")
      : names.slice(0, -1).join(", ") + " and " + names[names.length - 1];
  };
  let first;
  if (missed.length === 1 && wins.length === 1) {
    const p = missed[0];
    // Shown the way the setting is shown — 12-hour with am/pm — rather than the 24-hour form it is
    // stored in. Somebody who typed "3:00 pm" should not have to work out that 15:00 is the same thing.
    const c12 = (v) => (F && F.clock12 ? F.clock12(v) : String(v || ""));
    first = `You haven't completed <b>${nameOf(p)}</b> between <b>${esc(c12(p.winStart))}</b> and ` +
            `<b>${esc(c12(p.winEnd))}</b>, so it unlocked nothing today — that's why ${it} is blocked.`;
  } else if (missed.length === 1) {
    // One row, and a stopwatch rather than a window. Its own sentence because "between two times" is
    // exactly what did NOT happen here: the limit was measured from the moment the site was opened.
    const p = missed[0];
    first = `You didn't finish <b>${nameOf(p)}</b> within ${allowOf(p)} of opening it — its ` +
            `${dur(Number(p.requiredSec) || 0)} goal plus ${dur(Number(p.graceSec) || 0)} of grace — so it ` +
            `unlocked nothing today. That's why ${it} is blocked.`;
  } else if (wins.length && limits.length) {
    first = `You haven't completed ${clause(wins)} inside their time windows, or ${clause(limits)} ` +
            `inside its time limit, so they unlocked nothing today — that's why ${it} is blocked.`;
  } else if (limits.length) {
    first = `You haven't completed ${clause(limits)} inside the time limits set for them, so they ` +
            `unlocked nothing today — that's why ${it} is blocked.`;
  } else {
    first = `You haven't completed ${clause(wins)} inside their time windows, so they unlocked nothing ` +
            `today — that's why ${it} is blocked.`;
  }
  // The time is not taken away and the bars still show it, which is the one thing people assume has
  // gone wrong when a full bar unlocks nothing. Worth a sentence of its own.
  //
  // Worded to cover both deadlines. Neither comes back: a window does not re-open later in the day, and
  // an allowance counted from when you sat down is spent once it is spent.
  const second = `The time you put in still counted — it's on the bars below. What ran out was the ` +
                 `deadline, and a deadline doesn't come round again later in the day.`;
  // Only when a whole group has failed, because only then is it certain. See missInfo.
  const third = doomed
    ? `<br/><br/>So nothing can open ${it} until the day starts over at <b>${esc(resetAt)}</b>.`
    : "";
  return `${first}<br/><br/>${second}${third}`;
}

// ---------------------------------------------------------------------------
// Site logos. Best guess first, each tried in turn, and the first that loads is
// kept — the same ladder Settings uses, so a row looks identical in both places.
// The site's own /favicon.ico leads because it's exact and it's a request to that
// site alone; Chrome's own cache follows, since it knows where a site really keeps
// its icon but answers with a grey globe when it has nothing.
// ---------------------------------------------------------------------------
function favCandidatesForRaw(raw) {
  raw = String(raw || "").trim().replace(/^https?:\/\//i, "");
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
function favCandidates(t) {
  const type = String(t && t.type || "");
  if (type === "local_file") return [];               // nothing on the web to ask
  if (type.startsWith("youtube")) return favCandidatesForRaw("youtube.com");
  return favCandidatesForRaw(t && (t.pattern || t.url) || "");
}
// When a site has no icon of its own, its kind stands in for it.
function kindEmoji(t) {
  const type = String(t && t.type || "");
  if (type === "youtube_channel") return "📺";
  if (type === "youtube_playlist") return "🎬";
  if (type === "youtube_video") return "▶️";
  if (type === "local_file") {
    const p = String(t.pattern || t.url || "").replace(/[\\/]+$/, "");
    return /\.[a-z0-9]{1,8}$/i.test(p) ? "🗂️" : "📁";
  }
  if (String(t && t.pattern || "").includes("/")) return "📄";
  return "🌐";
}
// Whichever address finally loaded, remembered per target. This page rebuilds its
// whole list every few seconds, and without this the logos would be re-fetched
// and blink each time.
const FAV_OK = new Map();
function iconInner(key, favs, emoji) {
  const settled = FAV_OK.get(key);
  if (settled === "none" || !favs.length) return `<span class="favfb">${emoji}</span>`;
  if (settled) return `<img src="${esc(settled)}" alt="" referrerpolicy="no-referrer"/>`;
  return `<img src="${esc(favs[0])}" data-fav="${esc(favs.join("|"))}" data-favi="0"
            data-favkey="${esc(key)}" alt="" loading="lazy" referrerpolicy="no-referrer"/><span class="favfb" hidden>${emoji}</span>`;
}
function iconHtml(key, favs, emoji, cls) {
  return `<span class="${cls}">${iconInner(key, favs, emoji)}</span>`;
}
// An image that fails doesn't bubble its error, so it's caught on the way down.
// One pair of listeners for the whole page, set once — the rows can be rebuilt as
// often as they like.
document.addEventListener("load", (e) => {
  const img = e.target;
  if (!img || img.tagName !== "IMG" || !img.hasAttribute("data-fav")) return;
  const key = img.getAttribute("data-favkey");
  if (key) FAV_OK.set(key, img.src);
}, true);
document.addEventListener("error", (e) => {
  const img = e.target;
  if (!img || img.tagName !== "IMG" || !img.hasAttribute("data-fav")) return;
  const list = (img.getAttribute("data-fav") || "").split("|").filter(Boolean);
  const i = (parseInt(img.getAttribute("data-favi"), 10) || 0) + 1;
  if (i < list.length) {
    img.setAttribute("data-favi", String(i));
    img.src = list[i];
    return;
  }
  const key = img.getAttribute("data-favkey");
  if (key) FAV_OK.set(key, "none");
  img.hidden = true;
  const fb = img.parentElement && img.parentElement.querySelector(".favfb");
  if (fb) fb.hidden = false;
}, true);

// The logo beside the headline. Set once — the site you were heading for can't
// change while this page is open.
function paintHeadIcon() {
  const box = document.getElementById("headIcon");
  if (!box || box.dataset.set || !blockedHost) return;
  box.dataset.set = "1";
  box.innerHTML = iconInner("__blocked__", favCandidatesForRaw(blockedHost), "🔒");
  box.hidden = false;
}

// ---------------------------------------------------------------------------
// One colour ramp for every progress bar in FocusGate: red at the start, through
// orange and yellow, to green when it's full. The same three functions live in
// options.js, popup.js and here — extension pages don't share modules, so the
// ramp is copied rather than imported. Keep them identical.
// ---------------------------------------------------------------------------
function barHue(pct) {
  const p = Math.max(0, Math.min(100, pct)) / 100;
  // Eased so orange arrives around a quarter and yellow around half, instead of
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

// A file on this computer goes by its own name, with the path underneath.
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

// Is this path anchored to a drive, or only the tail of one? A file picked from Chrome's own
// dialog is stored as a tail — "notes/physics/ch1.pdf", with no drive — because Chrome refuses to
// tell a page where it picked from. Must stay in step with absLocalPath in background.js.
function absLocalPath(v) {
  const s = String(v || "").trim();
  return /^file:/i.test(s) || /^[a-z]:[\\/]/i.test(s) || /^\\\\/.test(s) || /^\/[^/]/.test(s);
}
// Back to something a tab can open: file:///D:/notes/my%20file.pdf
// Mirrors toFileUrl in options.js, including the one line that is easy to leave out — the colon
// in the drive letter has to be put back after encoding. encodeURIComponent turns "D:" into
// "D%3A", which is no longer the drive separator, so the address quietly leads nowhere.
function toFileUrl(v) {
  let s = String(v || "").trim().split("#")[0];
  s = s.replace(/^file:\/*/i, "").replace(/\\/g, "/");
  try { s = decodeURIComponent(s); } catch {}
  s = s.replace(/\/{2,}/g, "/").replace(/^\/+/, "").replace(/\/+$/, "");
  if (!s) return "";
  const enc = s.split("/").map(seg => encodeURIComponent(seg).replace(/%3A/gi, ":")).join("/");
  return "file:///" + enc;
}
// Where FocusGate's own copy of a picked file opens. Mirrors fgViewerUrl in filestore.js — this
// page has no use for the rest of that file (it never reads or writes a copy), so the one line it
// does need is repeated rather than pulling IndexedDB onto the lock screen. Keep the two in step.
function viewerUrl(id) {
  if (!id) return "";
  try { return chrome.runtime.getURL("viewer.html") + "?t=" + encodeURIComponent(id); }
  catch { return ""; }
}

// Where a target opens. Addresses are stored without a protocol, and YouTube
// targets keep an id rather than a link.
function targetOpenUrl(p) {
  if (!p) return "";
  if (p.type === "local_file") {
    // The real file:// address, when FocusGate knows it. The background learns the full path the
    // first time the file is opened in a tab, at which point p.url holds the file:// URL and
    // p.path holds the normalised path. Opening the original file is what the user expects.
    if (p.url) return p.url;
    const path = p.path || "";
    if (absLocalPath(path)) return toFileUrl(path);
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

function infoTip(html) {
  return `<span class="tip" tabindex="0" role="button" aria-label="More information"><span class="tip-i" aria-hidden="true">?</span><span class="tip-box" role="tooltip">${html}</span></span>`;
}

function getBlockInfo(url) {
  return new Promise((res) => {
    try {
      chrome.runtime.sendMessage({ type: "blockInfo", url }, (r) => res(r && r.info ? r.info : null));
    } catch { res(null); }
  });
}

// ---------------------------------------------------------------------------
// The per-row deadline, as this page has to talk about it.
//
// A row can fail its window two ways, and until now neither reached this screen — which made this the
// page that looked broken. A goal finished at 09:12 against an 06:00–09:00 window rendered here as a
// full green bar reading "done", beside a headline saying the site was blocked, with no sentence
// anywhere connecting the two. And a goal whose window simply ran out looked like ordinary unfinished
// work, so the advice "spend your time on the sites below" pointed at hours that could no longer buy
// anything today.
//
// All the judging lives in settings.js, where the comment above those helpers explains why: the
// worker, the popup, the settings page and this screen all have to agree about a midnight wrap, and
// four copies of that comparison is four chances to disagree.
// ---------------------------------------------------------------------------

// A stamp as a wall clock, so a row can say the time it actually finished rather than "too late".
function clockOf(ms) {
  const t = Number(ms) || 0;
  if (!t) return "";
  const d = new Date(t);
  return String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0");
}

// The set of rows the WORKER judges, which is not the set this page lists.
//
// `todaysRows` below does not filter by weekday; `activeTargets` in background.js does. So a row
// scheduled for Tuesdays only still appears in this page's list on a Sunday, and blaming a locked
// site on a missed window belonging to a row that is not even asked for today would be a confident
// lie. Every claim about WHY the site is shut is judged on this set instead.
function workerRows(s) {
  const F = self.FGSettings;
  const list = (s.productiveSites || []).filter(p => p && p.enabled !== false &&
    p.requiredSec !== undefined && p.requiredSec !== null && !isNaN(p.requiredSec) && p.requiredSec >= 0);
  if (!F || !F.onDay || !F.weekdayNow) return list;
  const day = F.weekdayNow(s.dailyResetTime);
  return list.filter(p => F.onDay(p, day));
}

// Which missed windows are actually holding this site shut, and whether today is beyond saving.
//
// The group test is the part that stops this from overclaiming. Unlocking asks
// `groups.every(g => g.some(targetMet))`, so a row that missed its window inside an OR group whose
// sibling was met costs nothing at all — its deadline is irrelevant to why you are here, and saying
// "you didn't finish X in its window, that's why this is blocked" would be false. Only groups with no
// met row can be to blame.
//
// `doomed` is the stronger claim and is only made when it is provable: every row in some group has
// either finished too late or run out of its window. A late finish is stamped in `metAt` and that
// stamp does not move, and a window that has gone does not come back today, so no row in such a group
// can become met before the daily reset. That group can never be satisfied today, and because
// unlocking needs EVERY group, neither can the site.
function missInfo(s) {
  const F = self.FGSettings;
  const out = { rows: [], doomed: false };
  if (!F || !F.windowMissed || !F.windowGone || !F.targetMet) return out;
  // Both deadlines count as a failure, and they have to be asked together rather than in two passes: a
  // row can fail either one, and what makes `doomed` provable is that EVERY row in some group is past
  // saving — not that they all failed the same way. The grace helpers are guarded because this page
  // survives a settings.js that did not load, and an older one would not have them.
  const failed = (p) => F.windowMissed(p) || F.windowGone(p) ||
    !!(F.graceMissed && F.graceMissed(p)) || !!(F.graceGone && F.graceGone(p));
  const list = workerRows(s);
  const groups = F.computeTargetGroups ? F.computeTargetGroups(list) : [list];
  for (const g of groups) {
    if (!g.length) continue;
    if (g.some(F.targetMet)) continue;            // carried by a sibling: nothing here is to blame
    for (const p of g) if (failed(p)) out.rows.push(p);
    if (g.every(failed)) out.doomed = true;
  }
  return out;
}

// Everything still standing between you and this site, in the order you arranged
// in Settings. Rows switched off, or left at 0h 0m 0s, aren't part of today's
// work and don't appear.
function todaysRows(s) {
  // Sequence mode, worked out once for the whole list rather than per row.
  //
  // Every screen on this page that lists rows needs it, not just the out-of-order one: the ordinary
  // locked-list copy says "spend your time on the sites below", and under a sequence all but one of
  // those sites will refuse you. A list that offers five ways out when only one of them opens is the
  // page giving bad advice, which on a screen whose whole job is to be believed is the worst failure
  // available to it.
  //
  // Judged on workerRows, not on this list, for the reason that function exists: this one deliberately
  // keeps rows that are not scheduled for today, and such a row is in no step at all.
  const FSeq = self.FGSettings;
  const seqOn = s.sequenceMode === true && !!(FSeq && FSeq.inCurrentStep && FSeq.stepNumberOf && FSeq.stepCount);
  const seqAll = seqOn ? workerRows(s) : [];
  const seqTotal = seqOn ? FSeq.stepCount(seqAll) : 0;
  const rows = (s.productiveSites || [])
    .filter(p => p && p.enabled !== false && (p.requiredSec !== undefined && p.requiredSec !== null && !isNaN(p.requiredSec) && p.requiredSec >= 0))
    .map(p => {
      const req = p.requiredSec || 0;
      const spent = Math.min(req, p.spentSec || 0);
      // The deadline travels with the row. It used to be dropped here, which is why every screen
      // below this line could only ever talk about the clock: `rowHtml` had no way to know that a
      // full bar had unlocked nothing.
      const F = self.FGSettings;
      const hasWin = !!(F && F.hasWindow && F.hasWindow(p));
      const late = !!(F && F.windowMissed && F.windowMissed(p));
      const gone = !!(F && F.windowGone && F.windowGone(p));
      const met = F && F.targetMet ? F.targetMet(p) : ((req === 0) || (p.spentSec || 0) >= req);
      // The stopwatch deadline, guarded the same way: this page has to survive a settings.js that did not
      // load, and an older one has none of these.
      const gRunning = !!(F && F.graceStarted && F.graceStarted(p));
      const gLate = !!(F && F.graceMissed && F.graceMissed(p));
      const gGone = !!(F && F.graceGone && F.graceGone(p));
      // Which step this row is, and whether it is waiting its turn. `seqStep > 0` is what keeps a row
      // that is not in the sequence at all — not scheduled today — from being reported as locked by it.
      const seqStep = seqOn ? FSeq.stepNumberOf(p, seqAll) : 0;
      const seqMine = seqOn && seqStep > 0 ? FSeq.inCurrentStep(p, seqAll) : true;
      return {
        id: p.id, order: p.order || 0, type: p.type || "site",
        // Sequence position. seqLocked means "you cannot start this yet", which is deliberately not the
        // same as "not your turn": a FINISHED row is also not your turn, and it needs no warning
        // because its own bar already says so.
        seqStep, seqTotal, seqMine,
        seqLocked: seqOn && seqStep > 0 && !seqMine && !met,
        // Window state, in the three shapes the row actually needs: whether to go red, what the hours
        // were, and which of the two failures it was — a full bar stamped too late reads differently
        // from a half bar that ran out of hours.
        hasWin, late, gone, missed: late || gone || gLate || gGone,
        met,
        // The stopwatch, in the same three shapes as the window above it: whether it is running at all,
        // which of the two ways it was failed, and the figures the sentence needs. `missed` is shared
        // between the two deadlines on purpose — it drives the red styling, and a row that has failed is
        // red whichever deadline did it — while the two pairs of flags stay apart so the copy can name
        // the right one.
        gRunning, gLate, gGone,
        // Pre-formatted, and with FGSettings.fmtDur rather than this file's own fmt: these go into a
        // sentence, and fmt writes an hour and ten minutes as "70m 00s". The row builder is the right
        // place for it because rowHtml is handed a view model and should not be choosing formatters.
        gLeftTxt: gRunning && F.fmtDur ? F.fmtDur(F.graceLeftSec ? F.graceLeftSec(p) : 0) : "",
        // `F &&` on this one and not on the two around it, and the asymmetry is real: those are gated by
        // gRunning, which is already false when settings.js is missing. This one is not, so it needs its
        // own guard — a lock screen that threw here would render nothing at all.
        gAllowTxt: F && F.fmtDur ? F.fmtDur((req || 0) + (Number(p.graceSec) || 0)) : "",
        gEndTxt: gRunning ? clockOf(F.graceDeadline ? F.graceDeadline(p) : 0) : "",
        // The deadline as a raw number, for the per-second countdown to work from. It is a fixed instant,
        // so the ticker needs nothing else — no storage read, no re-derivation — and that is the whole
        // reason a second-by-second countdown costs nothing here.
        gEndMs: gRunning && F.graceDeadline ? F.graceDeadline(p) : 0,
        winLabel: hasWin && F.windowLabel ? F.windowLabel(p) : "",
        winStart: hasWin ? String(p.winStart || "") : "",
        winEnd: hasWin ? String(p.winEnd || "") : "",
        winOpen: hasWin && F.inWindow ? !!F.inWindow(p) : false,
        metAtTxt: late ? clockOf(p.metAt) : "",
        name: p.label || (p.type === "local_file" ? localName(p.url || p.path) : p.url)
             || (p.type === "youtube_channel" ? "YouTube channel"
             : p.type === "youtube_playlist" ? "YouTube playlist"
             : p.type === "youtube_video" ? "YouTube video" : "Site"),
        sub: p.type === "local_file" ? localDisplay(p.url || p.path)
             : (p.type === "site" || p.type === "youtube_video") ? (p.url || "") : "",
        req, spent, openUrl: targetOpenUrl(p), pattern: p.url || "", note: "",
        // A picked file knows its name and folder but not its drive, so there is no address to put
        // in a link. Its Open still works — it goes to the tab you already have the file in, and
        // otherwise to Chrome's file listing so you can click through to it once. Opening it once
        // teaches FocusGate the exact address, after which openUrl is filled in and this goes away
        // by itself.
        findLocal: p.type === "local_file" && !targetOpenUrl(p),
        operator: p.operator === "OR" ? "OR" : "AND"
      };
    });
  return rows.sort((a, b) => a.order - b.order);
}

// The one you're working on this very second: whichever site last earned a
// second. Goes quiet after 15s of nothing.
function liveRowId(s) {
  if (s.activeTargetId && (Date.now() - (s.activeTargetAt || 0)) < 15000) return s.activeTargetId;
  return "";
}

function rowHtml(r, liveId) {
  const done = r.req === 0 || Math.max(0, r.req - r.spent) === 0;
  const pct = done ? 100 : (r.req > 0 ? Math.round(100 * Math.min(r.spent, r.req) / r.req) : 0);
  const left = Math.max(0, r.req - r.spent);
  const live = r.id === liveId;
  const label = `<span class="tname">${esc(r.name)}</span><span class="ext" aria-hidden="true">↗</span>`;
  const attrs = `data-open-id="${esc(r.id)}" data-open-pattern="${esc(r.pattern)}" data-open-url="${esc(r.openUrl)}"`;
  const name = r.openUrl
    ? `<a class="tlink" href="${esc(r.openUrl)}" ${attrs} title="Go to ${esc(r.name)}">${label}</a>`
    : `<span class="tname">${esc(r.name)}</span>`;
  // The address only goes under the name when it says something the name doesn't —
  // "duolingo.com" under "duolingo.com" is the same word twice.
  const sub = r.sub && !sameTarget(r.sub, r.name) ? esc(r.sub) : "";
  // Nothing put in yet, so "3m 00s left · 0m 00s / 3m 00s" would say the goal
  // twice and tell you nothing extra. The count only splits in two once there's
  // something on the clock.
  //
  // A missed window replaces this line rather than adding to it, and "✅ done" is the reason. On a row
  // finished too late that tick was the page's own contradiction: a green tick and a full bar sitting
  // under a headline that says the site is blocked. The two failures read differently because they
  // are different — one has a finishing time to quote, the other has hours left over.
  //
  // The window is asked about first and the stopwatch second, which is arbitrary in the case where a row
  // failed both and correct in every other: they are mutually exclusive in practice, and a line naming
  // two deadlines would be a line nobody finishes reading. The stopwatch's live countdown is last of the
  // "not failed" cases because it is the most specific thing that can be said about a row still in play.
  const time = r.late
    ? (r.metAtTxt
        ? `⏰ finished ${r.metAtTxt} — after the ${r.winLabel} window`
        : `⏰ finished outside the ${r.winLabel} window`)
    : r.gone
      ? `⏰ the ${r.winLabel} window closed with ${fmt(left)} still to do`
      : r.gLate
        ? `⏳ finished after the ${esc(r.gAllowTxt)} limit ran out`
        : r.gGone
          ? `⏳ the ${esc(r.gAllowTxt)} limit ran out with ${fmt(left)} still to do`
          : done ? "✅ done"
            : r.gRunning
              // The countdown is wrapped in an element of its own, carrying the deadline as a number, so
              // tickGrace can rewrite this one figure every second without rebuilding the page. See the
              // note there for why the whole repaint is not simply run every second instead.
              ? `${fmt(left)} left · <span class="gtick" data-gtick="${esc(String(r.gEndMs))}"
                       data-gend="${esc(r.gEndTxt)}">⏳ ${esc(r.gLeftTxt)} until ${esc(r.gEndTxt)}</span>`
              : r.spent <= 0 ? `${fmt(r.req)} to do`
              : `${fmt(left)} left · ${fmt(r.spent)} / ${fmt(r.req)}`;
  const meta = [
    sub,
    time,
    r.note ? esc(r.note) : ""
  ].filter(Boolean).join(" · ");
  return `
    <!-- This page rebuilds its whole list on each repaint rather than patching
         single rows, so a row carries no id of its own. -->
    <div class="target${done ? " done" : ""}${r.missed ? " missed" : ""}${r.seqLocked ? " seqlock" : ""}${live ? " live" : ""}">
      ${iconHtml("t:" + r.id, favCandidates(r), kindEmoji(r), "tfav")}
      <div class="tbody">
        <div class="name">${name}${
          // Which deadline was missed, named rather than lumped together. "window missed" on a row that
          // has no window and simply ran out of its allowance would send somebody to look for hours they
          // never set.
          (r.late || r.gone) ? '<span class="misstag">window missed</span>'
          : (r.gLate || r.gGone) ? '<span class="misstag">time limit missed</span>'
          : ""}${
          // Which step this is, said on the row rather than only in the copy above it. Two tags, and
          // only ever one of them: the locked one is a warning and the open one is an instruction, and
          // a finished row gets neither because its bar has already said everything.
          r.seqLocked ? `<span class="seqtag">step ${r.seqStep} — locked</span>`
          : (r.seqStep > 0 && r.seqMine && !done) ? `<span class="seqtag mine">step ${r.seqStep} of ${r.seqTotal} — your turn</span>`
          : ""
        }${live ? '<span class="nowtag">working on this now</span>' : ""}</div>
        <div class="meta">${meta}</div>
        <div class="progress"><div style="width:${pct}%;background:${barFill(pct)};box-shadow:${pct > 0 ? barGlow(pct) : "none"}"></div></div>
      </div>
      ${r.seqLocked
        // No Open on a row the sequence has not reached. The link would work — it would navigate — and
        // land straight back on this screen, which is the one thing a lock screen must not do: offer a
        // way out that is not one. So the button says what it is instead, and the row keeps its bar and
        // its time so you can still see what it will ask for when its turn comes.
        ? `<span class="go locked" role="note" data-testid="seq-locked"
                 title="Step ${r.seqStep} of ${r.seqTotal}. FocusGate is doing your work list in order, so this opens once the steps before it are finished.">🔒 Step ${r.seqStep}</span>`
        : r.openUrl
        ? `<a class="go" href="${esc(r.openUrl)}" ${attrs} data-testid="open-target">${done ? "Open" : "Open →"}</a>`
        : r.findLocal
          ? `<button class="go" type="button" data-find-local="1" ${attrs} data-testid="find-local"
                     title="Goes to this file if you already have it open. If not, it opens your files so you can click through to it once — after that FocusGate knows its exact address and comes straight here.">${done ? "Open" : "Open →"}</button>`
          : ""}
    </div>`;
}

let INFO = null;

function paint(s) {
  const tgt = document.getElementById("targets");
  if (!tgt) return;
  const heading = document.getElementById("head") || document.querySelector("h1");
  const lead = document.getElementById("lead");
  const unlockCard = tgt.closest(".card");
  const unlockTitle = unlockCard ? unlockCard.querySelector("h2") : null;
  const info = INFO;
  // The site you were heading for is the headline — it's the thing you want, and
  // the sentence under it is the price. Said once here, and its logo sits beside it.
  if (heading) heading.innerHTML = headHtml("");
  paintHeadIcon();

  // ---- Blocked because this page is on a work site but not about its topic ----
  //
  // Its own branch, and it earns one: this is the only gate in the extension that fires on a site the user
  // deliberately nominated as WORK. Every other reason here can be summed up as "you are somewhere you
  // said you would not be", and the advice is "go and do the work". Here you ARE on the work site, and the
  // advice is the opposite — the page is fine, the site is fine, this particular thing on it is not what
  // you said you came for. Falling through to "spend your time on the sites below" would point somebody at
  // the very site they are already on.
  // Two ways in, and the second is not belt-and-braces: the worker's verdict lives in memory, and a
  // service worker is killed whenever Chrome feels like it — so `info` can come back with no opinion
  // about a page that was genuinely refused for this reason seconds earlier. `?tg=` is written only by
  // this gate, so its presence is proof enough on its own.
  // ---- Blocked because this VIDEO isn't about anything you're studying ----
  //
  // Its own branch and not a variant of the one below, because there is no single row to point at: the
  // video was judged against every live topic at once, so the honest thing to show is the topics and then
  // the work still to do. Recognised from the address as well as from the worker's answer, since the
  // verdict lives in the worker's memory and a service worker is killed whenever Chrome feels like it.
  // ---- Blocked because the AI put this site in a category you chose to block ----
  //
  // Its own branch, first, and it earns one: this is the only gate that can refuse a site the user never
  // named. Every other reason here can be traced back to something they typed, so "you asked for this" is
  // implicit — here it is not, and the page has to say which category, what the model thought the site was,
  // and where to change its mind. Falling through to the generic locked-list copy would tell somebody their
  // site was on a list they could go and look at and not find it on.
  const catGate = (info && info.gate === "category") || !!catId;
  if (catGate) {
    const id = (info && info.catId) || catId;
    const why = (info && info.catReason) || catReason;
    const cat = catInfoOf(id);
    const rows = todaysRows(s);
    if (heading) heading.innerHTML = headHtml("— blocked category");
    if (lead) {
      const named = cat ? `${cat.icon} <b>${esc(cat.name)}</b>` : "a category you blocked";
      lead.innerHTML = `FocusGate read this site and put it in ${named}` +
        (why ? ` — “${esc(why)}”` : "") + `.` +
        `<br/><br/>You didn't have to list this address: with a category switched on, every site is checked ` +
        `against it, so the ones you never thought of are covered too.`;
    }
    if (unlockTitle) {
      unlockTitle.innerHTML = "🗂️ Finish this to unlock " + infoTip(
        "You blocked a whole <b>category</b> rather than a list of addresses, so any site an AI reads as " +
        "belonging to it is locked until today's work is done.<br/><br/>" +
        "<b>The judgement is a language model, and it can be wrong.</b> If it has misread this site, the " +
        "quickest fix is to leave the category on and stop using it here: switch the category off in " +
        "<b>Settings → Earn &amp; Unlock → Blocked until I earn it</b>, or turn <b>AI category blocking</b> " +
        "off entirely there.<br/><br/>" +
        "Each site is classified <b>once</b> and remembered, so this costs one request per domain rather " +
        "than one per page.<br/><br/>" +
        "Finish the work below and every category opens again.");
    }
    tgt.innerHTML = rows.length
      ? rows.map(r => rowHtml(r, liveRowId(s))).join("")
      : '<div style="color:#64748b">Nothing to finish is set up. Open Settings → Earn &amp; Unlock to add some.</div>';
    return;
  }

  const gatedVideo = (info && info.gate === "offtopicvideo") ||
                     (!offTopicTargetId && !!offTopic && offTopicPct >= 0);
  if (gatedVideo) {
    const rows = todaysRows(s);
    if (heading) heading.innerHTML = headHtml("— off topic");
    if (lead) {
      const list = offTopic
        ? offTopic.split(" · ").map(t => t.trim()).filter(Boolean)
        : (s.productiveSites || []).map(p => String(p.topic || "").trim()).filter(Boolean);
      const said = list.length
        ? (list.length === 1
            ? `You're studying <b>${esc(list[0])}</b> today`
            : "Today you're studying " + list.map(t => `<b>${esc(t)}</b>`).join(", "))
        : "This video isn't about what you're studying";
      lead.innerHTML = `${said} — and this video isn't that.` + offTopicClause() +
        `<br/><br/><b>Search still works</b>, so you can go and find the one you meant. A video about your ` +
        `topic opens straight away, even with youtube.com locked.`;
    }
    if (unlockTitle) {
      unlockTitle.innerHTML = "🎯 A video about your topic " + infoTip(
        "While today's work is unfinished, YouTube only opens <b>videos</b> about the topics on your study sites. " +
        "Matching <b>any one</b> of them is enough.<br/><br/>" +
        "The <b>home feed</b>, <b>search</b> and <b>channel pages</b> are not checked — they follow your locked list as usual — " +
        "so you can always go and look for the right video.<br/><br/>" +
        "The judgement is a language model reading this video against your topics, and it can be wrong. If it keeps " +
        "refusing something it shouldn't, widen the topic, lower the percentage, or switch <b>Only allow videos about my " +
        "topics</b> off in <b>Settings → General → 🎯 Study topics</b>.<br/><br/>" +
        "Finish the work below and every video opens again.");
    }
    // The work itself, so the way out is on the page rather than something to remember.
    tgt.innerHTML = rows.length
      ? rows.map(r => rowHtml(r, liveRowId(s))).join("")
      : '<div style="color:#64748b">Nothing to finish is set up. Open Settings → Earn &amp; Unlock to add some.</div>';
    return;
  }

  const offTopicRow = (info && info.gate === "offtopic" && info.target)
    ? ((s.productiveSites || []).find(x => x.id === info.target.id) || info.target)
    : (offTopicTargetId ? (s.productiveSites || []).find(x => x.id === offTopicTargetId) : null);
  if (offTopicRow) {
    const p = offTopicRow;
    const req = p.requiredSec || 0;
    const spent = Math.min(req, p.spentSec || 0);
    const topic = offTopic || p.topic || "";
    if (heading) heading.innerHTML = headHtml("— off topic");
    if (lead) {
      lead.innerHTML = (topic
        ? `This is one of your work sites, but you set it aside for <b>${esc(topic)}</b> — and this page isn't that.`
        : `This is one of your work sites, but this page isn't what you set it aside for.`) +
        offTopicClause() +
        `<br/><br/>Anything on here that <i>is</i> on topic opens straight away and counts as normal.`;
    }
    if (unlockTitle) {
      unlockTitle.innerHTML = "🎯 Back on topic " + infoTip(
        "You gave this site a <b>topic</b> — what you actually meant to do there — so being on the site is no longer enough on its own. " +
        "A page about the topic opens and its time counts; anything else on the same site is treated like any other distraction.<br/><br/>" +
        "<b>This is the strict version of the setting.</b> Without it, an off-topic page simply doesn't earn you time — it isn't taken away. " +
        "You can switch that back in <b>Settings → General → 🎯 Study topics</b>.<br/><br/>" +
        "The judgement is a language model reading this page against your sentence, and it can be wrong. If it keeps refusing something it shouldn't, " +
        "either widen the topic or lower the percentage it has to reach.");
    }
    tgt.innerHTML = rowHtml({
      id: p.id, type: p.type || "site",
      name: p.label || p.url || "your work site", sub: p.url || "",
      req, spent, openUrl: targetOpenUrl(p), pattern: p.url || "",
      note: topic ? "Topic: " + topic : "",
      findLocal: false
    }, liveRowId(s));
    return;
  }

  // ---- Blocked because this is a parent page of an exact-page target ----
  if (info && info.gate === "parent" && info.target) {
    // Read the live copy of that target, so its bar moves with the rest.
    const p = (s.productiveSites || []).find(x => x.id === info.target.id) || info.target;
    const req = p.requiredSec || 0;
    const spent = Math.min(req, p.spentSec || 0);
    if (heading) heading.innerHTML = headHtml("— wrong page");
    if (lead) {
      // The page you picked, and the time still owed on it, are both on the row
      // below — so this only explains why you're here.
      lead.innerHTML = spent >= req
        ? `You're done here — this page will open again in a moment.`
        : `You picked one exact page on this site, so the rest of it stays shut until that page is finished.`;
    }
    if (unlockTitle) unlockTitle.innerHTML = "🎯 Open this instead " + infoTip("You picked an <b>exact page</b> on this site, so the rest of the site is locked until you're done — the pages above it and any other section.<br/><br/>Open the page below and put your time in there. Anything <i>deeper</i> than it counts too.");
    tgt.innerHTML = rowHtml({
      id: p.id, type: p.type || "site", name: p.label || p.url || "your page", sub: p.url || "",
      req, spent, openUrl: targetOpenUrl(p), pattern: p.url || "", note: "",
      // This branch is only ever reached for a web target — the "wrong page on the right site"
      // gate needs a host, and a local file has none — so there is nothing to find. Passed
      // explicitly all the same, so rowHtml never has to read an absent field.
      findLocal: false
    }, liveRowId(s));
    return;
  }

  // ---- Blocked because this IS a work site, just not the step you are on ----
  //
  // Its own branch for the reason the topic branch above has one: you are on a site you nominated as
  // work, so the generic "go and spend your time on the sites below" would be pointing at a list this
  // site is already ON. The sentence that has to be said instead is narrower and more useful — not
  // "do your work" but "do THIS part of it first".
  //
  // After the parent gate, because that one is about a site with a target on it and this one is about a
  // target itself, and a page can only be one of the two. Before the generic tail, because the tail
  // lists every row with an Open button beside it — under a sequence, all but one of those buttons lead
  // straight back here, and a way out that is not a way out is worse than none.
  //
  // Two ways in, and the second is not belt-and-braces. The worker's answer lives in memory and Chrome
  // kills a service worker whenever it likes, so `info` can come back empty about a page that was
  // genuinely refused seconds earlier. `?sq=` is written only by this gate.
  //
  // The step itself is re-derived from storage rather than read out of the address, which is the
  // opposite of how the topic verdict travels — and the difference is that this one is still true: the
  // groups come out of the list and the progress is stored beside it, so the step this page names is the
  // step the worker would name if asked again this second. A number copied into a URL would be the step
  // as it was at the redirect, and a step that has moved on since would leave this page arguing with the
  // blocking.
  const seqTargetId = (params.get("sq") || "").slice(0, 40);
  // `self.FGSettings` with a guard, like every other use of it on this page. settings.js is a separate
  // script tag and a lock screen that threw a ReferenceError would show nothing at all — so a missing
  // file has to degrade to "no sequence branch", which is the copy this page had before the feature.
  const FG = self.FGSettings;
  const seqOk = !!(FG && FG.currentStepGroup && FG.currentStepIndex && FG.stepCount && FG.stepNumberOf);
  const seqRows = (seqOk && s.sequenceMode === true) ? workerRows(s) : [];
  const seqStep = seqRows.length ? FG.currentStepGroup(seqRows) : [];
  // `seqStep.length` is part of the condition, not checked inside it. No current step means everything
  // is finished or out of time, and then this screen would have nothing to send you to — so it falls
  // through to the ordinary copy, which does have something to say.
  if (((info && info.gate === "sequence") || !!seqTargetId) && seqStep.length) {
    const at = FG.currentStepIndex(seqRows);
    const total = FG.stepCount(seqRows);
    const stepIds = seqStep.map(x => x.id);
    // Which row the tab was on, and therefore which step got refused. Known from the worker or from
    // the address; unknown is survivable, and the copy below simply does not name a number.
    const mineId = (info && info.target && info.target.id) || seqTargetId;
    const mine = seqRows.find(x => x.id === mineId) || null;
    const mineStep = mine ? FG.stepNumberOf(mine, seqRows) : 0;
    const mineDone = mine && FG.targetMet ? FG.targetMet(mine) : false;
    if (heading) heading.innerHTML = headHtml("— out of order");
    if (lead) {
      const which = mineStep ? `step <b>${mineStep}</b>` : `a later step`;
      lead.innerHTML = mineDone
        // Finished, and shut again. The one state on this screen somebody would otherwise read as a
        // fault: the bar says 100% and the site is gone. Said first, because "I already did this" is
        // the objection.
        ? `You've finished ${which} of your work list, so it has closed behind you. FocusGate is doing ` +
          `today's list <b>in order</b> — you're on <b>step ${at + 1} of ${total}</b> now.`
        : `This is on your work list, but it's ${which} and you're on <b>step ${at + 1} of ${total}</b>. ` +
          `FocusGate is doing today's list <b>in order</b>, so only the step you're on is open.`;
    }
    if (unlockTitle) {
      unlockTitle.innerHTML = (seqStep.length > 1 ? "🔢 Either of these first " : "🔢 This one first ") +
        infoTip("Your work list is being done <b>in order</b>, top to bottom.<br/><br/>Only the step you're on is open. The steps after it are locked until you reach them, and each one closes again once it's finished — so you can't keep half of today's work started at once.<br/><br/>Sites joined by <b>OR</b> count as one step, so either of them will do.<br/><br/>To change the order, drag <b>⋮⋮</b> in <b>Settings → Earn &amp; Unlock</b>. To stop doing them in order, switch that card to <b>Any order</b>.");
    }
    // The step's own rows, built by the same function that builds every other list on this page, so a
    // bar, a deadline and an Open button all behave here exactly as they do everywhere else.
    tgt.innerHTML = todaysRows(s).filter(r => stepIds.includes(r.id))
      .map(r => rowHtml(r, liveRowId(s))).join("");
    return;
  }

  const rows = todaysRows(s);

  // ---- Locked list / allow-list gate, and the fallback when we couldn't ask ----
  const hasTargets = info ? info.hasTargets : rows.length > 0;
  if (!rows.length && !hasTargets) {
    if (lead) {
      // The headline above already names the site, so this only says what's wrong.
      lead.innerHTML = `It's on your locked list, but there's no work set for today — so there's nothing to finish and nothing to open it.`;
    }
    if (unlockTitle) unlockTitle.innerHTML = "⚠️ Nothing to finish yet " + infoTip("This site is in your <b>Locked</b> list, and that list opens when today's work is done. But you haven't set any work, so there's nothing to finish and it stays locked.<br/><br/>Add a site in <b>Settings → Earn &amp; Unlock</b>.");
    tgt.innerHTML = `
      <div style="color:#cbd5e1;font-size:13px;line-height:1.7">
        📚 Your work list is empty — add something to do in <b>Settings → Earn &amp; Unlock</b>.
      </div>`;
    return;
  }
  if (!rows.length) {
    if (lead) lead.innerHTML = `There's no work set for today, so nothing can open this site yet.`;
    tgt.innerHTML = '<div style="color:#64748b">Nothing to finish is set up. Open Settings → Earn &amp; Unlock to add some.</div>';
    return;
  }
  // ---- Blocked because a deadline went by, not because the hours are short ----
  //
  // Not a branch of its own: it is the same screen, the same list and the same rows, with the one
  // sentence that was missing. Splitting it off would mean a second copy of the row rendering, and the
  // rows are what you need here — the miss is marked on whichever one it belongs to.
  //
  // `dataset.set` was a write-once guard, and it had to learn a second state. paint() runs again every
  // five seconds and on every storage change, so a title written once could be the wrong one for the
  // rest of the day: a window can close while this very page is open, and finishing another goal can
  // take the blame off a missed row again. Keying the guard on WHICH title is showing lets it move
  // both ways instead of latching.
  const miss = missInfo(s);
  if (miss.rows.length) {
    if (heading) heading.innerHTML = headHtml("— window missed");
    if (lead) lead.innerHTML = missLeadHtml(miss.rows, s.dailyResetTime || "00:00", miss.doomed);
    if (unlockTitle && unlockTitle.dataset.set !== "miss") {
      unlockTitle.innerHTML = "⏰ Missed today's window " + infoTip(
        "One of the goals below had to be finished <b>between two times</b>, and that window has gone.<br/><br/>" +
        "<b>Your time was not thrown away.</b> Every second you put in is still on the bar — the window " +
        "decides whether finishing <i>buys</i> anything, not whether it is recorded.<br/><br/>" +
        "Nothing you do to that goal today will unlock this site: its hours are fixed, and the day's " +
        "stamp is already set. It starts fresh at your daily reset.<br/><br/>" +
        "If the hours were wrong rather than the day, change them in <b>Settings → Earn &amp; Unlock</b> " +
        "on that goal, under <b>🎛️ Site rules</b>. Making a window longer is a loosening, so it asks " +
        "for your password.");
      unlockTitle.dataset.set = "miss";
    }
  } else {
    if (unlockTitle && unlockTitle.dataset.set !== "1") {
      unlockTitle.innerHTML = "Finish this to unlock " + infoTip("Finish <b>all</b> of the pages below. They're in the order you arranged them in Settings, and this page sends you back on its own when you're done.");
      unlockTitle.dataset.set = "1";
    }
    if (lead) lead.innerHTML = leadHtml(rows);
  }
  const liveId = liveRowId(s);
  tgt.innerHTML = rows.map((r, i) => {
    const connector = i > 0 ? `<div class="blocked-logic-row"><span class="blocked-logic-tag ${r.operator === "OR" ? "or" : "and"}">${r.operator || "AND"}</span></div>` : "";
    return connector + rowHtml(r, liveId);
  }).join("");
}

// One-line messages, bottom centre. Only used where a click has something to
// explain — every other button on this page either goes somewhere or does nothing.
let toastTimer = 0;
function toast(html) {
  document.querySelectorAll(".toast").forEach(t => t.remove());
  const el = document.createElement("div");
  el.className = "toast";
  el.setAttribute("role", "status");
  el.innerHTML = html;
  document.body.appendChild(el);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.remove(), 9000);
}

// Clicking a name (or its Open button) goes to the tab you already have open on
// it, and only opens a new one when there isn't one.
document.addEventListener("click", (e) => {
  // "Turn it on", inside the message the local-file button can end up showing.
  const allow = e.target.closest && e.target.closest("[data-open-ext-page]");
  if (allow) {
    e.preventDefault();
    try { chrome.tabs.create({ url: "chrome://extensions/?id=" + chrome.runtime.id }); } catch {}
    return;
  }
  // A file we only know the name of, so there is no address to follow. The background goes to the
  // tab you already have that file open in, and only falls back to Chrome's file listing when
  // there isn't one — clicking through to the file once is what teaches FocusGate its full
  // address, after which this button becomes an ordinary link.
  //
  // The listing address itself is chosen there, per platform — see browseRootUrl. This button used
  // to navigate to a bare "file:///", which on Windows answers with ERR_TOO_MANY_REDIRECTS rather
  // than a listing.
  const find = e.target.closest && e.target.closest("[data-find-local]");
  if (find) {
    e.preventDefault();
    const id = find.getAttribute("data-open-id") || "";
    try {
      chrome.runtime.sendMessage({ type: "browseLocal", id, pattern: "" }, (r) => {
        void chrome.runtime.lastError;
        if (r && r.ok && r.focused) return;                  // you're already there
        if (r && r.ok) return toast("Click through to your file — FocusGate will remember exactly where it is.");
        if (r && r.reason === "noFileAccess") {
          return toast(`Chrome is hiding your files from FocusGate. Turn on <b>Allow access to file URLs</b> on its extension page. <button class="tbtn" type="button" data-open-ext-page="1">Open that page</button>`);
        }
        toast("Couldn't open your files. Press <b>Ctrl+O</b> in a new tab and pick the file once.");
      });
    } catch {}
    return;
  }
  const a = e.target.closest && e.target.closest("a.tlink, a.go");
  if (!a) return;
  if (e.ctrlKey || e.metaKey || e.shiftKey || e.altKey || e.button !== 0) return;
  e.preventDefault();
  try {
    chrome.runtime.sendMessage({
      type: "openTarget",
      id: a.getAttribute("data-open-id") || "",
      pattern: a.getAttribute("data-open-pattern") || "",
      url: a.getAttribute("data-open-url") || a.getAttribute("href") || ""
    }, () => void chrome.runtime.lastError);
  } catch {}
});

(async () => {
  let s = {};
  try { s = await chrome.storage.local.get(null); } catch { return; }
  INFO = await getBlockInfo(fromUrl);
  paint(s);

  // Go back the moment this page has no reason to exist any more — FocusGate
  // switched off, the work list emptied, the day finished. The background sends
  // tabs back too; this is the same question asked from this side, so whichever
  // notices first wins and there's no wait either way.
  let left = false;
  const tryRecover = () => {
    if (left || !fromUrl) return;
    if (!extensionAlive()) { stopLive(); return; }
    try {
      chrome.runtime.sendMessage({ type: "checkBlocked", url: fromUrl }, (r) => {
        void chrome.runtime.lastError;
        if (!r || !r.ok || r.blocked !== false) return;
        left = true;
        // The browser takes the tab back to the site, rather than this page
        // replacing itself. A document that replaces itself hands its own
        // Content-Security-Policy to whatever loads next, and FocusGate's rules
        // landing on a website block every script that site owns — it would open
        // visibly broken. Replacing ourselves stays as the fallback.
        try {
          chrome.runtime.sendMessage({ type: "navigate", url: fromUrl }, (res) => {
            if (chrome.runtime.lastError || !res || !res.ok) location.replace(fromUrl);
          });
        } catch { location.replace(fromUrl); }
      });
    } catch {}
  };

  // Live: the bars move as you earn, and mode/list changes trigger immediate recovery.
  const LIVE_KEYS = [
    "productiveSites", "activeTargetId", "activeTargetAt", "enabled",
    "blockMode", "blockedSites", "allowedSites", "allDoneCelebratedOn",
    // The AI category lists, so switching a category off from the settings page releases this tab at once
    // rather than on the next four-second poll — the same treatment the two typed lists get.
    "aiCatEnabled", "aiCatBlock", "aiCatAllow"
  ];
  let paintTimer = 0, beat = 0, recheck = 0, grace = 0;
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (!LIVE_KEYS.some(k => k in changes)) return;
    // Any change to blocking mode, targets, or lists can immediately unlock tabs,
    // so recover instantly with zero delay instead of waiting for a 4s poll.
    tryRecover();
    clearTimeout(paintTimer);
    paintTimer = setTimeout(async () => {
      try { paint(await chrome.storage.local.get(null)); } catch {}
    }, 150);
  });

  // Direct wake-up message from options page or background script for instant unlock
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg && (msg.type === "unlockCheck" || msg.type === "refreshBlockedTabs")) {
      tryRecover();
    }
  });
  // The "working on this now" tag has to fade by itself when you stop, and that
  // isn't a storage change — so give it a slow heartbeat too.
  beat = setInterval(async () => {
    if (!extensionAlive()) { stopLive(); return; }
    try { paint(await chrome.storage.local.get(null)); } catch {}
  }, 5000);

  // ---- the time-limit countdown, once a second -------------------------------------------------
  //
  // Its own ticker rather than running the heartbeat above at 1000ms, and the difference is not
  // efficiency for its own sake. That one reads the WHOLE of storage and rebuilds the entire list's
  // innerHTML; at five seconds that is invisible, and at one second it would be a page that throws away
  // and re-creates every row you are looking at once a second — which drops any text you had selected,
  // restarts the logo fade-ins, and makes a mid-click button vanish under the pointer.
  //
  // This touches one figure per row and nothing else. It also needs no state at all: a deadline is a
  // fixed instant, written into the element as a number when the row was drawn, so the countdown is
  // arithmetic on the clock. The five-second repaint stays as the thing that corrects it — if the goal
  // changes, the deadline moves with it and the next full paint rewrites the number.
  //
  // Hitting zero asks for a full repaint straight away, because that is the moment the row stops being a
  // countdown and becomes a failure: the badge, the red styling and the headline all have to change, and
  // waiting up to five seconds to say so would leave the page counting down past a deadline it had
  // already missed.
  function tickGrace() {
    const els = document.querySelectorAll("[data-gtick]");
    if (!els.length) return false;
    const F = self.FGSettings;
    let expired = false;
    els.forEach(el => {
      const end = Number(el.getAttribute("data-gtick")) || 0;
      if (!end) return;
      const left = Math.max(0, Math.round((end - Date.now()) / 1000));
      if (left <= 0) { expired = true; return; }
      const txt = "⏳ " + (F && F.fmtDur ? F.fmtDur(left) : fmt(left)) +
                  " until " + (el.getAttribute("data-gend") || "");
      if (el.textContent !== txt) el.textContent = txt;
    });
    return expired;
  }
  grace = setInterval(async () => {
    if (!extensionAlive()) { stopLive(); return; }
    if (!tickGrace()) return;
    // One of them ran out. Repaint from storage so the row changes what it SAYS, not just its figure,
    // and ask the worker as well: a blown limit can be what finally settles whether this tab is going
    // anywhere today.
    try { paint(await chrome.storage.local.get(null)); } catch {}
    tryRecover();
  }, 1000);

  // A slow backstop, for anything that changes without touching storage.
  recheck = fromUrl ? setInterval(tryRecover, 4000) : 0;

  // Nothing left to ask once the extension has been reloaded under us: the timers
  // stop instead of throwing into the console every few seconds. Reloading this
  // page brings it back.
  function stopLive() {
    if (beat) { clearInterval(beat); beat = 0; }
    if (recheck) { clearInterval(recheck); recheck = 0; }
    if (grace) { clearInterval(grace); grace = 0; }
  }
})();
