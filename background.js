// FocusGate background service worker
// Handles: time tracking, blocking, badge, daily reset, password gating

// The copies FocusGate keeps of picked files. Needed here for two things only: recognising
// viewer.html as time on a target, and deleting a copy once its target is gone.
try { importScripts("filestore.js"); } catch {}
// Which keys are settings, and which are bookkeeping. The settings page has always loaded this;
// the worker needs it too now, for the one job that has to know the difference — putting
// everything back to how it shipped. Separate try from the line above so a failure in one does
// not cost the other.
//
// It is written to run in both: plain functions over plain objects, no chrome.* anywhere.
try { importScripts("settings.js"); } catch {}
// "Is this page actually about what you said you'd study?" — the prompt, the request, the caps and the
// subtitle parsing. Loaded here because this is the side that makes the call, and by the settings page
// because that is the side that has to describe it; one definition, so the screen cannot promise
// something different from what is sent. Its own try for the same reason as the two above.
try { importScripts("aicheck.js"); } catch {}

const DEFAULTS = {
  passwordHash: null,
  passwordProtectionEnabled: true,
  productiveSites: [],
  // Is the list above a sequence or a set?
  //
  // Off, which is the behaviour every existing profile already has: the rows are a set of things owed
  // today and you may spend the hours on them in whatever order suits you. On, the order you dragged
  // them into becomes the rule — one step open at a time, the finished ones shutting behind you. See
  // sequenceBlock below and currentStepIndex in settings.js.
  sequenceMode: false,
  blockedSites: [],
  allowedSites: [],
  blockMode: "blacklist",
  dailyResetTime: "00:00",
  lastResetDate: "",
  enabled: true,
  sessionUnlocked: false,
  // Auto-lock
  autoLockDelaySec: 0, // 0 = immediate on popup close
  fullPageLockEnabled: false,
  // Strict mode, part one: a daily freeze. Settings lock between these two clock times
  // and lift again each morning.
  // The defaults match what the settings card offers and what strict.js falls back to —
  // all three used to disagree. The card showed 15:00 → 08:00, these said 00:00 → 00:00,
  // and a window that starts and ends together never opens: strict mode could read as
  // armed on the page while the guard answered "not now".
  strictModeEnabled: false,
  strictStart: "15:00",
  strictEnd: "08:00",
  // Strict mode, part two: a deadline. Strict stays on continuously — day and night, not
  // just inside the window above — from now until this moment. It does not lift, so
  // nothing can be loosened before it expires, including either of the two switches.
  // Works on its own; it does not need the daily freeze.
  // The date can sit here unused while the switch is off, which is what lets the boxes
  // remember what you last picked instead of opening blank every time.
  strictUntilEnabled: false,
  strictUntil: "",
  // 23:59 rather than 00:00, so "until the 21st" means the whole of the 21st.
  strictUntilTime: "23:59",
  // Gamification
  xp: 0,
  level: 1,
  streakCount: 0,
  lastStreakDate: "",
  // The big "everything is finished" celebration fires once a day. This is the
  // day it last fired, so re-opening a page doesn't replay it.
  allDoneCelebratedOn: "",
  // ---- what the video gate has actually turned away ----
  //
  // A running tally, and it exists because the cover over a refused player says "you have been saved N
  // minutes" and that sentence has to be TRUE. A figure worked out on the spot from the video's length
  // would be a guess dressed as a statistic — and a guess is exactly the wrong thing on a screen whose
  // whole job is to be believed when it refuses you something.
  //
  // Counted once per video, when its verdict first settles as off-topic while the gate is on. The seconds
  // are that video's own duration as the page reported it, so a video with no readable duration adds to
  // the count and not to the clock rather than adding a made-up number to both.
  //
  // ALL-TIME, deliberately not reset at the day boundary: the point of it is the total, and a number that
  // goes back to zero every morning is a number nobody ever sees get big. Both are in EXCLUDED in
  // settings.js — measured, never configured, and never restored from a backup file.
  vidSkipCount: 0,
  vidSkipSec: 0,
  // MacroDroid mobile app-blocking bridge
  macrodroidEnabled: false,
  macrodroidLockUrl: "",   // webhook fired when goals NOT yet met (block phone apps)
  macrodroidUnlockUrl: "", // webhook fired when ALL goals met (release phone apps)
  mobileLockSent: null,    // last lock state pushed to phone (true=locked,false=unlocked)
  // A break the user asked for, from the card on the page or the popup. Nothing is
  // credited while it's on and the camera is released. It is not an anti-cheat
  // setting: pausing can only ever cost you time.
  userPaused: false,
  // Anti-cheat: time only counts while something is actually playing on the page —
  // a lecture, a video course. For targets where the work *is* watching, an open
  // tab proves nothing. Muted playback doesn't count (that's usually an ad loop or
  // a background video), and neither does a page with no media on it at all.
  mediaPlayingRequired: false,
  // Anti-cheat: pause the productive timer when the user is inactive
  inactivityPauseEnabled: false,
  inactivityTimeoutSec: 30,
  // Anti-cheat: require a detected face at the camera for the timer to run
  faceDetectionEnabled: false,
  // (there used to be a "wait this long after losing your face" number here. The
  // camera check stops the clock the moment it loses you, so nothing reads it now.)
  // How hard the camera tries to find you: 1 = strict (needs a clear, well-lit
  // face), 5 = forgiving (keeps hold of you in poor light or at an angle).
  // Read by facecam.js, where it becomes the pico quality bar.
  faceSensitivity: 3,
  // Anti-cheat: eyes open and pointed at the screen, not just a face in frame.
  // 1 = strict (a quick glance aside stops the clock), 5 = only obvious looking
  // away.
  eyeTrackingEnabled: false,
  eyeSensitivity: 3,
  // Live markers drawn over the camera preview (face box + a dot per eye). Only a
  // view of what the detector sees; the 👁 button on the preview toggles it.
  camOverlayEnabled: true,
  // How wide the camera preview is drawn, in real screen pixels. Height follows at 4:3, and the
  // floating card is sized to match — see CAM_MIN/CAM_MAX and camBox() in content.js.
  //
  // Adjustable because there is no one right answer: the preview sits on top of whatever page you
  // are working on, so a box big enough to aim by on a laptop is in the way on a small window, and
  // somebody who wants to actually watch themselves work wants it much bigger than either. It
  // costs nothing to move — the detector reads the camera stream at its own resolution, so this
  // changes what you can see and nothing about what the checks can.
  camSizePx: 134,
  // Anti-cheat: the browser window must fill the screen (maximised or F11 full
  // screen) AND be the focused app. Stops "shrink Chrome to half the screen,
  // leave the work page showing at your face, use something else beside it".
  fullscreenOnlyEnabled: true,
  // Anti-cheat: the work page must have the whole window, not half of it. A
  // maximised window passes the check above even when the browser is showing two
  // tabs side by side (Chrome's split view, Edge's split screen) or DevTools is
  // docked beside the page — so the page's own width is measured too.
  splitViewBlockEnabled: true,
  // Short beep when the camera loses you, and a brighter one when it finds you.
  soundEffectsEnabled: true,
  // A glow around the edge of the work page: green while time is counting, red while
  // something is stopping it. The camera window's counterpart in the Anki extension
  // outlines Anki's own window; here the thing being worked in IS the page, so the
  // page is what gets the edge. Off by default, unlike that one — an outline on
  // another application's window is a small thing, but this draws over whatever site
  // you are reading, so it should be asked for rather than assumed.
  pageGlowEnabled: true,
  // Whenever the clock stops — face gone from the camera, window not full screen, a
  // break, an idle timeout — whatever is playing on the work page is paused too, and
  // started again once the clock runs. Without it, getting up leaves the clock
  // correctly frozen and the lecture running on to an empty chair: you come back to
  // a video twenty minutes further along and a timer that hasn't moved. The minutes
  // you can earn back, the part of the video that went past you can't.
  //
  // Ships OFF. It used to ship on, on exactly the reasoning above — the minutes can be earned
  // back and the part of the lecture that went past cannot. That still holds, and it is still why
  // the switch is worth having; what it does not justify is doing it to somebody who never asked
  // for it. Reaching into a page and stopping what is playing there is the most intrusive thing
  // FocusGate does, and the only one of its effects that lands on your media rather than on its
  // own clock. So it is opted into, like the glow and the camera.
  mediaPauseEnabled: false,
  // And start it again once every condition is satisfied — you look back at the camera,
  // the window goes full screen again, the break ends. Off means the clock comes back
  // but you press play yourself.
  //
  // Ships OFF with its parent, which is the only value that makes sense for it: this is the other
  // half of the switch above and does nothing whatsoever on its own. On by itself it would be a
  // switch reading "on" that can never fire.
  mediaResumeEnabled: false,
  // How far the video is wound back as it pauses. The last few seconds before you
  // looked away were played, not taken in, so resuming exactly where it stopped
  // means resuming into a gap. 5 is about one sentence of a lecture; 0 means "pause
  // where it is and don't move".
  mediaRewindSec: 5,
  // Live "why isn't my timer moving" status for the popup ("" = it is running)
  timerPauseReason: "",
  timerPauseAt: 0,
  // How long the clock has been stopped, and how much of today has gone that way.
  //
  // timerPauseReason above answers "why", which was never the whole question: "no face" tells you
  // nothing about whether you looked away for four seconds or for half an hour, and half an hour
  // is the thing worth knowing. So the stretch gets a start stamp, and the day gets two totals.
  //
  // Two rather than one, because the two kinds of stopped time are not the same fact about your
  // day. A break is a decision you made; everything else is the checks refusing to credit you —
  // looking away, the window losing focus, the video paused. Added together they would hide
  // exactly the distinction you would open the popup to see.
  pauseSinceAt: 0,
  pausedTodaySec: 0,
  breakTodaySec: 0,
  // The target that last earned a second, so any page can point at the one you're
  // actually working on right now.
  activeTargetId: "",
  activeTargetAt: 0,
  // Anti-cheat: the head-movement check (defeats a held-up photo).
  //
  // No longer a challenge on a schedule. The deadline slides forward every time you move, so
  // working normally never trips it and a photograph trips it once and stays tripped. Ten
  // seconds, down from three minutes: the old interval was so long that nobody discovered the
  // check worked or what it was for, and the reason it had to be that long was that the old
  // version demanded a lean left AND a lean right, which was often impossible to perform.
  // Any movement clears it now, so it can afford to ask often.
  livenessEnabled: false,
  livenessIntervalSec: 10,
  // How much counts as moving: 1 wants a real shift of position, 5 takes almost anything.
  moveSensitivity: 3,
  // How long you may look away before the eye check stops the clock. Its own setting rather
  // than a number buried in the eye-sensitivity table: what counts as looking away and how
  // long you may do it for are two different questions, and one dial cannot answer both.
  eyeAwaySec: 10,
  // Blink at least this often. The strongest liveness signal a webcam can get — a photo
  // cannot blink at all, and a looping video blinks on a schedule — so it ships available
  // but off, like the eye check, because it is stricter than most people want by default.
  blinkRequired: false,
  blinkIntervalSec: 10,
  // How much of a dip from your own open-eye reading counts as an eyelid: 1 wants an
  // unmistakable blink, 5 takes a flicker.
  blinkSensitivity: 3,
  // ---- the timer speed ----
  // Every other camera setting here answers "does this second count". This one answers "how
  // fast", and it is the only setting in FocusGate that does: fill the dashed box on the camera
  // preview with your head and the clock runs at paceFast, sit back out of it and it drops to
  // paceSlow. Leaning in is the whole gesture — the box is a target you put your face in.
  //
  // Off by default, and it has to be: it is the one switch that can credit a second faster than
  // a second passes, so it is opted into rather than sprung on someone whose goal would then
  // finish early without them asking for it.
  paceEnabled: false,
  // Head inside the box, and outside it. Not clamped to either side of 1 on purpose — both are
  // free across the whole range, so "1.5 in the box and 1 out of it" is a pure bonus with no
  // penalty, "1 in and 0.5 out" is a pure penalty with no bonus, and the two dials cover every
  // arrangement between. They are read as a min/max pair where they are used, so crossing them
  // over behaves like the range it looks like rather than inverting.
  paceFast: 1.5,
  paceSlow: 0.5,
  // How big the box is, as a percentage of the shorter side of the picture. Bigger box = your
  // head has to fill more of the frame = you sit closer. Read by facecam.js, which is where the
  // geometry lives.
  paceBoxPct: 55,

  // ---- is this page actually about what you said you would study? ----
  //
  // A target is an ADDRESS, and being at an address is all FocusGate has ever been able to check. That
  // is enough for a PDF and nowhere near enough for a video site: the channel you nominated because it
  // teaches linear algebra also has a podcast, a Q&A and an hour of bloopers, and every second of those
  // counted towards your maths goal. The rule was satisfied and the intention was not.
  //
  // So every target can now carry a TOPIC — what you actually meant to do there, in your own words —
  // and with this on, a language model judges the page in front of you against that row's topic. Time
  // counts while you are on the topic and stops while you are not.
  //
  // Off by default, and it has to be: it is the only thing in this extension that sends anything off
  // this machine besides the MacroDroid webhook, and what it sends is what you are reading.
  aiTopicEnabled: false,
  // Your own Gemini API key. A SECRET — see EXCLUDED in settings.js: it never travels in a settings
  // backup, for the same reason the password hash does not.
  aiTopicKey: "",
  // Which model answers. Picked from a short list on the settings page, with a box for typing one that
  // is not on it — model names are Google's to retire, and this extension cannot ship an update the day
  // one goes away.
  //
  // A LITE model by default, and it is the opposite of what the sibling Anki extension picks. Free-tier
  // Gemini is metered per model per day: the full Flash models allow about 20 requests and the Lite ones
  // about 500. This feature asks one question per page you open on a work site, so 20 is twenty pages
  // and then nothing for the rest of the day — and because the check fails open, "nothing" means every
  // page counts again. Weaker judgement all day beats perfect judgement until mid-morning. See
  // FGAi.GEMINI_MODELS, where the trade is spelt out on each option.
  aiTopicModel: "gemini-3.5-flash-lite",
  // How on-topic a page has to be, as a percentage. 50: more than half a match counts, less does not.
  //
  // Lowering it means MORE pages count towards your goal, so lowering is the loosening — see STRICTER.
  aiTopicMinPct: 50,
  // How deeply to look: "title" | "details" | "video". See FGAi.MODES for what each one reads and what
  // it costs. "details" by default, because a title is the one part of a page written to be clicked
  // rather than to be accurate, and judging a forty-minute lecture by its headline when the subtitles
  // are right there is answering an easier question badly.
  aiTopicMode: "details",
  // Which of the extras "details" mode reads. All on; the two page-side ones are free, and the
  // subtitles need their own permission, which is asked for when they are switched on.
  aiTopicScope: { description: true, tags: true, transcript: true },
  // Only videos about your topics. The half that makes a topic mean something OFF your work sites.
  //
  // A target is an address, so a topic written on one could only ever govern that address — and the site
  // you actually need keeping off is the one you never listed. With this on, every YouTube video is judged
  // against the union of your live topics: about one of them, it plays; about none of them, it is blocked
  // like any other distraction, until today's work is done.
  //
  // ON by default, and it is safe to be, because it is dead until two other things are true: the master
  // switch above, and at least one row carrying a topic. Nobody who has not typed a sentence can be
  // affected by it — see videoGateActive, where that is the last condition rather than an afterthought.
  //
  // Scope is deliberately narrow. VIDEOS, and only on YouTube: the home feed, search and channel pages
  // stay governed by your blocked list exactly as before. Gating every page on the web against a topic is
  // a far larger promise, and it would put a model between you and any address you type.
  aiTopicVideoGate: true,
  // ---- earn your study time by watching videos ABOUT your subject ----
  //
  // The other direction of the gate above. That one decides what YouTube will let you WATCH; this decides
  // what watching it EARNS. With it on, a video the gate finds is about one of your topics credits time to
  // the very card whose topic it matched — exactly as if you had spent that time on the site itself. Watch
  // twenty minutes of a German lesson and the "German — 30 min" card is twenty minutes closer to done,
  // whether or not youtube.com is a site you ever nominated as work.
  //
  // OFF by default, unlike the gate, and the asymmetry is deliberate: blocking a distraction is safe to
  // ship on, but CREDITING time is a claim about work done, and it should be opted into rather than sprung
  // on somebody whose goal would then start finishing itself from a tab they left playing. It also leans on
  // the same per-card time WINDOW as everything else — a card with a window only earns from YouTube inside
  // it, which is how you say "German counts from six to nine, and only then".
  //
  // Which card gets the second is answered by the model itself: see the `w` index in FGAi.ask and
  // videoEarnTarget, which maps it back to the row that owns the matched topic. Only ever CREDITS on the
  // video's own watch page — a video playing on in the miniplayer while you read the feed is covered if it
  // is off-topic (that is the gate) but earns nothing, because reading the feed is not watching it.
  aiTopicVideoEarn: false,
  // Hold the clock while the model is still deciding, instead of letting the seconds count and stopping
  // once the answer lands.
  //
  // OFF, and this is the one setting here where the two answers are both defensible, so the reasoning
  // matters. Every verdict is cached per (topic, page), so "deciding" happens once per video — a few
  // seconds, the first time you open it. Holding the clock through that means every legitimate video
  // you open starts by refusing to pay you, which is friction pointed at the person doing the work.
  // Letting it run means a deliberate cheat — open a video, take five seconds, open another — can
  // collect a trickle of time.
  //
  // Off is the right default because the cheat is laborious and self-defeating while the friction lands
  // on everybody, every time. It is a switch rather than a decision because somebody who knows they
  // will do exactly that to themselves should be able to shut it.
  aiTopicStrict: false,
  // Off-topic pages don't just stop earning — they get taken away, like a blocked site.
  //
  // OFF, and this one is not a close call. Stopping the clock is a statement about what counts;
  // redirecting the tab is taking a page off somebody, and the page in question is on a site THEY
  // nominated as work. A model that has misread a lecture should cost you a stopped clock you can see
  // and argue with, not the page you were reading. On for anybody who wants the harder version.
  aiTopicBlocks: false,

  // ---- whole categories of site, decided by asking ----
  //
  // The other half of the category picker on the settings page. The chips there write ordinary domains
  // into blockedSites; these hold CATEGORY IDS, and every site you visit is classified against them.
  //
  // Both exist because a list of hand-typed domains can only ever be the domains somebody thought of.
  // Fifteen social networks is not "social media" — it is fifteen doors shut in a corridor with no walls,
  // and the one reached for at 1am is the sixteenth.
  //
  // OFF by default, and it has to be: it shares the key and the daily allowance with the topic check, and
  // it is the only feature here that can take away a site the user never named.
  aiCatEnabled: false,
  // Category ids to block, and to allow. Empty lists mean the feature is inert however the switch is set —
  // see aiCatReady, where that is the last condition rather than an afterthought.
  aiCatBlock: [],
  aiCatAllow: [],
  // The classifier's answers, kept across worker restarts: { "<host>": { c: [ids], r: reason, at: ms } }.
  //
  // IN STORAGE, unlike the topic cache, and the difference is the whole economics of the feature. A topic
  // verdict is about one page and is worth re-deciding; a category is a property of a DOMAIN — "youtube.com
  // is a video site" does not stop being true — so re-asking after every worker eviction would burn a free
  // daily allowance on questions already answered. One question per domain, once, is what makes this
  // affordable at all.
  aiCatSeen: {}
};
const AUTO_LOCK_ALARM = "focusgate_autolock";
let openPortCount = 0;

// ---------- helpers ----------
// The day boundary, remembered from the last read.
//
// activeTargets below has to know what weekday it is, and "what weekday" depends on the user's own
// reset time — a boundary of 04:00 means two in the morning still belongs to yesterday. But
// activeTargets is called from nine places, several of which are handed a list of sites and no
// state at all, so threading the boundary through all of them would mean changing every signature
// on the way.
//
// Caching it here is safe because nothing can reach activeTargets without having called getState
// first: the sites it filters come out of that same call. The only value it can ever hold is the
// stored one or the shipped default, and those agree until the user changes it.
let dayBoundary = DEFAULTS.dailyResetTime;
async function getState() {
  const s = await chrome.storage.local.get(null);
  const out = { ...DEFAULTS, ...s };
  dayBoundary = out.dailyResetTime || DEFAULTS.dailyResetTime;
  return out;
}
// Which weekday FocusGate is inside right now, as a getDay() number.
//
// Falls back to "every day is fine" if settings.js could not be imported — see the top of this
// file. That is the safe direction to fail in: the alternative is a failed import silently
// switching off every target whose schedule does not happen to include the fallback day.
function todayWeekday() {
  if (!self.FGSettings || !self.FGSettings.weekdayNow) return -1;
  return self.FGSettings.weekdayNow(dayBoundary);
}
async function setState(patch) {
  await chrome.storage.local.set(patch);
}
function todayStr() {
  const d = new Date();
  return d.getFullYear() + "-" + (d.getMonth()+1) + "-" + d.getDate();
}
// Does `url` fall under a block/allow list entry?
// An entry can be a bare domain or a deeper path
// ("drive.google.com/drive/my-drive" -> that page and anything under it, nothing
// else on the host).
//
// How WIDE a bare domain is depends on which list it is on — see hostMatches.
// `wide` defaults to true so every caller that has no opinion keeps the behaviour
// it always had. Only the allow list asks for narrow, and it asks in one place.
function urlMatchesPattern(url, pattern, wide = true) {
  if (!pattern) return false;
  const t = splitTarget(pattern);
  if (!t.host) return false;
  if (t.segs.length) return isAtOrUnderTarget(url, pattern, wide);
  // A pattern with a query but no path still has to honour that query. This used to
  // fall straight through to the bare host match below, so "youtube.com?v=abc" — a
  // rule written for one video — covered the whole of youtube.com. Wrong in both
  // directions: it over-blocks on the block list, and on the allow list it opens a
  // whole site when one page was asked for.
  if (t.params.length) return isAtOrUnderTarget(url, pattern, wide);
  return hostMatches(splitUrl(url).host, t.host, wide || t.wide);
}
function inAnyList(url, list, wide = true) {
  // Array.isArray, not `list || []`. If the stored list is ever anything but an array
  // — an older build's shape, a hand-edited profile, a half-finished write — then
  // `.some` throws, and this is called from the middle of the block decision. A throw
  // there does not degrade gracefully: enforcement stops and NOTHING is blocked any
  // more. Failing closed on a junk list is the only acceptable behaviour.
  return Array.isArray(list) && list.some(e => e && urlMatchesPattern(url, e.url, wide));
}

// ---------- path-aware target matching ----------
// A productive target can be a bare domain ("duolingo.com") or a deeper URL
// ("duolingo.com/lesson", "drive.google.com/drive/folders/ABC").
// Rule:
//   • The target URL itself and anything DEEPER counts as productive time.
//     e.g. target /lesson  ->  /lesson, /lesson/1, /lesson/1/x all count.
//   • Any SHALLOWER path on the same host (a parent of the target) gets blocked
//     until the day's targets are met, so you can't sit on the homepage.
//     e.g. target /drive/folders/ABC -> /drive/folders, /drive and the bare
//     host are blocked.
// Query strings and #fragments are ignored when comparing.
// Query string of a target, as [key, value] pairs. An exact page can therefore
// pin down "?v=abc" or "?id=7" instead of matching every page on that path.
function parseQuery(q) {
  return String(q || "").split("&").filter(Boolean).map(pair => {
    const i = pair.indexOf("=");
    const k = (i < 0 ? pair : pair.slice(0, i)).trim().toLowerCase();
    const v = (i < 0 ? "" : pair.slice(i + 1)).trim().toLowerCase();
    return [k, v];
  }).filter(([k]) => !!k);
}
// One host name, written the one way. Everything a browser treats as "the same site"
// has to collapse to the same string here, or the difference is a bypass.
//
// The trailing dot is the one that matters. "youtube.com." is a fully-qualified domain
// name for exactly the same site — DNS accepts it, Chrome loads it, the page is
// identical — but new URL().hostname keeps the dot, so it compared unequal to
// "youtube.com" and simply was not blocked. One extra character defeated the list.
function canonHost(h) {
  return String(h || "").trim().toLowerCase()
    .replace(/\.+$/, "")        // trailing dot(s): the FQDN spelling of the same host
    .replace(/^www\./, "");
}
function splitTarget(pattern) {
  const raw = String(pattern || "").trim().toLowerCase()
    .replace(/^https?:\/\//, "")
    .split("#")[0];
  const q = raw.indexOf("?");
  const beforeQuery = q < 0 ? raw : raw.slice(0, q);
  const query = q < 0 ? "" : raw.slice(q + 1);
  let [hostPart, ...rest] = beforeQuery.split("/");
  // A leading "*." asks for every subdomain, whatever the list would do on its own. It
  // is how you say "all of google.com" on the allow list, where a bare entry now means
  // that one site. On the block list it changes nothing, because that list is already
  // wide. Taken off before canonHost, so "*.www.google.com" still canonicalises.
  let wide = false;
  if (hostPart.startsWith("*.")) { wide = true; hostPart = hostPart.slice(2); }
  const host = canonHost(hostPart);
  // A single-label pattern is refused, because the subdomain rule would turn it into a
  // wildcard: "youtube.com" matching "m.youtube.com" is the same rule that makes "com"
  // match every .com site there is. normSite in options.js already turns such a thing
  // away, but matching must not depend on that — a value that arrived some other way
  // (an imported file, an older build, a hand-edited profile) should be inert rather
  // than catastrophic.
  const usable = host.includes(".") || host === "localhost" || /^\[.*\]$/.test(host);
  return {
    host: usable ? host : "",
    wide,
    segs: rest.join("/").split("/").filter(Boolean),
    params: parseQuery(query)
  };
}
function splitUrl(url) {
  try {
    const u = new URL(url);
    const params = new Map();
    u.searchParams.forEach((v, k) => {
      const key = k.trim().toLowerCase();
      if (!params.has(key)) params.set(key, String(v).trim().toLowerCase());
    });
    return {
      host: canonHost(u.hostname),
      segs: u.pathname.split("/").filter(Boolean).map(s => s.toLowerCase()),
      params
    };
  } catch { return { host: "", segs: [], params: new Map() }; }
}
// "www." is not a different site: google.com redirects to www.google.com and half the
// web answers to both, so an entry for one has to cover the other or the rule would
// depend on which spelling the address bar happened to use. canonHost already does
// this, and this is the same thing said again for a host that reached here raw.
const bareHost = (h) => String(h || "").replace(/^www\./, "");

// Does this host match the pattern's host?
//
// `wide` decides whether subdomains count, and the two lists want opposite answers.
// That is not an inconsistency, it is the rule the whole extension runs on: when in
// doubt, be stricter.
//
//   BLOCK list, wide: "keep this shut", so broader is safer. Block youtube.com and
//   m.youtube.com and music.youtube.com go with it, which is what anyone writing that
//   entry meant.
//
//   ALLOW list, narrow: "let this through", so narrower is safer. Allowing google.com
//   used to open gemini.google.com, keep.google.com and every other workspace on the
//   domain — one entry for a search engine quietly unlocked a day's worth of
//   distraction. Nobody asks for that by typing one address, and "allow" is the
//   direction where being wrong costs you the session.
//
// Either list can ask for the other behaviour explicitly with "*.google.com".
function hostMatches(host, target, wide) {
  if (!host || !target) return false;
  if (wide) return host === target || host.endsWith("." + target);
  return bareHost(host) === bareHost(target);
}

// ---------- local files (file:// targets) ----------
// A file on your own computer isn't a website: it has no host, only a path. So a
// local target is matched by path instead — "file:///D:/notes/physics.pdf", or a
// whole folder that holds a course.
// The same file can be written half a dozen ways (backslashes, %20 for a space,
// a drive letter in either case, a stray trailing slash), so both sides are
// reduced to one plain form before they're compared.
function isFileUrl(url) {
  return /^file:/i.test(String(url || "").trim());
}
// A local file being read inside SOMEBODY ELSE'S extension, and the file:// address it is showing.
//
// A PDF reader extension does not open the file at the file's own address. It opens a page of its
// own and puts the file in the query string:
//
//   chrome-extension://<its id>/viewer.html?file=file%3A%2F%2F%2FC%3A%2FUsers%2F…%2Fmanual.pdf
//
// That address is not a path, so every local-file check below used to answer no — the clock never
// started, the dot beside the target stayed red, and a file you were plainly sitting and reading
// earned nothing at all.
//
// Deliberately not tied to one extension id. A reader that names the file's own address is naming
// the file, and the file is the only thing the target was ever about; which program is drawing it
// on screen is not a question a target asks. It also means this keeps working if the user changes
// readers, which an id list would not.
//
// Returns "" for every other address — including FocusGate's own viewer, which carries a target id
// rather than a path and is answered by viewerTargetId instead.
//
// What this does NOT do is make the camera work there, and it cannot: Chrome does not allow one
// extension to run a script inside another extension's page, so there is nowhere on that page for
// the card, the preview or the stillness checks to live. Those targets are told so in as many
// words — see the refusal in localFileBeat — and the way through is FocusGate's own viewer.
const EMBED_FILE_KEYS = ["file", "url", "src", "path", "pdf", "doc", "target", "href"];
function embeddedFileUrl(url) {
  const s = String(url || "").trim();
  // Other browsers' extension schemes as well, since the rest of FocusGate already tolerates them.
  if (!/^(chrome|moz|edge|ms-browser)-extension:\/\//i.test(s)) return "";
  let u;
  try { u = new URL(s); } catch { return ""; }
  // The query first, then the #fragment: plenty of viewers keep their state in the hash instead.
  const pools = [u.searchParams];
  try { pools.push(new URLSearchParams(String(u.hash || "").replace(/^#/, ""))); } catch {}
  for (const pool of pools) {
    for (const k of EMBED_FILE_KEYS) {
      let v = "";
      try { v = pool.get(k) || ""; } catch {}
      if (!v) continue;
      // One extra decode, and one only. searchParams has already undone the viewer's own encoding;
      // a second round is for a viewer that encoded twice. A loop would keep going and eat the
      // %20s that belong to the path itself, which filePath decodes later and needs intact.
      if (!isFileUrl(v)) { try { v = decodeURIComponent(v); } catch {} }
      if (isFileUrl(v)) return v.trim();
    }
  }
  return "";
}
// The file:// address behind a tab, whichever way the file is being shown: straight off the disk,
// or inside a reader extension that named it. "" when the tab is not showing a local file.
function fileUrlOf(url) {
  const s = String(url || "").trim();
  return isFileUrl(s) ? s : embeddedFileUrl(s);
}
// Does what the user typed look like a path on this computer rather than a site?
//   file:///D:/x   ·   D:\notes\a.pdf   ·   C:/notes   ·   \\server\share\x   ·   /Users/me/a.html
function looksLocalPath(v) {
  const s = String(v || "").trim();
  if (!s) return false;
  if (/^file:/i.test(s)) return true;
  if (/^[a-z]:[\\/]/i.test(s)) return true;      // Windows drive letter
  if (/^\\\\/.test(s)) return true;              // \\server\share
  return /^\/[^/]/.test(s);                      // /Users/… , /home/…
}
// One plain form of a local path: lower case, forward slashes, spaces decoded,
// no protocol, no leading or trailing slash, no query or #fragment.
function filePath(v) {
  let s = String(v || "").trim().split("#")[0].split("?")[0];
  s = s.replace(/^file:\/*/i, "").replace(/\\/g, "/");
  try { s = decodeURIComponent(s); } catch {}
  return s.replace(/\/{2,}/g, "/").replace(/^\/+/, "").replace(/\/+$/, "").toLowerCase();
}
// The file's own name, for anywhere a whole path would be too long to read.
function fileLeaf(v) {
  const p = String(v || "").trim().split("#")[0].split("?")[0]
    .replace(/^file:\/*/i, "").replace(/\\/g, "/").replace(/\/+$/, "");
  let last = p.split("/").filter(Boolean).pop() || p;
  try { last = decodeURIComponent(last); } catch {}
  return last || "Local file";
}
// Does this pattern name a place on the disk, or only the tail end of one?
//
// A path picked from Chrome's own file dialog is always a tail. Chrome refuses to tell a page
// where a chosen file actually lives — a single file arrives as "physics.pdf" and a folder pick
// arrives as "notes/physics/ch1.pdf", relative to the folder you chose — so the leading drive or
// mount point is simply not knowable from there. What IS knowable is enough to recognise the file
// when it is opened later, which is all a target has to do.
function absLocalPath(v) {
  const s = String(v || "").trim();
  return /^file:/i.test(s) || /^[a-z]:[\\/]/i.test(s) || /^\\\\/.test(s) || /^\/[^/]/.test(s);
}
// Does `got` contain `want` as a run of WHOLE segments?
//
// Segment by segment rather than a string search, because a text match would let "notes/phys"
// match "…/notes/physics.pdf" — a target for a folder that does not exist quietly covering a file
// it was never meant to. Matching a run anywhere also gives folders their behaviour for free: if
// the run is found and the path carries on past it, the file is inside that folder.
function pathTailMatch(got, want) {
  const g = String(got || "").split("/").filter(Boolean);
  const w = String(want || "").split("/").filter(Boolean);
  if (!w.length || w.length > g.length) return false;
  for (let start = 0; start + w.length <= g.length; start++) {
    let all = true;
    for (let i = 0; i < w.length; i++) if (g[start + i] !== w[i]) { all = false; break; }
    if (all) return true;
  }
  return false;
}
// Is this local page the target file itself, or something inside the target folder?
// A folder therefore covers everything under it, exactly like a deep web target.
function fileCovers(url, pattern) {
  // Resolved once, here, rather than at each of the callers. This is the single place that turns an
  // address into a path, so a reader extension's page answering for the file it is showing is one
  // line — and matching, blocking, the badge and "is a tab open on this" all get it at once.
  const real = fileUrlOf(url);
  if (!real) return false;
  const want = filePath(pattern);
  if (!want) return false;
  const got = filePath(real);
  // A full path is anchored: it has to match from the start, so "d:/notes" cannot be satisfied by
  // "e:/backup/notes". This is the exact behaviour it always had, and it stays the strict case.
  if (absLocalPath(pattern)) return got === want || got.startsWith(want + "/");
  // A tail is all we have, so it is matched wherever it sits. Looser by necessity: two files with
  // the same name in different folders both count. That is the honest cost of a file dialog that
  // will not say where it picked from, and it is a target you chose for yourself rather than a
  // rule holding something back — so erring towards recognising it is the right way round.
  return pathTailMatch(got, want);
}
// Is `url` the target itself, or nested deeper inside it?
// Every query value the target pins down must match; extra params on the visited
// URL are ignored, so tracking/referrer junk doesn't break a match.
function isAtOrUnderTarget(url, pattern, wide = true) {
  // A local file has no host to compare, so it's judged by path. Checked first so
  // every caller below — matching, blocking, "is a tab already open on it" — gets
  // local files right without knowing about them.
  if (looksLocalPath(pattern) || isFileUrl(url)) return fileCovers(url, pattern);
  const t = splitTarget(pattern), u = splitUrl(url);
  if (!hostMatches(u.host, t.host, wide || t.wide)) return false;
  if (u.segs.length < t.segs.length) return false;
  if (!t.segs.every((seg, i) => u.segs[i] === seg)) return false;
  return t.params.every(([k, v]) => u.params.get(k) === v);
}
// When you commit to an exact page, the REST of that host is off-limits until
// you're done — not just the pages above it, but sibling branches too.
// Target  drive.google.com/drive/folders/ABC  therefore blocks:
//   drive.google.com            (parent)
//   drive.google.com/drive      (parent)
//   drive.google.com/drive/u/0/home  (sibling branch)
// while .../folders/ABC and anything under it still earns time.
// Which host does a target live on? Only targets that pin down one specific
// place lock the rest of their host. Channels and playlists are deliberately
// left out: their pages are spread all over youtube.com, so locking the host
// would block the very videos they're meant to let you watch.
// Local files are deliberately absent here too: a file on your disk has no host,
// so it never locks anything else.
function targetHost(s) {
  if (!s) return "";
  if (s.type === "youtube_video") return "youtube.com";
  if (s.type === "local_file") return "";
  if (s.type === "site") return looksLocalPath(s.url) ? "" : splitTarget(s.url).host;
  return "";
}
// Does the target name one page/video (as opposed to a whole site)?
function targetIsExact(s) {
  if (s.type === "youtube_video") return !!(s.videoId || "").trim();
  if (s.type === "site") {
    const t = splitTarget(s.url);
    return t.segs.length > 0 || t.params.length > 0;
  }
  return false;
}
// FocusGate's own copy of a picked file, open in viewer.html. Which target it belongs to is in the
// address — "viewer.html?t=<id>" — because there is nothing else to go on: a picked file has no
// drive in its path and therefore no file:// address of its own. See filestore.js for why a copy
// exists at all.
//
// Returns "" for every other address, and a target id is never "", so no ordinary page can be
// mistaken for one of these.
function viewerTargetId(url) {
  const s = String(url || "");
  let base = "";
  try { base = chrome.runtime.getURL("viewer.html"); } catch { return ""; }
  if (!base || !s.startsWith(base)) return "";
  try { return new URL(s).searchParams.get("t") || ""; } catch { return ""; }
}

// Is this URL inside the target's own area (so it earns time)?
function targetCovers(url, s) {
  if (s.type === "youtube_video") {
    const want = (s.videoId || "").trim();
    const got = youtubeVideoId(url);
    return !!want && !!got && want === got;
  }
  if (s.type === "local_file") {
    // Reading FocusGate's copy is reading the file. Checked first: the viewer's address is not a
    // path, so fileCovers can say nothing useful about it.
    if (viewerTargetId(url) === s.id) return true;
    return fileCovers(url, s.path || s.url);
  }
  return isAtOrUnderTarget(url, s.url);
}

// A target the user switched off (its icon clicked) is invisible to everything:
// it earns no time, it doesn't lock the rest of its own site, and it isn't part
// of "is today's work done?". Filtering here covers every caller below.
// A target with no time on it (0h 0m 0s) is treated the same way: 0 means "this
// doesn't count today".
//
// And so is a target whose weekday schedule doesn't include today. Putting it here rather than at
// each of the nine call sites is the entire implementation of that feature: a row that is not on
// today earns no time, does not hold the locked list shut, is not part of "is today's work done?",
// and is not in the badge's figure — all of which fall out of this one filter, because every one of
// those questions is already asked through it.
//
// Which also decides the case worth thinking about: if NO row is scheduled for today, this returns
// empty, and getBlockReason already treats an empty list as "nothing to earn, so nothing to lock".
// A Sunday with no work set is a Sunday off, not a Sunday with everything blocked and no way out.
function activeTargets(sites) {
  const day = todayWeekday();
  const onToday = day < 0
    ? () => true                                   // settings.js missing; see todayWeekday
    : (s) => self.FGSettings.onDay(s, day);
  return (sites || []).filter(s => s && s.enabled !== false && (s.requiredSec !== undefined && s.requiredSec !== null && !isNaN(s.requiredSec) && s.requiredSec >= 0) && onToday(s));
}

// The subset of today's targets the PHONE waits on.
//
// Deliberately narrower than activeTargets and used in exactly one place — syncMobileLock. Every
// other question ("does this page earn time", "is this tab locked", "what does the badge say")
// goes on asking activeTargets, because a row opting out of the phone changes nothing about the
// browser. Adding the filter to activeTargets itself would have quietly stopped such a row earning
// time at all, which is the opposite of what the switch is for.
//
// `!== false` so every row that predates the field, and every row nobody has touched, counts
// towards the phone exactly as it always did.
function phoneTargets(sites) {
  return activeTargets(sites).filter(s => s.webhookOn !== false);
}

// `step` is the rows of the current sequence step, or null when sequence mode is off. It changes
// nothing about WHETHER this blocks — only which of the host's rows gets named as the way out. See the
// tail of the function.
function findOffTargetBlocked(url, sites, step) {
  if (!url) return null;
  const host = splitUrl(url).host;
  // Only targets that live on this same host, and are switched on, have a say.
  // `true`: a work target you set on a bare domain covers its subdomains, and always
  // has. Narrowing is the allow list's rule, not this one — a target is something you
  // chose to spend time on, not a hole in the blocking.
  const onHost = activeTargets(sites).filter(s => {
    const h = targetHost(s);
    return !!h && hostMatches(host, h, true);
  });
  if (!onHost.length) return null;

  // Allowed if ANY target on this host covers the URL — a bare-domain target
  // opens the whole site, and multiple exact pages each keep their own area.
  for (const s of onHost) {
    if (!targetIsExact(s)) return null;      // whole-site target
    if (targetCovers(url, s)) return null;   // inside a target area
  }
  // Off-target on a host you committed to. Report the first unfinished target
  // so the blocked page can point the user at the right place.
  const unfinished = onHost.filter(s => (s.spentSec || 0) < (s.requiredSec || 0));
  if (!unfinished.length) return null;
  // Under sequence mode, prefer one this host has in the CURRENT step.
  //
  // "The right place" acquires a second condition once the list is ordered, and without this the page
  // has a button that cannot work. Picture khanacademy.org/math/algebra as step three and the user on
  // khanacademy.org: they are off-target, so this fires, and the old answer named the algebra page —
  // which sequenceBlock then refuses, sending them back to the screen they just came from. A blocked
  // page whose own way out is blocked is worse than no advice at all.
  //
  // Only a re-ordering of candidates, never a change of verdict: if this host has no row in the current
  // step the original answer stands, because the page still has to explain why the homepage is shut and
  // naming nothing would explain nothing.
  if (step && step.length) {
    const inStep = unfinished.find(s => step.some(t => t === s || (t && t.id && s.id && t.id === s.id)));
    if (inStep) return inStep;
  }
  return unfinished[0];
}

// The video a YouTube URL is playing, in every shape YouTube uses:
//   youtube.com/watch?v=ID · youtu.be/ID · /shorts/ID · /embed/ID · /live/ID
// Returns "" when the URL isn't a single video.
function youtubeVideoId(url) {
  try {
    const u = new URL(url);
    const host = u.hostname.toLowerCase().replace(/^www\./, "").replace(/^m\./, "");
    if (host === "youtu.be") return (u.pathname.split("/").filter(Boolean)[0] || "");
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

// Returns matching productive site entry for a URL (handles youtube channel/playlist)
function findProductiveMatch(url, sites) {
  if (!url) return null;
  for (const s of activeTargets(sites)) {
    if (s.type === "local_file") {
      // A file on this computer, opened in Chrome — either straight from the disk, or as the copy
      // FocusGate kept when you picked it. A folder target covers every file inside it, so a whole
      // course can be one row. targetCovers answers all three.
      if (targetCovers(url, s)) return s;
    } else if (s.type === "site") {
      // Bare domain => whole site counts. Deeper URL => that page and below.
      if (isAtOrUnderTarget(url, s.url)) return s;
    } else if (s.type === "youtube_video") {
      // One specific video and nothing else — playlists, autoplay and the next
      // video in the queue all stop the clock.
      const want = (s.videoId || "").trim();
      const got = youtubeVideoId(url);
      if (want && got && want === got) return s;
    } else if (s.type === "youtube_channel") {
      try {
        const u = new URL(url);
        if (u.hostname.includes("youtube.com") || u.hostname.includes("youtu.be")) {
          // We'll match by path containing channel handle/ID; content script reports actual channel
          // Rough URL match
          const handle = (s.channelId || s.url || "").toLowerCase();
          if (handle && (u.pathname.toLowerCase().includes(handle) || u.href.toLowerCase().includes(handle))) {
            return s;
          }
        }
      } catch {}
    } else if (s.type === "youtube_playlist") {
      try {
        const u = new URL(url);
        if (u.hostname.includes("youtube.com")) {
          const list = u.searchParams.get("list");
          const pid = (s.playlistId || s.url || "").trim();
          if (list && pid && list === pid) return s;
          if (pid && url.includes(pid)) return s;
        }
      } catch {}
    }
  }
  return null;
}

// ---------- "is this one open right now?" ----------
// Powers the little dot beside each name in settings, and the click that takes
// you there. Unlike findProductiveMatch this answers per target and ignores
// whether the target is switched on — the question is only "is a tab on it".
function targetHasUrl(url, s) {
  if (!url || !s) return false;
  if (s.type === "youtube_video" || s.type === "local_file") return targetCovers(url, s);
  if (s.type === "youtube_playlist") {
    try {
      const u = new URL(url);
      if (!u.hostname.includes("youtube.com")) return false;
      const list = u.searchParams.get("list");
      const pid = (s.playlistId || s.url || "").trim();
      return !!(list && pid && list === pid);
    } catch { return false; }
  }
  if (s.type === "youtube_channel") {
    try {
      const u = new URL(url);
      if (!u.hostname.includes("youtube.com")) return false;
      const handle = String(s.channelId || s.url || "").toLowerCase().replace(/^@/, "");
      return !!handle && url.toLowerCase().includes(handle);
    } catch { return false; }
  }
  return isAtOrUnderTarget(url, s.url);
}

async function listTabs() {
  try { return (await chrome.tabs.query({})) || []; } catch { return []; }
}

// { targetId: {tabId, windowId} } for every target with a tab open on it.
async function openTargetIds() {
  const state = await getState();
  const sites = state.productiveSites || [];
  const out = {};
  if (!sites.length) return out;
  for (const t of await listTabs()) {
    const url = t.url || t.pendingUrl || "";
    // FocusGate's own pages are not places you can be working — with one exception. viewer.html IS
    // the file, open in a tab, so it is the one extension page that can answer "do you have this
    // target open". Without it here, clicking Open would add another copy of the same PDF beside
    // the one already in front of you, and the dot beside the name would stay red while you read.
    //
    // And there is now a second exception, for the same reason as the first: a PDF reader
    // extension's page IS the file too, when its address names one. Without it the dot beside a
    // target stayed red while the user sat reading it, and Open would have added a second copy
    // beside the one already in front of them.
    if (!url || (isExtensionInternal(url) && !viewerTargetId(url) && !embeddedFileUrl(url))) continue;
    for (const s of sites) {
      if (out[s.id]) continue;
      if (targetHasUrl(url, s)) out[s.id] = { tabId: t.id, windowId: t.windowId };
    }
  }
  return out;
}

// A tab already showing this address. The exact page (and anything under it) wins;
// only if nothing matches do we settle for another page on the same site.
async function findTabForPattern(pattern) {
  if (!pattern) return null;
  const tabs = await listTabs();
  const usable = tabs.filter(t => {
    const u = t.url || t.pendingUrl || "";
    return u && !isExtensionInternal(u);
  });
  for (const t of usable) {
    if (isAtOrUnderTarget(t.url || t.pendingUrl, pattern)) return { tabId: t.id, windowId: t.windowId };
  }
  // A local file is that one file (or that one folder). There's no "same site"
  // second best to fall back to.
  if (looksLocalPath(pattern)) return null;
  const host = splitTarget(pattern).host;
  if (!host) return null;
  // Finding an already-open tab is a convenience, not a rule, so it stays broad: any
  // page on the site will do when the exact address is not open anywhere. Narrowing it
  // would only make FocusGate open a second tab for a site you already have up, which
  // is annoying and protects nothing.
  for (const t of usable) {
    if (hostMatches(splitUrl(t.url || t.pendingUrl).host, host, true)) return { tabId: t.id, windowId: t.windowId };
  }
  return null;
}

// Clicking a name should take you to the tab you already have open, and only open
// a new one when there isn't one. A second tab on the same site is never what you
// wanted.
async function focusOrOpen({ id, pattern, url }) {
  let hit = null;
  if (id) {
    const map = await openTargetIds();
    hit = map[id] || null;
  }
  if (!hit) hit = await findTabForPattern(pattern);
  if (hit) {
    try {
      await chrome.tabs.update(hit.tabId, { active: true });
      if (chrome.windows && chrome.windows.update) {
        try { await chrome.windows.update(hit.windowId, { focused: true }); } catch {}
      }
      return { ok: true, focused: true };
    } catch { /* the tab went away between the query and the click */ }
  }
  if (!url) return { ok: false };
  // A local file, and Chrome is keeping file:// away from us. Diagnosed before the attempt rather
  // than after it, because "it didn't work" is the one answer nobody can act on — this is a switch
  // on the extension's own page, and naming it is the difference between a fixable problem and a
  // broken button. Same reason browseForLocal checks it.
  if (/^file:/i.test(String(url)) && !(await fileSchemeAllowed())) {
    return { ok: false, reason: "noFileAccess" };
  }
  try { await chrome.tabs.create({ url }); return { ok: true, created: true }; }
  catch { return { ok: false, reason: "createFailed" }; }
}

// Is FocusGate allowed to see file:// pages at all? Chrome keeps this off for every
// extension until you turn it on, and while it is off a local file can be neither
// timed nor opened. Mirrors fileAccessAllowed in options.js.
function fileSchemeAllowed() {
  return new Promise(resolve => {
    try {
      if (chrome.extension && chrome.extension.isAllowedFileSchemeAccess) {
        chrome.extension.isAllowedFileSchemeAccess(r => resolve(r !== false));
      } else resolve(true);
    } catch { resolve(true); }
  });
}

// Chrome's own file listing, at an address that actually loads.
//
// A bare "file:///" does not, on Windows: the tab lands on ERR_TOO_MANY_REDIRECTS instead of a
// listing, which is what the blocked page's local-file button used to open. There is no folder
// above the drives for Chrome to list there, so it is asking for a place that doesn't exist.
// "file:///C:/" is a real directory and lists normally; on macOS and Linux "/" is real too, so
// those keep the plain address. One level lower on Windows, but a page that opens.
let browseRootCached = "";
async function browseRootUrl() {
  if (browseRootCached) return browseRootCached;
  let os = "";
  try {
    if (chrome.runtime.getPlatformInfo) {
      const info = await chrome.runtime.getPlatformInfo();
      os = String((info && info.os) || "");
    }
  } catch {}
  // getPlatformInfo is missing on some extension browsers; the user agent still says.
  if (!os && /windows/i.test(String(navigator.userAgent || ""))) os = "win";
  browseRootCached = os === "win" ? "file:///C:/" : "file:///";
  return browseRootCached;
}

// "Open" on a local target whose drive FocusGate was never told.
//
// A file picked from Chrome's dialog is stored as the tail of its path — Chrome refuses to say
// which drive it came from — so there is no address to follow. Two things are tried, in the order
// you'd want them:
//   1. A tab already sitting on that file. That IS the work, and opening a second copy of the same
//      PDF beside it is not what the button is for. Matched by target id, so the tail-matching
//      rules in fileCovers decide it rather than a guess at a host name.
//   2. Chrome's own file listing, so you can click through to the file once. Doing that is also
//      what teaches FocusGate the full address (see localFileBeat), after which the target has a
//      real link and never comes back here.
// Both can fail for one honest reason, and it is reported rather than swallowed: while "Allow
// access to file URLs" is off, Chrome hides file:// from us and neither step can work.
async function browseForLocal({ id, pattern }) {
  const hit = await focusOrOpen({ id: id || "", pattern: pattern || "", url: "" });
  if (hit && hit.focused) return { ok: true, focused: true };
  if (!(await fileSchemeAllowed())) return { ok: false, reason: "noFileAccess" };
  const url = await browseRootUrl();
  try {
    await chrome.tabs.create({ url, active: true });
    return { ok: true, browse: true, url };
  } catch {
    return { ok: false, reason: "createFailed" };
  }
}

// ---------- housekeeping for the kept copies ----------
// A copy belongs to its target and to nothing else, so when the target goes the copy goes with it.
// Settings deletes it on the spot when you remove a row; this is the backstop for every other way
// a target can disappear — a settings import, a restore, a row removed while the worker was
// asleep. Someone else's textbook sitting forgotten in IndexedDB is not a thing anyone would think
// to go looking for, so it is swept rather than left.
async function pruneStoredFiles() {
  if (typeof fgFileIds !== "function") return;        // filestore.js failed to load
  try {
    const ids = await fgFileIds();
    if (!ids.length) return;
    const keep = new Set(((await getState()).productiveSites || []).map(p => p && p.id));
    for (const id of ids) if (!keep.has(id)) await fgFileDrop(id);
  } catch {}
}
// Only when the LIST changes, not when it is written. spentSec is rewritten about once a second
// while you work, and every one of those writes lands in this listener.
let prunedIdSig = null;
let pruneTimer = 0;
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local" || !changes.productiveSites) return;
  const sig = (changes.productiveSites.newValue || []).map(p => (p && p.id) || "").join(",");
  if (sig === prunedIdSig) return;
  prunedIdSig = sig;
  clearTimeout(pruneTimer);
  pruneTimer = setTimeout(pruneStoredFiles, 3000);
});

// ---------- window gate (anti-cheat) ----------
// Time only counts while the browser window really is what you're using: filling
// the screen (maximised or full screen) and focused. Half-screen Chrome next to
// another app, or Chrome sitting behind another window, pauses the timer.
// `reported` holds what the page measured itself, used only where the windows
// API is missing (mobile extension browsers).
// Records whether the work timer is running right now and, if not, why — so the
// popup can answer "my timer isn't moving". Written at most every 5 seconds.
let notedPause = { reason: null, at: 0 };

// ---------- how long it has been stopped ----------
// The reason alone was never the whole answer. "no face" is the same three words after four
// seconds and after forty minutes, and only one of those is worth interrupting yourself over.
//
// Measured off the clock, exactly as secondsOwed measures credited time, rather than counted per
// message: notePause is called about once a second per reporting tab, and counting calls would
// double every figure the moment a second tab opened on the same target.
//
// Held in memory beside creditAt and for the same reasons. The totals are flushed to storage on
// the 5-second cadence the status write already uses, so this costs no extra writes at all, and
// the most a crash can lose is the part-second that had not been flushed.
//
// A break and a refusal are tracked apart — see pauseSinceAt in DEFAULTS for why.
const PAUSE_BREAK = "on a break";
// The clock is not running, and for once that is not a refusal: this target's time is already full.
//
// Its own word rather than an empty reason, and the empty string is exactly what it is avoiding. ""
// means "the clock is running" to everything that reads this, so a finished target reported as "" had
// the popup announcing "Counting now" over a goal that cannot be counted any further. Reported as an
// ordinary reason it was worse — "Paused — play the video" in front of a completed row, asking for
// something that buys nothing.
//
// pauseKind below maps it to no kind at all, so it never adds to the day's stopped or break totals.
// "You lost 19 seconds to a paused video" is not a smaller truth on a row that was already full; there
// was nothing there to lose.
const PAUSE_DONE = "this one is finished";
// Nothing was reporting across a gap this long: a tab went behind, the worker slept, you left the
// work page altogether. The same 5-second ceiling secondsOwed uses, with a second of slack for a
// busy page — time nobody was watching is not counted, in either direction.
const PAUSE_GAP_MAX = 6000;
let pauseAcc = { at: 0, kind: "", since: 0, stopped: 0, brk: 0 };
// Which of the two totals a reason belongs to. "" is not a pause at all.
function pauseKind(reason) {
  // PAUSE_DONE beside "" on purpose: it is a WORDING for the popup, not a stretch of lost time. It has
  // to say something, and it must not be counted.
  if (!reason || reason === PAUSE_DONE) return "";
  return reason === PAUSE_BREAK ? "brk" : "stopped";
}
// Drop everything being measured. Called when the clock's state stops being knowable — FocusGate
// switched off, the day rolling over — so a stretch can never be reported as having run through a
// stretch of time nothing was watching.
function forgetPause() {
  pauseAcc = { at: 0, kind: "", since: 0, stopped: 0, brk: 0 };
  notedPause = { reason: null, at: 0 };
}
async function notePause(reason) {
  const r = reason || "";
  const now = Date.now();
  const kind = pauseKind(r);

  // ---- the measuring, which happens on every call ----
  // Deliberately above the throttle below. The throttle is about how often STORAGE is written;
  // running the clock on the same schedule would round every stretch to the nearest five seconds
  // and lose whichever part of it did not land on a write.
  const gap = pauseAcc.at ? now - pauseAcc.at : 0;
  const continuous = gap > 0 && gap <= PAUSE_GAP_MAX;
  if (pauseAcc.kind && continuous) pauseAcc[pauseAcc.kind] += gap / 1000;
  pauseAcc.at = now;
  // A stretch runs for as long as the KIND holds, not the wording. Looking away and then leaning
  // out of the focus box changes the reason twice while you sit in one place, and restarting the
  // count each time would report thirty unbroken minutes as three separate seconds.
  // A gap nothing reported across breaks it regardless: you were somewhere else in between.
  if (kind !== pauseAcc.kind || !continuous) {
    pauseAcc.kind = kind;
    pauseAcc.since = kind ? now : 0;
  }

  if (notedPause.reason === r && now - notedPause.at < 5000) return;
  notedPause = { reason: r, at: now };
  const patch = { timerPauseReason: r, timerPauseAt: now, pauseSinceAt: pauseAcc.since };
  // Whole seconds only, with the remainder carried, so a flush landing mid-second doesn't
  // repeatedly throw away the same fraction — the same reasoning as paceCarry.
  const wholeStop = Math.floor(pauseAcc.stopped);
  const wholeBrk = Math.floor(pauseAcc.brk);
  if (wholeStop > 0 || wholeBrk > 0) {
    const s = await getState();
    if (wholeStop > 0) { patch.pausedTodaySec = (s.pausedTodaySec || 0) + wholeStop; pauseAcc.stopped -= wholeStop; }
    if (wholeBrk > 0) { patch.breakTodaySec = (s.breakTodaySec || 0) + wholeBrk; pauseAcc.brk -= wholeBrk; }
  }
  await setState(patch);
}

// ---------- no-cheating rules, per target ----------
// The checks in Setup are the defaults. Any single target can keep its own copy
// instead — a lecture playlist may need the camera while a reading site doesn't —
// by carrying `cheatCustom: true` and a `cheat` object using the same key names.
// Anything it doesn't name still falls back to the global value, so an override can
// be partial and stays correct when the defaults change.
const CHEAT_KEYS = ["mediaPlayingRequired",
                    "inactivityPauseEnabled", "inactivityTimeoutSec",
                    "fullscreenOnlyEnabled", "splitViewBlockEnabled",
                    "faceDetectionEnabled", "faceSensitivity",
                    "eyeTrackingEnabled", "eyeSensitivity", "eyeAwaySec",
                    "livenessEnabled", "livenessIntervalSec", "moveSensitivity",
                    "blinkRequired", "blinkIntervalSec", "blinkSensitivity",
                    // Not a condition either, and different again from the three below: this
                    // one decides how FAST a second is credited rather than whether it is.
                    // Per-target for the most useful reason of any key in this list — a
                    // reading target is exactly where leaning in earns its keep, and a video
                    // lecture you watch from across the room is exactly where it should not.
                    "paceEnabled", "paceFast", "paceSlow", "paceBoxPct",
                    // Not conditions — these three don't decide whether a second
                    // counts, they act on the page while you work. They ride along
                    // here because they are per-target for the same reason the
                    // conditions are: a lecture wants its video held and wound back,
                    // a reading site has nothing to hold.
                    "mediaPauseEnabled", "mediaResumeEnabled", "mediaRewindSec",
                    "pageGlowEnabled"];

function effectiveCheat(state, site) {
  const out = {};
  for (const k of CHEAT_KEYS) out[k] = state[k];
  out.custom = !!(site && site.cheatCustom);
  if (out.custom && site.cheat) {
    for (const k of CHEAT_KEYS) {
      const v = site.cheat[k];
      if (v !== undefined && v !== null) out[k] = v;
    }
  }
  return out;
}

// Is the page using the whole browser window, or only a slice of it? A window can
// be maximised and focused while the work page sits in half of it — Chrome's split
// view, Edge's split screen, or DevTools docked to the side. The window APIs can't
// see any of that, so the page reports its own viewport width and we compare it
// with the window's.
//
// Page zoom is the trap here: at 150% zoom the viewport is measured in fewer, bigger
// CSS pixels than the window frame, which would look like a split. chrome.tabs.getZoom
// gives us the exact factor, so the two numbers are compared in the same units.
// How much of the window a page may lose before it stops counting. A page that
// has the window to itself keeps ~99% of it: all it gives up is the scrollbar and
// the window border. So anything taking more than a few percent — a split view, a
// side panel, docked DevTools — is something else sharing your work window, and
// even a narrow strip is enough to watch a video in.
const SOLO_WINDOW_SHARE = 0.95;

async function splitViewGate(state, tabId, reported) {
  if (state.splitViewBlockEnabled === false) return { ok: true };
  // Two reasons, not one, because the two branches below know different things and the card that
  // shows this is about twenty characters wide.
  //
  // It used to say "give this page the whole window" for both. That is what the CHECK is about,
  // but it is not something anyone can act on — it describes the state it wants rather than the
  // thing you have to do — and at that width it arrived as "give this page the whole wind…", which
  // is a sentence cut off mid-word telling you nothing. What is actually in the way is a sidebar or
  // a split view, so the reason names the one we know about and says to close it.
  const noSplit = { ok: false, reason: "close split view" };
  const noRoom = { ok: false, reason: "close the sidebar" };

  // 1. Ask the browser outright. Newer Chrome tags tabs that sit in a split view,
  //    and two tabs can only be active in one window when it's split. Neither
  //    depends on measuring anything, so they're checked first.
  //    This branch is the one case where the browser has told us WHAT it is, so it is the one that
  //    can say "split view" rather than guessing.
  if (chrome.tabs && chrome.tabs.get && typeof tabId === "number") {
    try {
      const tab = await chrome.tabs.get(tabId);
      if (tab) {
        const sid = tab.splitViewId;
        if (sid !== undefined && sid !== null && sid !== -1) return noSplit;
        if (chrome.tabs.query) {
          const act = await chrome.tabs.query({ windowId: tab.windowId, active: true });
          if ((act || []).length > 1) return noSplit;
        }
      }
    } catch {}
  }

  // 2. Then measure. This is what catches everything the browser won't admit to:
  //    another browser's split screen, a side panel, DevTools docked to the side.
  //    Skipped where there's no windows API (mobile extension browsers), because
  //    there the viewport and the window aren't comparable.
  //
  //    All this branch knows is that the page is not getting the width it should. It cannot tell a
  //    side panel from docked DevTools, so it names the overwhelmingly common one: Chrome's own side
  //    panels — reading list, bookmarks, the AI assistant — which are one click to close. Someone
  //    with DevTools open beside the page already knows why the width is short.
  if (!(chrome.windows && chrome.windows.get)) return { ok: true };
  if (!reported) return { ok: true };
  const inner = Number(reported.inner) || 0;
  const outer = Number(reported.outer) || 0;
  if (inner <= 0 || outer <= 0) return { ok: true };      // nothing measurable
  let zoom = 1;
  if (chrome.tabs && chrome.tabs.getZoom && typeof tabId === "number") {
    try { zoom = (await chrome.tabs.getZoom(tabId)) || 1; } catch {}
  }
  const share = (inner * zoom) / outer;
  if (share < SOLO_WINDOW_SHARE) return noRoom;
  return { ok: true };
}

async function windowGate(state, tabId, reported) {
  // Split view is its own switch, so it's checked even when the full-screen rule
  // is off — half a maximised window is the same cheat either way.
  const split = await splitViewGate(state, tabId, reported);
  if (!split.ok) return split;
  if (state.fullscreenOnlyEnabled === false) return { ok: true };

  if (chrome.windows && chrome.windows.get && typeof tabId === "number") {
    try {
      const tab = await chrome.tabs.get(tabId);
      if (tab && tab.active === false) return { ok: false, reason: "open this tab" };
      const win = tab ? await chrome.windows.get(tab.windowId) : null;
      if (win) {
        // Named for the fix, not for the state. "window minimised" told you what FocusGate could
        // see and left you to work out what it wanted — and it is the same thing wanted two lines
        // below, so there is no reason for two different sentences. This one is also read in the
        // popup, which is where you are when the window it is complaining about is not on screen.
        if (win.state === "minimized") return { ok: false, reason: "make window full screen" };
        if (win.focused === false) return { ok: false, reason: "click this window" };
        if (win.state !== "maximized" && win.state !== "fullscreen") {
          return { ok: false, reason: "make window full screen" };
        }
        return { ok: true };
      }
    } catch { /* fall through to what the page reported */ }
  }

  if (reported) {
    if (reported.focused === false) return { ok: false, reason: "click this window" };
    if (reported.winFull === false) return { ok: false, reason: "make window full screen" };
  }
  return { ok: true };
}

// Pages FocusGate has no business touching. file:// used to be in this list, which
// is why a local file could never earn time; it's now a target you can add, so it's
// treated like any other page — except that it is never blocked (see getBlockReason).
function isExtensionInternal(url) {
  return !url || url.startsWith("chrome://") || url.startsWith("chrome-extension://") ||
         url.startsWith("about:") || url.startsWith("edge://") ||
         url.startsWith("devtools://");
}

// Start this row's stopwatch, if it has one and has not started it today.
//
// "From the moment you first opened the site" is the promise, so this fires on the page being SEEN and
// not on the clock running. That is why it lives in the tick handler beside `onTarget` rather than in
// tickFromContent: crediting is skipped entirely while anything is paused — no face, a video not
// playing, the window not full screen — and an allowance that only started once the camera was happy
// would be an allowance you could postpone by looking away.
//
// Written once per day per row. The guard is checked twice, against the row we were handed and again
// against a fresh read, because two tabs on the same target can tick in the same second and the second
// one must not move a stamp the first one just set — a later stamp is a longer allowance.
//
// Nothing is swept afterwards. Starting a stopwatch cannot change what is blocked: the allowance only
// ever runs OUT, and running out never unlocks anything. The one thing expiry does change is sequence
// mode stepping over a row it can no longer satisfy, and the minute heartbeat picks that up.
async function noteGraceStart(target) {
  if (!target) return false;
  const F = self.FGSettings;
  if (!F || !F.hasGrace || !F.hasGrace(target)) return false;
  if ((Number(target.graceFrom) || 0) > 0) return false;        // already running
  const now = Date.now();
  const fresh = await getState();
  const row = (fresh.productiveSites || []).find(p => p && p.id === target.id);
  if (!row || (Number(row.graceFrom) || 0) > 0) return false;   // another tab got there first
  await setState({
    productiveSites: (fresh.productiveSites || [])
      .map(p => (p && p.id === target.id ? { ...p, graceFrom: now } : p))
  });
  return true;
}

// Is today's work finished? One question covering every website target you set.
// This is what releases the locked-sites list.
async function allRequiredMet(state) {
  const sites = activeTargets(state.productiveSites);
  if (!sites.length) return false;                 // nothing set => nothing to release
  if (self.FGSettings && self.FGSettings.evaluateTargets) {
    return self.FGSettings.evaluateTargets(sites);
  }
  return sites.every(p => (p.requiredSec === 0) || (p.spentSec || 0) >= (p.requiredSec || 0));
}

// ---------- the big "everything is done" moment ----------
// Fires once a day, from whichever target happens to finish last. Every open page
// hears about it: the tab you're on draws the confetti card, and the popup /
// settings page draw their own.
async function maybeCelebrateAllDone() {
  const s = await getState();
  if (!s.enabled) return false;
  if (!(await allRequiredMet(s))) return false;
  const today = todayStr();
  if (s.allDoneCelebratedOn === today) return false;

  const patch = { allDoneCelebratedOn: today };
  let streak = s.streakCount || 0;
  if (s.lastStreakDate !== today) {
    streak += 1;
    patch.streakCount = streak;
    patch.lastStreakDate = today;
  }
  const xp = (s.xp || 0) + 200;
  patch.xp = xp;
  patch.level = Math.floor(xp / 500) + 1;
  await setState(patch);

  const payload = {
    title: "Everything is done! 🏆",
    subtitle: `All of today's work is finished — ${streak} day${streak === 1 ? "" : "s"} in a row. Your locked sites are open.`,
    xp: 200,
    big: true,
    all: true
  };
  // Every ordinary tab: content.js already knows how to draw this.
  try {
    const tabs = await chrome.tabs.query({});
    for (const t of tabs) {
      if (!t.id || isExtensionInternal(t.url)) continue;
      try { chrome.tabs.sendMessage(t.id, { type: "celebrate", payload }, () => void chrome.runtime.lastError); } catch {}
    }
  } catch {}
  // The popup and the settings page, if either is open right now.
  try { chrome.runtime.sendMessage({ type: "celebrateAll", payload }, () => void chrome.runtime.lastError); } catch {}
  return true;
}

// ---------- MacroDroid mobile bridge ----------
// Fires a webhook to MacroDroid so selected phone apps stay blocked until
// every productive target for the day is met. Locked = goals NOT yet met.
async function fireMacrodroid(url, locked) {
  if (!url) return false;
  try {
    const sep = url.includes("?") ? "&" : "?";
    const full = `${url}${sep}state=${locked ? "locked" : "unlocked"}&source=focusgate&ts=${Date.now()}`;
    await fetch(full, { method: "GET", cache: "no-store", keepalive: true });
    return true;
  } catch (e) {
    return false;
  }
}

// Unlock the phone right now, unconditionally.
//
// The one-line version of syncMobileLock's first branch, without the reconciling. Used when
// FocusGate is switched off from the popup, which is the case where waiting is worst: the user has
// just declared that none of FocusGate's rules apply, and a phone whose apps are still blocked a
// minute later is a rule outliving the switch that turns it off.
//
// Unconditional on purpose. `mobileLockSent` is a record of the last successful push, and if the
// worker was shut down and woken since then it can disagree with the phone — so the ONE moment it
// must not be trusted is the moment somebody is asking to be let out. A redundant unlock costs a
// single webhook call and MacroDroid treats it as a no-op.
//
// Returns the outcome so the caller can say whether the phone was actually reached, and writes
// mobileLockSent only on success, exactly like every other send here — a failed call must stay
// pending so the next heartbeat retries it.
async function releaseMobileNow() {
  const state = await getState();
  if (!state.macrodroidEnabled) return { ok: false, reason: "off" };
  const url = state.macrodroidUnlockUrl;
  if (!url) return { ok: false, reason: "nourl" };
  const ok = await fireMacrodroid(url, false);
  if (ok) await setState({ mobileLockSent: false });
  return { ok, reason: ok ? "" : "unreachable" };
}

// Compute desired mobile lock state and push to phone when it changes.
// `force` re-sends even if unchanged (used only by manual Test/Sync buttons).
// mobileLockSent is updated ONLY after a successful send, so if the phone was
// offline the next heartbeat retries automatically — without spamming when
// nothing changed.
async function syncMobileLock(force = false) {
  const state = await getState();

  // If FocusGate itself is turned off, unlock the phone and never send lock webhooks!
  if (!state.enabled) {
    if (state.macrodroidUnlockUrl) {
      if (!force && state.mobileLockSent === false) return; // already unlocked
      const ok = await fireMacrodroid(state.macrodroidUnlockUrl, false);
      if (ok) await setState({ mobileLockSent: false });
    } else {
      if (state.mobileLockSent !== false) await setState({ mobileLockSent: false });
    }
    return;
  }

  // If MacroDroid bridge is turned off, also make sure phone is unlocked if it was locked earlier
  if (!state.macrodroidEnabled) {
    if (state.mobileLockSent === true && state.macrodroidUnlockUrl) {
      const ok = await fireMacrodroid(state.macrodroidUnlockUrl, false);
      if (ok) await setState({ mobileLockSent: false });
    }
    return;
  }

  // Only manage the phone when the user actually has goals to achieve — and only the goals that
  // asked to be one of them.
  //
  // phoneTargets, not activeTargets: a row with its own webhook switch off still earns time and
  // still gates the browser, it simply is not something the phone waits for. The distinction
  // matters because the bridge is otherwise all-or-nothing, and one reference site you dip into at
  // odd hours was enough to hold the phone locked all day.
  //
  // Nothing left after the filter takes the branch below, which is the right answer: every target
  // opted out of the phone means there is nothing for it to wait on, so it is released rather than
  // held on a rule nobody asked it to enforce.
  const onTargets = phoneTargets(state.productiveSites);
  if (!onTargets.length) {
    if (state.mobileLockSent === true && state.macrodroidUnlockUrl) {
      const ok = await fireMacrodroid(state.macrodroidUnlockUrl, false);
      if (ok) await setState({ mobileLockSent: false });
    }
    return;
  }

  const met = (self.FGSettings && self.FGSettings.evaluateTargets)
    ? self.FGSettings.evaluateTargets(onTargets)
    : onTargets.every(p => (p.requiredSec === 0) || (p.spentSec || 0) >= (p.requiredSec || 0));
  const locked = !met; // block phone apps until all goals are met
  if (!force && state.mobileLockSent === locked) return; // already in sync -> no resend
  const url = locked ? state.macrodroidLockUrl : state.macrodroidUnlockUrl;
  const ok = await fireMacrodroid(url, locked);
  if (ok) await setState({ mobileLockSent: locked });
}

// ---------- daily reset ----------
async function maybeReset(state) {
  const today = todayStr();
  const now = new Date();
  const [hh, mm] = (state.dailyResetTime || "00:00").split(":").map(n=>parseInt(n,10));
  const resetMoment = new Date(now);
  resetMoment.setHours(hh||0, mm||0, 0, 0);
  // If now is past today's reset moment and lastResetDate != today => reset
  if (now >= resetMoment && state.lastResetDate !== today) {
    // metAt goes with spentSec, and for the same reason: it is a measurement of today. Leaving
    // yesterday's finishing time on a row would hand today's unlock to a deadline that was met
    // before the day even started.
    //
    // graceFrom is the third of the three and the most obvious of them: it is the moment you first
    // opened that site TODAY, so carrying it over would start every morning with an allowance that had
    // already run out overnight. This is the only place it is cleared — see the note in options.js
    // beside the wind-back buttons for why pressing ↺ deliberately does not.
    const sites = (state.productiveSites||[]).map(s => ({...s, spentSec: 0, metAt: 0, graceFrom: 0}));
    await setState({ productiveSites: sites, lastResetDate: today,
                     // Today's stopped time is about today, exactly as spentSec is, so it goes
                     // with it. Anything the accumulator was still holding belongs to the day
                     // that just ended and is dropped rather than carried across the boundary.
                     pausedTodaySec: 0, breakTodaySec: 0, pauseSinceAt: 0,
                     allDoneCelebratedOn: "" });
    forgetPause();
    await syncMobileLock(); // day reset => re-lock phone apps (only fires if state changed)
    return true;
  }
  // If we've never reset, mark today
  if (!state.lastResetDate) {
    await setState({ lastResetDate: today });
  }
  return false;
}

// ---------- is this page about the topic you set for this target? ----------
//
// The engine — the prompt, the request, the caps, the subtitle parsing — is in aicheck.js. What lives
// here is everything that needs Chrome: the permissions, the cache, the fetch of the subtitles, and the
// one synchronous reader that the clock and the blocker can consult without becoming slow.
//
// The shape is deliberately the same as the AI half of the Anki extension, because the same two
// problems come up: a verdict is needed NOW by code that cannot wait for a network round trip, and one
// page must cost one request rather than one per tick. So there is a synchronous peek that answers from
// what is already known and starts a request when it is not, and every caller treats "don't know yet"
// as the answer that leaves things as they were.
//
// Where it differs is the direction of "leaves things as they were", and that is the whole design. In
// the Anki extension the pre-existing answer was "this video is refused", so an unknown verdict left it
// refused. Here the pre-existing answer is "this page counts", so an unknown verdict leaves it
// counting. Both fail away from taking something off the user — which for this one means an outage at
// Google cannot stop somebody's study clock.

const aiOk = () => !!self.FGAi;

// key -> { state, pct, reason, read, mode, err, at }.  state: "pending" | "on" | "off" | "error"
//
// "on"/"off" rather than "allow"/"deny", because that is what this answers: whether the page is on the
// topic. Nothing here decides whether you may be somewhere.
const aiCache = new Map();
const AI_CACHE_MAX = 400;
// After a hard failure, how long before the same page is asked again. Stops a tick every second from
// turning one bad key into three thousand refused requests an hour.
const AI_ERROR_COOLDOWN_MS = 60000;
// The floor under the whole feature, and the reason it is safe to point at ordinary websites and not
// only at videos.
//
// A verdict is cached per (topic, page), and on a video site that is the end of it — one video, one
// request. On a site that rewrites its address as you work (a language app moving through exercises, a
// docs site with a page per section) every new path is a new question, and a free daily allowance would
// be gone in an afternoon. So no more than one request leaves here per this interval, whatever is
// asked. Pages that lose the race are answered "don't know yet", which means "keep counting".
const AI_MIN_GAP_MS = 4000;
let aiLastAskAt = 0;
// The most recent failure, for the settings page to show. One slot, not a log: what somebody needs when
// the switch is on and nothing is happening is "the last thing that went wrong", and sixty identical
// 429s are not more useful than one.
let aiLastError = null;
// And the most recent verdict on a video's SUBTITLES, which is a different fact and needs its own slot.
// See aiNoteMeta.
let aiLastTranscript = null;
// And the last request that actually went out, in full, so it can be read rather than believed.
let aiLastSent = null;

function aiCachePut(key, entry) {
  // Oldest out first. A Map iterates in insertion order, so the first key is the oldest.
  if (aiCache.size >= AI_CACHE_MAX) {
    const oldest = aiCache.keys().next();
    if (!oldest.done) aiCache.delete(oldest.value);
  }
  aiCache.set(key, entry);
}

// ---- the two optional permissions ----
//
// Both are OPTIONAL and asked for at the moment somebody switches the thing that needs them on.
// Declaring either outright would put an install-time warning in front of every user of this extension,
// including everyone who never turns this on — and adding a required host permission to an extension
// that is already installed disables it until the user re-approves.
// ONE origin, not two. There was a second check here for youtube.com, on the belief that reading a video's
// subtitles needed permission to read the site — and it did, while the worker was the thing fetching them.
// It is not any more: the page bridge fetches them as the page, from inside a document the user already
// has open. So the only outbound host this extension needs a say about is the model's.
let aiOriginOk = null;
async function aiHasOrigin() {
  if (aiOriginOk !== null) return aiOriginOk;
  try {
    aiOriginOk = await chrome.permissions.contains({ origins: [FGAi.ORIGIN_PATTERN] });
  } catch { aiOriginOk = false; }
  return aiOriginOk;
}
try {
  // Granted or revoked from the settings page, or from chrome://extensions. Either way the cached answer
  // above is now a guess about the past, so it is thrown away rather than corrected — the next call
  // re-asks, which is one cheap query on a path that runs at most once per page.
  chrome.permissions.onAdded.addListener(() => { aiOriginOk = null; });
  chrome.permissions.onRemoved.addListener(() => { aiOriginOk = null; });
} catch {}

// ---- what the page told us about itself ----
//
// The title, the channel, the description, the tags and the readable text all come from the content
// script, because they are in a document it is already running in and fetching the page again from here
// would be paying twice for something the browser has rendered.
//
// Kept in the worker's memory keyed on the page's own identity rather than used straight from the
// message, and that is what makes the callers agree: the tick has the evidence, the blocker does not,
// and if the blocker asked its own question with less of it the same page would hold two verdicts
// depending on which asked first. So whoever sees it writes it down, and both read from here.
//
// Nothing in it is trusted as an instruction; see FGAi.prompt, which fences every block.
const aiPageMeta = new Map();      // subjectKey -> { title, channel, description, tags, text, at }
const AI_META_MAX = 80;
const AI_META_FRESH_MS = 30 * 60 * 1000;
const META_FIELDS = ["title", "channel", "description", "tags", "text", "transcript"];
// `quiet` keeps a report out of the settings page's "what happened to the subtitles" line. Used for videos on
// Google, whose subtitles are unreachable from a page that only frames the player — a fact about where the
// video is shown, not about the video, and reporting it there would make the line say YouTube refused them.
function aiNoteMeta(subject, raw, quiet) {
  if (!aiOk() || !subject || !raw || typeof raw !== "object") return;
  const next = {
    title: FGAi.clean(raw.title, FGAi.TITLE_MAX),
    channel: FGAi.clean(raw.channel, FGAi.CHANNEL_MAX),
    description: FGAi.clean(raw.description, FGAi.DESC_MAX),
    tags: FGAi.clean(raw.tags, FGAi.TAGS_MAX),
    text: FGAi.clean(raw.text, FGAi.TEXT_MAX),
    // SAMPLED, never head-trimmed, and that distinction is the whole reason it does not go through
    // FGAi.clean like its neighbours. The first minutes of a lecture are "hello everyone, welcome back" —
    // the least informative part of the recording and exactly what a head trim keeps. FGAi.sample takes a
    // third from the start, the middle and the end instead.
    transcript: FGAi.sample(raw.transcript, FGAi.TRANSCRIPT_MAX),
    // What the page bridge made of the subtitles: "ok" | "none" | "unreadable" | "nobridge", or "" while it
    // is still trying. Not evidence — a status — and the one thing that tells "two seconds away" apart from
    // "this video has none", which is the difference between waiting and asking. See aiEvidenceReady.
    transcriptState: String(raw.transcriptState || "").slice(0, 20),
    at: Date.now()
  };
  if (!META_FIELDS.some(k => next[k]) && !next.transcriptState) return;
  const had = aiPageMeta.get(subject);
  // Only ever grown, never replaced with less. Pages render lazily — the first tick of a YouTube watch
  // page routinely carries a title and an empty description and the second carries both — and a straight
  // overwrite would let the emptier report arrive last and throw away evidence the model was about to be
  // given. The subtitles are the extreme case: they arrive seconds late, on a report that carries nothing
  // else at all.
  // The most recent thing the bridge said about a video's subtitles, for the settings page to report.
  //
  // One slot, not a log, and it exists because of exactly the failure this whole change was chasing: the
  // switch said "on", the subtitles were never read, and there was nowhere at all to find that out. A line
  // that says "on · none on that video" is the difference between a feature and a promise.
  if (next.transcriptState && !quiet) aiLastTranscript = { why: next.transcriptState, at: Date.now() };
  if (had) {
    for (const k of META_FIELDS) if (!next[k]) next[k] = had[k] || "";
    // The state is the exception to "only grown": it is allowed to change, because it is a status rather
    // than evidence and its whole job is to move from "" to something. It may not go BACKWARDS to "",
    // though — that would restart the waiting after the answer had arrived.
    if (!next.transcriptState) next.transcriptState = had.transcriptState || "";
  } else if (aiPageMeta.size >= AI_META_MAX) {
    const oldest = aiPageMeta.keys().next();
    if (!oldest.done) aiPageMeta.delete(oldest.value);
  }
  aiPageMeta.set(subject, next);
}
function aiMetaFor(subject) {
  const blank = { title: "", channel: "", description: "", tags: "", text: "", transcript: "", transcriptState: "" };
  const m = aiPageMeta.get(subject);
  if (!m) return blank;
  if (Date.now() - m.at > AI_META_FRESH_MS) { aiPageMeta.delete(subject); return blank; }
  return m;
}

// ---- the subtitles ----
//
// This is what makes "check the video" mean something to a text model. YouTube has already transcribed
// nearly every lecture on the site; the transcript is what was actually SAID, and no title, description or
// tag list can be dressed up to survive it.
//
// THERE IS NO CODE FOR IT HERE, and that is the finding rather than an omission.
//
// This file used to fetch it: get the watch page, pull `captionTracks` out of the HTML, fetch the baseUrl.
// That is what every tutorial says and it does not work, for three separate reasons — see the header of
// yt_page_bridge.js, which is where it lives now. The short version is that the caption URL needs a
// proof-of-origin token minted inside the player, so an anonymous fetch from a service worker gets a 200
// with an empty body. Not an error: a success with no words in it, which reads exactly like "this video has
// no subtitles" and is therefore invisible.
//
// So the subtitles now arrive the only way they can — from the page, gathered by a MAIN-world script that
// watches the player fetch its own captions — and reach this side as an ordinary field of the page
// metadata, alongside the title and the description. See aiNoteMeta, and `transcriptState`, which is what
// lets this side wait for them rather than judging a video on its headline while they are still coming.

// ---- the question ----

// Is the topic check switched on AND actually usable? Both, in one question, because every caller wants
// the same answer and "on but no key" must behave exactly like "off" rather than like an error.
function aiTopicReady(state) {
  const s = state || {};
  if (!aiOk()) return false;
  if (s.aiTopicEnabled !== true) return false;
  if (s.enabled === false) return false;
  return !!String(s.aiTopicKey || "").trim();
}
// ---- which topic applies where ----
//
// There are two ways a topic can bear on a page, and conflating them was the bug that made this whole
// feature look dead:
//
//   ON A TARGET. You gave khanacademy.org a topic, so pages on khanacademy.org are judged against it and
//   the clock only runs while you are on it. This is about EARNING.
//
//   ON A VIDEO, ANYWHERE. You said you are studying linear integrated circuits today, so a German course
//   on YouTube is not that — and YouTube is neither a work site nor on your blocked list, so nothing in
//   FocusGate had any opinion about it at all. This is about BLOCKING, and it is the half that was
//   missing: a topic that only applies to sites you already nominated as work cannot keep you off the
//   sites you did not.
//
// Both go through the same machinery from here on, which is what the context object is for. One question
// builder, one cache, one verdict reader — so the two paths cannot disagree about the same video.

// The cards whose topic bears on YouTube RIGHT NOW.
//
// `activeTargets` does most of the work: it drops rows that are switched off and rows not asked for today,
// so a rest day or a disabled row silently takes its topic out of the gate. On top of that, a card that
// keeps a time WINDOW only counts while the clock is inside it — that is how a window comes to mean "German
// counts from six to nine, and only then" for YouTube, the same window that already decides when finishing
// the card unlocks anything. A card with no window is unaffected and applies all day, exactly as before.
//
// Deliberately the ONE place the window touches the YouTube feature, so the gate, the earning and the
// miniplayer cover cannot disagree about when a subject is live. On a work site the window still governs
// only the reward, untouched — this is about the videos scattered across a site you never nominated.
function ytTopicTargets(state) {
  if (!aiOk()) return [];
  const F = self.FGSettings;
  const out = [];
  for (const t of activeTargets((state || {}).productiveSites)) {
    if (!FGAi.topicOf(t)) continue;
    // Fail open if settings.js is missing or the helpers are absent: a card with no readable window is
    // treated as having none, which is the direction that keeps a subject working rather than silently
    // switching it off.
    if (F && F.hasWindow && F.inWindow && F.hasWindow(t) && !F.inWindow(t)) continue;
    out.push(t);
  }
  return out;
}

// Every topic that is live right now, across the whole list, de-duplicated. Window-aware by way of
// ytTopicTargets above.
function activeTopics(state) {
  if (!aiOk()) return [];
  const out = [];
  const seen = new Set();
  for (const t of ytTopicTargets(state)) {
    const topic = FGAi.topicOf(t);
    if (!topic) continue;
    const k = topic.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(topic);
  }
  return out;
}

// Is the "only videos about my topics" gate running?
//
// Four conditions, and the last one is the one that keeps this safe to ship on by default: with no topic
// written anywhere, the gate stands down completely and YouTube behaves exactly as it always did. Nobody
// who has not opted in by typing a sentence can be affected by it.
function videoGateActive(state) {
  const s = state || {};
  if (!aiTopicReady(s)) return false;
  if (s.aiTopicVideoGate !== true) return false;
  return activeTopics(s).length > 0;
}

// Is the "matching videos EARN their card's time" half running? Same shape as the gate, and independent of
// it: earning can be on with blocking off (matching videos count and the rest just play) or blocking on with
// earning off (the existing behaviour — matching videos open but credit nothing). Off by default; see the
// note in DEFAULTS for why crediting is opted into rather than shipped on.
function videoEarnActive(state) {
  const s = state || {};
  if (!aiTopicReady(s)) return false;
  if (s.aiTopicVideoEarn !== true) return false;
  return activeTopics(s).length > 0;
}

// Should a YouTube video be checked against your topics at all? Either half being on is reason enough — the
// gate needs the verdict to decide what plays, and earning needs it to decide what counts, and they share
// the one question so a video is never asked about twice.
function videoTopicActive(state) {
  return videoGateActive(state) || videoEarnActive(state);
}

// The topic that applies to this URL, and where it came from. Null for "nothing to check here".
//
// A target's OWN topic wins over the gate's list, and that ordering is deliberate: nominating a channel
// as work and giving it a topic is a more specific statement than "these are my subjects today", so the
// specific one decides. A target with no topic is exempt from the gate entirely — you called it work.
function topicContextFor(state, url, matchedTarget) {
  if (!aiTopicReady(state)) return null;
  const own = matchedTarget ? FGAi.topicOf(matchedTarget) : "";
  if (own) return { kind: "target", id: String(matchedTarget.id || ""), topics: [own] };
  if (matchedTarget) return null;                    // on a work site with no topic: nothing to judge
  // videoTopicActive, not videoGateActive, so the union question is asked whenever EITHER the gate or the
  // earn half wants it. The two consumers read the same cached verdict from opposite ends — one to decide
  // what plays, the other to decide what counts.
  if (videoTopicActive(state) && FGAi.isVideo(url)) {
    const topics = activeTopics(state);
    if (topics.length) return { kind: "gate", id: "__gate__", topics };
  }
  return null;
}

// Everything one question needs. Null when there is nothing to ask about: the check is off, nothing here
// carries a topic, or the address is not something a verdict can be filed under.
function aiTopicQuestion(state, url, ctx) {
  if (!aiTopicReady(state)) return null;
  const topics = (ctx && Array.isArray(ctx.topics)) ? FGAi.topicList(ctx.topics) : [];
  if (!topics.length) return null;
  // Joined with newlines for the cache key and for the prompt, which splits it again. One string, so the
  // key is a hash of the whole SET — add a topic to another row and every cached verdict from before it
  // existed becomes unreachable, which is correct: the question really has changed.
  const topic = topics.join("\n");
  const subject = FGAi.subjectKey(url);
  if (!subject) return null;
  const isVideo = FGAi.isVideo(url);
  // "Watch the video" on something that is not a video falls back to reading the details, and this is
  // the one place in the feature where a setting is silently downgraded. It is right here: the depth is
  // one global choice and targets are a mixture of videos and ordinary pages, so the alternative is
  // either refusing to check half of somebody's list or making them keep two settings in step by hand.
  // What is reported afterwards is what was ACTUALLY read — see FGAi.evidenceList — so nothing claims
  // to have watched a video it could not.
  const wanted = FGAi.modeOf(state);
  const mode = (wanted === "video" && !isVideo) ? "details" : wanted;
  const scope = FGAi.scopeFor(state, mode);
  const model = FGAi.modelOf(state);
  return {
    topic, topics, subject, isVideo, mode, scope, model,
    kind: (ctx && ctx.kind) || "target",
    videoId: FGAi.videoId(url),
    need: FGAi.threshold(state),
    targetId: String((ctx && ctx.id) || ""),
    key: FGAi.cacheKey(topic, url, model, mode, scope)
  };
}

// What is ALREADY KNOWN about this page, and nothing more.
//
// Synchronous, and that is the point of it: the clock credits a second inside a message handler and the
// blocker decides inside a navigation listener, and neither can afford to wait on a model.
//
// Returns one of:
//   { state: "off" }                  nothing to check — no topic on this row, or the feature is off
//   { state: "pending" }              asked, no answer yet
//   { state: "on" | "off2", pct }     a score, compared against the threshold on this machine
//   { state: "error", err }           asked and failed
//
// The two "off"s are genuinely different and must not be conflated, which is why the second has an
// awkward name rather than sharing the first: "nothing to check here" and "checked, and this is not it"
// lead to opposite behaviour, and a bug that mixed them up would either stop every clock or no clock.
function aiTopicCached(state, url, ctx, start) {
  const q = aiTopicQuestion(state, url, ctx);
  if (!q || !q.key) return { state: "off" };
  const now = Date.now();
  const hit = aiCache.get(q.key);
  const base = { mode: q.mode, need: q.need, topic: q.topic, topics: q.topics, kind: q.kind };
  if (hit) {
    if (hit.state === "on" || hit.state === "off2") {
      return {
        ...base, state: hit.state, pct: hit.pct, reason: hit.reason || "", read: hit.read || [],
        scores: hit.scores || {}, hasSent: !!hit.sent,
        // Which topic of the set this verdict scored against, so the earn path can credit the right card.
        which: hit.which || 0
      };
    }
    if (hit.state === "pending") {
      // Outstanding for longer than anyone should wait. Reported as an error rather than as pending so
      // the callers that cannot wait stop waiting; the request itself is left alone to finish and
      // overwrite this, because a slow answer is still the right answer for the next tick.
      if (now - hit.at > FGAi.pendingMaxFor(q.mode)) return { ...base, state: "error", err: "timeout" };
      return { ...base, state: "pending" };
    }
    if (hit.state === "error" && now - hit.at < AI_ERROR_COOLDOWN_MS) {
      return { ...base, state: "error", err: hit.err };
    }
    // An error that has cooled off falls through and is asked again — a quota resets, a network comes
    // back, and a key that was wrong an hour ago may have been fixed since.
  }
  if (start === false) return { ...base, state: hit ? "error" : "pending", err: hit ? hit.err : "" };
  // Nothing to ask WITH yet. The evidence comes from the page, and the page only gathers it after a reply
  // has told it to (see aiWantMeta) — so the very first tick on a video knows the address and nothing
  // else. Asking then would spend a request on a question with an empty title in it, and cache the
  // resulting nonsense under this page's name for as long as the topic lasts.
  //
  // Answering "pending" instead costs one second: the reply that carries this also carries the request for
  // the metadata, so the next tick has a title and the question goes properly.
  const ready = aiEvidenceReady(q);
  // The backstop overrides the wait for the SUBTITLES and never the wait for a title. A prompt with no title
  // in it is a question about nothing, and caching its answer under this video's name would be worse than
  // waiting a while longer — so a page that has told us literally nothing goes on being pending.
  const forced = !ready && !!aiMetaFor(q.subject).title && aiWaitedTooLong(q);
  if (!ready && !forced) return { ...base, state: "pending" };
  aiTopicAsk(state, q);
  return { ...base, state: "pending" };
}

// How long this side is willing to wait for the page to finish describing a video before asking anyway.
//
// A BOUND on the waiting, and it exists because the absence of one is what turned a single missing line into
// a video held still for ever. aiEvidenceReady waits for the subtitles to settle; the page settles them
// within a few seconds by design — and "by design" is exactly the kind of promise that is one typo away from
// never being kept. So the wait has an end, and past it the model is asked with whatever is in hand.
//
// Generous, because the ordinary case must not hit it: the bridge takes up to 5.5s and gets two goes.
const AI_EVIDENCE_WAIT_MS = 16000;
const evidenceSince = new Map();     // cache key -> when we first wanted to ask
const EVIDENCE_SINCE_MAX = 200;
function aiWaitedTooLong(q) {
  const now = Date.now();
  let at = evidenceSince.get(q.key);
  if (!at) {
    if (evidenceSince.size >= EVIDENCE_SINCE_MAX) {
      const oldest = evidenceSince.keys().next();
      if (!oldest.done) evidenceSince.delete(oldest.value);
    }
    evidenceSince.set(q.key, now);
    return false;
  }
  return (now - at) > AI_EVIDENCE_WAIT_MS;
}

// Is there anything to ask with — and is everything that was ASKED FOR in hand yet?
//
// Two conditions, and the second is the one that makes the subtitles worth having at all. They arrive from
// the page bridge a few seconds after the title does, so asking the moment a title exists means every
// single video gets judged on its headline and the subtitles are fetched for nothing. That is not a
// hypothetical — it is what the extension did until this check existed, and it is visible in the answer:
// "the AI read the title, the channel, the description and the tags", on a video with captions on screen.
//
// Bounded by the page rather than by a timer here: the bridge reports a settled state within a few seconds
// whatever happens — "none" for a video with no captions, "unreadable" if it tried and failed, "nobridge"
// if the MAIN-world script is not there — so this can wait for a state without ever waiting for ever.
function aiEvidenceReady(q) {
  if (q.mode === "video") return true;         // the link is the whole request
  const meta = aiMetaFor(q.subject);
  if (!meta.title) return false;              // the one field the prompt is never built without
  // Only when the subtitles were actually asked for, and only on a video — an ordinary page has none, and
  // its stand-in is the page text, which arrives with the rest.
  if (q.isVideo && q.scope.transcript && !meta.transcriptState) return false;
  return true;
}

// Everything the model will be shown, assembled. Async because the subtitles are a fetch; everything
// else is already in hand.
async function aiTopicEvidence(state, q) {
  const meta = aiMetaFor(q.subject);
  const page = {
    videoId: q.videoId,
    title: meta.title,
    channel: "", description: "", tags: "", transcript: "", text: ""
  };
  if (q.mode === "video") return page;
  if (q.mode !== "details") return page;
  page.channel = meta.channel;
  if (q.scope.description) page.description = meta.description;
  if (q.scope.tags) page.tags = meta.tags;
  if (q.isVideo) {
    if (q.scope.transcript) {
      // Already sampled to the budget on the way in — see aiNoteMeta — so it is used as it stands rather
      // than sampled twice.
      page.transcript = meta.transcript || "";
      page.transcriptWhy = meta.transcriptState || "";
    }
  } else {
    // Not a video, so the readable text of the page stands in for the subtitles — it is the same idea
    // (what the thing actually says, rather than how it was named) reached by the only route an ordinary
    // web page offers. Gathered by the content script; see readablePageText there.
    page.text = meta.text;
  }
  return page;
}

// Start one question, unless one is already in flight or the floor says not yet.
//
// Fire and forget by design: the clock needs an answer now, not in thirty seconds, so it is told
// "pending", it does whatever "don't know" means for it, and it finds the answer on a later tick.
function aiTopicAsk(state, q) {
  const hit = aiCache.get(q.key);
  if (hit && hit.state === "pending" && Date.now() - hit.at <= FGAi.pendingMaxFor(q.mode)) return;
  // The floor. Checked BEFORE the pending stamp is written, so a request that was not made does not
  // leave a page looking as though it is being decided.
  if (Date.now() - aiLastAskAt < AI_MIN_GAP_MS) return;
  aiLastAskAt = Date.now();
  // Marked pending BEFORE anything is fetched, which is what makes this de-duplicating: a tick a second
  // from three tabs during one request must be three cache hits and one request. It matters more with
  // the deeper depths, where a check can be outstanding for a minute.
  aiCachePut(q.key, { state: "pending", mode: q.mode, at: Date.now() });
  (async () => {
    if (!(await aiHasOrigin())) return { ok: false, err: "permission" };
    const page = await aiTopicEvidence(state, q);
    return FGAi.ask({
      key: state.aiTopicKey, model: state.aiTopicModel, mode: q.mode,
      topic: q.topic, page
    });
  })().then((r) => {
    if (r && r.ok) {
      aiCachePut(q.key, {
        state: r.pct >= q.need ? "on" : "off2",
        pct: r.pct, reason: r.reason || "", read: r.read || [],
        // The per-field figures and the exact prompt, kept with the verdict so both can be shown next to
        // it. Neither is used to DECIDE anything — the decision is `pct` against the threshold, on this
        // machine — they are here so the decision can be examined.
        scores: r.scores || {}, sent: r.sent || null,
        // Which topic of the set it matched, so a video judged against several subjects at once can be
        // credited to the one card it was actually about. See videoEarnTarget.
        which: r.which || 0,
        mode: q.mode, at: Date.now()
      });
      // And one slot for the settings page, so the last request is inspectable from there too.
      aiLastSent = r.sent ? Object.assign({ at: Date.now(), topic: q.topic }, r.sent) : aiLastSent;
      // No nudge to the page, deliberately. The Anki extension sends one because its shield is painted
      // once and then sits there; here the page asks a fresh question every single second by design — the
      // tick IS the poll — so the answer is picked up on the next one whatever happens. A broadcast with
      // no listener would be a message that exists to look thorough.
      //
      // What DOES need waking is the blocker, and only when it is armed: a verdict that has just landed
      // as "off topic" is a page that should be taken away now rather than at the next minute tick.
      // The video gate counts here as much as aiTopicBlocks does — more, in fact, since it is on by
      // default. Without it a refused video would sit playing until the next minute tick.
      const settled = aiCache.get(q.key);
      if (settled && settled.state === "off2" &&
          (state.aiTopicBlocks === true || state.aiTopicVideoGate === true)) {
        sweepSoon(0);
      }
    } else {
      const err = (r && r.err) || "error";
      aiCachePut(q.key, { state: "error", err, detail: (r && r.detail) || "", mode: q.mode, at: Date.now() });
      aiLastError = { err, status: (r && r.status) || 0, detail: (r && r.detail) || "", at: Date.now() };
    }
  }).catch(() => {
    aiCachePut(q.key, { state: "error", err: "error", mode: q.mode, at: Date.now() });
  });
}

// What the page should bother gathering, or null for "nothing".
//
// Told rather than worked out on the page, and for the reason every other verdict in this file is told
// rather than inferred: what gets read is the result of four conditions — the switch, a key existing,
// this row having a topic, and the depth — and a content script deciding for itself would be a second
// implementation of that rule, free to disagree with the one that actually judges. It also means a page
// with nothing to contribute reads nothing at all, which matters: this runs on every site.
function aiWantMeta(state, url, ctx) {
  const topical = aiTopicReady(state) && ctx && Array.isArray(ctx.topics) && ctx.topics.length > 0;
  // The classifier wants a title too, and asks for nothing else.
  //
  // Its own branch rather than a condition folded into the one below, because it needs a hundredth of what
  // the topic check needs: a host name is already a fair question — "what is youtube.com" needs no page at
  // all — and the title is only there to settle the ambiguous cases. So a profile running the classifier
  // and not the topic check reads one string per page rather than scraping descriptions and transcripts.
  if (!topical) {
    if (aiCatReady(state) && catHostOf(url)) {
      return { title: true, channel: false, description: false, tags: false, transcript: false, text: false };
    }
    return null;
  }
  const isVideo = FGAi.isVideo(url);
  const wanted = FGAi.modeOf(state);
  const mode = (wanted === "video" && !isVideo) ? "details" : wanted;
  // Truly nothing: the model is fetching the video itself, and scraping the page as well would break the
  // one promise that mode makes.
  if (mode === "video") return null;
  const scope = FGAi.scopeFor(state, mode);
  return {
    // Always, in every depth. It is `document.title`, so it costs nothing, and it is the one field the
    // prompt is never built without.
    title: true,
    channel: isVideo,
    description: scope.description === true,
    tags: scope.tags === true,
    // The video's own subtitles, asked of the page bridge.
    //
    // THIS KEY WAS MISSING, and its absence is the whole of "it sits on 2/5 · Fetching the captions for
    // ever". The page only asks the bridge when this says to (`if (wantMeta.transcript) ensureTranscript()`),
    // so with no such key the question was never asked, the state never settled, and aiEvidenceReady — which
    // deliberately waits for a settled state before spending a request — waited for something that could not
    // arrive. Every visible symptom followed from one absent line: the panel stuck on step 2, the video held
    // for ever, and no analysis at all.
    transcript: isVideo && scope.transcript === true,
    // A page that is not a video has no subtitles, so its readable text stands in for them — the same
    // question ("what does this actually say, as opposed to how was it named") reached by the only route
    // an ordinary web page offers. Governed by the same switch because it is the same decision.
    text: !isVideo && scope.transcript === true
  };
}

// ---- what KIND of site is this? -------------------------------------------------------------------
//
// The category classifier. A much smaller question than the topic check above, and a different one: that
// asks "is this page about what you said you'd study" and governs EARNING; this asks "what sort of site is
// this" and governs BLOCKING.
//
// Three things make it a separate piece of machinery rather than another mode of the topic check:
//
//   It is keyed on the HOST, not the page. "youtube.com is a video site" is true of every address on it,
//   so one question covers a whole domain for good — where a topic verdict has to be re-decided for every
//   new path. That is the entire reason this is affordable.
//
//   Its cache lives in STORAGE. A category does not stop being true when Chrome evicts the worker, and
//   re-asking after every eviction would spend a free daily allowance on questions already answered.
//
//   It has its own request floor. The topic check's floor exists to survive a site that rewrites its
//   address as you work; this one asks at most once per domain ever, so the two must not be able to
//   starve each other out of one shared counter.

// How many classifications to remember, and for how long. Generous on both: a domain's category is about
// as stable a fact as this extension deals in, and the cost of forgetting one is a wasted request.
const AI_CAT_SEEN_MAX = 600;
const AI_CAT_FRESH_MS = 60 * 24 * 3600 * 1000;      // 60 days
// Hosts asked about in this worker's lifetime, so a page that reloads every second cannot re-ask while the
// first answer is still travelling. In memory, unlike the answers: this is about right now.
const catPending = new Map();                       // host -> when the request went out
const CAT_PENDING_MAX = 120;
const CAT_PENDING_MS = 30000;                       // past this, assume it died and let another go
// Failures, with a cooldown, so one bad key does not become a request per navigation.
const catError = new Map();                         // host -> { err, at }
const CAT_ERROR_COOLDOWN_MS = 5 * 60 * 1000;
let catLastAskAt = 0;
const CAT_MIN_GAP_MS = 2500;
let catLastError = null;

// Is the classifier running at all? The last condition is the one that keeps it safe: with neither list
// holding a category, nothing is being asked about and every site behaves exactly as it always did.
function aiCatReady(state) {
  const s = state || {};
  if (!aiOk()) return false;
  if (s.aiCatEnabled !== true) return false;
  if (s.enabled === false) return false;
  if (!String(s.aiTopicKey || "").trim()) return false;
  return catWanted(s).length > 0;
}
// Every category either list names, de-duplicated. What the model is offered, and nothing more: asking it
// to sort a site into categories nobody has an opinion about would be paying for an answer to throw away.
function catWanted(state) {
  const s = state || {};
  const out = [], seen = new Set();
  for (const id of [...(Array.isArray(s.aiCatBlock) ? s.aiCatBlock : []),
                    ...(Array.isArray(s.aiCatAllow) ? s.aiCatAllow : [])]) {
    const k = String(id || "");
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push(k);
  }
  return out;
}
// Those ids as the {id, name} pairs the prompt wants. Read from the shared list, so the names the model
// reasons about are the names on the buttons.
function catPromptList(state) {
  const all = (self.FGSettings && self.FGSettings.SITE_CATEGORIES) || [];
  const want = new Set(catWanted(state));
  return all.filter(c => want.has(c.id)).map(c => ({ id: c.id, name: c.name }));
}
// The host a classification is filed under. Bare, lowercased, no "www." — so one site is one question
// however it was reached.
function catHostOf(url) {
  try {
    const u = new URL(String(url || ""));
    if (u.protocol !== "http:" && u.protocol !== "https:") return "";
    return u.hostname.toLowerCase().replace(/\.+$/, "").replace(/^www\./, "");
  } catch { return ""; }
}

// What is ALREADY KNOWN about this host. Synchronous, for the same reason aiTopicCached is: the blocker
// decides inside a navigation listener and cannot wait on a model.
//
//   { state: "off" }                 nothing to classify against
//   { state: "pending" }             asked, no answer yet
//   { state: "known", cats, reason } classified
//   { state: "error", err }          asked and failed
function aiCatCached(state, url, start) {
  if (!aiCatReady(state)) return { state: "off" };
  const host = catHostOf(url);
  if (!host) return { state: "off" };
  const seen = (state.aiCatSeen && typeof state.aiCatSeen === "object") ? state.aiCatSeen[host] : null;
  if (seen && Array.isArray(seen.c) && (Date.now() - (Number(seen.at) || 0)) < AI_CAT_FRESH_MS) {
    return { state: "known", cats: seen.c, reason: String(seen.r || ""), host };
  }
  const err = catError.get(host);
  if (err && Date.now() - err.at < CAT_ERROR_COOLDOWN_MS) return { state: "error", err: err.err, host };
  const out = catPending.get(host);
  if (out && Date.now() - out < CAT_PENDING_MS) return { state: "pending", host };
  // READ ONLY for every caller that cannot afford to start something — which is all of the blocking
  // paths, exactly as with the topic check. The tick is what starts a question, because the tick is what
  // has the page's title in hand.
  if (start === false) return { state: "pending", host };
  aiCatAsk(state, host, url);
  return { state: "pending", host };
}

// Start one classification. Fire and forget.
function aiCatAsk(state, host, url) {
  if (!host) return;
  const out = catPending.get(host);
  if (out && Date.now() - out < CAT_PENDING_MS) return;
  if (Date.now() - catLastAskAt < CAT_MIN_GAP_MS) return;
  const cats = catPromptList(state);
  if (!cats.length) return;
  catLastAskAt = Date.now();
  if (catPending.size >= CAT_PENDING_MAX) {
    const oldest = catPending.keys().next();
    if (!oldest.done) catPending.delete(oldest.value);
  }
  catPending.set(host, Date.now());
  (async () => {
    if (!(await aiHasOrigin())) return { ok: false, err: "permission" };
    // Whatever the page happened to tell us, and nothing is waited for. That is the deliberate difference
    // from the topic check, which holds off until a title exists: a HOST NAME is already a fair question —
    // "what is youtube.com" needs no page at all — so stalling for evidence would mean a site could never
    // be classified until a content script had run on it, and the whole point is to catch sites before
    // they are opened properly.
    const meta = aiMetaFor(FGAi.subjectKey(url) || "");
    return FGAi.askCategory({
      key: state.aiTopicKey, model: state.aiTopicModel, cats,
      page: { host, title: meta.title || "", description: meta.description || "" }
    });
  })().then(async (r) => {
    catPending.delete(host);
    if (r && r.ok) {
      catError.delete(host);
      // Written into storage, pruned oldest-first. Re-read rather than taken from the `state` this closure
      // captured: the request took seconds, and another host may well have been written in the meantime.
      try {
        const fresh = await getState();
        const seen = (fresh.aiCatSeen && typeof fresh.aiCatSeen === "object") ? { ...fresh.aiCatSeen } : {};
        seen[host] = { c: r.cats || [], r: r.reason || "", at: Date.now() };
        const keys = Object.keys(seen);
        if (keys.length > AI_CAT_SEEN_MAX) {
          keys.sort((a, b) => (Number(seen[a].at) || 0) - (Number(seen[b].at) || 0));
          for (const k of keys.slice(0, keys.length - AI_CAT_SEEN_MAX)) delete seen[k];
        }
        await setState({ aiCatSeen: seen });
      } catch {}
      // A site that has just been classified into a blocked category is a tab to take away now rather than
      // at the next minute tick. Only when it actually matters — a verdict that changes nothing should not
      // wake the blocker.
      const blockSet = new Set(Array.isArray(state.aiCatBlock) ? state.aiCatBlock : []);
      if ((r.cats || []).some(c => blockSet.has(c)) || state.blockMode === "whitelist") sweepSoon(0);
    } else {
      const err = (r && r.err) || "error";
      if (catError.size >= CAT_PENDING_MAX) {
        const oldest = catError.keys().next();
        if (!oldest.done) catError.delete(oldest.value);
      }
      catError.set(host, { err, at: Date.now() });
      catLastError = { err, status: (r && r.status) || 0, detail: (r && r.detail) || "", at: Date.now() };
    }
  }).catch(() => {
    catPending.delete(host);
    catError.set(host, { err: "error", at: Date.now() });
  });
}

// The classifier's opinion about this URL, as a block reason — or null for "no opinion, carry on with the
// ordinary rules".
//
// Two answers it can give, and they are NOT symmetrical:
//
//   A blocked category   -> blocked. Only ever on a settled classification: pending, error and "I don't
//                           recognise this site" all return null and leave the page alone, because taking
//                           a site away on a verdict nobody reached is the one failure this must not have.
//
//   An allowed category  -> { blocked: false }, and only in whitelist mode, where it plays exactly the
//                           part an entry in the allowed list plays. In blocklist mode it would be an
//                           exemption nobody asked for, so it is not offered.
function aiCatVerdict(url, state) {
  const v = aiCatCached(state, url, false);
  if (v.state !== "known") return null;
  const cats = v.cats || [];
  if (!cats.length) return null;                       // the model did not recognise the site
  const blockSet = new Set(Array.isArray(state.aiCatBlock) ? state.aiCatBlock : []);
  const hit = cats.find(c => blockSet.has(c));
  if (hit) {
    return {
      blocked: true, gate: "category", hasTargets: true,
      catId: hit, catReason: v.reason || "", catHost: v.host || ""
    };
  }
  if (state.blockMode === "whitelist") {
    const allowSet = new Set(Array.isArray(state.aiCatAllow) ? state.aiCatAllow : []);
    if (cats.some(c => allowSet.has(c))) return { blocked: false };
  }
  return null;
}

// A page ON a target that the topic check has settled is NOT the topic — as a block reason, or null.
//
// Its own function because two callers need exactly the same answer and they reach the target by
// different routes. getBlockReason matches on the URL alone; the tick matches with the channel and
// playlist the content script read out of the DOM as well, which catches a watch page inside a tracked
// channel that the URL says nothing about. Two copies of this rule would be two ways for the tab to be
// taken away in one place and left alone in the other.
//
// Only ever a settled "off2". Pending, error, no key, no topic — every one of those returns null and
// leaves the page exempt, because taking a page away on the strength of a verdict nobody has reached yet
// is the one failure this feature must not have.
function offTopicBlock(state, url, target) {
  if (!target) return null;
  if (!state || state.aiTopicBlocks !== true) return null;
  const ctx = topicContextFor(state, url, target);
  if (!ctx || ctx.kind !== "target") return null;
  // `false` — READ ONLY, never start a request. This runs on every navigation and once a minute across
  // every open tab, and none of those callers has the page's own title, description or text in hand: the
  // tick does. A question asked from here would be asked with less evidence and then cached under the
  // page's name, so the sweep would be deciding what the clock has to live with. The tick asks; this
  // reads.
  const v = aiTopicCached(state, url, ctx, false);
  if (v.state !== "off2") return null;
  return {
    blocked: true, gate: "offtopic", target, hasTargets: true,
    aiPct: v.pct, aiNeed: v.need, aiReason: v.reason || "", aiRead: v.read || [], topic: v.topic
  };
}

// ---- the gate: is this video about anything you are studying? ----
//
// The half that was missing, and the reason the feature appeared to do nothing at all: a topic that only
// applies to sites you already nominated as work cannot keep you off the sites you did not. YouTube is
// usually on neither list, so nothing looked at it.
//
// Returns null for "no opinion, carry on with the ordinary rules" — which is the answer for every URL
// that is not a YouTube video, and for YouTube's own home page, search and channel pages, which stay
// governed by your blocked list exactly as before. Gating those would be a much bigger promise than the
// one being made here, and it is not the one that was asked for.
//
// The interesting part is that a MATCHING video comes back `{ blocked: false }` rather than null, so it
// stops the walk. That is the whole point rather than an accident: it means a video about your subject
// opens even with youtube.com on your blocked list, which is what makes this usable — otherwise the only
// way to study from YouTube would be to leave the whole site open.
function videoTopicVerdict(url, state) {
  if (!videoGateActive(state)) return null;
  if (!FGAi.isVideo(url)) return null;
  const ctx = topicContextFor(state, url, null);
  if (!ctx) return null;
  // READ ONLY. This runs on every navigation and once a minute across every open tab, and none of those
  // callers has the video's title in hand — the tick does, and the tick is what starts the question. See
  // topicKick.
  const v = aiTopicCached(state, url, ctx, false);
  // It matches. Allowed, and allowed OVER the blocked list — see the note above. This is the only answer
  // here that stops the walk, and it is the only one that should: it is the exemption that makes the
  // feature usable at all.
  if (v.state === "on") return { blocked: false };
  // EVERYTHING ELSE answers null — "no opinion, carry on with the ordinary rules" — including a video the
  // model has just refused. That looks wrong at a glance and it is the whole point:
  //
  //   A refused video costs you the PLAYER, not the page. It used to redirect the whole tab to the blocked
  //   screen, which threw away the search results you found it with, the sidebar, the playlist you were
  //   working through and your place in all three, in order to refuse one <video> element. So the element
  //   is what gets covered now — by the content script, the only thing that can reach into a page — and
  //   this function stops having an opinion about the TAB. See videoShieldFor, and armShieldWatch for the
  //   fallback that still takes the page away if no content script is there to cover anything.
  //
  //   "pending" nobody has decided yet. Blocking on a verdict that does not exist is the one failure this
  //             must not have — and neither may an undecided video be handed the exemption above, or
  //             youtube.com on your blocked list would come open for the two seconds before every verdict,
  //             which is a bypass with a timer on it.
  //
  //   "error"   no key, quota spent, no network. With the check unable to run, YouTube behaves precisely
  //             as it would with the whole feature switched off. Answering `{ blocked: false }` here would
  //             mean an outage at Google silently unlocked a site somebody had deliberately locked.
  return null;
}

// ---- which card, if any, a matching video earns time for ----
//
// The heart of "watch a German lesson and your German card fills". Returns the card to credit, or null for
// "nothing to earn here" — which is the answer for every URL that is not a settled, on-topic video while the
// earn half is running.
//
// READ ONLY, and it must be: this is consulted from the tick to decide crediting, and from the pause path to
// decide whose stamp to drop. Starting a request from here would spend one on a question the gate is already
// asking with better evidence — the tick's own topicKick is the one caller that starts it. See aiTopicCached
// with start=false.
//
// The mapping from verdict to card is the `w` index the model returned: the video was scored against the
// whole set of live topics at once, and `which` says which one it landed on. That index points into the
// SAME de-duplicated topic list the question was built from — so it is turned back into the card that owns
// that topic here. A model that omits the index, or gives one out of range, falls back to the first live
// topic rather than crediting nothing, because a video the gate called on-topic has earned SOMETHING and the
// worst answer is to silently drop it.
function videoEarnTarget(state, url) {
  if (!videoEarnActive(state)) return null;
  if (!FGAi.isVideo(url)) return null;
  const ctx = topicContextFor(state, url, null);
  // Only the gate's context earns from a video. A target's own topic is the earning it always had — time on
  // that site — and is credited by the ordinary match, not here.
  if (!ctx || ctx.kind !== "gate") return null;
  const v = aiTopicCached(state, url, ctx, false);
  if (!v || v.state !== "on") return null;
  const topics = Array.isArray(v.topics) ? v.topics : [];
  if (!topics.length) return null;
  let idx = Number.isInteger(v.which) ? v.which : 0;
  if (idx < 0 || idx >= topics.length) idx = 0;
  const matched = String(topics[idx] || topics[0] || "").toLowerCase();
  if (!matched) return null;
  // The window-aware set again, so a card that has just fallen outside its hours cannot be credited by a
  // verdict that is still cached from a minute ago. If two cards share the exact same sentence the first
  // one in the list takes it, which is arbitrary but harmless — they are the same subject by definition.
  const cards = ytTopicTargets(state);
  return cards.find(t => String(FGAi.topicOf(t) || "").toLowerCase() === matched) || null;
}

// ---- videos inside Google Search ----
//
// Google plays YouTube without ever leaving the results page: a trailer in a pop-up, a short in its viewer, a
// clip in an AI Overview. Every one of those is the YouTube player in an <iframe>, so none of them is a
// youtube.com address and the gate never saw them. The page now reports the id of each YouTube player it
// finds (see the Google section of content.js), and each is judged here exactly as if it had been opened on
// YouTube: the same question, the same cache, the same verdict, the same panel drawn over it.
//
// Search hosts only — www.google.<tld> and google.<tld>. Gmail, Docs and the rest are Google's too, but they
// are not where anybody goes looking for something to watch, and gating them is a wider promise than this.
function isGoogleSearchUrl(url) {
  try {
    const u = new URL(String(url || ""));
    if (u.protocol !== "https:" && u.protocol !== "http:") return false;
    return /^(www\.)?google\.[a-z]{2,3}(\.[a-z]{2})?$/i.test(u.hostname);
  } catch { return false; }
}

// What YouTube itself says a video is called, for videos seen only inside Google.
//
// A page that only frames the player cannot read it — it is another origin — so the title a question is never
// asked without has to come from somewhere else. oEmbed is YouTube's own public answer to "what is video X":
// the title and the channel, no key, and no cookies sent. It goes to youtube.com, which is already serving
// that very player to this browser, so nobody new learns anything.
const ytEmbedInfo = new Map();          // video id -> { state: "pending" | "ok" | "fail", title, author, at }
const YT_EMBED_INFO_MAX = 300;
const YT_OEMBED_MS = 8000;
const YT_OEMBED_RETRY_MS = 5 * 60 * 1000;
// Filed under the video's own subject, so it is the same record a YouTube watch page would grow. QUIET, so
// the settings page's subtitles line is not told "unavailable" about what is only a fact about Google.
function googleNoteMeta(subject, title, author) {
  if (!subject || !title) return;
  const have = aiMetaFor(subject);
  aiNoteMeta(subject, {
    title, channel: author || "",
    // The subtitles cannot be reached from a page that only frames the player, so they are settled as
    // unavailable — otherwise the check would wait for a transcript that is never coming. Never overwrites
    // a state YouTube itself already reported for this video.
    transcriptState: have.transcriptState ? "" : "unreadable"
  }, true);
}
function ytEmbedFetch(id, vurl, domTitle) {
  if (!ytEmbedInfo.has(id) && ytEmbedInfo.size >= YT_EMBED_INFO_MAX) {
    const oldest = ytEmbedInfo.keys().next();
    if (!oldest.done) ytEmbedInfo.delete(oldest.value);
  }
  ytEmbedInfo.set(id, { state: "pending", at: Date.now() });
  const subject = FGAi.subjectKey(vurl);
  // Rebuilt from the validated id, never passed through from the page.
  const api = "https://www.youtube.com/oembed?format=json&url=" + encodeURIComponent(vurl);
  FGAi.fetchSoon(api, { method: "GET", credentials: "omit" }, YT_OEMBED_MS)
    .then(res => (res && res.ok) ? res.json() : null)
    .then(j => {
      const title = FGAi.clean(j && j.title, FGAi.TITLE_MAX);
      const author = FGAi.clean(j && j.author_name, FGAi.CHANNEL_MAX);
      if (!title) throw new Error("no title");
      ytEmbedInfo.set(id, { state: "ok", title, author, at: Date.now() });
      googleNoteMeta(subject, title, author);
    })
    .catch(() => {
      ytEmbedInfo.set(id, { state: "fail", at: Date.now() });
      // The page's own name for it, when it had one. A fallback and no more.
      if (domTitle) googleNoteMeta(subject, domTitle, "");
    })
    .then(async () => {
      // The evidence has just arrived, so ask now rather than at the next tick.
      try {
        const s = await getState();
        topicKick(s, vurl, topicContextFor(s, vurl, null));
      } catch {}
    });
}
// Is there something to judge this video by? "ok" | "pending" (YouTube is being asked) | "fail" (nothing).
function googleVideoEvidence(id, vurl, domTitle) {
  const subject = FGAi.subjectKey(vurl);
  if (aiMetaFor(subject).title) return "ok";             // already described — by YouTube itself, or earlier
  const info = ytEmbedInfo.get(id);
  const age = info ? Date.now() - info.at : Infinity;
  if (info && info.state === "ok") { googleNoteMeta(subject, info.title, info.author); return "ok"; }
  if (info && info.state === "pending" && age < YT_OEMBED_MS + 4000) return "pending";
  if (info && info.state === "fail" && age < YT_OEMBED_RETRY_MS) {
    if (domTitle) { googleNoteMeta(subject, domTitle, ""); return "ok"; }
    return "fail";
  }
  ytEmbedFetch(id, vurl, domTitle);
  return "pending";
}
// The panel for each video the page reported, as [{ id, shield }]. A shield is exactly what videoShieldFor
// gives a video on YouTube, so the two covers can never disagree about the same video.
async function googleVideoShields(state, pageUrl, list) {
  if (!aiOk() || !isGoogleSearchUrl(pageUrl) || !videoGateActive(state)) return [];
  const out = [];
  const seen = new Set();
  for (const raw of list.slice(0, 4)) {
    const id = String((raw && raw.id) || "");
    if (!/^[A-Za-z0-9_-]{11}$/.test(id) || seen.has(id)) continue;
    seen.add(id);
    const vurl = "https://www.youtube.com/watch?v=" + id;
    const domTitle = FGAi.clean(raw && raw.title, FGAi.TITLE_MAX);
    const ev = googleVideoEvidence(id, vurl, domTitle);
    topicKick(state, vurl, topicContextFor(state, vurl, null));
    let shield = videoShieldFor(vurl, state);
    // Nothing to judge it with — YouTube would not name it and the page did not either. Released, like any
    // other check that cannot run. "Watch the video" needs no title, so it is the one depth exempt.
    if (shield && shield.state === "pending" && ev === "fail" && FGAi.modeOf(state) !== "video") shield = null;
    // Counted in the "saved" tally like a refusal on YouTube. Once per video; see noteVideoSkip.
    if (shield && shield.state === "off") { try { await noteVideoSkip(state, vurl, 0); } catch {} }
    out.push({ id, shield });
  }
  return out;
}

// ---- what the check is doing right now, for the panel on the player ----
//
// Both halves are read off the SAME state the check itself reads, rather than being reported by whichever
// bit of code happens to be running. That is the property worth having: a progress display fed by its own
// timer makes a stall look like work, and a stall is precisely the case somebody is staring at the screen
// trying to understand.

// One row per thing this check may look at, and how that is going.
function videoFields(state, q) {
  const meta = aiMetaFor(q.subject);
  const rows = [];
  const add = (key, on, st) => rows.push({
    key, label: FGAi.FIELD_LABELS[key] || key, on: !!on,
    state: st, text: FGAi.fieldStateText(st)
  });
  if (q.mode === "video") {
    // Nothing on the page is read at all — the model opens the video itself — so there is one row.
    add("title", true, "found");
    return rows;
  }
  // Always on, and the one field the prompt is never built without.
  add("title", true, meta.title ? "found" : "waiting");
  if (q.isVideo) add("channel", true, meta.channel ? "found" : "waiting");
  // "absent" rather than "waiting" once the title has landed: these arrive in the same report, so a title
  // with no description beside it means the page has not GOT one rather than has not sent it yet.
  add("description", q.scope.description,
      !q.scope.description ? "off" : (meta.description ? "found" : (meta.title ? "absent" : "waiting")));
  add("tags", q.scope.tags,
      !q.scope.tags ? "off" : (meta.tags ? "found" : (meta.title ? "absent" : "waiting")));
  if (q.isVideo) {
    // The subtitles have four ways of not being there and they are worth telling apart on screen: one is a
    // setting, one is a fact about the video, one is YouTube refusing, and one is this extension's own
    // page script not having loaded. Only the last is something anybody can act on.
    let st = "off";
    if (q.scope.transcript) {
      const why = meta.transcriptState || "";
      st = why === "ok" ? "found"
         : why === "none" ? "none"
         : why === "unreadable" ? "unreadable"
         : why === "nobridge" ? "nobridge"
         : "fetching";
    }
    add("transcript", q.scope.transcript, st);
  } else {
    add("text", q.scope.transcript,
        !q.scope.transcript ? "off" : (meta.text ? "found" : (meta.title ? "absent" : "waiting")));
  }
  return rows;
}

// The field rows for a SETTLED verdict: what was read, and what the model made of each part.
//
// Built from the same list the progress panel uses, so a row cannot appear during the check and vanish from
// the result. Rows the user switched off are dropped here, though — during the check "Description off" is
// useful (it explains what is not being looked at), and in the result it is noise beside the numbers that
// actually decided.
function verdictFields(state, url, ctx, v) {
  const q = aiTopicQuestion(state, url, ctx);
  if (!q) return [];
  const scores = (v && v.scores) || {};
  return videoFields(state, q)
    .filter(f => f.on)
    .map(f => {
      const n = scores[f.key];
      return {
        key: f.key, label: f.label, on: true, state: f.state,
        // The percentage where the model gave one, and the gathering state where it did not — a field with
        // no score was not scored, and showing it as 0% would invent an opinion the model never expressed.
        pct: (typeof n === "number") ? n : null,
        text: (typeof n === "number") ? (n + "%") : FGAi.fieldStateText(f.state)
      };
    });
}

// Which step the check is on, worked out from what has actually happened.
function videoProgress(state, q) {
  const hit = aiCache.get(q.key);
  let key;
  if (hit && (hit.state === "on" || hit.state === "off2")) key = "done";
  else if (hit && hit.state === "pending") key = "think";
  else if (aiEvidenceReady(q)) key = "send";
  else if (q.mode === "details" && q.isVideo && q.scope.transcript && aiMetaFor(q.subject).title) key = "captions";
  else key = "read";
  const steps = FGAi.stepsFor(q.mode);
  return {
    fields: videoFields(state, q),
    step: { key, at: FGAi.stepIndex(q.mode, key), of: steps.length, label: FGAi.stepLabel(q.mode, key) },
    mode: q.mode
  };
}

// What the page should put over the player, or null for "nothing".
//
// Its own function, and separate from the verdict above, because they answer different questions: that one
// is "should this TAB be taken away", this one is "what should cover this PLAYER". Folding them together is
// what produced a version where an undecided video inherited a matching one's exemption from the blocked
// list — two answers coming out of one return value, one of them wrong.
function videoShieldFor(url, state) {
  if (!videoGateActive(state)) return null;
  if (!FGAi.isVideo(url)) return null;
  const ctx = topicContextFor(state, url, null);
  if (!ctx) return null;
  const v = aiTopicCached(state, url, ctx, false);
  if (v.state === "off2" || v.state === "on") {
    // BOTH verdicts get a panel now, and the ALLOWED one is the addition that matters.
    //
    // Until this, a video that passed simply had the cover taken off it — so the entire check was invisible
    // on every video it allowed: no score, no reason, nothing. And "the AI read it and thought 88%" looks
    // exactly like "the check never ran" when the answer is silence, while those two need opposite responses
    // from the user. So a pass says its number out loud, exactly like a refusal.
    //
    // The page shows the allowed one for a few seconds and lets go; only the refusal stays. See
    // setVideoShield in content.js.
    return {
      state: v.state === "on" ? "on" : "off",
      topics: v.topics || [], pct: v.pct, need: v.need,
      reason: v.reason || "", read: v.read || [],
      // Per-field figures, so "which part of the video did this rest on" has an answer on screen.
      fields: verdictFields(state, url, ctx, v),
      // Whether there is a prompt to show. The prompt itself is fetched on demand — see the aiTopicPrompt
      // message — rather than pushed with every tick, because it can be tens of thousands of characters.
      hasSent: !!v.hasSent,
      mode: v.mode
    };
  }
  // Being judged. The panel that goes up for this is a small one in the corner of the player, not a cover
  // over it, and it carries the STEPS and the FIELDS — see videoProgress. A held video with no explanation
  // is indistinguishable from a broken extension, which is exactly what it was mistaken for.
  if (v.state === "pending") {
    const q = aiTopicQuestion(state, url, ctx);
    return Object.assign({ state: "pending", topics: v.topics || [], need: v.need },
                          q ? videoProgress(state, q) : {});
  }
  // An error puts nothing over the player. The check could not run, so there is nothing to report and no
  // grounds to withhold anything.
  return null;
}

// ---- what the gate has turned away, as a real number ------------------------
//
// The cover over a refused player says how much watching it just spared you. That sentence is either true or
// it is the worst thing on the screen, so the figure is a tally of videos actually refused rather than
// arithmetic done at paint time.
//
// Counted ONCE per video, and this is the whole difficulty: the tick fires every second, on every open tab,
// and it would otherwise add the same forty-minute lecture to the total forty times a minute. So a subject
// that has been counted is remembered and skipped.
//
// In MEMORY, not in storage, and the consequence is stated rather than hidden: when the worker is evicted
// this set goes with it, so a video still covered when that happens can be counted a second time. The
// alternative is a list of watched video ids written to disk and pruned for ever, which is a great deal of
// machinery to make a motivational counter slightly less approximate. It only ever over-counts, never
// under-counts, and it cannot affect a verdict — nothing reads these two numbers except the words on a
// panel.
const vidSkipSeen = new Set();
const VID_SKIP_SEEN_MAX = 400;
// A video's length, as the page read it off its own <video> element. Clamped hard: it arrives in a message
// from a content script, and twelve hours is longer than anything anybody is being spared.
const VID_SKIP_SEC_MAX = 12 * 3600;
function vidSkipSecOf(raw) {
  const n = Math.round(Number(raw) || 0);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.min(VID_SKIP_SEC_MAX, n);
}
async function noteVideoSkip(state, url, rawSec) {
  const total = {
    count: Math.max(0, Number(state.vidSkipCount) || 0),
    sec: Math.max(0, Number(state.vidSkipSec) || 0),
    // This video's own length, sent every tick, so the panel can say what it is sparing you right now. Zero
    // when the page could not read it — the panel drops the line rather than guessing.
    thisSec: vidSkipSecOf(rawSec)
  };
  // Only a settled refusal counts, and only while the gate is actually on. A pending verdict has refused
  // nothing yet and an error has refused nothing at all.
  if (!videoGateActive(state) || !FGAi.isVideo(url)) return total;
  let subject = "";
  try { subject = FGAi.subjectKey(url); } catch { return total; }
  if (!subject || vidSkipSeen.has(subject)) return total;
  const ctx = topicContextFor(state, url, null);
  if (!ctx) return total;
  // `false` — look at what is already known and start nothing. This runs on the tick; a counter must never
  // be the reason a request goes out.
  const v = aiTopicCached(state, url, ctx, false);
  if (!v || v.state !== "off2") return total;
  if (vidSkipSeen.size >= VID_SKIP_SEEN_MAX) {
    const oldest = vidSkipSeen.values().next();
    if (!oldest.done) vidSkipSeen.delete(oldest.value);
  }
  vidSkipSeen.add(subject);
  const next = {
    count: total.count + 1,
    // Seconds only when the page actually knew the duration. A video whose length never rendered adds to
    // "how many" and not to "how long", which is the honest split — better a total that is a little low
    // than one padded with a default.
    sec: total.sec + total.thisSec
  };
  try { await setState(next); } catch {}
  return { count: next.count, sec: next.sec, thisSec: total.thisSec };
}

// Start the gate's question for this video, if it needs starting. Fire and forget.
//
// Called from the tick and nowhere else, because the tick is the only caller that has the page's own
// title, description and subtitles to ask WITH. Every other consumer reads what this leaves behind.
function topicKick(state, url, ctx) {
  if (!ctx) return;
  try { aiTopicCached(state, url, ctx); } catch {}
}

// The same, for the category classifier. Its own function rather than a line inside the one above, because
// it fires on a completely different set of pages: topicKick only ever runs where a topic applies, and this
// has to run on every ordinary website — which is precisely the set the topic check ignores.
//
// Also from the tick and nowhere else, and for a slightly different reason. The classifier does not NEED the
// page (a host name is a fair question on its own), but the tick is the one caller that is not on a
// navigation path, and a request started from a navigation listener would be a request started while
// somebody is waiting for a page to paint.
function catKick(state, url) {
  if (!aiCatReady(state)) return;
  try { aiCatCached(state, url); } catch {}
}

// The clock's own question, in one word.
//
// Returns "" when the seconds should keep counting, or the sentence to show on the card when they should
// not. Everything that is not a settled "this is not the topic" comes back as "" — no topic on this row,
// no key, a quota spent, a network down, a model talking nonsense — because the answer this replaces is
// "the page counts", and an outage must not be able to stop somebody's study clock.
//
// `aiTopicStrict` is the one setting that changes that, and only for the few seconds a page is genuinely
// being decided. See DEFAULTS for why it is off.
function aiTopicPause(state, url, target) {
  if (!aiTopicReady(state)) return "";
  // The TARGET's own context only. The clock is about earning time on a work site, and the video gate
  // does not touch it: a page that is not a target is crediting nothing, so there is nothing there to
  // withhold. Handing the gate's context in here would mean an off-topic YouTube video "paused" a clock
  // that was never running.
  const ctx = topicContextFor(state, url, target);
  if (!ctx || ctx.kind !== "target") return "";
  const v = aiTopicCached(state, url, ctx);
  if (v.state === "off2") {
    // Named, so the card says which topic was missed rather than "off topic" — with several targets in
    // play, "off topic" leaves you working out which promise you are being held to.
    const short = v.topic.length > 42 ? v.topic.slice(0, 42) + "…" : v.topic;
    return "not about " + short;
  }
  if (v.state === "pending" && state.aiTopicStrict === true) return "checking this page…";
  return "";
}

// ---------- blocking ----------

// Sequence mode: is this work page the one you are supposed to be on?
//
// The second of the two ways a study site can lose its own exemption, and deliberately built to the
// same shape as the first (offTopicBlock, above): opt-in, only ever consulted about a page that was
// ALREADY on a target, and returning null for everything it has no business deciding. A study site is
// exempt from the blocking by default and that promise is only ever withdrawn on purpose.
//
// Where offTopicBlock withdraws it over WHAT you are doing there, this one withdraws it over WHEN.
// The list becomes ordered work: step one is the only row open, and when it is finished it closes and
// step two opens. Three rows therefore means three sittings rather than three tabs, which is the whole
// of what the feature buys — you cannot keep all of today's work half-started.
//
// `activeTargets`, so the sequence is built out of today's rows only. A row switched off, left at zero,
// or not scheduled for today is invisible to the sequence exactly as it is invisible to everything
// else, and it neither occupies a step nor waits for one.
//
// Nothing here can block a page that was not already exempt: `onTarget` arrives from
// findProductiveMatch, which is itself filtered by activeTargets, so the worst this can do is hand a
// work page back to the ordinary rules.
function sequenceBlock(state, url, onTarget) {
  if (!onTarget) return null;
  if (!state || state.sequenceMode !== true) return null;
  const F = self.FGSettings;
  // settings.js failed to load. Every other consumer of that file degrades to "as it was before the
  // feature existed", and this is that: no sequence, so no study site loses its exemption.
  if (!F || !F.inCurrentStep || !F.currentStepGroup) return null;
  const sites = activeTargets(state.productiveSites);
  if (sites.length < 2) return null;            // one step cannot be out of order
  if (F.inCurrentStep(onTarget, sites)) return null;
  const step = F.currentStepGroup(sites);
  // No current step at all — everything finished, or everything left is out of time. inCurrentStep
  // already answers `true` in that case, so this is belt and braces: a sequence with nowhere to point
  // must never be the reason a page is shut, because the blocked page would have no way out to offer.
  if (!step.length) return null;
  return {
    blocked: true,
    gate: "sequence",
    target: onTarget,
    // The row to go and do instead. The FIRST alternative of the current step when there are several:
    // the blocked page draws the whole step anyway, so this only decides which one the button points
    // at, and the top one is the one the user put first.
    next: step[0],
    step: F.stepNumberOf(step[0], sites),
    steps: F.stepCount(sites),
    hasTargets: true
  };
}

// Returns a structured reason describing whether/why a URL is blocked, so the
// blocked page can explain itself and show the right unlock requirement.
async function getBlockReason(url, state) {
  if (!state.enabled) return { blocked: false };
  if (isExtensionInternal(url)) return { blocked: false };
  // Your own files are work, never a distraction to lock: a local file can be a
  // target, but it is never taken away from you (allow-list mode included).
  if (isFileUrl(url)) return { blocked: false };
  // Don't block productive sites themselves!
  //
  // …with one exception, and it is opt-in. A target that carries a TOPIC is a promise about what you
  // would do there, not merely about where you would be — so if the topic check has settled that this
  // page is not it, the exemption is what is being abused rather than earned. With aiTopicBlocks on, the
  // page is treated like any other distraction.
  //
  // Asked in this order deliberately: the match is found first, so the exemption is only ever withdrawn
  // from a page that was ON a target. Nothing here can block a page that was not already exempt.
  // Two things can withdraw that exemption and both are opt-in. Order between them matters only for
  // which screen you get when both apply, and the sequence answers first on purpose: "you are not
  // meant to be on this site yet" is the simpler and more actionable of the two sentences, and asking
  // a model whether the page matches a topic you are not due to study is work done for a verdict that
  // changes nothing.
  const onTarget = findProductiveMatch(url, state.productiveSites);
  if (onTarget) {
    const seq = sequenceBlock(state, url, onTarget);
    if (seq) return seq;
    return offTopicBlock(state, url, onTarget) || { blocked: false };
  }

  // Nothing to earn means nothing to lock. With no work set — the list emptied,
  // every row switched off or left at 0 — a locked site has no condition left to
  // satisfy, so holding it hostage would just be a dead end with no way out. It's
  // also the way back if you clear the list by mistake. Strict mode is unaffected:
  // it refuses to let you delete targets in the first place.
  if (!activeTargets(state.productiveSites).length) return { blocked: false };

  // One list, one condition: everything you set for today has to be finished
  // before the locked sites open.
  if (await allRequiredMet(state)) return { blocked: false };

  // Only videos about what you are studying. BEFORE the lists, because for a video it replaces them
  // rather than adding to them — a video about your subject is allowed even with youtube.com blocked, and
  // an unrelated one is refused whether or not you ever listed the site. See videoTopicVerdict, which
  // returns null for everything it has no business deciding, which is most of the web.
  //
  // AFTER allRequiredMet, so it lifts the moment today's work is done, like every other gate here. And
  // after the target match above, so a channel you nominated as work is never caught by it.
  const vg = videoTopicVerdict(url, state);
  if (vg) return vg;

  // You committed to an exact page, so the rest of that site is locked — no
  // loitering on the homepage or wandering into another branch.
  //
  // The current step goes in so the row it names is one you can actually open; null when sequence mode
  // is off, which is the answer this gate has always given.
  const seqStep = (state.sequenceMode === true && self.FGSettings && self.FGSettings.currentStepGroup)
    ? self.FGSettings.currentStepGroup(activeTargets(state.productiveSites))
    : null;
  const parent = findOffTargetBlocked(url, state.productiveSites, seqStep);
  if (parent) {
    return {
      blocked: true,
      gate: "parent",
      target: parent,
      hasTargets: true
    };
  }

  const hasTargets = activeTargets(state.productiveSites).length > 0;
  // An entry in the block list is an explicit "never" — it wins even in allow-list
  // mode, so "allow google.com" + "block drive.google.com" behaves as expected
  // (otherwise the subdomain would sneak in through the allow rule).
  if (inAnyList(url, state.blockedSites)) {
    return { blocked: true, gate: "productive", hasTargets };
  }
  // The AI category lists, AFTER the typed ones and before the mode branch.
  //
  // After, deliberately: a domain somebody typed is an explicit decision about that domain, and an
  // explicit decision should not be re-litigated by a model. So the chips answer first and this only ever
  // decides the sites they never mentioned — which is the whole reason it exists.
  //
  // It returns null for everything it has no business deciding, which on a fresh profile is the entire
  // web: the switch off, neither list holding a category, no key, a site not yet classified, or a site the
  // model did not recognise. See aiCatVerdict.
  if (aiCatReady(state)) {
    const cv = aiCatVerdict(url, state);
    if (cv) {
      if (cv.blocked) return { ...cv, hasTargets };
      return cv;                                   // an allowed category, in whitelist mode only
    }
  }
  if (state.blockMode === "whitelist") {
    // An empty allow list means exactly what it says: nothing is allowed. Only
    // your step 1 work pages stay open (they're exempted further up), and the
    // whole web opens again once the day's work is done. The power switch in the
    // popup is the way out if you need one.
    //
    // `false` — the narrow match, and the only caller in the extension that asks for
    // it. An allow list entry means that one site: "google.com" opens google.com, not
    // gemini.google.com or keep.google.com. It used to open all of them, so one entry
    // for a search engine handed back a whole workspace. "*.google.com" is how you ask
    // for the subdomains on purpose.
    if (inAnyList(url, state.allowedSites, false)) return { blocked: false };
    return { blocked: true, gate: "whitelist", hasTargets };
  }
  return { blocked: false };
}

async function shouldBlock(url, state) {
  return (await getBlockReason(url, state)).blocked;
}

function blockedPageUrl(url, info) {
  if (!info || !info.blocked) return "";
  let q = "?from=" + encodeURIComponent(url || "");
  // The topic verdict travels in the address, and it has to. Every other reason on that page can be
  // re-derived by handing the URL back — "is reddit.com blocked" has the same answer a minute later — but
  // this one was reached from the page's own title, description and subtitles, and by the time the
  // blocked page is running the tab has left it. "Which promise did this break, and what did the AI think
  // it was" is the whole of what the page has to say, so it is written down at the moment it is known.
  // BOTH topic gates, and the second one had to be added here explicitly rather than being caught by the
  // first. "offtopic" is a page on a work site; "offtopicvideo" is a video anywhere — and while this read
  // `=== "offtopic"` the newer one wrote none of its reason into the address, so the blocked page could
  // say a video was refused and not one word about which topic it missed or what the AI thought it was.
  // The classifier's verdict travels too, for the same reason and with one extra: its answers live in
  // storage rather than in memory, so the worker CAN normally be asked again — but the category's name and
  // the model's one-line reason are what that page has to say, and re-deriving them would mean the blocked
  // page loading the whole category table to look up an id.
  if (info.gate === "category") {
    if (info.catId) q += "&ct=" + encodeURIComponent(String(info.catId).slice(0, 40));
    if (info.catReason) q += "&cr=" + encodeURIComponent(String(info.catReason).slice(0, 90));
  }
  // Which work row was refused for being out of turn. The sequence position itself is NOT sent, and
  // deliberately: unlike the topic verdict it is derivable from storage at any moment — the groups come
  // out of the list, the progress is stored beside it — so writing it into the address would be putting
  // a second copy of a live figure somewhere it cannot be updated. What is not derivable is which of
  // the rows the tab was on, because by the time this page loads the tab has left it. So the identity
  // travels, as with `tg=` above, and the page works the rest out for itself.
  if (info.gate === "sequence" && info.target && info.target.id) {
    q += "&sq=" + encodeURIComponent(String(info.target.id).slice(0, 40));
  }
  if (info.gate === "offtopic" || info.gate === "offtopicvideo") {
    // Which row this was about, by id.
    //
    // The blocked page can normally ask the worker again and get the whole verdict back — but the
    // verdict lives in the worker's MEMORY, and a service worker is killed whenever Chrome feels like
    // it. Restart between the redirect and the page loading and that question comes back "not blocked
    // for that reason", after which the page would fall through to the generic copy and tell somebody
    // to go and spend time on the very site they are being kept off. So the identity travels too, and
    // the branch reads from the address when the worker has forgotten.
    if (info.target && info.target.id) q += "&tg=" + encodeURIComponent(String(info.target.id).slice(0, 40));
    if (info.topic) q += "&tp=" + encodeURIComponent(String(info.topic).slice(0, 300));
    if (Number(info.aiPct) >= 0) {
      q += "&ap=" + encodeURIComponent(String(Math.round(Number(info.aiPct) || 0)));
      q += "&an=" + encodeURIComponent(String(Math.round(Number(info.aiNeed) || 0)));
    }
    if (info.aiReason) q += "&ar=" + encodeURIComponent(String(info.aiReason).slice(0, 120));
    if (Array.isArray(info.aiRead) && info.aiRead.length) {
      q += "&ad=" + encodeURIComponent(info.aiRead.join(",").slice(0, 120));
    }
  }
  return chrome.runtime.getURL("blocked.html") + q;
}

// The URL a message is about. A content script always reports its own
// location.href, which stays correct through history-API navigations; the tab
// snapshot is only a fallback for callers that can't report one.
function senderUrl(msg, sender) {
  const reported = msg && typeof msg.url === "string" ? msg.url : "";
  if (reported && /^(https?|file):/i.test(reported)) return reported;
  return (sender && sender.tab && sender.tab.url) || reported || activeUrl;
}

// Send a tab somewhere on a page's behalf. Only two destinations are ever asked
// for — FocusGate's own pages, or an address that isn't blocked at this moment —
// so this can't be turned into a way of pushing a tab anywhere.
async function navigateTab(tabId, urlIn) {
  const url = String(urlIn || "").trim();
  if (typeof tabId !== "number" || !url) return false;
  if (!url.startsWith(chrome.runtime.getURL(""))) {
    if (!/^(https?|file):/i.test(url)) return false;
    const state = await getState();
    if ((await getBlockReason(url, state)).blocked) return false;
  }
  try { await chrome.tabs.update(tabId, { url }); return true; } catch { return false; }
}

async function enforceOnTab(tabId, url) {
  const state = await getState();
  if (await shouldBlock(url, state)) {
    const target = chrome.runtime.getURL("blocked.html") + "?from=" + encodeURIComponent(url);
    try { await chrome.tabs.update(tabId, { url: target }); } catch {}
    return;
  }
  // The video gate's safety net.
  //
  // A refused video is normally covered IN the page, by the content script, so the tab is deliberately
  // left alone — see videoTopicVerdict. That moves the enforcement somewhere a page could in principle be
  // talked out of, and the honest hedge is this: if nothing reports from the tab, nothing is covering the
  // player, and the whole page is taken away as it used to be.
  //
  // Armed rather than acted on, because this runs at navigation — before any content script could possibly
  // have reported. The deadline is what tells "the script has not loaded YET" apart from "the script is not
  // coming".
  if (aiOk() && videoShieldFor(url, state)) armShieldWatch(tabId, url);
}

// ---------- is anything actually covering that player? ----------
//
// The tick is the signal, and it is the right one: a content script that is ticking is a content script
// that is drawing the shield, because the same reply carries both.
const contentAt = new Map();          // tabId -> { url, at }
const CONTENT_FRESH_MS = 5000;        // the tick is every second, so this is four missed beats
function noteContentAlive(tabId, url) {
  if (typeof tabId !== "number") return;
  contentAt.set(tabId, { url: String(url || ""), at: Date.now() });
}
function contentAlive(tabId, url) {
  const e = contentAt.get(tabId);
  if (!e) return false;
  if (Date.now() - e.at > CONTENT_FRESH_MS) return false;
  // Same address, or the page has navigated and its next tick will say so. Compared because a script that
  // reported on the previous video must not vouch for this one.
  return !url || e.url === url;
}

// One timer per tab, replaced only when the URL it is waiting on changes. Re-arming on every event for the
// same page would push the deadline forward indefinitely, which is exactly the hole the deadline closes.
const shieldWatch = new Map();
// Long enough that an ordinary page on a slow connection gets its content script injected and ticking,
// short enough that it is not a usable window to watch anything in.
const SHIELD_GRACE_MS = 7000;
function clearShieldWatch(tabId) {
  const w = shieldWatch.get(tabId);
  if (!w) return;
  try { clearTimeout(w.timer); } catch {}
  shieldWatch.delete(tabId);
}
function armShieldWatch(tabId, url) {
  if (typeof tabId !== "number" || !url) return;
  const prev = shieldWatch.get(tabId);
  if (prev && prev.url === url) return;
  clearShieldWatch(tabId);
  const timer = setTimeout(() => {
    shieldWatch.delete(tabId);
    shieldDeadline(tabId, url).catch(() => {});
  }, SHIELD_GRACE_MS);
  shieldWatch.set(tabId, { url, timer });
}
async function shieldDeadline(tabId, url) {
  let tab = null;
  try { tab = await chrome.tabs.get(tabId); } catch { return; }
  if (!tab || (tab.url || "") !== url) return;         // moved on; not our business any more
  if (contentAlive(tabId, url)) return;                // something is covering the player. Stay out of it.
  const state = await getState();
  const shield = aiOk() ? videoShieldFor(url, state) : null;
  // Only a settled refusal takes the page. Still being judged is not grounds to take anything away, and if
  // the verdict has since changed to "on topic" there is nothing left to enforce.
  if (!shield || shield.state !== "off") return;
  const info = {
    blocked: true, gate: "offtopicvideo", hasTargets: true,
    aiPct: shield.pct, aiNeed: shield.need, aiReason: shield.reason || "", aiRead: shield.read || [],
    topic: (shield.topics || []).join(" · ")
  };
  try { await chrome.tabs.update(tabId, { url: blockedPageUrl(url, info) }); } catch {}
}
if (chrome.tabs && chrome.tabs.onRemoved) {
  chrome.tabs.onRemoved.addListener((id) => { clearShieldWatch(id); contentAt.delete(id); });
}

// Listen for tab navigations
chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
  if (info.url || info.status === "loading") {
    const u = info.url || tab.url;
    if (u) enforceOnTab(tabId, u);
  }
  // A local file arriving in ANY tab, not only the one you are looking at, is the moment a picked
  // target can be told where it lives. See learnLocalPaths — this is the trigger that makes
  // opening the file once enough, rather than opening it and then staying on it.
  const local = fileUrlOf(info.url || tab.url || tab.pendingUrl || "");
  if (local) learnLocalPathsSoon();
});
// Mobile extension browsers (e.g. Quetta) may not implement webNavigation
if (chrome.webNavigation && chrome.webNavigation.onBeforeNavigate) {
  chrome.webNavigation.onBeforeNavigate.addListener((d) => {
    if (d.frameId === 0) enforceOnTab(d.tabId, d.url);
  });
}
// Single-page apps (Google Drive, YouTube, Gmail…) change the address bar with
// the history API instead of loading a new document. onBeforeNavigate never
// fires for those, so without this a Drive folder target could "leak" into the
// rest of Drive. The content script also checks on every URL change, so SPA
// pages are covered even if these events are missing (mobile browsers).
if (chrome.webNavigation && chrome.webNavigation.onHistoryStateUpdated) {
  chrome.webNavigation.onHistoryStateUpdated.addListener((d) => {
    if (d.frameId === 0) enforceOnTab(d.tabId, d.url);
  });
}
if (chrome.webNavigation && chrome.webNavigation.onReferenceFragmentUpdated) {
  chrome.webNavigation.onReferenceFragmentUpdated.addListener((d) => {
    if (d.frameId === 0) enforceOnTab(d.tabId, d.url);
  });
}
// ---------- time tracking ----------
let activeTabId = null;
let activeUrl = null;
let lastTickAt = Date.now();

async function refreshActive() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    activeTabId = tab ? tab.id : null;
    activeUrl = tab ? tab.url : null;
  } catch { activeTabId = null; activeUrl = null; }
  // Switching tabs or windows is when a local file comes into view, so it's also
  // when the loop that times local files needs to be running.
  startLocalBeatIfNeeded();
}

chrome.tabs.onActivated.addListener(refreshActive);
// Switching tabs, including switching TO Settings. That is the case worth naming: you open the
// file, come back to the settings page to see the link, and this is what fills the path in before
// the page draws rather than up to a minute later on the heartbeat.
chrome.tabs.onActivated.addListener(() => learnLocalPathsSoon(150));
// Belt to the braces on injectIntoOpenTabs(): reloading an unpacked extension does
// not report itself as consistently as an install or an update does, and a tab that
// was open before the extension existed never had the script at all. Switching to a
// tab is the moment it matters, and it costs nothing to be sure — the script turns
// itself away the instant it finds a working copy of itself already there.
chrome.tabs.onActivated.addListener(({ tabId }) => { injectIntoTab(tabId); });
chrome.tabs.onUpdated.addListener((id, info, tab) => {
  if (!tab.active) return;
  activeTabId = id;
  activeUrl = tab.url;
  // Opening a local file in the tab you're already in (Ctrl+O) isn't a tab switch,
  // so the clock for local files has to be woken here too. Not viewer.html: that page
  // reports for itself, and this loop turns itself away there.
  // fileUrlOf rather than isFileUrl: a reader extension navigating from one PDF to the next never
  // changes scheme, so the beat has to be woken for its addresses too.
  if (fileUrlOf(activeUrl || tab.pendingUrl || "")) startLocalBeatIfNeeded();
});
// The card has to keep one physical size while the page zooms around it, so it needs telling
// the moment the zoom moves. Pushed rather than polled: a Ctrl+scroll walks through half a dozen
// steps in a second, and asking on a timer would show the card at the wrong size in between.
//
// Wrapped, because onZoomChange is not present on every browser that runs extensions, and a
// missing listener here would take the whole worker down on load.
if (chrome.tabs && chrome.tabs.onZoomChange) {
  chrome.tabs.onZoomChange.addListener((info) => {
    const z = info && info.newZoomFactor;
    if (!info || !info.tabId || !(z > 0)) return;
    // No callback and no await: the tab may have no content script — a chrome:// page, a PDF —
    // and "receiving end does not exist" is the ordinary case rather than a fault.
    try {
      chrome.tabs.sendMessage(info.tabId, { type: "zoomChanged", zoom: z }, () => {
        void chrome.runtime.lastError;
      });
    } catch {}
  });
}

// chrome.windows may be unavailable on mobile extension browsers (e.g. Quetta)
if (chrome.windows && chrome.windows.onFocusChanged) {
  chrome.windows.onFocusChanged.addListener(refreshActive);
}

// ---------- local files: the clock, driven from here ----------
// Every web page runs content.js, which sends a tick a second. Chrome's own
// viewers don't: a local PDF, image or video is rendered by a built-in viewer
// where no content script can run, so those pages can never report anything —
// and a PDF is exactly what a local target usually is.
// So the second is counted here instead. Once a second, if the tab you are
// actually looking at is a local file belonging to a target, it earns a second.
// A local .html page still speaks for itself (it gets the on-page timer, the
// camera, the idle check); this loop notices its ticks and stays out of the way.
let localTimer = null;
let lastContentTick = { url: "", at: 0 };
function noteContentTick(url) {
  lastContentTick = { url: String(url || ""), at: Date.now() };
}
function scheduleLocalBeat(delayMs) {
  if (localTimer) { try { clearTimeout(localTimer); } catch {} }
  localTimer = setTimeout(localFileBeat, delayMs);
}
// The tab in front of you right now, or null.
async function focusedTab() {
  try {
    const q = (chrome.windows && chrome.windows.getLastFocused)
      ? { active: true, lastFocusedWindow: true } : { active: true };
    const [tab] = await chrome.tabs.query(q);
    return tab || null;
  } catch { return null; }
}
async function localFileBeat() {
  localTimer = null;
  try {
    const state = await getState();
    if (!state.enabled) return;
    const locals = activeTargets(state.productiveSites).filter(s => s.type === "local_file");
    if (!locals.length) return;                       // nothing local to watch

    const tab = await focusedTab();
    const url = tab ? (tab.url || tab.pendingUrl || "") : "";

    // FocusGate's own copy of a picked file, open in viewer.html. That page loads content.js like
    // any website, so it reports for itself — the camera, the stillness check, the break, the
    // window checks — and this loop has no business there. Handing out a second from here as well
    // would pay for it twice, and worse, it would pay without the camera having agreed.
    //
    // Which is the whole reason viewer.html exists in this shape: a local file opened straight from
    // the disk is drawn by Chrome's built-in PDF or image viewer, where no script of ours can run,
    // so a camera-gated target could never be satisfied there (see the refusal further down). This
    // loop is for exactly those pages, and nothing else.
    if (viewerTargetId(url)) return;

    // The file this tab is showing, whether it is open at its own address or inside somebody's PDF
    // reader extension — see embeddedFileUrl. Everything below works from this rather than from the
    // tab's address, so a reader's viewer.html?file=… is timed exactly like the file itself.
    const fileUrl = fileUrlOf(url);
    // Whose page it is, though, decides what can be checked on it. A reader extension's page is one
    // this extension may not touch, so the refusal further down has to say something different.
    const foreignViewer = !!fileUrl && !isFileUrl(url);

    const match = fileUrl ? locals.find(s => fileCovers(fileUrl, s.path || s.url)) : null;
    if (!match) return;                               // restarted by refreshActive / the alarm

    // Learn the whole address the first time the file is actually opened.
    //
    // A target picked from Chrome's file dialog only knows the tail of its path, because that is
    // all Chrome hands over. Here is a tab whose address bar holds the rest — so the tail is
    // replaced by the real thing, once, and from then on the target is anchored to that drive and
    // cannot be satisfied by a file of the same name somewhere else.
    //
    // Only ever an upgrade: a target that already knows its full path is left alone, and this runs
    // at most once per target because after it the path is absolute.
    // The kept copy is deliberately NOT dropped here. Knowing the real path makes the match
    // stricter, which is worth having, but it does not replace the copy: viewer.html is the only
    // address where the camera and the stillness checks can run, so it stays the one every Open in
    // FocusGate points at. See targetOpenUrl on the pages that draw a target row.
    //
    // fileUrl, not the tab's address: a reader extension's address is its own page, and storing it
    // as the target's path would anchor the target to that extension instead of to the file — so a
    // change of reader, or the same file opened straight off the disk, would stop matching.
    if (!absLocalPath(match.path || match.url)) {
      const full = filePath(fileUrl);
      if (full) {
        await setState({
          productiveSites: (state.productiveSites || [])
            .map(p => (p.id === match.id ? { ...p, path: full, url: fileUrl } : p))
        });
      }
    }

    // The page reported for itself a moment ago (a local .html can run content.js):
    // its answer wins, including its "no, I'm paused" — otherwise the checks it
    // runs would be pointless, since we'd credit the second it just refused. Drop
    // to a slow watch while that lasts, and pick the second back up if it stops.
    if (lastContentTick.url === url && Date.now() - lastContentTick.at < 3000) {
      scheduleLocalBeat(3000);
      return;
    }

    // Keep the clock going while this file is what's on screen, whether or not
    // this particular second ends up counting.
    scheduleLocalBeat(1000);

    // Every stopped path below drops the credit stamp for the same reason the tick
    // handler does: the gap since the last payment would otherwise include the pause,
    // and the whole pause would be handed over the moment the clock started again.
    if (state.userPaused) { forgetCredit(match.id); await notePause(PAUSE_BREAK); return; }
    // Already full, so there is nothing to withhold and nothing to ask for.
    //
    // Before every check below, because each one of them would otherwise tell the popup how to earn
    // time on a row that has already earned all of it — "open this file from FocusGate for the camera"
    // is a fair instruction on an unfinished goal and a pointless errand on a finished one. Same call
    // the tick handler makes for web pages; this is the path for a local file Chrome draws itself,
    // where no content script reports and the popup is the only thing listening.
    //
    // It also stops the per-second write that used to happen here: with every check switched off, a
    // finished local file fell through to tickFromContent and rewrote the whole list once a second to
    // store the number it already held.
    if ((match.requiredSec || 0) === 0 || (match.spentSec || 0) >= (match.requiredSec || 0)) {
      forgetCredit(match.id);
      await notePause(PAUSE_DONE);
      return;
    }
    const rules = effectiveCheat(state, match);
    // Nothing is reporting from this page, so the checks that need one — the camera, the eyes,
    // stillness, "something must be playing" — cannot run. Chrome draws a local PDF or image with
    // a built-in viewer that no script of ours can reach, which is exactly where this lands.
    //
    // Stopping the clock is the only honest answer: handing out time no one is watching would make
    // the camera setting a lie. But there IS a way through now, so the reason says what it is
    // rather than just refusing — opening the file from FocusGate serves it out of viewer.html,
    // which is our own page and runs every check.
    //
    // A reader extension's own page lands here for a different reason and it is worth saying so
    // separately: that page is not one Chrome will let this extension put anything on, at all.
    // Content scripts cannot be declared for the chrome-extension: scheme and scripting.executeScript
    // refuses another extension's tab, so there is nowhere for the card, the preview or the
    // stillness checks to live — the limit is the browser's, not a setting anybody can change.
    if (rules.faceDetectionEnabled || rules.eyeTrackingEnabled ||
        rules.inactivityPauseEnabled || rules.mediaPlayingRequired) {
      forgetCredit(match.id);
      await notePause(foreignViewer
        ? "no camera in another extension's reader — open from FocusGate"
        : "open this file from FocusGate for the camera");
      return;
    }
    // No page to measure, so only what the browser itself can tell us: this tab
    // is the active one, the window is focused and filling the screen.
    const gate = await windowGate(rules, tab.id, null);
    if (!gate.ok) { forgetCredit(match.id); await notePause(gate.reason || "make window full screen"); return; }
    await notePause("");
    // fileUrl again, so the target is found by the path rather than by the reader's address. The
    // matching inside would resolve either one — fileCovers handles both — but the file's own
    // address is the honest thing to credit against and the one every other caller passes.
    await tickFromContent(fileUrl, "", "", tab.id);
  } catch {
    scheduleLocalBeat(2000);
  }
}
// Cheap to call: it stops by itself the moment a local file isn't in front of you.
function startLocalBeatIfNeeded() {
  if (localTimer) return;
  scheduleLocalBeat(300);
}

// Receives "tick" pings from content script (only when page visible)
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    // Switched off is switched off. Before anything else, the two messages that
    // drive the on-page timer and the camera get a flat "we're off" answer, so no
    // clock runs, no camera opens and nothing is drawn on any page. The content
    // script tears its own UI down the moment it sees this.
    if (msg && (msg.type === "tick" || msg.type === "getStatus")) {
      const st0 = await getState();
      if (!st0.enabled) {
        sendResponse({ ok: true, enabled: false, url: senderUrl(msg, sender),
                       remaining: 0, match: null, paused: false, blocked: false, redirect: "" });
        return;
      }
    }
    if (msg && msg.type === "tick") {
      // The page reports its own location.href and that is the ground truth.
      // sender.tab.url can lag behind inside single-page apps (Drive, YouTube),
      // which used to keep the timer running on pages that are not the target.
      const url = senderUrl(msg, sender);
      // A local page that CAN run the on-page clock (a .html file) speaks for
      // itself. Remembered here so the background's local-file loop doesn't count
      // the same second twice.
      if (isFileUrl(url)) noteContentTick(url);
      // The video actually on screen, which is not always the page it is on. On an ordinary watch page the
      // two are the same. But a video playing on in YouTube's MINIPLAYER after you have scrolled to the feed,
      // run a search, or opened another page has a `url` that describes where you navigated and a player that
      // is still showing something else — and nothing here had any opinion about that video, so a refused one
      // simply kept playing in the corner. The page reports the miniplayer's own id as msg.ytPlaying; it is
      // rebuilt into a canonical watch URL so every video-gate function can judge it unchanged. Anything that
      // is not a bare 11-character id, or a page that is already a video, leaves videoUrl equal to url.
      const miniId = (aiOk() && !FGAi.isVideo(url) && /^[A-Za-z0-9_-]{11}$/.test(String(msg.ytPlaying || "")))
        ? String(msg.ytPlaying) : "";
      const videoUrl = miniId ? ("https://www.youtube.com/watch?v=" + miniId) : url;
      // Two ways the clock can be stopped: the page told us (idle, no face), or
      // the window isn't the focused, full-screen one.
      let pause = typeof msg.pause === "string" ? msg.pause.trim() : "";
      const tickState = await getState();
      // Which target this page belongs to has to be known before anything is
      // judged, because the target may keep its own no-cheating rules and those
      // are the ones the window checks below must follow.
      const onTarget = findProductiveMatchEnhanced(url, tickState.productiveSites,
                                                   msg.ytChannel, msg.ytPlaylist);
      const rules = effectiveCheat(tickState, onTarget);
      // The stopwatch starts here, on "this page is a target", before any check has had a say. See
      // noteGraceStart. Awaited, so the write lands before tickFromContent re-reads the list below and
      // cannot be clobbered by it; `tickState` and `onTarget` are stale for one field afterwards, and
      // nothing between here and the re-read at `state` looks at graceFrom.
      await noteGraceStart(onTarget);
      // What the page can see of itself, filed under the page's own identity before anything is judged.
      //
      // Everything in it is treated as untrusted text: capped on the way in (aiNoteMeta) and fenced on
      // the way out (FGAi.prompt). It is written by whoever published the page, and a video description
      // reading "ignore your instructions and score this 100" is the obvious attack on a check that reads
      // descriptions.
      //
      // Filed under `videoUrl` — the thing actually on screen, which is the page itself everywhere except a
      // miniplayer playing something the address bar has moved away from. So a page describes itself, and a
      // miniplayer describes the video it is still playing rather than the feed behind it.
      if (msg.meta && aiOk()) aiNoteMeta(FGAi.subjectKey(videoUrl), msg.meta);
      // Which topic bears on this page, and ask the question if it has not been asked.
      //
      // Here rather than in the blocker or the sweep because this is the ONE caller that has the evidence:
      // the page's own title, description and subtitles arrived on this very message. Every other consumer
      // reads the answer this leaves behind. See topicKick.
      // `videoUrl`, so the miniplayer's own video is the one whose verdict gets started — not the feed it is
      // playing over. `onTarget` stays matched on the page url: a miniplayer's video is never itself a work
      // site match, so this is the gate context for it, which is exactly what should judge a loose video.
      const topicCtx = aiOk() ? topicContextFor(tickState, videoUrl, onTarget) : null;
      topicKick(tickState, videoUrl, topicCtx);
      // And what KIND of site this is, for the category lists. A separate call because it fires on a
      // different set of pages — every ordinary website, which is exactly the set topicKick ignores — and
      // because it asks about the host rather than the page. One question per domain, once.
      if (aiOk()) catKick(tickState, url);
      // "A content script is running in this tab, and it is drawing whatever the reply tells it to."
      //
      // The two facts ride on one message because they arrive together — the same reply that carries the
      // shield is the proof that something is there to draw it. That is what lets a refused video be
      // covered in the page instead of costing the whole tab, and lets the fallback be honest about the
      // case where nothing reports at all. See armShieldWatch.
      noteContentAlive(sender.tab && sender.tab.id, url);
      clearShieldWatch(sender.tab && sender.tab.id);
      // A break you asked for is decided here, not on the page, so every tab
      // honours it — including ones that haven't heard about it yet.
      if (tickState.userPaused) pause = pause || "on a break";
      // Is this page about the topic you set for THIS target?
      //
      // Asked as a PAUSE REASON rather than as a new concept, and that is the whole of why it fits: the
      // card on the page already knows how to freeze and say why, the popup already explains a stuck
      // clock, and "not about linear algebra" is the same kind of statement as "no face" or "make window
      // full screen" — a reason this second is not being paid for.
      //
      // Only on a target. Off a target there is nothing being credited and therefore nothing to withhold,
      // and asking anyway would spend requests judging pages nobody claimed were work.
      if (!pause && onTarget) pause = aiTopicPause(tickState, url, onTarget) || pause;
      if (!pause) {
        const gate = await windowGate(rules, sender.tab?.id,
                                      { focused: msg.focused, winFull: msg.winFull,
                                        inner: msg.inner, outer: msg.outer });
        if (!gate.ok) pause = gate.reason || "make window full screen";
      }
      // Stopped, so the stamp goes: without this the pause itself would be paid for
      // the moment the clock started again, because the gap since the last payment
      // includes every second you were away.
      // The card a matching video would earn for, worked out here as well as inside tickFromContent, for the
      // one reason the crediting side does not cover: a PAUSE has to drop that card's timing stamp too, or
      // the paused seconds would be paid out the moment the clock started again. Read-only and cheap — it
      // reads the cached verdict, never starts one. Only consulted off a work-site match, since a video on a
      // site you nominated earns through the ordinary match instead.
      const earnTarget = (aiOk() && !onTarget) ? videoEarnTarget(tickState, url) : null;
      // What the clock was actually credited at. 1 while it is stopped, because nothing was.
      let paceUsed = 1;
      if (pause) forgetCredit((onTarget || earnTarget) && (onTarget || earnTarget).id);
      // msg.pace is the camera's speed for this second, measured in the frame that also
      // produced the face verdict above. It rides on this message rather than being stored,
      // so it cannot outlive the page that reported it.
      else paceUsed = await tickFromContent(url, msg.ytChannel, msg.ytPlaylist, sender.tab?.id, msg.pace);
      const state = await getState();
      // The same earn fallback the crediting used, so a matching video shows its card on the page and counts
      // it down rather than filling in silence. Recomputed against the freshly-read state, like the match.
      let match = findProductiveMatchEnhanced(url, state.productiveSites, msg.ytChannel, msg.ytPlaylist);
      if (!match && aiOk()) match = videoEarnTarget(state, url);
      const remaining = match ? Math.max(0, (match.requiredSec||0) - (match.spentSec||0)) : 0;

      // Nothing left to earn here, so nothing left to withhold.
      //
      // Every reason in this handler is a statement of one shape: "this second is not being paid for,
      // and here is why". On a target whose time is already full, that sentence has no second half —
      // no second is being paid for on it whatever you do, because tickFromContent caps spentSec at
      // requiredSec. So "play the video" on a finished card is not a rule being enforced, it is an
      // instruction that buys the user nothing, and the card's own design already agrees: setUI calls
      // the finished state "done" rather than "run" precisely because your video is your own business
      // again. The freeze-and-nag path simply never got that memo, so a completed target sat there
      // asking for a video and counting the seconds it was not getting one.
      //
      // Only the REPORTING is dropped, never the decision. `pause` itself is left exactly as it is, so
      // forgetCredit has already run and tickFromContent was already skipped: nothing about what gets
      // credited or written changes here. What changes is that the card falls through to its finished
      // state instead of freezing with a stop label, and the popup stops explaining a timer with
      // nothing left to do.
      //
      // Measured off `remaining` rather than off a fresh targetDone call, and that is why it sits here
      // rather than further up: `remaining` is the very number this reply hands the page, and the page
      // calls the target done when it is 0. Deriving the hush from anything else would let the two
      // disagree — a card in its finished state still carrying a stop label, which is the bug itself. It
      // also covers a 0-second goal for free, since that is 0 remaining from the start.
      //
      // The break survives, and it is the one that should. It is not a check the extension imposed, it
      // is a button the user pressed, and it is global — every other target is being held by it too. A
      // button that stops reporting itself the moment one row finishes reads as broken.
      const hushPause = !!match && remaining === 0 && !tickState.userPaused;

      // On a work page, remember whether the clock is running and why not, so the
      // popup can explain a timer that looks stuck.
      //
      // PAUSE_DONE rather than "" on a finished target. The card is told nothing at all — see the reply
      // below — but the popup has to say SOMETHING, and "" there means "counting", which is the one
      // thing a full goal is not doing. See PAUSE_DONE for why it costs the day's totals nothing.
      if (match) await notePause(hushPause ? PAUSE_DONE : pause);
      // A work page is exempt from blocking, and the short-circuit here is not an optimisation: `match`
      // comes from findProductiveMatchEnhanced, which also matches on the channel and playlist the page
      // read out of its own DOM, while getBlockReason can only match on the URL. Asking getBlockReason
      // about a watch page inside a tracked channel would have it block a page this side knows is work.
      //
      // The one thing that can still take a work page away is the topic check, and it is asked here for
      // exactly that reason — with the enhanced match, so the verdict is about the target the clock is
      // actually crediting.
      const info = match
        ? (offTopicBlock(state, url, match) || { blocked: false })
        : await getBlockReason(url, state);
      // Videos inside Google Search: whether they are gated here at all, and a panel for each one on screen.
      const onGoogle = aiOk() && isGoogleSearchUrl(url);
      const googleShields = (onGoogle && Array.isArray(msg.gVideos) && msg.gVideos.length)
        ? await googleVideoShields(state, url, msg.gVideos) : [];
      // The page enforces the rest of the checks (stillness, camera), so it's told
      // which rules apply here — this target's own, or the defaults.
      sendResponse({ ok: true, enabled: true, url, remaining, match,
                     gGate: onGoogle && videoGateActive(state),
                     gShields: googleShields,
                     // See hushPause above: a full target reports no reason, so the card goes to its
                     // finished state instead of freezing. `paused: false` is what sends it down the
                     // setUI path, which clears the stale label and puts the ＋ button up.
                     paused: !!pause && !hushPause, pauseReason: hushPause ? "" : pause,
                     cheat: match ? effectiveCheat(state, match) : rules,
                     // The figure the seconds were actually multiplied by, so the badge on the
                     // page reports what happened rather than what the camera hoped would.
                     paceUsed: Number.isFinite(paceUsed) ? paceUsed : 1,
                     // This target's topic, for the card to show, and what the page should gather for the
                     // next tick's question. Both null/empty unless there is genuinely something to do:
                     // this reply goes to every page on every site once a second, so it must not carry a
                     // standing instruction to read the document.
                     topic: match && aiOk() && aiTopicReady(state) ? FGAi.topicOf(match) : "",
                     // Recomputed against the freshly-read state and the enhanced match, so what the page
                     // is asked to gather follows what will actually be judged.
                     //
                     // NOT limited to targets any more, and that was the bug: a video on a site that is not
                     // a work site is exactly the case the gate exists for, and it cannot be judged without
                     // the page describing itself. While this said `match ? … : null`, YouTube was never
                     // asked for a title, so the gate's question was never askable, so nothing was ever
                     // blocked — the feature looked switched off.
                     //
                     // `videoUrl`, so a miniplayer is asked to gather ITS video's title and subtitles — read
                     // off the live player — rather than the feed's, which would judge the wrong thing.
                     wantMeta: aiOk() ? aiWantMeta(state, videoUrl, topicContextFor(state, videoUrl, match)) : null,
                     // Hold the video still while the gate is deciding.
                     //
                     // This is what stops an off-topic video getting a free few seconds. Blocking before a
                     // verdict exists would take away videos that turn out to be fine; letting it run means
                     // the unrelated one plays until the answer lands. Pausing is neither — nothing is taken
                     // away and nothing is watched. The page puts it back the moment this goes false.
                     //
                     // What to put over the player: a "checking this one" cover while the model reads it, a
                     // refusal once it has, or nothing at all. This is the whole of how an off-topic video is
                     // enforced now — the tab is left alone.
                     //
                     // Asked of the gate directly rather than read off `info`, because the two are different
                     // questions: `info` is "should this tab be taken away", and a refused video deliberately
                     // is not. See videoShieldFor.
                     //
                     // `videoUrl`, so a miniplayer playing an off-topic video gets covered in its own little
                     // player — the whole of "block it in the miniplayer too". On an ordinary watch page this
                     // is just the page's own video, as before.
                     videoShield: aiOk() ? videoShieldFor(videoUrl, state) : null,
                     // What this gate has turned away, for the cover to report. Counted here, once per
                     // video — see noteVideoSkip — because the tick is the only place that has both the
                     // settled verdict and the page's own reading of how long the video is.
                     skip: await noteVideoSkip(state, videoUrl, msg.vidSec),
                     blocked: !!info.blocked, redirect: blockedPageUrl(url, info) });
    } else if (msg && msg.type === "getStatus") {
      const url = senderUrl(msg, sender);
      const state = await getState();
      // Same two derived views as the tick, so the first paint already knows about a miniplayer and about a
      // matching video's card rather than discovering them a beat later. videoUrl is the on-screen video;
      // match falls back to the card a matching video would earn for.
      const miniId = (aiOk() && !FGAi.isVideo(url) && /^[A-Za-z0-9_-]{11}$/.test(String(msg.ytPlaying || "")))
        ? String(msg.ytPlaying) : "";
      const videoUrl = miniId ? ("https://www.youtube.com/watch?v=" + miniId) : url;
      let match = findProductiveMatchEnhanced(url, state.productiveSites, msg.ytChannel, msg.ytPlaylist);
      if (!match && aiOk()) match = videoEarnTarget(state, url);
      const remaining = match ? Math.max(0, (match.requiredSec||0) - (match.spentSec||0)) : 0;
      const info = match
        ? (offTopicBlock(state, url, match) || { blocked: false })
        : await getBlockReason(url, state);
      sendResponse({ ok: true, enabled: true, url, remaining, match, state,
                     cheat: effectiveCheat(state, match),
                     // The page's first look, so it can start gathering the evidence for the topic check
                     // straight away rather than waiting for the tick after next.
                     topic: match && aiOk() && aiTopicReady(state) ? FGAi.topicOf(match) : "",
                     wantMeta: aiOk() ? aiWantMeta(state, videoUrl, topicContextFor(state, videoUrl, match)) : null,
                     videoShield: aiOk() ? videoShieldFor(videoUrl, state) : null,
                     gGate: aiOk() && isGoogleSearchUrl(url) && videoGateActive(state),
                     blocked: !!info.blocked, redirect: blockedPageUrl(url, info) });
    } else if (msg && msg.type === "addTargetTime") {
      // "Actually, a bit more." Raising one target's goal for today from the card on the
      // page, which is where you are when you decide it.
      //
      // Raising it is the STRICTER direction, so strict mode deliberately does not stand in
      // the way: the rule strict mode enforces is that you cannot let yourself off, and this
      // is the opposite of that. Every other write to productiveSites on the settings page
      // asks inStrictWindow first; this one must not.
      const add = Math.round(Number(msg.secs) || 0);
      const id = String(msg.id || "");
      if (!(add > 0) || !id) { sendResponse({ ok: false }); return; }
      const s = await getState();
      const row = (s.productiveSites || []).find(p => p.id === id);
      if (!row) { sendResponse({ ok: false }); return; }
      // A day is the ceiling, the same figure the card's own field refuses past.
      const required = Math.max(0, Math.min(24 * 3600, (row.requiredSec || 0) + add));
      if (required === (row.requiredSec || 0)) { sendResponse({ ok: false }); return; }
      // A window too short for the bigger goal is stretched in the same write: a window always has to be
      // longer than its goal, so its end moves out to the shortest window the new goal fits in.
      const nextSites = (s.productiveSites || []).map(p => {
        if (p.id !== id) return p;
        const r = { ...p, requiredSec: required };
        const F = self.FGSettings;
        if (F && F.hasWindow && F.fitWindowEnd && F.hasWindow(r)) {
          const fitEnd = F.fitWindowEnd(r);
          if (fitEnd) r.winEnd = fitEnd;
        }
        return r;
      });
      // Pressed on a card IN a page — often the YouTube page itself — so it is not a settings change, and it
      // must not reload the YouTube tab somebody is working in. See ytQuietWrite.
      ytQuietWrite(nextSites);
      await setState({
        productiveSites: nextSites,
        // Today isn't finished any more, so the all-done celebration should be earned again
        // rather than being suppressed as already shown.
        allDoneCelebratedOn: ""
      });
      // The locked sites were open a second ago and have to shut again. Straight away, not on
      // the next poll: the whole point of pressing ＋ is that you are not done yet.
      sweepSoon(0);
      sendResponse({ ok: true, required });
    } else if (msg && msg.type === "setPageEffect") {
      // One of the discs in the camera window's tray, and it has to mean what it says.
      //
      // The three keys below are page EFFECTS rather than checks — a glow round the page, a
      // video paused, a video started again — and every one of them is also a per-target
      // setting, because a lecture wants its video held and a reading site has nothing to
      // hold. That is a good arrangement everywhere except here, and here it was silently
      // broken: switching "its own cheating prevention" on for a target copies whatever Setup
      // says at that moment into the target's own profile, all of it, including these three.
      // effectiveCheat then hands the frozen copy to the page, applyRules writes it over the
      // top of fgSettings on the very next tick, and the disc you had just pressed came
      // undone inside a second. From the outside: "I turned the glow off and it still glows",
      // "I turned auto-pause off and my video still pauses".
      //
      // So a disc writes the global value AND clears that one key from every target's own
      // profile. Not the whole profile — a target's camera sensitivity, its deadlines and its
      // focus box are untouched — only the key being switched, and only for a key from this
      // list. It makes the disc the last word on the effect, which is the only thing a switch
      // sitting on the page the effect happens to can honestly be.
      //
      // No strict-mode gate, and deliberately: settings.js marks pageGlowEnabled and
      // mediaResumeEnabled "free" (a light and a convenience, neither of which can hand you
      // time you have not spent), and the disc for mediaPauseEnabled has always written
      // straight to storage from inside the camera frame. Adding a gate here would change what
      // that disc does rather than fix what it reports.
      const EFFECT_KEYS = ["pageGlowEnabled", "mediaPauseEnabled", "mediaResumeEnabled"];
      const key = String(msg.key || "");
      if (EFFECT_KEYS.indexOf(key) < 0 || typeof msg.value !== "boolean") {
        sendResponse({ ok: false });
        return;
      }
      const st = await getState();
      const patch = { [key]: msg.value };
      // Only rewritten when something actually carries an override, so the ordinary case —
      // nobody has ever opened a per-target panel — writes one boolean and nothing else.
      const owns = (st.productiveSites || []).some(
        p => p && p.cheatCustom && p.cheat && p.cheat[key] !== undefined);
      if (owns) {
        patch.productiveSites = (st.productiveSites || []).map(p => {
          if (!p || !p.cheat || p.cheat[key] === undefined) return p;
          const cheat = { ...p.cheat };
          delete cheat[key];
          return { ...p, cheat };
        });
        // Pressed in the camera tray, inside a page — not a settings change. See ytQuietWrite.
        ytQuietWrite(patch.productiveSites);
      }
      await setState(patch);
      sendResponse({ ok: true });
    } else if (msg && msg.type === "navigate") {
      // Moving a tab between a website and FocusGate's own pages is the browser's
      // job, never the page's. A document that replaces itself hands its
      // Content-Security-Policy to whatever loads next, and both directions of
      // that hurt: a strict site's rules follow us onto the blocked page and leave
      // it blank, and FocusGate's own rules follow the site back and block every
      // script the site owns — the site then loads broken, with a console full of
      // "violates script-src 'self'". chrome.tabs.update starts a clean load that
      // carries only the destination's own rules.
      sendResponse({ ok: await navigateTab(sender.tab && sender.tab.id, msg.url) });
    } else if (msg && msg.type === "resetSettings") {
      // Everything back to how it shipped.
      //
      // What counts as "everything" is not decided here — it is FGSettings.KEYS, the same table
      // that decides what goes into a backup file and what comes out of one. So the three ways of
      // moving settings around cannot disagree about what a setting is, and a key added later is
      // covered by all three at once instead of being remembered in two places and missed in the
      // third.
      //
      // Which means the things that SURVIVE a reset are exactly the things settings.js already
      // documents as not settings, with the reason written beside each one:
      //   your password       — a reset is not a way to take the door off. It is also the thing
      //                         that was just checked to get here.
      //   points, level, streak — earned, not configured. Nobody asking to put the checks back to
      //                         normal is asking to lose their streak.
      //   today's progress    — winding that back is its own control, with its own warning.
      //
      // The gates are the settings page's, not this handler's: strict mode and the password are
      // both answered there, the same way they are for reading a backup file in. This is the hands,
      // not the judgement.
      if (!self.FGSettings || !self.FGSettings.KEYS) { sendResponse({ ok: false }); return; }
      const patch = {};
      for (const key of Object.keys(self.FGSettings.KEYS)) {
        if (DEFAULTS[key] === undefined) continue;   // a settings key with nothing to reset to
        // Cloned, not referenced. The three list keys default to arrays, and handing out the very
        // array DEFAULTS holds would let the next edit to a target mutate the defaults themselves —
        // after which "reset" would restore whatever was last done.
        patch[key] = Array.isArray(DEFAULTS[key]) ? [] : DEFAULTS[key];
      }
      // Not a setting, so not in the table above, but it has to go with the work list: it records
      // that today's "everything is done" already fired, and the list it referred to is gone.
      patch.allDoneCelebratedOn = "";
      patch.timerPauseReason = "";
      patch.activeTargetId = "";
      // A break outlives nothing here either — it is a live state, and the rules it was pausing no
      // longer exist.
      patch.userPaused = false;
      await setState(patch);
      // The lists are empty now, so everything that was locked has to be let go at once rather
      // than on the next poll — and every card on every page has nothing left to count.
      creditAt.clear();
      paceCarry.clear();
      await refreshBlockedTabs();
      await paintBadge();
      await syncMobileLock(true);
      sweepSoon(0);
      sendResponse({ ok: true, count: Object.keys(patch).length });
    } else if (msg && msg.type === "refreshBlockedTabs") {
      const locked = await refreshBlockedTabs();
      // The list was just edited, so a local file may have become a target while
      // its tab is already open behind this page.
      startLocalBeatIfNeeded();
      sendResponse({ ok: true, locked });
    } else if (msg && msg.type === "aiTopicPrompt") {
      // "Show me exactly what you sent." Asked by the panel on the player when the user opens that line, and
      // by the settings page.
      //
      // On demand rather than pushed with the verdict, because a prompt carrying a transcript is tens of
      // thousands of characters and the tick reply goes out once a second to every page. Nobody needs it
      // until they ask.
      //
      // Read from the SAME cache entry the verdict came from, so what is shown is what was sent for that
      // verdict — not a fresh reconstruction, which would be a claim about the past rather than a record of
      // it, and would quietly differ the moment a setting changed.
      if (!aiOk()) { sendResponse({ ok: false }); return; }
      const s = await getState();
      const url = senderUrl(msg, sender);
      const ctx = topicContextFor(s, url, findProductiveMatch(url, s.productiveSites));
      const q = ctx ? aiTopicQuestion(s, url, ctx) : null;
      const hit = q ? aiCache.get(q.key) : null;
      const sent = (hit && hit.sent) ? hit.sent : null;
      sendResponse(sent
        ? { ok: true, prompt: sent.prompt, model: sent.model, mode: sent.mode, chars: sent.chars,
            topic: q ? q.topic : "", at: hit.at }
        : { ok: false, error: "Nothing has been sent for this page yet." });
    } else if (msg && msg.type === "aiTopicStatus") {
      // What the settings page shows under the switch: is it usable, and what went wrong last time.
      //
      // Answered from here rather than read from storage there, like every other verdict in this file:
      // "ready" is the switch AND a key AND a granted origin AND at least one target with a topic, and a
      // page working that out for itself would be a second implementation free to disagree with this one.
      //
      // THE KEY ITSELF NEVER LEAVES. Only the fact that one exists.
      if (!aiOk()) { sendResponse({ ok: false }); return; }
      const s = await getState();
      // Three counts, not one, because "nothing is being checked" has three different causes and the
      // settings page has to name the right one. A row with no sentence is waiting for you to decide what
      // you meant; a row with a sentence and its own switch off is a decision you already made; and the
      // difference matters when somebody wonders why the line says nothing is happening.
      const rows = s.productiveSites || [];
      const withTopic = rows.filter(t => FGAi.topicOf(t)).length;
      const mutedTopics = rows.filter(t => FGAi.topicTextOf(t) && !FGAi.topicOn(t)).length;
      const mode = FGAi.modeOf(s);
      sendResponse({
        ok: true,
        ready: aiTopicReady(s) && withTopic > 0,
        hasKey: !!String(s.aiTopicKey || "").trim(),
        hasOrigin: await aiHasOrigin(),
        topics: withTopic,
        muted: mutedTopics,
        total: rows.length,
        model: FGAi.modelOf(s),
        need: FGAi.threshold(s),
        mode,
        scope: FGAi.scopeOf(s),
        // What actually happened to the subtitles on the last video that was checked.
        //
        // This replaced a `needsYouTube` flag that reported a permission, and the permission turned out to
        // be the wrong thing to worry about entirely: the subtitles are fetched by the page, as the page,
        // so there was never a permission to grant — and while the settings page was reassuring everyone
        // that access was fine, the subtitles were not being read at all. What is worth reporting is the
        // outcome, so that is what is reported. "" until a video has been checked.
        transcriptWhy: aiLastTranscript ? aiLastTranscript.why : "",
        lastError: aiLastError
          ? { text: FGAi.errorText(aiLastError.err, aiLastError.status, aiLastError.detail), at: aiLastError.at }
          : null
      });
    } else if (msg && msg.type === "aiTopicTest") {
      // The ▶ beside the key box: one real request, right now.
      //
      // Deliberately asked at TITLE depth whatever the configured depth is, and with a fixed pair rather
      // than a real page. It proves the whole of what the button is for — the key is accepted, the origin
      // is granted, the model name exists, and it answers in the shape this code parses — which is every
      // failure somebody can fix from this screen. What it does not do is spend a video-understanding
      // request, a minute of waiting and a large slice of a free daily allowance to re-prove those same
      // four things.
      if (!aiOk()) { sendResponse({ ok: false, error: "The AI engine didn't load." }); return; }
      const s = await getState();
      // Locked pages must not be able to spend a request either. Same guard as the webhook test.
      if (s.passwordProtectionEnabled && s.passwordHash && !s.sessionUnlocked) {
        sendResponse({ ok: false, error: "locked" });
        return;
      }
      if (!String(s.aiTopicKey || "").trim()) { sendResponse({ ok: false, error: "No API key saved yet." }); return; }
      if (!(await aiHasOrigin())) {
        sendResponse({ ok: false, error: FGAi.errorText("permission") });
        return;
      }
      // Any target's topic, so the test says something about the user's own setup where it can. The
      // sample title is chosen to be an obvious match for a maths topic and an obvious miss for anything
      // else, so a surprising score is informative rather than confusing.
      // topicTextOf, not topicOf: this is a test of the KEY, so a sentence on a row whose own switch is
      // currently off is still a perfectly good thing to test with. Using the active-only reader here
      // would mean somebody who had muted every row got the generic sample and no explanation why.
      const own = (s.productiveSites || []).map(t => FGAi.topicTextOf(t)).find(Boolean) || "";
      const topic = own || "Linear algebra — vectors, matrices and eigenvalues";
      const r = await FGAi.ask({
        key: s.aiTopicKey, model: s.aiTopicModel, mode: "title", topic,
        page: { title: "Eigenvectors and eigenvalues, visually explained" }
      });
      if (!r.ok) {
        sendResponse({ ok: false, error: FGAi.errorText(r.err, r.status, r.detail), err: r.err });
        return;
      }
      sendResponse({
        ok: true, pct: r.pct, reason: r.reason || "", model: FGAi.modelOf(s),
        usedTopic: !!own, topic, mode: FGAi.modeOf(s)
      });
    } else if (msg && msg.type === "macrodroidTest") {
      // Fire a chosen webhook immediately so the user can verify their phone reacts.
      const ok = await fireMacrodroid(msg.url, msg.locked);
      sendResponse({ ok });
    } else if (msg && msg.type === "macrodroidSync") {
      await syncMobileLock(true);
      sendResponse({ ok: true });
    } else if (msg && msg.type === "macrodroidUnlock") {
      // Release the phone THIS INSTANT, whatever the reconciler thinks.
      //
      // Sent when FocusGate itself is switched off. syncMobileLock would get there too, but it is a
      // reconciler: it compares against mobileLockSent and is entitled to decide nothing needs
      // sending. That flag is a record of what was last successfully pushed, and it is least
      // trustworthy in exactly this situation — a phone locked by a worker that has since been shut
      // down and woken again. "Off" has to mean nothing of FocusGate's is still holding anything, so
      // this asks outright rather than asking politely.
      sendResponse(await releaseMobileNow());
    } else if (msg && msg.type === "openTargets") {
      // Which of your targets have a tab open on them (the dot beside each name).
      sendResponse({ ok: true, open: await openTargetIds() });
    } else if (msg && msg.type === "openTarget") {
      sendResponse(await focusOrOpen(msg));
    } else if (msg && msg.type === "browseLocal") {
      // Opening a local target that has no address of its own: the blocked page's "find it" button.
      //
      // The settings page used to send this too, from a "Browse in a tab…" button in its file
      // picker. That button is gone — it was a third route to what the two file dialogs beside it
      // already did. This stays because the blocked page's use of it has no alternative: it is shown
      // for a target whose full path FocusGate was never told, so there is nothing else to open.
      sendResponse(await browseForLocal(msg || {}));
    } else if (msg && msg.type === "checkBlocked") {
      const state = await getState();
      const url = msg.url || senderUrl(msg, sender);
      const info = await getBlockReason(url, state);
      sendResponse({ ok: true, blocked: !!info.blocked, redirect: blockedPageUrl(url, info) });
    } else if (msg && msg.type === "blockInfo") {
      const state = await getState();
      const info = await getBlockReason(msg.url, state);
      sendResponse({ ok: true, info });
    } else if (msg && msg.type === "pageZoom") {
      // How much the page this card is sitting on has been zoomed. The card is an ordinary
      // element in that page, so it shrinks and grows with everything else — at 25% it was a
      // thumbnail you could not read. It has to hold one physical size, and that needs the
      // exact factor.
      //
      // Asked of the browser rather than worked out in the page. A content script can only
      // guess: outerWidth / innerWidth is off by the window frame and the scrollbar, and
      // devicePixelRatio folds the display's own scaling in with the zoom and cannot separate
      // them. chrome.tabs.getZoom is the number itself.
      //
      // Needs no "tabs" permission — the zoom methods are exempt.
      let zoom = 1;
      try { if (sender && sender.tab) zoom = await chrome.tabs.getZoom(sender.tab.id); } catch {}
      sendResponse({ ok: true, zoom: (zoom > 0 ? zoom : 1) });
    }
  })();
  return true;
});

function findProductiveMatchEnhanced(url, sitesIn, ytChannel, ytPlaylist) {
  // Targets switched off don't earn time, so they never match.
  const sites = activeTargets(sitesIn);
  // An exact video is the most specific thing you can ask for, so it wins over a
  // channel or playlist target that happens to contain it.
  const vid = youtubeVideoId(url);
  if (vid) {
    for (const s of sites) {
      if (s.type === "youtube_video" && (s.videoId || "").trim() === vid) return s;
    }
  }
  // Prefer exact YouTube channel/playlist if content script reported
  if (ytChannel) {
    for (const s of sites) {
      if (s.type === "youtube_channel") {
        const want = (s.channelId || s.url || "").toLowerCase().replace(/^@/,"");
        const got = (ytChannel || "").toLowerCase().replace(/^@/,"");
        if (want && got && (got === want || got.includes(want) || want.includes(got))) return s;
      }
    }
  }
  if (ytPlaylist) {
    for (const s of sites) {
      if (s.type === "youtube_playlist") {
        const want = (s.playlistId || s.url || "").trim();
        if (want && (ytPlaylist === want || ytPlaylist.includes(want) || want.includes(ytPlaylist))) return s;
      }
    }
  }
  return findProductiveMatch(url, sites);
}

// When each target was last paid, by target id. Time is credited by the CLOCK, not
// by the number of messages that arrive — a page sends a tick about once a second,
// but it also sends one the moment something happens (arriving on a work page,
// coming back to the tab, a single-page app rewriting its address), and paying a
// second per message meant a site like Duolingo, which changes its URL constantly,
// filled a 30-minute goal in a fraction of that. Two tabs open on the same target
// used to pay twice over for the same second, too.
//
// Deliberately in memory rather than in storage: it would otherwise be a write every
// second per tab, and losing it costs at most one second. The worker only sleeps when
// nothing is ticking, which is when there is nothing to lose.
const creditAt = new Map();
function forgetCredit(id) {
  if (!id) return;
  creditAt.delete(id);
  // The part-second the speed multiplier was holding goes with it. It belongs to the
  // measurement being abandoned — the stamp above is what it was measured against — so
  // carrying it across a pause would credit a fraction of a second nobody was watched for.
  paceCarry.delete(id);
}
// How many whole seconds this target has earned since it was last paid.
function secondsOwed(id, now) {
  const last = creditAt.get(id) || 0;
  // Nothing to measure from — first tick on this target, or the clock was stopped
  // and this is the first one since. Start the clock here and pay from the next one.
  // The 5s ceiling is the same idea: a longer gap means nobody was reporting (a
  // throttled background tab, a sleeping worker), and time nobody watched is not paid.
  if (!last || now - last > 5000) { creditAt.set(id, now); return 0; }
  const gap = now - last;
  if (gap < 1000) return 0;                 // less than a second owed yet
  const add = Math.floor(gap / 1000);
  // The remainder carries over rather than being thrown away, so a page reporting
  // every 1.4s doesn't quietly lose a share of every second it earns.
  creditAt.set(id, last + add * 1000);
  return add;
}

// ---------- how fast a second counts ----------
// secondsOwed above measures REAL seconds off the clock. This is the only thing in FocusGate
// that then credits a different number of them: fill the dashed box on the camera preview with
// your head and the multiplier goes up, sit back out of it and it comes down.
//
// Same three functions, same constants, as the Anki extension. Two extensions asking the same
// question of the same webcam should not answer it differently.
//
// The reading itself is not stored. It arrives on the tick the page already sends every second,
// which is the same message that decides whether the clock runs at all — so a multiplier can
// never outlive the verdict it belongs to. That is the whole freshness model, and it is a
// stronger one than a timestamp: the page reporting a speed IS the page still being there.
const PACE_HARD_MIN = 0.1, PACE_HARD_MAX = 4;
// The two dials as a min/max pair rather than as "fast" and "slow". Crossing them over on the
// settings page then behaves like the range it looks like instead of inverting: whatever the
// camera reports is held inside whatever the user actually set, either way round.
function paceRange(rules) {
  const f = Number((rules || {}).paceFast);
  const s = Number((rules || {}).paceSlow);
  const fast = Number.isFinite(f) ? f : DEFAULTS.paceFast;
  const slow = Number.isFinite(s) ? s : DEFAULTS.paceSlow;
  const clamp = (n) => Math.max(PACE_HARD_MIN, Math.min(PACE_HARD_MAX, n));
  return { lo: clamp(Math.min(fast, slow)), hi: clamp(Math.max(fast, slow)) };
}
// What multiplier applies to this second. 1 — no change at all — for every case where there is
// no live reading to act on, which is the only honest default: a multiplier is a claim about
// what the camera can see right now, and no reading is not a reading.
function facePace(rules, reported) {
  if (!rules || rules.paceEnabled !== true) return 1;
  // Nothing is looking, so nothing can be earned faster. The page guards this too; it is
  // repeated here because this is the function that hands out the time.
  if (!rules.faceDetectionEnabled) return 1;
  const p = Number(reported);
  if (!Number.isFinite(p)) return 1;
  // The slider range is applied here, where the number is USED, rather than to the number on
  // its way in — so moving a slider takes effect on the next second rather than whenever the
  // camera happens to report next.
  const r = paceRange(rules);
  return Math.max(r.lo, Math.min(r.hi, p));
}
// Whole seconds to credit, with the fraction kept for next time.
//
// The carry is what makes a multiplier under 1 mean "slower" rather than "stopped": half of one
// second, floored, is zero — for ever. With it, 0.5 pays a second every other second.
//
// Per target, and in memory beside creditAt for the same reasons as that map: in storage it
// would be a write every second per tab, and losing it costs under a second.
const paceCarry = new Map();
function paceSlice(id, slice, pace) {
  // Exactly 1 is not "a multiplier of one", it is "no multiplier" — the feature off, the camera
  // off, no reading. Dropping the carry keeps a stale fraction from being paid out much later
  // under a rule that is no longer running.
  if (pace === 1) { paceCarry.delete(id); return slice; }
  const want = slice * pace + (paceCarry.get(id) || 0);
  // Nudged before flooring, and this is not a nicety — without it the slowest setting loses a
  // tenth of the time it credits.
  //
  // 0.1 has no exact form in binary, so ten of them add up to 0.9999999999999999 rather than 1.
  // Floored, that is zero: the second that was owed on the tenth tick is not paid, the carry
  // rolls on, and every cycle of ten slips one payment. Over a hundred seconds at 0.1× the user
  // is credited nine instead of ten.
  //
  // 1e-9 is chosen with room on both sides. `want` here is at most about 21 — a five-second
  // slice, which is the ceiling secondsOwed will report, times the hard maximum of 4, plus a
  // carry under 1 — and at that magnitude a double resolves to roughly 1e-15, so the nudge is
  // six orders of magnitude above the error it is absorbing. It is also six orders below
  // anything that could round up a second genuinely still owed: that would need `want` to sit
  // within a nanosecond of the whole number.
  const paid = Math.floor(want + 1e-9);
  // Floored at 0 for the same reason: the nudge can leave the remainder a hair below zero, and a
  // negative carry would quietly eat into the next second.
  paceCarry.set(id, Math.max(0, want - paid));
  return Math.max(0, paid);
}

// Returns the speed multiplier it actually credited at, so the page can show that rather than the
// one the camera merely reported.
//
// Those two are not the same claim and the difference is the whole reason this is returned: the
// camera says "your head fills the box", this says "and I therefore paid you four seconds for
// that one". A badge showing the first while the second was quietly 1 is a badge that lies about
// the only thing anyone wants to know.
async function tickFromContent(url, ytChannel, ytPlaylist, senderTabId, pace) {
  const state = await getState();
  await maybeReset(state);
  if (!state.enabled) return 1;
  const fresh = await getState();
  let match = findProductiveMatchEnhanced(url, fresh.productiveSites, ytChannel, ytPlaylist);
  // Earning from a YouTube video that is ABOUT one of your subjects, even though the video itself is not a
  // site you nominated. The card whose topic it matched is credited exactly as if you were on that card's
  // own site — same accumulator, same cap, same completion. Only a settled, on-topic video earns; a pending
  // or off-topic one returns null and nothing is credited. Uses the page's own url, so it fires on a watch
  // page and never on the feed: a video playing on in the miniplayer while you read the feed is the gate's
  // business (it may be covered) but is not watching, so it earns nothing. See videoEarnTarget.
  if (!match) match = videoEarnTarget(fresh, url);
  // Not a work page, and not a video earning its keep. The badge still reports today's total — it is about
  // the day, not about where you happen to be, and blanking it here was what made the icon useless on
  // exactly the pages you are being kept off.
  if (!match) { await paintBadge(fresh); return 1; }

  // Worked out before anything else, and returned on every path below, so the page can be told
  // the real figure even on the ticks that credit nothing.
  const used = facePace(effectiveCheat(fresh, match), pace);

  // Sequence mode: a step you are not on yet earns nothing.
  //
  // The blocking already turns such a page away on navigation, so most of the time this tick never
  // happens — but "most of the time" is not the rule. A tab already sitting on step three when step
  // one finishes has not navigated anywhere, and the sweep that catches it runs on a timer; without
  // this, the seconds in between would be credited to the wrong step, which is precisely the thing
  // the feature exists to prevent.
  //
  // BEFORE secondsOwed rather than after, and that is the difference between refusing the seconds and
  // merely postponing them. secondsOwed and paceSlice both bank what they are not paid — a remainder
  // carries, a stamp advances — so a skip placed after them would hold the time and hand it over in a
  // lump the moment the step came round. Nothing is measured here at all, so there is nothing held.
  // The stale stamp is harmless by secondsOwed's own 5-second ceiling: a gap longer than that is read
  // as "nobody was reporting" and starts the clock again from zero.
  //
  // `used`, not 1, like every other early return here: it is what the camera reported, and the badge
  // on the page shows it.
  if (fresh.sequenceMode === true && self.FGSettings && self.FGSettings.inCurrentStep) {
    const seqSites = activeTargets(fresh.productiveSites);
    if (seqSites.length > 1 && !self.FGSettings.inCurrentStep(match, seqSites)) {
      await paintBadge(fresh);
      return used;
    }
  }

  const owed = secondsOwed(match.id, Date.now());
  if (owed <= 0) return used;               // nothing owed on this tick
  // Real seconds in, credited seconds out. Only the camera's speed multiplier moves the two
  // apart, and only while this target has it switched on — see facePace.
  //
  // Deliberately applied here and nowhere else. secondsOwed keeps its own stamp in REAL time
  // and must go on doing so: a clock that runs fast invents time, and the 5-second ceiling that
  // stops an unwatched gap being paid for is a real-world quantity.
  const add = paceSlice(match.id, owed, used);
  if (add <= 0) return used;                // slowed below a whole second; the rest is carried

  const wasDone = (match.spentSec || 0) >= (match.requiredSec || 0);
  const prevSpent = match.spentSec || 0;
  let completedNow = false;
  const sites = fresh.productiveSites.map(s => {
    if (s.id === match.id) {
      const spent = Math.min((s.requiredSec || 0), (s.spentSec || 0) + add);
      const nowDone = !wasDone && spent >= (s.requiredSec || 0);
      if (nowDone) completedNow = true;
      // The moment the goal was reached, stamped exactly once per day.
      //
      // This is the whole of how a per-row deadline is enforced: the window is checked against THIS
      // stamp rather than against the time the question is asked, so finishing at 08:50 inside a
      // 06:00–09:00 window keeps the unlock for the rest of the day, and finishing at 09:10 does not
      // earn it at 09:11 or at any point after. See targetMet in settings.js.
      //
      // Written on the completing tick and never rewritten, because "when did you finish" has one
      // answer. Cleared by the daily reset, and by winding the bar back below the goal — a row that
      // is no longer finished has no finishing time.
      if (nowDone) return { ...s, spentSec: spent, metAt: Date.now() };
      return { ...s, spentSec: spent };
    }
    return s;
  });

  // This second was credited to this target, so it's the one being worked on.
  const patch = { productiveSites: sites, activeTargetId: match.id, activeTargetAt: Date.now() };
  let xpAwarded = 0;
  const updated = sites.find(s => s.id === match.id);
  // A point per minute crossed, not per tick that happens to land on an exact
  // multiple of 60 — with more than one second credited at a time, that multiple can
  // be stepped straight over and the minute would go unpaid.
  xpAwarded += Math.max(0, Math.floor(updated.spentSec / 60) - Math.floor(prevSpent / 60));

  if (completedNow) xpAwarded += 50;

  if (xpAwarded > 0) {
    const newXp = (fresh.xp || 0) + xpAwarded;
    patch.xp = newXp;
    patch.level = Math.floor(newXp / 500) + 1;
  }

  await setState(patch);

  // "Everything is done" is decided in one place, and it also carries the +200 and
  // the streak, so every route into it awards the same thing.
  const bigCelebrate = completedNow ? await maybeCelebrateAllDone() : false;

  // Finishing something can be what opens the locked list, so any tab sitting on
  // the blocked screen is sent back at once rather than on its next poll.
  if (completedNow) sweepSoon(0);

  if (completedNow && senderTabId && !bigCelebrate) {
    const onTargets = activeTargets(sites);
    const groups = (self.FGSettings && self.FGSettings.computeTargetGroups)
      ? self.FGSettings.computeTargetGroups(onTargets)
      : onTargets.map(p => [p]);
    const isPending = (g) => !g.some(p => (p.requiredSec === 0) || (p.spentSec || 0) >= (p.requiredSec || 0));
    const pendingGroups = groups.filter(isPending);

    // "Next" means the one AFTER this one in your list, not the first one still outstanding.
    //
    // `pendingGroups[0]` was the whole of this decision, and it is only ever right if you work
    // top to bottom: finish the third card of four with the first still untouched and the toast
    // pointed back at the first, which is not what "next" says and not the order you had just
    // demonstrated you were working in. So the completed card's own position is found first and
    // the search starts below it.
    //
    // `groups` is sorted by each row's `order`, the same field the drag handles on the settings
    // page write — so "below it" here is literally the card below it there.
    //
    // Wrapping round to the top afterwards, rather than stopping at the end: something is still
    // outstanding, and a toast that says nothing when there is somewhere to go is worse than one
    // that points upwards. Finishing the last card sends you back to whatever you skipped.
    //
    // findIndex can come back -1 — the row was switched off, or dropped from today's schedule,
    // between the tick that credited it and this line — and the old behaviour is the right
    // answer for that case: no position to count from, so start at the top.
    const myGroupIdx = groups.findIndex(g => g.some(p => p.id === match.id));
    const nextGroup = myGroupIdx < 0
      ? pendingGroups[0]
      : (groups.slice(myGroupIdx + 1).find(isPending) || groups.slice(0, myGroupIdx).find(isPending));

    let nextTargets = [];
    if (nextGroup && nextGroup.length) {
      nextTargets = nextGroup.map(p => {
        const isLocal = p.type === "local_file";
        const name = p.label || (isLocal ? fileLeaf(p.url || p.path) : p.url) || "Study site";
        const remSec = Math.max(0, (p.requiredSec || 0) - (p.spentSec || 0));
        const remFmt = (self.FGSettings && self.FGSettings.fmtDur) ? self.FGSettings.fmtDur(remSec) : `${Math.ceil(remSec / 60)}m`;
        const openUrl = (self.FGSettings && self.FGSettings.targetOpenUrl) ? self.FGSettings.targetOpenUrl(p) : (p.url || "");
        return {
          id: p.id,
          name,
          remSec,
          remFmt,
          url: openUrl,
          // The toast's Open button is an element in somebody's web page, and a web page cannot
          // navigate to `file:///…` or to an extension URL — Chrome drops the attempt silently.
          // So the button asks the worker to open it instead, and these three are what that
          // request needs:
          //   isLocal  which way to ask. A local target with no address of its own has to go
          //            through browseLocal rather than openTarget, because there is nothing to
          //            follow — see the note on that handler.
          //   pattern  how to find a tab that is ALREADY on it, so pressing Open on a file you
          //            have open focuses that tab instead of opening a second copy of the same PDF.
          //   hasUrl   whether there is an address at all. `url` can be empty for a file picked
          //            through Chrome's dialog, which only yields the leaf name.
          isLocal,
          pattern: p.url || p.path || "",
          hasUrl: !!openUrl,
          operator: p.operator || "AND"
        };
      });
    }

    const completedName = match.label ||
                          (match.type === "local_file" ? fileLeaf(match.url || match.path) : match.url) ||
                          "Study site";

    try {
      chrome.tabs.sendMessage(senderTabId, {
        type: "celebrate",
        payload: {
          title: "Target Complete!",
          subtitle: completedName,
          completedName,
          nextTargets,
          remainingGroupsCount: pendingGroups.length,
          xp: xpAwarded,
          big: false
        }
      }, () => void chrome.runtime.lastError);
    } catch {}
  }

  const remaining = Math.max(0, (updated.requiredSec || 0) - (updated.spentSec || 0));
  await paintBadge();
  await syncMobileLock(); // push lock/unlock to phone if goal state changed
  return used;
}

// ---------- the toolbar badge ----------
// Today's work, added up across every target.
//
// Shows live remaining time for today across all sites on the badge,
// and detailed breakdown (total, remaining, spent, %) on hover.
function badgeText(left) {
  if (left <= 0) return "✓";
  if (left < 60) return left + "s";                 // live second-by-second countdown
  const mins = Math.ceil(left / 60);
  if (mins < 60) return mins + "m";                 // e.g. 45m
  const h = Math.floor(mins / 60), m = mins % 60;
  if (h < 10) return m > 0 ? `${h}h${m < 10 ? "0" + m : m}` : `${h}h`; // e.g. 1h15, 2h
  return `${h}h`;
}

function resetDefaultIcon() {
  try {
    if (chrome.action && chrome.action.setIcon) {
      chrome.action.setIcon({
        path: {
          "16": "icons/icon16.png",
          "48": "icons/icon48.png",
          "128": "icons/icon128.png"
        }
      });
    }
  } catch {}
  // Whatever paintIcon believed is now wrong: this has just put the full-colour icon back from
  // underneath it. Cleared rather than set to "on", because this is also called as a baseline at
  // startup and the answer there is not known yet — "unknown" makes the next paintIcon do the work
  // instead of skipping it.
  iconStateShown = null;
}

// ---------- the icon says whether any of this is running ----------
// Switched off, FocusGate does nothing at all: nothing is blocked, nothing is counted, no phone is
// touched. The badge already clears — but an empty badge is also what a fresh profile with no work
// set up looks like, and what a finished day looks like for a moment. So "off" had no appearance of
// its own: the toolbar showed a healthy, full-colour icon for an extension that was inert.
//
// Greyed rather than badged with a mark. A mark is another thing to learn and it competes with the
// countdown that badge exists for; a drained icon is the convention every browser already uses for
// "this is not active", and it reads at 16px where a glyph does not.
//
// Built rather than shipped as three more PNGs, because a second set of icons is a second set to
// keep in step — redraw the logo and one of them is quietly wrong. Derived from the real ones, so
// they cannot disagree.
let greyIconData = null;          // built once, then reused: the logo never changes at runtime
let iconStateShown = null;        // what is currently on the toolbar, so nothing is repainted for nothing

async function buildGreyIcon() {
  if (greyIconData) return greyIconData;
  // OffscreenCanvas because a service worker has no document. createImageBitmap takes the blob
  // straight from our own packaged file, so nothing here touches the network.
  if (typeof OffscreenCanvas !== "function" || typeof createImageBitmap !== "function") return null;
  const out = {};
  for (const size of [16, 48, 128]) {
    const res = await fetch(chrome.runtime.getURL(`icons/icon${size}.png`));
    const bmp = await createImageBitmap(await res.blob());
    const canvas = new OffscreenCanvas(size, size);
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) return null;
    ctx.drawImage(bmp, 0, 0, size, size);
    try { bmp.close(); } catch {}
    const img = ctx.getImageData(0, 0, size, size);
    const d = img.data;
    for (let i = 0; i < d.length; i += 4) {
      // Rec. 601 luminance, which is what "greyscale" means to an eye rather than to an average:
      // a flat (r+g+b)/3 turns a saturated amber logo into a mid-grey blob and loses the shape.
      const lum = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
      // Darkened as well as drained. Grey alone still reads as a normal icon in a dark toolbar —
      // it has to look switched off, not merely colourless. Alpha is left alone: fading the whole
      // icon makes it look like a rendering fault rather than a state.
      const v = Math.round(lum * 0.58);
      d[i] = d[i + 1] = d[i + 2] = v;
    }
    ctx.putImageData(img, 0, 0);
    out[size] = img;
  }
  greyIconData = out;
  return out;
}

// `on` is the master switch. Called from paintBadge, which every path that can change this already
// goes through — and guarded on the last state shown, because paintBadge runs about once a second
// while the clock is counting and setIcon is not free.
async function paintIcon(on) {
  if (!chrome.action || !chrome.action.setIcon) return;
  const want = on ? "on" : "off";
  if (iconStateShown === want) return;
  // Written before the await, not after. Two callers a few milliseconds apart — a storage change and
  // the heartbeat, which is exactly how this gets called — would both pass the check above while the
  // first was still building its bitmaps, and the second would repaint over the first for nothing.
  iconStateShown = want;
  if (on) { resetDefaultIcon(); return; }
  try {
    const imageData = await buildGreyIcon();
    // No OffscreenCanvas (an older or a mobile extension browser): the icon simply stays as it is.
    // The badge is still cleared and the popup still says "Off" in words, so nothing is misreported
    // — the toolbar just says less than it could.
    if (!imageData) { iconStateShown = null; return; }
    chrome.action.setIcon({ imageData });
  } catch {
    // Left unknown rather than claimed: the next paintBadge tries again.
    iconStateShown = null;
  }
}

async function paintBadge(state) {
  // Badge APIs may be absent on mobile extension browsers (e.g. Quetta)
  if (!chrome.action || !chrome.action.setBadgeText) return;
  const s = state || await getState();
  const clear = () => {
    try { chrome.action.setBadgeText({ text: "" }); } catch {}
    try { chrome.action.setTitle({ title: "FocusGate" }); } catch {}
  };
  // The icon's colour, wherever the badge is decided. Not awaited: nothing below depends on it, and
  // the first call after a restart has three bitmaps to build.
  paintIcon(s.enabled !== false);
  if (s.enabled === false) {
    clear();
    // Said in the tooltip as well as in the colour. The grey is the thing you notice; this is the
    // thing that tells you it is deliberate when you go looking.
    try { chrome.action.setTitle({ title: "FocusGate is off — nothing is blocked or tracked" }); } catch {}
    return;
  }
  const sites = activeTargets(s.productiveSites);
  // Nothing set up means nothing to report. A "✓" here would be a claim that you had
  // finished something, when you have not asked for anything yet.
  if (!sites.length) { clear(); return; }

  const totals = (self.FGSettings && self.FGSettings.calcTotals)
    ? self.FGSettings.calcTotals(sites)
    : {
        req: sites.reduce((a, p) => a + (p.requiredSec || 0), 0),
        spent: sites.reduce((a, p) => a + Math.min(p.requiredSec || 0, p.spentSec || 0), 0),
        allDone: sites.length > 0 && sites.every(p => (p.requiredSec === 0) || (p.spentSec || 0) >= (p.requiredSec || 0))
      };
  const req = totals.req;
  const spent = totals.spent;
  const left = totals.left !== undefined ? totals.left : Math.max(0, req - spent);
  const allDone = totals.allDone;
  const pct = totals.pct !== undefined ? totals.pct : (allDone ? 100 : (req > 0 ? Math.min(100, Math.round((spent / req) * 100)) : 0));

  // Badge background color: Green if done, Orange if in progress, Red if not started
  const badgeColor = allDone ? "#16a34a" : (spent > 0 ? "#ea580c" : "#dc2626");
  try { chrome.action.setBadgeBackgroundColor({ color: badgeColor }); } catch {}
  try { chrome.action.setBadgeText({ text: allDone ? "✓" : badgeText(left) }); } catch {}

  // Tooltip with complete metrics on hover
  try {
    chrome.action.setTitle({
      title: allDone
        ? `FocusGate — Today's Total: ${fmtDurDetail(req)} | All Done! ✓ (100%)`
        : `FocusGate — Today's Total: ${fmtDurDetail(req)} | Remaining: ${fmtDurDetail(left)} | Done: ${fmtDurDetail(spent)} (${pct}%)`
    });
  } catch {}
}

// Detailed formatting for tooltip and UI: "1h 30m 45s", "45m 12s", "30s"
function fmtDurDetail(sec) {
  const t = Math.max(0, Math.round(sec));
  const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = t % 60;
  const parts = [];
  if (h) parts.push(`${h}h`);
  if (m) parts.push(`${m}m`);
  if (s || (!h && !m)) parts.push(`${s}s`);
  return parts.join(" ");
}

function fmtDurBadge(sec) {
  return fmtDurDetail(sec);
}

// ---------- alarms (daily reset & periodic check & auto-lock) ----------
chrome.alarms.create("focusgate_tick", { periodInMinutes: 1 });
chrome.alarms.onAlarm.addListener(async (a) => {
  if (a.name === "focusgate_tick") {
    const state = await getState();
    // The day still rolls over while FocusGate is off, but nothing is blocked and
    // no phone is touched — being off has to mean nothing happens.
    await maybeReset(state);
    if (!state.enabled) return;
    await syncMobileLock(); // non-forced: only re-sends if state changed or a prior send failed
    await enforceOnAllTabs();
    startLocalBeatIfNeeded();   // revive the local-file clock if the worker restarted
  } else if (a.name === AUTO_LOCK_ALARM) {
    if (openPortCount === 0) {
      await setState({ sessionUnlocked: false });
    }
  }
});

// ---------- auto-lock via port disconnect ----------
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "popup" && port.name !== "options") return;
  openPortCount++;
  chrome.alarms.clear(AUTO_LOCK_ALARM);
  port.onDisconnect.addListener(async () => {
    openPortCount = Math.max(0, openPortCount - 1);
    if (openPortCount > 0) return;
    const s = await getState();
    const delay = Math.max(0, s.autoLockDelaySec || 0);
    if (delay === 0) {
      await setState({ sessionUnlocked: false });
      return;
    }
    // chrome.alarms minimum is 0.5 min in prod. For <30s, use short alarm; <1min will round up.
    chrome.alarms.create(AUTO_LOCK_ALARM, { delayInMinutes: Math.max(0.0084, delay / 60) });
  });
});

// React immediately to goal / mobile-setting changes (e.g. user edits target
// minutes in options) by re-syncing the phone lock state right away.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;

  // Anything that changes WHAT should be blocked re-checks the tabs you already
  // have open, straight away — no waiting for the next heartbeat. Deliberately
  // not watching productiveSites here: it's rewritten every second while the
  // clock runs, and options already asks for a sweep when you edit the list.
  if (changes.enabled || changes.blockMode || changes.blockedSites || changes.allowedSites ||
      // The AI category lists, for the same reason as the two typed ones above: switching a category on can
      // shut a tab that is open right now, and switching it off has to release it. Deliberately NOT
      // aiCatSeen — that is written every time a site is classified, and a sweep per classification would
      // be a sweep per new domain for no benefit. The classifier wakes the blocker itself when a verdict
      // actually changes something; see aiCatAsk.
      changes.aiCatEnabled || changes.aiCatBlock || changes.aiCatAllow ||
      // Whether an off-topic page on a target is merely uncounted or actually taken away. Switching it
      // OFF has to release any tab it is currently holding, and that release must not wait for the
      // minute tick — the whole reason somebody turns it off is a page they want back.
      changes.aiTopicBlocks || changes.aiTopicEnabled || changes.aiTopicVideoGate ||
      // Whether the work list is read as a sequence. Exactly the shape of blockMode above it: it does
      // not change any row, it changes what the whole list MEANS — switching it on shuts every study
      // site but one, and switching it off opens them all again. The settings page asks for this sweep
      // itself, so this is for every other way the key can move: a restored backup, a second window.
      changes.sequenceMode) {
    // Instant sweep with zero delay: tabs that are no longer blocked must release immediately.
    refreshBlockedTabs();
  }

  // The power switch behaves like Chrome's own "disable extension": everything
  // stops at once. Off clears the badge and drops the "why is my timer paused"
  // stamp. The pages themselves tear their timers down from the same storage
  // change.
  if (changes.enabled) {
    const on = changes.enabled.newValue !== false;
    paintBadge();                 // clears it when off, restores today's total when on
    if (!on) {
      // The stretch stops being a stretch: nothing is watching, so nothing is "paused". Cleared
      // rather than frozen, or switching off for an hour and back on would report that hour as
      // one unbroken pause you never chose.
      forgetPause();
      setState({ timerPauseReason: "", timerPauseAt: 0, pauseSinceAt: 0 });
    } else {
      startLocalBeatIfNeeded();
    }
  }

  // Today's total changed: a second credited, a target added or removed, a time edited, the
  // day reset. productiveSites is rewritten every second while the clock runs, which is
  // exactly the cadence the badge wants, so this is deliberately not debounced — setBadgeText
  // is cheap and a stale countdown on the icon is the thing being fixed.
  if (changes.productiveSites) paintBadge();

  if (changes.productiveSites || changes.macrodroidEnabled ||
      changes.macrodroidLockUrl || changes.macrodroidUnlockUrl ||
      changes.enabled) {
    syncMobileLock();
  }

  // productiveSites is rewritten every second while the clock runs, so it can't
  // simply be added to the list above. What matters for blocking is only *which*
  // targets exist and what they demand — deleting one, switching one off, or
  // changing a time. Compare that alone, and sweep the moment it differs.
  if (changes.productiveSites) {
    const sig = targetsSignature(changes.productiveSites.newValue);
    // A service worker that has just woken up has never seen the list before. Its
    // previous shape is right there in the change record, so use that rather than
    // letting the first change of a new worker's life go unanswered — that was the
    // one case where switching every target off left a tab locked.
    const was = lastTargetsSig !== null
      ? lastTargetsSig
      : targetsSignature(changes.productiveSites.oldValue);
    if (sig !== was) sweepSoon(0);
    lastTargetsSig = sig;
  }
});

// ---------- a window is always long enough to finish its goal in ----------
//
// The settings page, the ＋ on a card and a restored backup each keep a row's window longer than its goal
// (see fitWindowEnd in settings.js). This is the backstop for everything else: a window saved before the
// rule existed — a 30-minute goal inside 5:14–5:15 — and any route that writes the list without asking. It
// does what those places do: keeps the start, and moves the end out to the shortest window that fits.
//
// Checked whenever the list changes, which is once a second while the clock runs — so the check is a pass
// over a handful of rows and writes nothing unless a window is actually short.
function windowsNeedFit(list) {
  const F = self.FGSettings;
  if (!F || !F.hasWindow || !F.fitWindowEnd || !Array.isArray(list)) return false;
  return list.some(p => {
    if (!p || !F.hasWindow(p)) return false;
    const fitEnd = F.fitWindowEnd(p);
    return !!fitEnd && fitEnd !== p.winEnd;
  });
}
let fitWindowsTimer = 0;
function fitWindowsSoon(ms) {
  clearTimeout(fitWindowsTimer);
  fitWindowsTimer = setTimeout(() => { fitWindowsTimer = 0; fitWindowsToGoals().catch(() => {}); }, ms);
}
async function fitWindowsToGoals() {
  const F = self.FGSettings;
  if (!F || !F.hasWindow || !F.fitWindowEnd) return;
  const s = await getState();
  const list = Array.isArray(s.productiveSites) ? s.productiveSites : [];
  if (!windowsNeedFit(list)) return;
  await setState({
    productiveSites: list.map(p => {
      if (!p || !F.hasWindow(p)) return p;
      const fitEnd = F.fitWindowEnd(p);
      return (fitEnd && fitEnd !== p.winEnd) ? { ...p, winEnd: fitEnd } : p;
    })
  });
}
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local" || !changes.productiveSites) return;
  // A beat later rather than at once, so a page that is mid-way through its own write finishes first.
  if (windowsNeedFit(changes.productiveSites.newValue)) fitWindowsSoon(400);
});
// And once whenever the worker starts, for rows stored before any of this existed.
fitWindowsSoon(1500);

// ---------- a setting that governs YouTube changed: reload the YouTube tabs ----------
//
// With the AI side on, what a YouTube page does — which videos are held, covered, let through, or earn a card
// its time — is decided by a handful of settings. A YouTube tab in the background picks most of a change up on
// its next tick, but not all of it cleanly: a verdict already on screen, a video already released or held, a
// miniplayer mid-check. So when one of those settings changes, the YouTube tabs behind the one you are looking
// at are reloaded and start again under the new rules.
//
// Watched here, in the worker, so every route a setting can move by is covered the same way: the settings
// page, the popup, a restored backup, "reset everything".
//
// What counts: every Study topics setting (the switches, the bar, the depth, the model, the key); the master
// switch; and any change to a card that carries a 🎯 topic or points at YouTube itself — its sentence, its
// switch, its window, its days, its goal, its checks, or the card being added or removed.
// What does not: cards with no topic and nothing to do with YouTube, and every value the extension writes by
// itself — today's progress, the stopwatch stamp, a local file's discovered path. Those change every second
// while you work, and counting them would reload YouTube every second.
//
// Only while the AI feature is on, or was until this very change: switching it off reloads too, so the pages
// let go of everything it was doing to them instead of carrying it until you next navigate.
const YT_RELOAD_KEYS = [
  "enabled",
  "aiTopicEnabled", "aiTopicVideoGate", "aiTopicVideoEarn", "aiTopicMinPct", "aiTopicModel",
  "aiTopicMode", "aiTopicScope", "aiTopicStrict", "aiTopicBlocks", "aiTopicKey"
];
// YouTube itself, where the gate acts. Not studio.youtube.com — an upload in progress must never be reloaded
// out from under someone — and not music.youtube.com, which is not the page this is about.
const YT_RELOAD_URLS = ["*://www.youtube.com/*", "*://youtube.com/*", "*://m.youtube.com/*"];
// One reload once the edits stop, not one per keystroke: the settings page saves as you type.
const YT_RELOAD_DEBOUNCE_MS = 1500;
// The parts of a card the extension writes by itself rather than you setting them…
const YT_SIG_SKIP = new Set(["spentSec", "metAt", "graceFrom"]);
// …and, on a local file, the address it was discovered at, which is learned rather than set.
const YT_SIG_SKIP_LOCAL = new Set(["url", "path", "stored"]);
let ytReloadTimer = 0;
// A list the worker wrote on a page's behalf — the ＋ on a card, a disc in the camera tray. Those are pressed
// IN a page, often the YouTube page itself, and are not settings changes. See ytQuietWrite.
let ytQuiet = null;

// The same value always reads as the same string, whatever order its keys were written in.
function stableJson(v) {
  if (Array.isArray(v)) return "[" + v.map(stableJson).join(",") + "]";
  if (v && typeof v === "object") {
    return "{" + Object.keys(v).filter(k => v[k] !== undefined).sort()
      .map(k => JSON.stringify(k) + ":" + stableJson(v[k])).join(",") + "}";
  }
  return JSON.stringify(v === undefined ? null : v);
}
// Does this card have any bearing on YouTube? A 🎯 topic — those feed the video gate and the earning — or an
// address on YouTube itself.
function ytRowRelevant(p) {
  if (!p || typeof p !== "object") return false;
  if (String(p.topic || "").trim()) return true;
  if (/^youtube_/.test(String(p.type || ""))) return true;
  return /(^|[\/.@])(youtube\.com|youtu\.be)(?=$|[\/?#:])/i.test(String(p.url || ""));
}
// The YouTube-governing part of the work list, as one string.
function ytSitesSig(list) {
  if (!Array.isArray(list)) return "";
  const rows = [];
  for (const p of list) {
    if (!ytRowRelevant(p)) continue;
    const local = p.type === "local_file";
    const keep = {};
    for (const k of Object.keys(p)) {
      if (YT_SIG_SKIP.has(k) || (local && YT_SIG_SKIP_LOCAL.has(k))) continue;
      keep[k] = p[k];
    }
    rows.push(keep);
  }
  rows.sort((a, b) => String(a.id || "").localeCompare(String(b.id || "")));
  return stableJson(rows);
}
// "The list about to be written was changed from inside a page, not in the settings." Matched against the
// change it produces and then forgotten; the expiry is only there so a write that never lands cannot leave
// it waiting to swallow some later, real change.
function ytQuietWrite(list) {
  ytQuiet = { sig: ytSitesSig(list), until: Date.now() + 5000 };
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  let touched = YT_RELOAD_KEYS.some(k =>
    changes[k] && stableJson(changes[k].oldValue) !== stableJson(changes[k].newValue));
  if (!touched && changes.productiveSites) {
    const next = ytSitesSig(changes.productiveSites.newValue);
    if (next !== ytSitesSig(changes.productiveSites.oldValue)) {
      const q = ytQuiet;
      if (q && q.sig === next && Date.now() < q.until) ytQuiet = null;
      else touched = true;
    }
  }
  if (touched) ytReloadSoon(changes).catch(() => {});
});

async function ytReloadSoon(changes) {
  const s = await getState();
  // Before OR after, so switching either one off still reloads.
  const aiOn = changes.aiTopicEnabled
    ? (changes.aiTopicEnabled.oldValue === true || changes.aiTopicEnabled.newValue === true)
    : s.aiTopicEnabled === true;
  const fgOn = changes.enabled
    ? (changes.enabled.oldValue !== false || changes.enabled.newValue !== false)
    : s.enabled !== false;
  if (!aiOn || !fgOn) return;
  clearTimeout(ytReloadTimer);
  ytReloadTimer = setTimeout(() => {
    ytReloadTimer = 0;
    reloadYouTubeTabs().catch(() => {});
  }, YT_RELOAD_DEBOUNCE_MS);
}

async function reloadYouTubeTabs() {
  let tabs = [];
  try { tabs = await chrome.tabs.query({ url: YT_RELOAD_URLS }); } catch { return; }
  if (!tabs.length) return;
  // The tab in front of you is left alone. A change made from the popup over a YouTube video is applied there
  // within a second anyway, and reloading the very video you are watching is not "update the ones behind".
  let front = -1;
  try {
    const [t] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (t && typeof t.id === "number") front = t.id;
  } catch {}
  for (const t of tabs) {
    // A discarded tab has nothing loaded to be stale; it loads fresh the moment you open it.
    if (typeof t.id !== "number" || t.id === front || t.discarded) continue;
    reloadYouTubeTab(t.id);
  }
}
// Asked of the page first, so it can carry the video's position across the reload — see fgReloadKeepingPlace
// in content.js. Reloaded from here when nothing answers: no content script there yet, or an old one orphaned
// by an extension update.
function reloadYouTubeTab(tabId) {
  const hard = () => { try { chrome.tabs.reload(tabId, () => void chrome.runtime.lastError); } catch {} };
  try {
    chrome.tabs.sendMessage(tabId, { type: "fgReloadPage" }, (r) => {
      if (chrome.runtime.lastError || !r || r.ok !== true) hard();
    });
  } catch { hard(); }
}

// On startup
// ---------- support entries on the icon's right-click menu ----------
// Reaching us shouldn't need the settings page open: right-click the icon and the
// two ways to get in touch are right there, beside Chrome's own entries.
const SUPPORT_MAIL = "sinhanikhil549@gmail.com";
// Chrome has no per-item icon in contextMenus.create() — the only "icon" it draws
// is the extension's own, from the manifest. So the mark rides in the title text,
// which is what every extension does here. Followed by two spaces, because a
// single one lets the glyph crowd the word.
const SUPPORT_MENU = [
  { id: "fg_support_mail", title: "✉️  Email support",
    url: "https://mail.google.com/mail/?view=cm&fs=1&to=" + encodeURIComponent(SUPPORT_MAIL) +
         "&su=" + encodeURIComponent("FocusGate feedback") },
  { id: "fg_support_wa", title: "💬  WhatsApp support",
    url: "https://wa.me/917693075429?text=" + encodeURIComponent("Hi FocusGate support") }
];
function buildSupportMenu() {
  // Torn down and rebuilt, so the same id can never be registered twice — which
  // is what happens if the worker wakes and re-runs this.
  if (!chrome.contextMenus) return;   // absent on some mobile extension browsers
  try {
    chrome.contextMenus.removeAll(() => {
      void chrome.runtime.lastError;
      for (const m of SUPPORT_MENU) {
        chrome.contextMenus.create(
          { id: m.id, title: m.title, contexts: ["action"] },
          () => void chrome.runtime.lastError
        );
      }
    });
  } catch {}
}
// Registered at the top level, so the worker can be woken by a click on it.
if (chrome.contextMenus && chrome.contextMenus.onClicked) {
  chrome.contextMenus.onClicked.addListener((info) => {
    const hit = SUPPORT_MENU.find(m => m.id === info.menuItemId);
    if (hit) chrome.tabs.create({ url: hit.url });
  });
}

chrome.runtime.onStartup.addListener(async () => {
  resetDefaultIcon();
  await setState({ sessionUnlocked: false });
  buildSupportMenu();
  refreshActive();
  await paintBadge();            // the day's figure, before anything is opened
  await enforceOnAllTabs();      // tabs restored from last session
});
chrome.runtime.onInstalled.addListener(async (details) => {
  resetDefaultIcon();
  if (details.reason === "install") {
    // `livenessIntervalSec` is written out here rather than left to DEFAULTS, and it is worth
    // saying why, because the rest of DEFAULTS is deliberately NOT seeded.
    //
    // Four separate readers carry their own copy of this number's shipped value — DEFAULTS
    // here, camRules in content.js, the liveness watcher in facecam.js, and the two fields on
    // the settings page — because a fresh profile has the key absent and each of them sees the
    // raw store rather than a merged state. They all say 10 today. Nothing makes them agree
    // tomorrow: a fallback edited in one file and missed in the other three is invisible until
    // someone installs fresh, and the symptom is a settings page reading 10 over a camera
    // behaving like something else.
    //
    // Writing the real value on install closes that: from the first run the key exists, so
    // every reader takes it from storage and none of them reaches for a fallback at all.
    //
    // Only on "install". Reloading an unpacked build or taking an update arrives as "update",
    // and resetting a number somebody has deliberately changed is not what a version bump is
    // for.
    await setState({
      lastResetDate: todayStr(),
      livenessEnabled: false,
      livenessIntervalSec: 10,
      pageGlowEnabled: true
    });
  }
  buildSupportMenu();
  refreshActive();
  await paintBadge();
  await enforceOnAllTabs();      // whatever was already open gets checked now
  // Reload, update or first install: the tabs already open have either no copy of
  // the content script or a copy that can no longer reach us. Either way nothing is
  // watching those pages until they are loaded again, which is why a work page had
  // to be refreshed by hand before its clock and camera came back.
  await injectIntoOpenTabs();
});

// Put the content script into tabs that are already open. Chrome only injects the
// manifest's content scripts as a page loads, so on install it has never run in any
// open tab, and on reload/update the copy running there was orphaned the moment the
// old extension went away. The script itself decides whether to take over or stand
// down, so injecting into a tab that already has a live copy is harmless.
async function injectIntoOpenTabs() {
  for (const t of await listTabs()) {
    if (typeof t.id === "number") await injectIntoTab(t.id, t.url || t.pendingUrl || "");
  }
}

// One tab: the script AND the stylesheet.
//
// The stylesheet used to be left out of this, on the reasoning that the card injects a <link>
// to content.css itself whenever it finds itself unstyled — which is true, but it only asks
// that question when the card is BUILT, and only answers "unstyled" when no sheet is applied
// at all. A tab that was already open when the extension reloaded is the case neither covers:
// Chrome injects the manifest's CSS as a page loads and never again, so that tab keeps the
// PREVIOUS build's stylesheet while running the new script. The card looked styled, so nothing
// re-injected, and every rule added since the tab opened was simply missing — which is how the
// clock row came out stacked instead of side by side.
//
// Inserting it again is safe: identical rules applied twice change nothing, and where a rule
// has changed the later sheet wins.
async function injectIntoTab(tabId, knownUrl) {
  if (!chrome.scripting || !chrome.scripting.executeScript) return;
  if (typeof tabId !== "number") return;
  let url = knownUrl;
  if (url === undefined) {
    try { const t = await chrome.tabs.get(tabId); url = t.url || t.pendingUrl || ""; }
    catch { return; }
  }
  // The only places the manifest asks to be injected. Chrome itself refuses
  // chrome://, the Web Store and other extensions' pages, so asking would only
  // produce noise in the log.
  if (!/^(https?|file):/i.test(url || "")) return;
  const target = { tabId, allFrames: false };
  // CSS first, so a card built by the script below is never drawn against the old sheet.
  try { await chrome.scripting.insertCSS({ target, files: ["content.css"] }); } catch {}
  try { await chrome.scripting.executeScript({ target, files: ["content.js"] }); } catch {}
}

// Sweep every open tab with its live URL. Used by the heartbeat instead of the
// cached activeUrl, which could be stale after a history-API navigation.
async function enforceOnAllTabs() {
  try { await refreshBlockedTabs(); } catch {}
  // Not awaited, and deliberately behind the sweep: learning where a file lives is worth having
  // but nothing is waiting on it, and the caller above is on the one-minute heartbeat.
  learnLocalPaths().catch(() => {});
}

// ---------- teaching a picked file where it actually lives ----------
// Chrome's file dialog never says which drive a chosen file came from. A pick arrives as
// "AR.pdf" and nothing more, so a local target starts life knowing only the tail of its path.
// The tail is enough to RECOGNISE the file when it is opened; it is not enough to build a link
// to it, which is why such a target opens through viewer.html — FocusGate's own copy — instead of
// at the address in the user's address bar.
//
// The missing half is sitting in any tab that has the file open, and this reads it from there.
//
// It already happened in one place: the local-file beat. That loop runs for the ACTIVE tab, and
// only while that tab is showing a local file — so the path was learned if you happened to be
// looking at the file at the time, and was never learned if you opened it in a background tab, or
// opened it and then switched away to Settings to see why the link still pointed at the viewer.
// Both of those are the ordinary way round, which is why one target on a list can know its full
// path while the one under it, added the same way, still opens the viewer. That is the whole bug.
//
// So it runs over every tab now, and off three triggers rather than one: a tab navigating, a tab
// being switched to, and the heartbeat. A file opened once at its real address is enough,
// whichever tab it is in and whatever you do next.
//
// Only ever an upgrade, and at most once per target: after this the path is absolute, so the
// filter below stops matching it. A target that already knows its full path is never touched.
async function learnLocalPaths() {
  const state = await getState();
  const unknown = (state.productiveSites || []).filter(
    p => p && p.type === "local_file" && !absLocalPath(p.path || p.url));
  if (!unknown.length) return;
  const tabs = await listTabs();
  // fileUrlOf, not the tab's address: a reader extension showing the file names it in its own
  // query string, and THAT is the file's real address — the reader's own page is not. Storing the
  // reader's address would anchor the target to the reader instead of to the file.
  const seen = [];
  for (const t of tabs) {
    const real = fileUrlOf(t.url || t.pendingUrl || "");
    if (real) seen.push(real);
  }
  if (!seen.length) return;
  const found = new Map();
  for (const p of unknown) {
    const want = p.path || p.url;
    // Every open tab that could be this target, reduced to the plain path form so two tabs on the
    // same file count once.
    const hits = [...new Set(seen.filter(u => fileCovers(u, want)).map(u => filePath(u)))];
    // Exactly one answer, or none. A tail matches a name wherever it sits, so two files called
    // AR.pdf in different folders both qualify — and picking one of those by whichever tab
    // happened to be enumerated first would anchor the target to a coin flip, permanently and
    // silently. Leaving it unlearned keeps the viewer link working and costs only that the user
    // closes the tab they did not mean.
    if (hits.length !== 1) continue;
    // Back to the address that matched this one path, because the link has to keep the capitals
    // the disk uses — filePath lower-cases, which is right for matching and wrong for opening.
    const url = seen.find(u => filePath(u) === hits[0]);
    if (url) found.set(p.id, { path: hits[0], url });
  }
  if (!found.size) return;
  // The kept copy is deliberately NOT dropped. Knowing the real path makes the match stricter,
  // which is worth having, but viewer.html is still the only address where the camera and the
  // stillness checks can run on a PDF or an image — so the copy stays as the way through for
  // anyone who has not granted "Allow access to file URLs".
  await setState({
    productiveSites: (state.productiveSites || []).map(p => {
      const hit = found.get(p.id);
      return hit ? { ...p, path: hit.path, url: hit.url } : p;
    })
  });
}
// Coalesced, because a single file opening fires onUpdated several times (loading, title, then
// complete) and each one would otherwise be its own pass over every tab.
let learnTimer = null;
function learnLocalPathsSoon(ms = 600) {
  if (learnTimer) { try { clearTimeout(learnTimer); } catch {} }
  learnTimer = setTimeout(() => {
    learnTimer = null;
    learnLocalPaths().catch(() => {});
  }, ms);
}

// What a target list demands, ignoring how far through it you are. Two lists with
// the same signature block the same things, however much time has been spent.
function targetsSignature(list) {
  return (list || [])
    .map(p => `${p.id}:${p.enabled === false ? 0 : 1}:${p.requiredSec || 0}`)
    .join("|");
}
let lastTargetsSig = null;

// Coalesced sweep: several settings often change in one go (switching mode also
// rewrites a list), and tab navigation can fire in bursts.
let sweepTimer = null;
function sweepSoon(ms = 300) {
  if (sweepTimer) { try { clearTimeout(sweepTimer); } catch {} }
  sweepTimer = setTimeout(() => { sweepTimer = null; enforceOnAllTabs(); }, ms);
}

// Refresh all currently open blocked tabs (called when user enables/changes lists)
// Returns how many tabs it locked, so whoever asked can say so out loud. A count
// of 0 is useful information too: it means nothing open needed locking.
// The other half of a sweep: tabs sitting on the blocked screen that shouldn't be
// blocked any more go straight back where they came from. Switching FocusGate off,
// emptying the work list, or finishing the day all end up here, so none of them
// leave you staring at a lock screen that no longer applies.
async function releaseBlockedTabs(state) {
  const s = state || await getState();
  const base = chrome.runtime.getURL("blocked.html");
  const tabs = await listTabs();
  const blockedTabs = tabs.filter(t => (t.url || t.pendingUrl || "").startsWith(base));
  if (!blockedTabs.length) return 0;
  let freed = 0;
  await Promise.all(blockedTabs.map(async (t) => {
    const url = t.url || t.pendingUrl || "";
    let from = "";
    try { from = new URL(url).searchParams.get("from") || ""; } catch {}
    if (!from || isExtensionInternal(from)) return;
    const info = await getBlockReason(from, s);
    if (info.blocked) return;                       // still locked, leave it
    try {
      await chrome.tabs.update(t.id, { url: from });
      freed++;
    } catch {}
    try {
      chrome.tabs.sendMessage(t.id, { type: "unlockCheck" }, () => void chrome.runtime.lastError);
    } catch {}
  }));
  return freed;
}

async function refreshBlockedTabs() {
  const state = await getState();
  // Free first: if a rule just went away, being sent back is the news, and doing
  // it before the locking pass keeps the two from fighting over the same tab.
  await releaseBlockedTabs(state);
  const tabs = await chrome.tabs.query({});
  let locked = 0;
  for (const t of tabs) {
    // A tab restored from a previous session has no url until it is opened; its
    // destination sits in pendingUrl. Those were being skipped.
    const url = t.url || t.pendingUrl || "";
    if (!url || isExtensionInternal(url)) continue;
    const info = await getBlockReason(url, state);
    if (!info.blocked) continue;
    try {
      await chrome.tabs.update(t.id, { url: blockedPageUrl(url, info) });
      locked++;
    } catch {}
  }
  return locked;
}

// Initial
resetDefaultIcon();
// And then the real answer. This block runs every time the worker WAKES, not only on install or
// browser start, so it is the one place that covers a worker which was shut down and revived — and
// without it the reset above would leave a full-colour icon on an extension that is switched off.
// The minute heartbeat cannot be relied on for this: it returns early when FocusGate is off, which
// is precisely the state that needs repainting.
paintBadge();
refreshActive();
// Check the tabs you already have open right now, rather than waiting up to a
// minute for the heartbeat. Also covers the worker being woken from sleep.
enforceOnAllTabs();
// Behind the useful work, not in front of it: a kept file copy with no target left is untidy, not
// urgent.
setTimeout(pruneStoredFiles, 5000);

// Discover real file paths for stored files that only have a filename tail.
//
// Chrome's file dialog never says where a picked file lives, so a target added that way stores just
// the filename. Here is the next best source: Chrome's own download history, which carries the full
// path on disk. If the file was downloaded through Chrome, its real path can be found and stored so
// that every page — Settings, the popup, the blocked page — can link to it directly.
async function discoverStoredFilePaths() {
  try {
    if (!chrome.downloads || !chrome.downloads.search) return;
    const st = await getState();
    const list = st.productiveSites || [];
    const need = list.filter(p =>
      p.type === "local_file" && p.stored &&
      !looksLocalPath(p.url || "") && !looksLocalPath(p.path || ""));
    if (!need.length) return;
    let changed = false;
    for (const p of need) {
      const name = String(p.path || "").replace(/\\/g, "/").split("/").pop()
                || String(p.label || "");
      if (!name) continue;
      try {
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
        if (dl && dl.filename) {
          // Store both the file:// URL and the normalised path, matching the format the localBeat
          // upgrade writes (see the upgrade block in localBeat).
          let fp = dl.filename.replace(/\\/g, "/");
          try { fp = decodeURIComponent(fp); } catch {}
          fp = fp.replace(/\/{2,}/g, "/").replace(/^\/+/, "").replace(/\/+$/, "").toLowerCase();
          const enc = dl.filename.replace(/\\/g, "/").replace(/^\/+/, "").split("/")
            .map(seg => encodeURIComponent(seg).replace(/%3A/gi, ":")).join("/");
          p.url = "file:///" + enc;
          p.path = fp;
          changed = true;
        }
      } catch {}
    }
    if (!changed) return;
    await setState({ productiveSites: list });
  } catch {}
}
setTimeout(discoverStoredFilePaths, 6000);
