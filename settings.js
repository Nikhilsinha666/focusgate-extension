// FocusGate — what counts as a setting, and how to check one coming back in from a file.
//
// Pure functions over plain objects, no chrome.* anywhere, so the settings page loads it as
// an ordinary script.
//
// The whole point of this file is that "which keys are settings" is written ONCE. Export and
// import read the same table, so a key can never be saved by one and refused by the other,
// and adding a setting later means adding one line here rather than remembering two places.
(function (G) {
  "use strict";

  // ---- validators ----
  // Each returns { ok, value }. `ok:false` means the value is dropped and named in the
  // report, never silently coerced into something the UI could not have produced.
  const bad = { ok: false };
  const ok = (value) => ({ ok: true, value });

  const bool = () => (v) => (typeof v === "boolean" ? ok(v) : bad);
  const oneOf = (...allowed) => (v) => (allowed.includes(v) ? ok(v) : bad);
  const int = (min, max) => (v) => {
    const n = Math.round(Number(v));
    if (!Number.isFinite(n)) return bad;
    // Clamped, not refused. These come from sliders and number boxes that already clamp, so
    // a value outside the range is a hand-edited file rather than a different intention —
    // and clamping keeps it inside what the page itself would let you set.
    return ok(Math.max(min, Math.min(max, n)));
  };
  // The same, for a setting that is genuinely fractional. Only the timer speeds are: a
  // multiplier of 1.5 is a different thing from 1 or 2, where every other number here is a
  // count of seconds or a step on a five-point dial.
  //
  // Rounded to the slider's own step before it is clamped, so a file carrying 1.4999 stores
  // the 1.5 the page would have produced. Floating point makes that worth doing explicitly:
  // without it a value read back out could fail to equal the one the slider shows, and
  // changeDir below decides "is this a change at all" by comparing exactly those two numbers.
  const dec = (min, max, dp) => (v) => {
    const n = Number(v);
    if (!Number.isFinite(n)) return bad;
    const p = Math.pow(10, dp);
    return ok(Math.max(min, Math.min(max, Math.round(n * p) / p)));
  };
  const time = () => (v) => {
    const m = /^(\d{1,2}):(\d{2})$/.exec(String(v == null ? "" : v).trim());
    if (!m) return bad;
    const h = Number(m[1]), mi = Number(m[2]);
    if (h > 23 || mi > 59) return bad;
    return ok(String(h).padStart(2, "0") + ":" + String(mi).padStart(2, "0"));
  };
  // The same check, but for a field INSIDE a row rather than a key in its own right — so it falls
  // back instead of refusing. A row is validated as a whole: rejecting it because one of its two
  // deadline times was malformed would throw away the address, the goal and the schedule with it.
  const hhmm = (v, dflt) => {
    const r = time()(v);
    return r.ok ? r.value : dflt;
  };
  // The same idea as hhmm one field over: a NUMBER inside a row, clamped to its range, falling back
  // rather than rejecting. A row is validated as a whole, so one unreadable number must not cost the
  // address, the goal and the schedule along with it.
  const rowInt = (v, dflt, lo, hi) => {
    const n = Math.round(Number(v));
    if (!Number.isFinite(n)) return dflt;
    return Math.max(lo, Math.min(hi, n));
  };
  // Minutes since midnight, for comparing times of day without dragging Date into it.
  const hhmmMin = (v) => {
    const m = /^(\d{1,2}):(\d{2})$/.exec(String(v == null ? "" : v).trim());
    if (!m) return -1;
    const h = Number(m[1]), mi = Number(m[2]);
    if (h > 23 || mi > 59) return -1;
    return h * 60 + mi;
  };
  // "" is a real answer: it means no commitment date is set.
  const date = () => (v) => {
    const s = String(v == null ? "" : v).trim();
    if (!s) return ok("");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return bad;
    const [y, mo, d] = s.split("-").map(Number);
    if (mo < 1 || mo > 12) return bad;
    if (d < 1 || d > new Date(y, mo, 0).getDate()) return bad;
    return ok(s);
  };
  const text = (maxLen) => (v) => {
    if (typeof v !== "string") return bad;
    return ok(v.trim().slice(0, maxLen));
  };
  // A web address for the phone bridge. Empty is fine — it means "not set up".
  const httpUrl = () => (v) => {
    const s = String(v == null ? "" : v).trim();
    if (!s) return ok("");
    if (!/^https?:\/\/[^\s]+$/i.test(s)) return bad;
    return ok(s.slice(0, 500));
  };
  // The name of the language model that answers the topic check. Empty is a real answer and means "use
  // the default", which the caller substitutes.
  //
  // The character class is the whole point of this checker rather than text(): the string is spliced
  // into a URL PATH by FGAi.ask, so anything that could end that path or start a query — a slash beyond
  // the optional "models/" prefix, a "?", a "#", a space, a ".." — would be a way to aim the request at
  // a different endpoint on the same host. Letters, digits, dashes and dots only, dots allowed because
  // model versions carry them.
  const modelName = () => (v) => {
    const s = String(v == null ? "" : v).trim();
    if (!s) return ok("");
    if (s.length > 80) return bad;
    if (!/^(models\/)?[a-z0-9][a-z0-9.\-]*$/i.test(s)) return bad;
    return ok(s);
  };
  // What the topic check is allowed to read: three named booleans and nothing else.
  //
  // Rebuilt key by key rather than passed through, and that is the reason it is a checker rather than a
  // wave-through. The worker spreads this object into a prompt-building path, so a file that added a
  // fourth key would be adding a field to something it does not own — and every value is read `!== false`
  // there, so an unexpected key with a truthy value would read as "on".
  //
  // Missing means on, matching FGAi.rawScope. The two must agree: one decides what happens and the other
  // decides what a backup can say happens.
  const aiScope = () => (v) => {
    if (!v || typeof v !== "object" || Array.isArray(v)) return bad;
    return ok({
      description: v.description !== false,
      tags: v.tags !== false,
      transcript: v.transcript !== false
    });
  };
  // A set of category ids, for the AI category lists.
  //
  // Checked against SITE_CATEGORIES rather than merely cleaned, and that is the point: an id nothing
  // recognises would sit in the list looking like a rule while matching nothing for ever, which is the
  // worst shape a blocklist entry can have. A file naming a category this build has dropped simply loses
  // that entry — the rest of the list survives, which is the right trade for a backup.
  //
  // Declared here as a closure over SITE_CATEGORIES, which is defined further down; that is fine because
  // the closure is not CALLED until something validates a key.
  const catIdList = () => (v) => {
    if (!Array.isArray(v)) return bad;
    const known = new Set(SITE_CATEGORIES.map(c => c.id));
    const out = [];
    const seen = new Set();
    for (const raw of v.slice(0, 200)) {
      const id = String(raw == null ? "" : raw).trim();
      if (!id || !known.has(id) || seen.has(id)) continue;
      seen.add(id);
      out.push(id);
    }
    return ok(out);
  };

  // ---- the anti-cheat keys, shared by the global settings and a target's own copy ----
  // Same names as CHEAT_KEYS in background.js. A target's `cheat` object holds any subset.
  const CHEAT = {
    mediaPlayingRequired: bool(),
    inactivityPauseEnabled: bool(),
    inactivityTimeoutSec: int(5, 600),
    fullscreenOnlyEnabled: bool(),
    splitViewBlockEnabled: bool(),
    faceDetectionEnabled: bool(),
    faceSensitivity: int(1, 5),
    eyeTrackingEnabled: bool(),
    eyeSensitivity: int(1, 5),
    // 0 is a real answer for all three of the sliding deadlines: "the moment you stop". The old
    // floor of 30 on the movement check came from that check being hard to satisfy — asking
    // twice a minute for a lean you couldn't perform would have been unusable. Any movement
    // clears it now, so there is no reason to keep a floor that only ever got in the way.
    eyeAwaySec: int(0, 600),
    livenessEnabled: bool(),
    livenessIntervalSec: int(0, 1800),
    moveSensitivity: int(1, 5),
    blinkRequired: bool(),
    blinkIntervalSec: int(0, 600),
    blinkSensitivity: int(1, 5),
    // The timer speed, decided by how much of the focus box your head fills. The only setting
    // in the extension that changes how fast a second is credited rather than whether it is
    // credited at all, which is why the two speeds are fractional and everything else here
    // is not.
    //
    // The bounds are the same numbers facecam.js clamps to, deliberately: a file that gets
    // past this check must not then be quietly clamped again somewhere else, because the two
    // limits would drift and the page would show a value the camera was not using.
    paceEnabled: bool(),
    paceFast: dec(1, 4, 1),
    paceSlow: dec(0.1, 1, 1),
    paceBoxPct: int(30, 85),
    mediaPauseEnabled: bool(),
    mediaResumeEnabled: bool(),
    mediaRewindSec: int(0, 120),
    pageGlowEnabled: bool()
  };

  // A site on the blocked or allowed list. Only the address survives — the lists hold
  // nothing else, and a file that carried extra fields would be inventing them.
  const siteList = () => (v) => {
    if (!Array.isArray(v)) return bad;
    const out = [];
    const seen = new Set();
    for (const row of v.slice(0, 2000)) {
      const url = String((row && row.url) || "").trim().slice(0, 500);
      if (!url) continue;
      const k = url.toLowerCase();
      if (seen.has(k)) continue;
      seen.add(k);
      out.push({ url });
    }
    return ok(out);
  };

  // ---- which days of the week a target is active on ----
  // A seven-bit mask, and the bit numbers are Date.getDay()'s: 0 = Sunday through 6 = Saturday.
  // Stored that way rather than Monday-first because every comparison in the extension is against
  // getDay(), and exactly one place wants Monday-first — the row of chips on the settings page,
  // which walks DAY_ORDER below. Shifting at the storage end would move an off-by-one out of a
  // display list and into the path that decides whether your day counts.
  //
  // 127 is all seven days. That is the default for a new target and the answer for anything
  // unreadable, because "every day" is what a target with no schedule has always meant — and
  // every row saved before this setting existed has no schedule.
  const DAY_ALL = 127;
  const DAY_WEEKDAYS = 62;    // Mon–Fri
  const DAY_WEEKEND = 65;     // Sat + Sun
  // Monday first, for reading. The number in each pair is the getDay() bit it stands for.
  const DAY_ORDER = [[1, "Mon"], [2, "Tue"], [3, "Wed"], [4, "Thu"], [5, "Fri"], [6, "Sat"], [0, "Sun"]];
  const dayMask = (v) => {
    const n = Math.round(Number(v));
    // Unreadable, or a mask with no days in it at all. Both answer "every day" rather than being
    // stored as-is: a target active on no day can never be satisfied and never unlocks anything,
    // so it is a trap and not a setting. The settings page refuses to clear the last day for the
    // same reason, and this is the backstop for a hand-edited file.
    if (!Number.isFinite(n) || n <= 0) return DAY_ALL;
    return (n & DAY_ALL) || DAY_ALL;
  };
  // Which weekday FocusGate is currently inside, as a getDay() number.
  //
  // Not simply today's, and that is the whole reason this is a function rather than a one-liner at
  // each call site. The day boundary is the user's own reset time: with a boundary of 04:00, two in
  // the morning on Tuesday is still Monday's session — the counters have not been zeroed and the
  // goal on screen is Monday's. A target set to Mondays only has to still be active then, so
  // reading the calendar day would switch it off four hours before its session had ended.
  function weekdayNow(dailyResetTime, now) {
    const d = now instanceof Date ? new Date(now.getTime()) : new Date();
    const m = /^(\d{1,2}):(\d{2})$/.exec(String(dailyResetTime == null ? "" : dailyResetTime).trim());
    const hh = m ? Number(m[1]) : 0, mi = m ? Number(m[2]) : 0;
    const boundary = new Date(d.getTime());
    boundary.setHours(hh, mi, 0, 0);
    if (d < boundary) d.setDate(d.getDate() - 1);
    return d.getDay();
  }
  // Is this row scheduled to run on that weekday? A row with no `days` says yes — see DAY_ALL.
  function onDay(target, weekday) {
    if (!target) return false;
    if (target.days === undefined || target.days === null) return true;
    return (dayMask(target.days) & (1 << weekday)) !== 0;
  }
  // What the schedule says, in as few words as a settings row has space for.
  function daysLabel(days) {
    const mask = dayMask(days);
    if (mask === DAY_ALL) return "Every day";
    if (mask === DAY_WEEKDAYS) return "Mon–Fri";
    if (mask === DAY_WEEKEND) return "Weekends";
    return DAY_ORDER.filter(([bit]) => mask & (1 << bit)).map(([, nm]) => nm).join(", ");
  }

  // A work target. spentSec is deliberately absent from what is read: see EXCLUDED below.
  const targetList = () => (v) => {
    if (!Array.isArray(v)) return bad;
    const out = [];
    v.slice(0, 500).forEach((row, i) => {
      if (!row || typeof row !== "object") return;
      const type = ["site", "youtube_channel", "youtube_playlist", "youtube_video", "local_file"]
        .includes(row.type) ? row.type : "site";
      const url = String(row.url || "").trim().slice(0, 500);
      const path = String(row.path || "").trim().slice(0, 500);
      // A target with nothing to match on is not a target.
      if (!url && !path && !row.channelId && !row.playlistId) return;
      const item = {
        id: String(row.id || "").slice(0, 40) || ("id_" + Math.random().toString(36).slice(2, 10)),
        type,
        url,
        label: String(row.label || "").trim().slice(0, 60),
        requiredSec: Math.max(0, Math.min(24 * 3600, Math.round(Number(row.requiredSec)) || 0)),
        // Today's progress never comes back from a file.
        spentSec: 0,
        enabled: row.enabled !== false,
        // Which days of the week this row is asked for. Absent in every file written before the
        // setting existed, and dayMask answers those with "every day" — so an old backup restores
        // to exactly the behaviour it was saved under.
        days: dayMask(row.days),
        order: Math.max(0, Math.min(9999, Math.round(Number(row.order)) || i)),
        operator: row.operator === "OR" ? "OR" : "AND",
        // What you actually meant to do here, in your own words.
        //
        // A target is an ADDRESS, and being at an address is all this list could ever describe: the
        // channel you nominated because it teaches linear algebra also has a podcast, and every second of
        // that counted. The topic is the other half of the promise, and it belongs in a backup for exactly
        // the same reason requiredSec does — it is a decision you made, not a measurement.
        //
        // Empty for every row written before this existed, and empty means "no topic", which means the row
        // behaves precisely as it always did. So an old backup restores to the behaviour it was saved
        // under, which is the rule every field in here follows.
        //
        // 300 characters, matching FGAi.TOPIC_MAX: it is a sentence that goes into a prompt, not an essay.
        topic: String(row.topic || "").trim(),
        // Whether THIS row's topic is actually checked, as its own switch beside the sentence.
        //
        // Separate from the topic text on purpose, and separate from the global switch too. One site can be
        // one you genuinely want held to a subject while another on the same list is a reference you dip
        // into and should not be judged — and the alternative, deleting the sentence to stop the checking,
        // means retyping it to start again. A switch keeps the promise written down while suspending it.
        //
        // `!== false`, like `enabled` above and for the same reason: every row saved before this existed has
        // no such field, and those must go on being checked rather than silently stopping.
        topicCheck: row.topicCheck !== false,
        // Whether THIS row is one of the goals the phone waits on.
        //
        // The phone bridge is all-or-nothing by nature: it locks your apps until today's work is done, and
        // "done" meant every target on the list. That is the wrong answer for a list that mixes a lecture
        // you must finish before touching your phone with a reference site you dip into whenever. Left as
        // one rule, the reading habit holds the phone hostage; the only fix was to stop using the bridge.
        //
        // So it is per-row: with this off, the row still earns time and still gates your BROWSER exactly as
        // before — it simply isn't one of the things the phone is waiting for. Nothing else about the row
        // changes, which is why it lives here rather than in `cheat` (that object is the page checks handed
        // to the content script; this is read only by the worker's phone sync).
        //
        // `!== false` for the third time and the same reason: every row written before this field existed
        // has no such field, and those must go on counting towards the phone rather than silently dropping
        // out of it — which would unlock somebody's phone the moment they restored an old backup.
        webhookOn: row.webhookOn !== false,
        // ---- the deadline: finish it BETWEEN these two times, or it does not count ----
        //
        // Off by default, and off is the behaviour every row has always had: finish whenever, the
        // reward is yours. With it on, the row only buys the unlock — your blocked sites, and the
        // phone webhook — if the goal was reached while the clock was inside the window. Finish at
        // ten past a window that shut at ten and the sites stay shut for the day.
        //
        // What it deliberately does NOT change is earning. Time still counts outside the window, and
        // the bar still fills, because the alternative is a row that silently refuses to move and
        // reads as broken. The window governs the reward, not the work.
        //
        // `winStart === winEnd` is the one shape rejected on the way in (see below): a window of zero
        // length can never be satisfied, so it is not a strict setting, it is a locked door.
        winEnabled: row.winEnabled === true,
        winStart: hhmm(row.winStart, "06:00"),
        winEnd: hhmm(row.winEnd, "09:00"),
        // When the goal was first reached today, as epoch ms, or 0 for "not yet". The worker stamps
        // it; the daily reset clears it along with spentSec, which is what makes the window a
        // deadline for TODAY rather than a permanent verdict.
        //
        // Never restored from a file — see the note on spentSec, which this belongs with. A stamp is
        // a measurement of today, and a backup carrying yesterday's would either hand over an unlock
        // nobody earned or withhold one they did.
        metAt: 0,
        // ---- the OTHER deadline: a stopwatch rather than a clock ----
        //
        // The window above is a time of day. This is an allowance that starts when you do: open the
        // site and you have the goal PLUS this much slack to finish it in. An hour of Duolingo with
        // ten minutes of grace means seventy minutes, counted from the first time you opened Duolingo
        // today, to put sixty in.
        //
        // Both exist because they are different promises. A window is a commitment to a time of day
        // and only means anything if you know when you will sit down; this is a commitment to not
        // dawdling, and it means the same thing whenever you sit down. One stops you starting at
        // eleven at night, the other stops an hour of work taking four.
        //
        // Off by default, so every row that predates this behaves exactly as it always has. Like the
        // window, it governs the REWARD and not the work: time goes on counting after the allowance
        // runs out and the bar goes on filling, because a row that silently refused to move would
        // read as broken rather than as strict.
        graceEnabled: row.graceEnabled === true,
        // How much slack, in seconds, on top of the goal. Zero is a legal answer and means "exactly
        // the goal, not a second more" — brutal, and somebody's to choose.
        //
        // The fallback is ten minutes rather than zero, and that is deliberate: a file carrying
        // `graceEnabled: true` with no slack at all would restore as a row that fails the moment you
        // pause for anything, which is a locked door wearing a setting's clothes. Ten minutes is what
        // the switch itself seeds, so a file with the switch on and nothing else behaves like a row
        // somebody had just switched on by hand.
        graceSec: rowInt(row.graceSec, 600, 0, 12 * 3600),
        // When the allowance started — the first moment this row's site was seen today, as epoch ms,
        // or 0 for "not opened yet". Measured, so it belongs with metAt and spentSec above: the worker
        // stamps it once a day and the daily reset clears it, and it never comes back from a file.
        graceFrom: 0
      };
      // Trimmed after the object is built rather than inside it, so the cap and the shape are not two
      // things to keep in step: 300 is FGAi.TOPIC_MAX, and this is the one place a file's version of it
      // is cut down.
      item.topic = item.topic.slice(0, 300);
      // A window too short to finish its goal in is stretched to fit on the way in, exactly as the settings
      // page would — the start kept, the end moved. See fitWindowEnd.
      if (hasWindow(item)) {
        const fitEnd = fitWindowEnd(item);
        if (fitEnd) item.winEnd = fitEnd;
      }
      if (path) item.path = path;
      if (row.channelId) item.channelId = String(row.channelId).slice(0, 120);
      if (row.playlistId) item.playlistId = String(row.playlistId).slice(0, 120);
      // The video id, which was silently being dropped.
      //
      // Not part of the topic work, and fixed alongside it because it is the same bug one field over:
      // targetCovers matches a "youtube_video" row purely on `videoId`, and this function — the only thing
      // that validates a target on the way in from a file — never copied it. So restoring a backup left
      // every single-video target matching nothing at all: still in the list, still showing its time, and
      // permanently unearnable. Exactly what would have happened to `topic` had it been added the same way.
      if (row.videoId) item.videoId = String(row.videoId).slice(0, 40);
      // Whether a copy of a picked file is held in the filestore. Dropped for the same reason and with the
      // same consequence: without it the viewer cannot be recognised as time on the target.
      if (row.stored) item.stored = true;
      if (row.cheatCustom) {
        item.cheatCustom = true;
        const c = {};
        for (const [k, check] of Object.entries(CHEAT)) {
          if (!row.cheat || row.cheat[k] === undefined || row.cheat[k] === null) continue;
          const r = check(row.cheat[k]);
          if (r.ok) c[k] = r.value;
        }
        item.cheat = c;
      }
      out.push(item);
    });
    return ok(out);
  };

  // ---- the table ----
  const KEYS = Object.assign({
    // the lists
    productiveSites: targetList(),
    blockedSites: siteList(),
    allowedSites: siteList(),
    blockMode: oneOf("blacklist", "whitelist"),
    // Whether the work list is read as a sequence or as a set. See currentStepIndex below.
    //
    // In a backup because the ORDER is already in one — every row carries its `order` — and a saved
    // list whose order was load-bearing would otherwise restore as a list whose order meant nothing.
    // Absent from every file written before this existed, and absent reads as false, so an old backup
    // restores to the behaviour it was saved under.
    sequenceMode: bool(),

    // the day
    dailyResetTime: time(),

    // the master switch and the door
    enabled: bool(),
    passwordProtectionEnabled: bool(),
    autoLockDelaySec: int(0, 3600),
    fullPageLockEnabled: bool(),

    // strict mode, both halves
    strictModeEnabled: bool(),
    strictStart: time(),
    strictEnd: time(),
    strictUntilEnabled: bool(),
    strictUntil: date(),
    strictUntilTime: time(),

    // the phone bridge
    macrodroidEnabled: bool(),
    macrodroidLockUrl: httpUrl(),
    macrodroidUnlockUrl: httpUrl(),

    // is this page about the topic you set for this target?
    //
    // The switches, the bar, the depth and the model travel in a backup. The KEY does not — see
    // EXCLUDED, where it sits with the password hash.
    //
    // Restoring `aiTopicEnabled: true` onto a machine with no key stored is deliberately fine and does
    // nothing at all: aiTopicReady checks for a key before anything else, so the check reports "no key"
    // and every page counts as normal. Same shape as passwordProtectionEnabled restoring without its hash.
    aiTopicEnabled: bool(),
    aiTopicVideoGate: bool(),
    // Whether a matching YouTube video also EARNS time for the card whose topic it matched. Its own key
    // rather than a mode of the gate, because the two are different promises — one is about what plays, the
    // other about what counts — and a backup should be able to carry "block off-topic videos" without also
    // carrying "and let the rest fill my study bar". Off by default, like aiTopicBlocks.
    aiTopicVideoEarn: bool(),
    aiTopicMinPct: int(0, 100),
    aiTopicModel: modelName(),
    aiTopicMode: oneOf("title", "details", "video"),
    aiTopicScope: aiScope(),
    aiTopicStrict: bool(),
    aiTopicBlocks: bool(),

    // ---- whole categories of site, decided by asking ----
    //
    // The AI half of the category picker. The chips beside it write ordinary domains into the two lists;
    // these two hold CATEGORY IDS, and every site you visit is classified against them.
    //
    // Why both exist: a list of hand-typed domains can only ever be the domains somebody thought of.
    // Fifteen social networks is not "social media" — it is fifteen doors shut in a corridor with no
    // walls, and the one reached for at 1am is the sixteenth.
    aiCatEnabled: bool(),
    aiCatBlock: catIdList(),
    aiCatAllow: catIdList(),

    // things that are neither checks nor rules
    camOverlayEnabled: bool(),
    // The width of the camera preview, in real screen pixels. Height follows at 4:3 and the card
    // is drawn to match, so this one number is the whole of the size.
    //
    // The floor is where the clock stops being readable rather than a round number: everything on
    // the card scales with the preview now, so 72px gives a 72x54 picture with roughly 12px digits
    // beside it.
    //
    // The ceiling is deliberately generous — 1280 gives a 1280x960 preview, which on most screens is
    // as close to full screen as a 4:3 camera can get. It is not the real limit and is not trying to
    // be: content.js clamps to the window it is drawn in, so this only has to be wide enough not to
    // refuse a size the screen could actually show. A value that arrives from an imported file is
    // checked here as well as by the slider, which is why the number lives in both places.
    camSizePx: int(72, 1280),
    soundEffectsEnabled: bool()
  }, CHEAT);

  // Named so the reason is written down, not just the absence.
  const EXCLUDED = {
    passwordHash: "your password. A hash in a backup file is your door in a backup file.",
    aiTopicKey: "your Gemini API key. A credential, so the same rule as the password hash — and this one can be spent. It is also not portable in any useful sense: it belongs to a Google account rather than to a configuration, so carrying it would be all of the risk for none of the convenience.",
    sessionUnlocked: "whether this session is unlocked. It is about right now, not about setup.",
    spentSec: "today's progress. A backup would otherwise be a way to hand yourself an afternoon you didn't spend.",
    lastResetDate: "bookkeeping for the day boundary.",
    xp: "earned, not configured.",
    level: "earned, not configured.",
    streakCount: "earned, not configured.",
    lastStreakDate: "earned, not configured.",
    allDoneCelebratedOn: "whether today's celebration already fired.",
    // The video gate's own tally. Measured, like the streak: it records what actually happened, so a file
    // that could set it would be a file that hands you a number you did not earn.
    vidSkipCount: "counted, not configured — how many videos the gate has turned away.",
    vidSkipSec: "counted, not configured — how much of them, in seconds.",
    // What the classifier decided about each site. Measured, like the tally above — and carrying it would
    // be worse than useless: it is a cache of answers to questions about the web at a moment in time, so a
    // year-old backup would restore a year-old opinion of every site in it and suppress the re-ask that
    // would have corrected it. The categories themselves travel; the answers are re-earned.
    aiCatSeen: "the classifier's answers about each site. A cache, not a setting — restoring it would carry a stale opinion of every site in it and suppress the re-ask that would correct it.",
    mobileLockSent: "the last state pushed to your phone.",
    timerPauseReason: "live status for the popup.",
    timerPauseAt: "live status for the popup.",
    pauseSinceAt: "when the pause running right now began. About this second, not about setup.",
    pausedTodaySec: "how much of today the clock spent stopped. Measured, not configured — and it belongs to today, like spentSec.",
    breakTodaySec: "how much of today went to breaks. Measured, not configured.",
    activeTargetId: "which target earned the last second.",
    activeTargetAt: "which target earned the last second."
  };

  // ---- which direction is stricter? ---------------------------------------
  // The password used to guard the whole settings page: you proved who you were before you
  // could even read it. That is one rule and easy to trust, but it is friction pointed the
  // wrong way. Turning a check ON, raising today's goal, blocking another site — those are
  // the things the password exists to protect, and being asked to prove who you are before
  // you make your own rules HARDER teaches you to leave the page unlocked, which is the one
  // outcome the password was for.
  //
  // So the question is no longer "are you editing", it is "are you letting yourself off".
  //
  // It is answered here, once, beside the table that already knows what every key is. Before
  // this the direction lived at each call site — a hand-written comparison in a few handlers
  // and nothing at all on the rest. "Nothing at all" is the reason for a table: a setting
  // nobody remembered to guard is a setting you can quietly ease off mid-session, and there
  // is no way to spot one by reading the page.
  //
  //   "up"      a bigger number is stricter. Raising is a tightening.
  //   "down"    a smaller number is stricter. Lowering is a tightening.
  //   "on"      true is stricter. Switching on is a tightening.
  //   "off"     false is stricter — the rare inverse, for a switch that makes the goal
  //             EASIER to reach, so turning it ON is the loosening.
  //   "list"    a longer list is stricter — the blocklist. Adding tightens.
  //   "short"   a shorter list is stricter — the allowlist. Removing tightens.
  //   "filled"  having a value is stricter than not having one. Clearing it is the loosening.
  //   "targets" the work itself, which is a list of objects rather than a number — see
  //             targetsLoosen. This is where "I can raise today's goal but not lower it"
  //             actually lives.
  //   "free"    neither direction is stricter, so the gate has no opinion.
  //
  // A key missing from this table is treated as "free": a preference, not a rule. That is the
  // safe default for a password gate — it must not nag about the beep — and every key here is
  // checked against KEYS by a test, so a direction can never name a key that does not exist.
  const STRICTER = {
    // ---- what you actually have to do ----
    // The goal is not a top-level key in FocusGate: it is requiredSec on each row of this
    // list. So the one rule the user cares about most — "I can push my goal up without a
    // password, but pulling it down needs one" — is inside here rather than beside it.
    productiveSites: "targets",

    // ---- the lists ----
    blockedSites: "list",
    allowedSites: "short",
    // Swapping the mode is not a direction. An empty allowlist is the strictest thing in the
    // extension and a full one is the loosest, so which way this moves depends entirely on
    // what is in the two lists — and a guess either way would be wrong half the time. Strict
    // mode refuses the swap outright instead, which is a rule that cannot be wrong.
    blockMode: "free",
    // Reading the work list as a sequence takes choices away: with it off you may spend today's hours
    // on the list in any order you like, and with it on there is exactly one row you are allowed to
    // open. Nothing about it makes any goal smaller — the same total is owed either way — so at a
    // glance it looks like a preference about style. It is not, and the reason is the way out: a
    // sequence you are two steps into is a sequence whose remaining steps you cannot start, and
    // switching it off mid-afternoon opens all of them at once. That is a loosening, so turning it ON
    // is free and turning it OFF asks.
    sequenceMode: "on",

    // ---- the master switch and the door ----
    // Switching FocusGate off is the largest loosening there is: every gate stops at once.
    enabled: "on",
    passwordProtectionEnabled: "on",
    autoLockDelaySec: "down",       // locking sooner after you close the popup
    fullPageLockEnabled: "on",

    // ---- strict mode ----
    strictModeEnabled: "on",
    strictUntilEnabled: "on",
    // strictStart, strictEnd and strictUntil are deliberately absent, which reads as "free".
    // A time of day has no stricter direction on its own: moving the start earlier lengthens
    // the window if the end is fixed and shortens it if you have crossed midnight, so a
    // direction here would be wrong about half the time. Both halves are guarded where the
    // guard cannot be wrong instead — strict mode refuses edits while it is running, and the
    // deadline control only lets you push the date further out.
    strictStart: "free",
    strictEnd: "free",
    strictUntil: "free",
    strictUntilTime: "free",

    // ---- the phone ----
    macrodroidEnabled: "on",
    // "url": any change to a webhook URL is sensitive and requires password authentication.
    macrodroidLockUrl: "url",
    macrodroidUnlockUrl: "url",

    // ---- the day ----
    // Where the day boundary sits is a preference about your own schedule. It does not make
    // any goal bigger or smaller — it decides when the counters start again.
    dailyResetTime: "free",

    // ---- anti-cheat ----
    // Every one of these is "turning it on asks nothing, turning it off asks", which is the
    // whole shape the user described.
    mediaPlayingRequired: "on",
    inactivityPauseEnabled: "on",
    inactivityTimeoutSec: "down",   // pausing after less stillness
    fullscreenOnlyEnabled: "on",
    splitViewBlockEnabled: "on",
    faceDetectionEnabled: "on",
    eyeTrackingEnabled: "on",
    livenessEnabled: "on",
    blinkRequired: "on",
    // Every dial here reads 1 = fussiest, 5 = most forgiving, so a LOWER number asks more of
    // you and sliding towards "easy" is the loosening.
    faceSensitivity: "down",
    eyeSensitivity: "down",
    moveSensitivity: "down",
    // blinkSensitivity is deliberately absent, which reads as "free", and it is the one dial
    // here with no honest direction. The others decide how much evidence of you is ENOUGH, so
    // easing them asks less of you. This one decides how faint a dip still counts as an eyelid,
    // which is a question about the detector rather than about your effort: sliding it right
    // makes the check easier to SATISFY, and also makes it more likely to notice a real blink
    // that was being missed. Guessing either way would be wrong about half the time, so the
    // gate has no opinion. Same call as the Anki extension makes about the same dial.
    //
    // The three sliding deadlines. A smaller number asks more of you — less time to sit still,
    // to look away, or to go without blinking — so lowering any of them is a tightening.
    livenessIntervalSec: "down",
    eyeAwaySec: "down",
    blinkIntervalSec: "down",
    // The timer speed. `paceEnabled` is the rare inverse — the only "off" in this table — and
    // it is worth saying why, because at a glance a switch that can also SLOW the clock down
    // does not look like a loosening.
    //
    // What it can do is finish today's goal in less time than the goal asks for. Every other
    // switch here can only ever cost you seconds; this one can hand them to you, at up to four
    // to the second. That is precisely the shape the password exists to guard, so switching it
    // on asks and switching it off does not. Same call as the Anki extension makes.
    //
    // Both speeds are "down" for the same reason: a bigger multiplier, fast or slow, reaches
    // the goal sooner. The box is "up" — a bigger box means your head has to fill more of the
    // frame, so you must sit closer to earn the fast speed.
    paceEnabled: "off",
    paceFast: "down",
    paceSlow: "down",
    paceBoxPct: "up",
    mediaPauseEnabled: "on",
    mediaRewindSec: "up",           // winding further back costs you more of the video
    // "free", and it is worth saying why, because at a glance this looks like the loose half
    // of the switch above it. It is not, and the reason is WHEN it fires: the resume only
    // ever happens at a moment when the clock would already be running — you are back at the
    // camera, the window is full screen, the break is over — so it cannot hand you a second
    // of credit that was not already yours. The only thing it saves is a click. Calling it a
    // loosening would put the password in front of a convenience, which is how a gate stops
    // being taken seriously.
    mediaResumeEnabled: "free",
    // The glow reports on whether the clock is running. It changes nothing about whether a
    // second counts, so neither direction is stricter — it is a light, not a rule.
    pageGlowEnabled: "free",

    // ---- is this page about the topic you set? ----
    //
    // "on", like every other check: switching it ON is free, switching it OFF asks. It can only ever
    // WITHHOLD time from a target, so turning it off is handing yourself back every off-topic second on
    // every site you have given a topic — which is the same shape as switching off the camera check.
    aiTopicEnabled: "on",
    // Switching the video gate off makes every video on YouTube watchable again, whatever your topics
    // say. That is the largest single loosening in this group, so it is guarded like the rest.
    aiTopicVideoGate: "on",
    // Letting matching videos EARN a card's time is a new way to reach a goal, so switching it on makes the
    // goal easier to meet and the locked list open sooner — a loosening. The rare inverse, where "off" is
    // the stricter side: turning it on asks for your password and a strict window refuses it, turning it off
    // is free. Same shape as any switch that hands you time.
    aiTopicVideoEarn: "off",
    // A higher bar means a page has to be more clearly on-topic to earn you anything, so fewer pages
    // count: up is stricter, and lowering it is the loosening. Exactly like the sensitivity dials.
    aiTopicMinPct: "up",
    // Holding the clock while the model is still deciding costs you the seconds it spends thinking, so
    // switching it on is the stricter direction.
    aiTopicStrict: "on",
    // Taking the page away rather than merely not paying for it. The strictest thing here.
    aiTopicBlocks: "on",
    // The key gets the same treatment as a webhook address, and it needs it for a reason the switch alone
    // does not cover.
    //
    // With aiTopicEnabled already on and the key box empty, the check is inert — aiTopicReady looks for a
    // key before anything else, so every page counts. CLEARING the key is therefore how you would switch
    // the whole thing off without touching the switch that asked for your password. "url" means any change
    // at all is treated as a loosening, which is right here for the same reason it is right there: there is
    // no direction in which changing a credential is a tightening.
    //
    // It is in EXCLUDED rather than KEYS — it never travels in a backup — and that is no obstacle: this
    // table is consulted on its own, so a key can be guarded without being exportable.
    aiTopicKey: "url",
    // Which model answers, how deeply it looks, and at which fields: all free, and the first instinct is
    // to call "just the title" the loose one. It isn't.
    //
    // These change what the model is SHOWN, not what it has to conclude — the bar is aiTopicMinPct above,
    // and that is guarded. More evidence moves a score in whichever direction the truth lies: reading the
    // subtitles rescues an honest lecture with a useless name, and it also catches a podcast on a channel
    // you nominated for its maths. Neither is a direction, so neither can be one here.
    //
    // The consequence is deliberate: somebody in a strict window can still switch from watching the whole
    // video to reading the subtitles when a check is taking too long, which is a change to how the rule is
    // measured and not a way out of it.
    aiTopicModel: "free",
    aiTopicMode: "free",
    aiTopicScope: "free",

    // ---- the AI category lists ----
    // The master switch, like every other check: on is free, off asks. Switching it off hands back every
    // site the classifier was keeping shut.
    aiCatEnabled: "on",
    // The BLOCKED categories behave exactly like the blocked list of domains, and for the same reason:
    // a longer list is stricter, so adding a category is free and removing one asks.
    aiCatBlock: "list",
    // And the ALLOWED categories like the allowed list: a longer list opens more of the web, so a SHORTER
    // one is stricter. The two point in opposite directions, which is why they cannot share an entry.
    aiCatAllow: "short",

    // ---- views, not rules ----
    camOverlayEnabled: "free",
    // How big the camera preview is drawn. The most obviously "free" thing in this table: the
    // detector reads the camera stream at its own resolution, so this changes what YOU can see and
    // nothing whatsoever about what the checks can. A smaller box does not make the face check
    // easier to fool, which is the only question this table asks.
    camSizePx: "free",
    soundEffectsEnabled: "free"
  };

  // Does this patch loosen anything, measured against what is stored right now?
  //
  // Any one key loosening makes the whole patch a loosening. Patches here are small and
  // deliberate, and a patch that tightens one thing while easing another is exactly the shape
  // a gate must not wave through on the strength of its better half.
  //
  // A value equal to what is already stored is not a change in either direction. That matters
  // more than it looks: the settings page rewrites whole groups of keys at once, so most keys
  // in a patch are usually identical to what is there — and treating "same" as "loosening"
  // would ask for the password on every save.
  function loosens(patch, current) {
    for (const key of Object.keys(patch || {})) {
      if (loosensKey(key, patch[key], (current || {})[key])) return true;
    }
    return false;
  }

  // The mirror, for the second gate: does this patch make anything HARDER?
  //
  // Tightening never needs a password — that is the whole point of the direction table — but
  // it is not therefore free of consequence. It is one-way: the same table that lets you
  // switch a check on without proving who you are is the table that will ask for the password
  // when you want it back off. So a tightening edit is a commitment, and the page says so
  // before making it rather than after.
  //
  // A patch that loosens ANYTHING is not a tightening, even if it also tightens something.
  // The two gates are exclusive and the password one wins: it is the stronger question, and
  // asking both for one edit would be two dialogs for one decision.
  function tightens(patch, current) {
    if (loosens(patch, current)) return false;
    for (const key of Object.keys(patch || {})) {
      if (tightensKey(key, patch[key], (current || {})[key])) return true;
    }
    return false;
  }

  // Which way is ONE key moving: "loosen", "tighten", or "" for neither.
  //
  // Both gates are built from this single function rather than from a pair of mirrored ones.
  // That is not tidiness: the two gates now say opposite things to the user — one asks for a
  // password, the other warns that the change is hard to undo — and a pair of near-identical
  // comparisons is exactly the shape that drifts, leaving a setting that both prompts for and
  // warns about, or neither.
  function changeDir(key, next, cur) {
    if (key === "blockMode") {
      const prev = cur || "blacklist";
      if (next === "whitelist" && prev !== "whitelist") return "tighten";
      if (next === "blacklist" && prev !== "blacklist") return "loosen";
      return "";
    }
    const dir = STRICTER[key];
    if (!dir || dir === "free") return "";
    if (dir === "url") {
      if (next === undefined) return "";
      const curStr = String(cur == null ? "" : cur).trim();
      const nextStr = String(next == null ? "" : next).trim();
      return nextStr !== curStr ? "loosen" : "";
    }
    if (dir === "targets") return targetsReason(next, cur).dir;
    if (dir === "on" || dir === "off") {
      // `next === false` rather than `!next`: a key the patch does not mention arrives here
      // as undefined, and "not mentioned" is not "switched off".
      //
      // `cur !== false` rather than `cur === true` is the deliberate half. An absent current
      // value means we do not know what it was, and this is a self-discipline guard, so not
      // knowing is answered the strict way — by asking. In practice it does not come up: the
      // worker writes every DEFAULTS key on install, so there is always something to compare.
      const looseVal = dir === "on" ? false : true;
      const tightVal = dir === "on" ? true : false;
      if (next === looseVal && cur !== looseVal) return "loosen";
      if (next === tightVal && cur !== tightVal) return "tighten";
      return "";
    }
    if (dir === "filled") {
      if (next === undefined) return "";
      const had = String(cur == null ? "" : cur).trim() !== "";
      const has = String(next == null ? "" : next).trim() !== "";
      if (had && !has) return "loosen";
      if (!had && has) return "tighten";
      return "";
    }
    if (dir === "list" || dir === "short") {
      const a = Array.isArray(cur) ? cur.length : null;
      const b = Array.isArray(next) ? next.length : null;
      // Not comparable, so no claim either way. A junk value is the validator's problem.
      if (a === null || b === null || a === b) return "";
      const grew = b > a;
      // A longer blocklist is stricter; a longer allowlist is looser.
      return (dir === "list") === grew ? "tighten" : "loosen";
    }
    const x = Number(cur), y = Number(next);
    // An unreadable number is not evidence of a direction, and it cannot be stored either:
    // every one of these keys goes through KEYS on the way in.
    if (!Number.isFinite(x) || !Number.isFinite(y) || x === y) return "";
    const bigger = y > x;
    return (dir === "up") === bigger ? "tighten" : "loosen";
  }
  const loosensKey = (key, next, cur) => changeDir(key, next, cur) === "loosen";
  const tightensKey = (key, next, cur) => changeDir(key, next, cur) === "tighten";

  // The work list, compared row by row rather than by length.
  //
  // Length alone would be useless here: the interesting changes all keep the list the same
  // size. Dropping a goal from 30 minutes to 5, switching a row off, or easing that row's own
  // camera check are each a loosening that leaves the count untouched.
  //
  // Rows are matched by id, so reordering is not mistaken for anything.
  //
  // Returns a reason as well as a direction, because this is the one key whose name tells the
  // user nothing — a warning that says "your work list is changing" is not worth reading, and
  // "today's goal is going up" is.
  //
  // A loosening anywhere in the list beats a tightening anywhere else, for the same reason a
  // mixed patch is treated as a loosening: the gate must not wave one through on the strength
  // of its better half. So the whole list is walked before a tightening is reported.
  function targetsReason(next, cur) {
    if (!Array.isArray(next) || !Array.isArray(cur)) return { dir: "", why: "" };
    const now = new Map(), was = new Map();
    for (const t of next) if (t && t.id) now.set(t.id, t);
    for (const t of cur) if (t && t.id) was.set(t.id, t);
    let tight = "";

    for (const [id, before] of was) {
      // "Live" means it is actually part of today's targets.
      const wasLive = before.enabled !== false && (Number(before.requiredSec) || 0) >= 0;
      const after = now.get(id);

      if (!after) { if (wasLive) return { dir: "loosen", why: "a work site removed" }; continue; }
      if (wasLive && after.enabled === false) return { dir: "loosen", why: "a work site switched off" };
      if (!wasLive && after.enabled !== false && (Number(after.requiredSec) || 0) >= 0) {
        tight = tight || "a work site switched back on";
      }

      // The rule the user asked for in as many words: up is free, down asks.
      const wantWas = Number(before.requiredSec) || 0;
      const wantNow = Number(after.requiredSec) || 0;
      if (wantNow < wantWas) return { dir: "loosen", why: "less time to spend" };
      if (wantNow > wantWas) tight = tight || "more time to spend";

      // The topic — what you said you would actually DO on this site. Adding one narrows what counts on
      // that row, so it is a tightening; REMOVING one hands back every page on the site, so it is a
      // loosening of exactly the same kind as switching the row off.
      //
      // CHANGING one is treated as a loosening too, and that is the load-bearing decision here rather
      // than caution. The topic is a key, and a key you can retype is not a key: with a topic of "linear
      // algebra" you are three keystrokes from "anything on this channel", and no amount of cleverness in
      // the comparison can tell that edit from an honest correction, because both are just a different
      // sentence. So the answer is not to detect the intent, it is to ask for the password — the same
      // call the Anki extension makes about the collection lock, and for the same reason.
      //
      // The cost is real and small: fixing a typo in a topic asks for your password, and is refused
      // during a strict window. Both are correct. A commitment you can rewrite at 11pm on a whim is not
      // a commitment, and this is the field that says what the commitment IS.
      const topicWas = String(before.topic || "").trim();
      const topicNow = String(after.topic || "").trim();
      if (topicWas && topicNow !== topicWas) {
        return { dir: "loosen", why: topicNow ? "a study topic changed" : "a study topic removed" };
      }
      if (!topicWas && topicNow) tight = tight || "a study topic added";

      // The row's own topic switch. Turning it OFF hands back every off-topic page on that site, which is
      // the same loosening as deleting the sentence — and it has to be judged here, or the switch would be
      // the free way to do the thing the sentence itself asks for a password to undo.
      //
      // Only counted while there IS a sentence. Flicking a switch on a row with no topic changes nothing
      // whatsoever, and a password prompt in front of a no-op is how a gate stops being taken seriously.
      const checkWas = before.topicCheck !== false;
      const checkNow = after.topicCheck !== false;
      if (topicWas && checkWas && !checkNow) return { dir: "loosen", why: "a study topic switched off" };
      if (topicNow && !checkWas && checkNow) tight = tight || "a study topic switched back on";

      // The row's own switch for the phone. Turning it OFF takes a goal off the list your phone is
      // waiting for, and if it was the last unfinished one the phone is released the moment this is
      // written — so it is a loosening of the same kind as switching the row off altogether, just
      // aimed at the phone rather than the browser. Turning it back on is a tightening.
      //
      // Judged unconditionally, unlike topicCheck above, which is only counted while the row has a
      // topic to check. There is no row-level equivalent here: whether anything happens depends on
      // `macrodroidEnabled`, which is global state this function is not handed. The page only draws
      // the switch while the bridge is on, so in practice a change means what it says — and where
      // the two readings differ, the gate's rule for every mixed or unclear case in this file is to
      // treat it as the loosening.
      const phoneWas = before.webhookOn !== false;
      const phoneNow = after.webhookOn !== false;
      if (wasLive && phoneWas && !phoneNow) return { dir: "loosen", why: "a work site stopped holding your phone" };
      if (wasLive && !phoneWas && phoneNow) tight = tight || "a work site started holding your phone";

      // The row's deadline — finish between these two times or the unlock is forfeit.
      //
      // Switching it ON is a tightening for the plainest reason available: it adds a way to fail a day
      // that could not be failed before. Switching it OFF removes that, so it is a loosening, and
      // during a strict window it is refused — which is the whole point of putting a deadline behind
      // the same gate as the goal itself. A commitment you can call off at 9pm is not a commitment.
      //
      // The LENGTH is judged too, and by duration rather than by either end on its own. Moving the
      // start later or the end earlier both shrink the window and both make the day harder, but which
      // number moved says nothing by itself: a window that wraps midnight has its end before its
      // start, so "end went down" is a tightening in one case and a loosening in the other. The
      // minutes between them is the one reading that means the same thing either way.
      const winWas = before.winEnabled === true;
      const winNow = after.winEnabled === true;
      if (wasLive && winWas && !winNow) return { dir: "loosen", why: "a work site's deadline switched off" };
      if (wasLive && !winWas && winNow) tight = tight || "a work site got a deadline";
      if (wasLive && winWas && winNow) {
        const span = (row) => {
          const a = hhmmMin(row.winStart), b = hhmmMin(row.winEnd);
          if (a < 0 || b < 0) return -1;
          return a < b ? b - a : (1440 - a) + b;   // wrapping midnight is the second case
        };
        // Read at no less than the shortest window the (new) goal allows. Nothing shorter can exist any more —
        // see windowMinFor — so a window stretched only up to that floor is not a loosening: a goal raised
        // past its window drags the window along with it, and raising a goal is the tightening it always was.
        // Room beyond the floor is still judged exactly as before.
        const floor = Math.min(winMaxMin(), windowMinFor(after.requiredSec));
        const wasLen = Math.max(span(before), floor), nowLen = Math.max(span(after), floor);
        if (span(before) >= 0 && span(after) >= 0) {
          if (nowLen > wasLen) return { dir: "loosen", why: "a work site's deadline got longer" };
          if (nowLen < wasLen) tight = tight || "a work site's deadline got shorter";
          // Same length, different hours: the window was MOVED. No honest direction — 6am to 9am and
          // 9pm to midnight are three hours either way, and which is harder is a fact about the
          // person, not about the setting. Left unjudged, which reads as free, exactly like
          // blinkSensitivity in the table above and for the same reason.
        }
      }

      // The row's OTHER deadline — the stopwatch. Same shape as the window above and judged the same
      // way: switching it on adds a way to fail a day, switching it off takes one away.
      //
      // The slack needs none of the window's care about which end moved, because it has no midnight to
      // wrap around and only one number to read. More grace is more time to finish in, so raising it is
      // a loosening and lowering it is a tightening. That is the whole of it.
      const grcWas = before.graceEnabled === true;
      const grcNow = after.graceEnabled === true;
      if (wasLive && grcWas && !grcNow) return { dir: "loosen", why: "a work site's time limit switched off" };
      if (wasLive && !grcWas && grcNow) tight = tight || "a work site got a time limit";
      if (wasLive && grcWas && grcNow) {
        const gWas = Number(before.graceSec) || 0, gNow = Number(after.graceSec) || 0;
        if (gNow > gWas) return { dir: "loosen", why: "more grace time on a work site" };
        if (gNow < gWas) tight = tight || "less grace time on a work site";
      }
      // When the stopwatch started, moving LATER. Measured rather than configured, so like spentSec
      // below nothing on the page writes it — but pushing it forward is how you would hand yourself back
      // an allowance that had already run out, and that is the same cheat as lowering the goal reached
      // from another direction. Only judged once it is already set: 0 to a real stamp is the worker's
      // legitimate once-a-day write, and prompting for a password on it would ask about the act of
      // opening a website.
      const gFromWas = Number(before.graceFrom) || 0, gFromNow = Number(after.graceFrom) || 0;
      if (wasLive && gFromWas && gFromNow > gFromWas) {
        return { dir: "loosen", why: "a time limit's start pushed later" };
      }

      // Which days it runs on. Dropping a day is a loosening for the plainest possible reason: it
      // is a day you no longer have to do the work, and the sites you blocked open on it for free.
      // Adding one is a tightening.
      //
      // Compared as bits rather than by how many days there are, so swapping Monday for Tuesday
      // registers as both at once — and the loosening wins, which is the rule for every mixed
      // change in this file.
      const daysWas = dayMask(before.days === undefined ? DAY_ALL : before.days);
      const daysNow = dayMask(after.days === undefined ? DAY_ALL : after.days);
      if (daysWas & ~daysNow) return { dir: "loosen", why: "a work site dropped a day" };
      if (daysNow & ~daysWas) tight = tight || "a work site added a day";

      // Operator (AND vs OR). Changing from AND to OR is loosening (completing either site
      // satisfies the step instead of requiring both). Changing from OR to AND is tightening.
      const opWas = before.operator === "OR" ? "OR" : "AND";
      const opNow = after.operator === "OR" ? "OR" : "AND";
      if (wasLive && opWas === "AND" && opNow === "OR") return { dir: "loosen", why: "a work site logic changed to OR" };
      if (wasLive && opWas === "OR" && opNow === "AND") tight = tight || "a work site logic changed to AND";

      // Time already spent, moving FORWARD. Nothing in the page does this — the progress bar
      // only winds back, and says so — so this is here for the shape of write that would.
      // Handing yourself an afternoon you did not spend is the same cheat as lowering the
      // goal, arrived at from the other end.
      //
      // The one false positive is a day boundary landing between a read and the write that
      // follows it, which would compare a stale figure against a freshly zeroed one. That is
      // a spurious prompt once in a very long while, against a hole that would otherwise be
      // permanent — so it is the right way round.
      const spentWas = Number(before.spentSec) || 0, spentNow = Number(after.spentSec) || 0;
      if (spentNow > spentWas) return { dir: "loosen", why: "time you have not spent" };
      if (spentNow < spentWas) tight = tight || "today's progress wound back";

      // A row keeping its own copy of the checks. Only compared while BOTH sides are custom:
      // turning that switch off hands the row back to Setup, and whether Setup is looser or
      // stricter than the copy being abandoned is not knowable from this patch.
      if (before.cheatCustom && after.cheatCustom) {
        const had = before.cheat || {}, has = after.cheat || {};
        for (const k of Object.keys(CHEAT)) {
          if (has[k] === undefined) continue;
          const d = changeDir(k, has[k], had[k]);
          if (d === "loosen") return { dir: "loosen", why: "a work site's own checks eased off" };
          if (d === "tighten") tight = tight || "a work site's own checks tightened";
        }
      }
    }
    // Rows that are new. Adding work is a tightening, whatever is in it.
    for (const [id, after] of now) {
      if (was.has(id)) continue;
      if (after.enabled !== false && (Number(after.requiredSec) || 0) >= 0) {
        tight = tight || "a new work site";
      }
    }
    return tight ? { dir: "tighten", why: tight } : { dir: "", why: "" };
  }

  // ---- saying what changed -------------------------------------------------
  // A warning that will not name the thing it is warning about does not get read. These are
  // the words the settings page itself uses, so the sentence points at a row you can see.
  //
  // Only keys with a direction need one: a "free" key never reaches either gate.
  const SAYS = {
    blockMode: "allowlist mode (blocking all other sites)",
    productiveSites: "your work sites",
    sequenceMode: "doing your work sites in order",
    blockedSites: "the blocked list",
    allowedSites: "the allowed list",
    enabled: "FocusGate itself",
    passwordProtectionEnabled: "password protection",
    autoLockDelaySec: "how long an unlock lasts",
    fullPageLockEnabled: "full-page password lock",
    strictModeEnabled: "strict mode",
    strictUntilEnabled: "the strict-mode deadline",
    macrodroidEnabled: "phone app blocking",
    macrodroidLockUrl: "the phone lock address",
    macrodroidUnlockUrl: "the phone unlock address",
    mediaPlayingRequired: "media tracking",
    inactivityPauseEnabled: "the mouse inactivity tracker",
    inactivityTimeoutSec: "how long you can sit still",
    fullscreenOnlyEnabled: "the full screen forcer",
    splitViewBlockEnabled: "split screen prevention",
    faceDetectionEnabled: "face detection",
    eyeTrackingEnabled: "eye detection",
    livenessEnabled: "the head movement check",
    blinkRequired: "the blink check",
    faceSensitivity: "face sensitivity",
    eyeSensitivity: "eye sensitivity",
    moveSensitivity: "movement sensitivity",
    // No entry for blinkSensitivity: it has no direction, so neither gate ever reaches it.
    livenessIntervalSec: "how long you can sit perfectly still",
    eyeAwaySec: "how long you can look away",
    blinkIntervalSec: "how long you can go without blinking",
    paceEnabled: "the camera speeding the timer up",
    paceFast: "the speed while you face the camera",
    paceSlow: "the speed while you don't",
    paceBoxPct: "how close you have to sit",
    mediaPauseEnabled: "pausing the video when the clock stops",
    mediaRewindSec: "how far the video winds back"
  };

  // Every key in this patch moving the given way, said in words. Deduplicated and in the
  // table's own order, so two keys that happen to share a phrase are named once.
  function describe(patch, current, want) {
    const out = [];
    for (const key of Object.keys(patch || {})) {
      if (changeDir(key, patch[key], (current || {})[key]) !== want) continue;
      // The work list is the one key whose own name says nothing useful, so it borrows the
      // reason instead.
      if (key === "productiveSites") {
        const r = targetsReason(patch[key], (current || {})[key]);
        if (r.why && !out.includes(r.why)) out.push(r.why);
        continue;
      }
      const say = SAYS[key] || key;
      if (!out.includes(say)) out.push(say);
    }
    return out;
  }

  function checkOne(key, value) {
    const check = KEYS[key];
    if (!check) return bad;
    return check(value);
  }

  // Everything worth saving, read out of a full state object.
  function exportFrom(state, meta) {
    const s = state || {};
    const out = {};
    for (const key of Object.keys(KEYS)) {
      if (s[key] === undefined) continue;
      const r = checkOne(key, s[key]);
      if (r.ok) out[key] = r.value;
    }
    return Object.assign({
      app: "FocusGate",
      kind: "settings",
      version: (meta && meta.version) || "",
      exportedAt: new Date().toISOString()
    }, { settings: out });
  }

  // Everything worth restoring, read out of a parsed file. Returns the patch to write plus
  // a report, so the page can say what it took and what it would not.
  function importFrom(file) {
    if (!file || typeof file !== "object") return { ok: false, reason: "That file isn't FocusGate settings." };
    const body = (file.settings && typeof file.settings === "object") ? file.settings : file;
    if (file.app && file.app !== "FocusGate") {
      return { ok: false, reason: `That file says it belongs to ${String(file.app).slice(0, 30)}, not FocusGate.` };
    }
    const patch = {};
    const skipped = [];
    for (const [key, value] of Object.entries(body)) {
      if (!KEYS[key]) { skipped.push(key); continue; }
      const r = checkOne(key, value);
      if (!r.ok) { skipped.push(key); continue; }
      patch[key] = r.value;
    }
    const took = Object.keys(patch).length;
    if (!took) return { ok: false, reason: "There were no FocusGate settings in that file." };
    return { ok: true, patch, took, skipped };
  }

  // ---- the per-row deadline ----------------------------------------------------------------
  //
  // Three small functions, and the reason they live here rather than in the worker is that four
  // separate places have to agree about them: the worker decides what to unlock, the popup and the
  // settings page both say what is happening, and the blocked screen explains why it is still shut.
  // Four copies of a midnight-wrap comparison is four chances to get it wrong in one direction.

  // Does this row have a deadline at all? A window of zero length is treated as no window, because
  // it could never be satisfied — that is a locked door rather than a strict setting, and refusing
  // to honour it is kinder than silently making a row unearnable.
  function hasWindow(p) {
    if (!p || p.winEnabled !== true) return false;
    const a = hhmmMin(p.winStart), b = hhmmMin(p.winEnd);
    return a >= 0 && b >= 0 && a !== b;
  }

  // Is `atMs` inside the row's window? Windows may wrap midnight — 22:00 to 02:00 is a real thing
  // somebody would ask for — so the comparison is written as "start before end" and "start after
  // end" rather than assuming the first is smaller.
  //
  // Both ends are inclusive of the start and exclusive of the end, like every other half-open range:
  // a 06:00–09:00 window contains 06:00 and does not contain 09:00, so two windows laid end to end
  // never both claim the same minute.
  function inWindow(p, atMs) {
    if (!hasWindow(p)) return true;
    const d = new Date(atMs == null ? Date.now() : atMs);
    const now = d.getHours() * 60 + d.getMinutes();
    const a = hhmmMin(p.winStart), b = hhmmMin(p.winEnd);
    return a < b ? (now >= a && now < b) : (now >= a || now < b);
  }

  // Has this row earned its reward?
  //
  // Split from "is the time done" on purpose, and this is the one distinction the whole feature rests
  // on. `done` is about the clock and is what the bars and percentages show. This is about whether the
  // unlock was earned, which is `done` plus the deadline — and it is what the blocking and the phone
  // ask.
  //
  // A row with no window answers exactly as it always did, so every existing profile is unaffected.
  function targetDone(p) {
    if (!p) return false;
    return (p.requiredSec === 0) || (p.spentSec || 0) >= (p.requiredSec || 0);
  }
  // Two deadlines now, and a row has to satisfy both. Written as a list of ways to FAIL rather than as
  // nested "if it has one" branches, so adding a third would be one line and could not accidentally
  // short-circuit the second.
  function targetMet(p) {
    if (!targetDone(p)) return false;
    const at = Number(p.metAt) || 0;
    // No stamp, but done. Three ways to arrive here and all are answered the same way: a row finished
    // before this feature existed, a row whose deadline was switched on after it was already finished
    // today, and a row with a zero-second goal that was never "completed" by a tick at all. None is
    // evidence that a deadline was missed, and taking somebody's earned unlock away on the strength of
    // a missing field is the one outcome worth ruling out — so an absent stamp is read as "no
    // violation recorded" rather than as a failure.
    if (!at) return true;
    if (hasWindow(p) && !inWindow(p, at)) return false;
    if (graceStarted(p) && !graceInTime(p, at)) return false;
    return true;
  }
  // Done, inside a window, and the window has closed on it. The state worth its own name because it
  // is the only one that needs explaining: the bar says 100%, and nothing is unlocked.
  function windowMissed(p) {
    return hasWindow(p) && targetDone(p) && !targetMet(p);
  }
  // The OTHER way to miss a deadline, and the commoner one: the window shut and the work was never
  // finished at all.
  //
  // `windowMissed` cannot answer this, and the difference is not a detail. That one requires
  // `targetDone`, so it only ever describes a row that was finished LATE — a full bar that unlocked
  // nothing. This describes a row whose hours simply ran out: a half-full bar that also unlocked
  // nothing, and which no amount of further work can rescue today. Both need saying out loud, and
  // neither was being said, so the screen that has to explain a locked site had no words for the
  // most ordinary way of failing this feature.
  //
  // Windows that wrap midnight are deliberately never called gone. 22:00 to 02:00 sitting in the
  // middle of the afternoon has already had its morning half, but it opens again this evening, so
  // the chance is not lost and saying it was would be the one error worth avoiding here: telling
  // somebody their day is over when it is not. Conservative in the direction of hope.
  function windowGone(p) {
    if (!hasWindow(p)) return false;
    if (targetDone(p)) return false;             // finished, so this is windowMissed's business
    const a = hhmmMin(p.winStart), b = hhmmMin(p.winEnd);
    if (a > b) return false;                     // wraps midnight: it comes round again today
    const d = new Date();
    return (d.getHours() * 60 + d.getMinutes()) >= b;
  }
  // "15:00" said the way people say it: "3:00 pm".
  //
  // Stored times stay 24-hour and always will — it is the only form with no midnight ambiguity, and
  // hasWindow and inWindow parse it with a strict pattern. This is purely how it is SHOWN, and it lives
  // here for the same reason the rest of this block does: six screens display a window now, and a clock
  // that read 24-hour on one of them and 12-hour on the next would look like two different settings
  // rather than one setting written two ways.
  function clock12(v) {
    const t = hhmmMin(v);
    if (t < 0) return "";
    const h24 = Math.floor(t / 60), mi = t % 60;
    const h12 = h24 % 12 === 0 ? 12 : h24 % 12;         // midnight and noon are both 12, not 0
    return `${h12}:${String(mi).padStart(2, "0")} ${h24 < 12 ? "am" : "pm"}`;
  }
  // "6:00 am – 9:00 am", or "" when there is no window. One place, so the screens that show it cannot
  // punctuate it three different ways.
  function windowLabel(p) {
    if (!hasWindow(p)) return "";
    return `${clock12(p.winStart)} – ${clock12(p.winEnd)}`;
  }

  // ---- the window has to be long enough to finish the goal in ----
  //
  // Thirty minutes of work cannot be done inside a one-minute window, and a window of EXACTLY thirty is no
  // better: the clock pays from the second tick on a page, not the first, and a goal reached at 9:00 sharp
  // is already outside a window that closes at 9:00. So the window always has to be LONGER than the goal —
  // a 30-minute goal needs a window of at least 31 minutes — and everything that sets either one keeps it
  // so: the settings page when you edit the times or the goal, the ＋ on the card, a restored backup, and
  // the worker for anything already stored.
  //
  // Whole minutes, because a window is two times of day to the minute.
  function windowMinFor(sec) {
    const g = Math.max(0, Math.round(Number(sec) || 0));
    return Math.floor(g / 60) + 1;
  }
  // The longest a window can be, 1439 minutes: equal ends mean no window at all, so a full day is not
  // available — and a goal of nearly a day (23h 59m or more) therefore cannot fit inside any window. A
  // function rather than a constant so nothing that runs while this file is still loading can reach it early.
  function winMaxMin() { return 1439; }
  // The window's length in minutes, counting one that crosses midnight; -1 when its times are unreadable or
  // equal, which is no window.
  function windowSpan(p) {
    if (!p) return -1;
    const a = hhmmMin(p.winStart), b = hhmmMin(p.winEnd);
    if (a < 0 || b < 0 || a === b) return -1;
    return a < b ? b - a : (1440 - a) + b;
  }
  // Can this row's goal be finished inside its window? Always true for a row with no window in force.
  function windowFits(p) {
    if (!hasWindow(p)) return true;
    return windowSpan(p) >= windowMinFor(p.requiredSec);
  }
  // The end time that makes this window long enough for a goal of `goalSec` (the row's own goal when it is
  // left out), or "" when it already is or its start cannot be read.
  //
  // THE START IS THE ANCHOR. It is the hour you said you would sit down, so it is always the end that
  // moves — the same way a calendar keeps an event's start and pushes its end. That one rule covers every
  // case: an end set too close to the start is pushed back out to the shortest window that fits, a start
  // moved too close to the end carries the end along with it, and a goal raised past its window stretches
  // the window to match.
  function fitWindowEnd(p, goalSec) {
    if (!p) return "";
    const a = hhmmMin(p.winStart);
    if (a < 0) return "";
    const need = Math.min(winMaxMin(), windowMinFor(goalSec == null ? p.requiredSec : goalSec));
    const span = windowSpan(p);
    if (span >= need) return "";
    const end = (a + need) % 1440;
    return String(Math.floor(end / 60)).padStart(2, "0") + ":" + String(end % 60).padStart(2, "0");
  }

  // ---- the other deadline: a stopwatch ------------------------------------------------------------
  //
  // Everything here is arithmetic on three fields — requiredSec, graceSec and graceFrom — so there is
  // no second source of truth to keep in step. Only graceFrom is measured, and it is written once a day
  // by the worker the first time the site is seen; see noteGraceStart in background.js.
  //
  // The set mirrors the window's on purpose, because the screens that consume them need the same four
  // answers about each: is there one, is it running, has it been failed with the work done, has it been
  // failed with the work unfinished.

  // Does this row have a stopwatch deadline at all?
  //
  // `requiredSec > 0` is part of the question, for the reason hasWindow refuses a zero-length window: a
  // row with nothing to do has nothing to be late for, and an allowance measured against work that is
  // already complete is either meaningless or a locked door depending on how you read it. Refusing to
  // honour it is the kinder of the two.
  function hasGrace(p) {
    if (!p || p.graceEnabled !== true) return false;
    const g = Number(p.graceSec);
    if (!Number.isFinite(g) || g < 0) return false;
    return (Number(p.requiredSec) || 0) > 0;
  }
  // Has the stopwatch actually started? Not until the first time the site is opened today, which is the
  // whole difference between this and a window: a window is running whether or not you turned up.
  function graceStarted(p) {
    return hasGrace(p) && (Number(p.graceFrom) || 0) > 0;
  }
  // The moment the chance runs out, as epoch ms, or 0 when no stopwatch is running.
  //
  // requiredSec is read LIVE rather than remembered from when the stopwatch started, so pressing ＋ on
  // the card extends the deadline along with the goal. That is the honest reading of "the goal plus your
  // slack": adding ten minutes of work and getting ten more minutes to do it in leaves the promise the
  // same shape, and the alternative — a fixed deadline with a growing goal — would turn ＋ into a button
  // that makes the day harder in two ways at once.
  function graceDeadline(p) {
    if (!graceStarted(p)) return 0;
    const allow = (Number(p.requiredSec) || 0) + (Number(p.graceSec) || 0);
    return (Number(p.graceFrom) || 0) + allow * 1000;
  }
  // How long is left, in whole seconds, floored at zero. Callers that need to tell "none left" from "not
  // running" ask graceStarted — a plain number is what all six screens actually want, and a null would
  // be unwrapped in every one of them.
  function graceLeftSec(p) {
    const d = graceDeadline(p);
    if (!d) return 0;
    return Math.max(0, Math.round((d - Date.now()) / 1000));
  }
  // Was `atMs` inside the allowance? Fail-open when there is no stopwatch or it never started, exactly
  // as inWindow answers true for a row with no window.
  function graceInTime(p, atMs) {
    const d = graceDeadline(p);
    if (!d) return true;
    return (atMs == null ? Date.now() : atMs) <= d;
  }
  // Finished, but after the allowance ran out — the mirror of windowMissed. A full bar that unlocked
  // nothing, and one of the two states on these screens that has to be explained in words rather than
  // shown as a number.
  function graceMissed(p) {
    if (!graceStarted(p) || !targetDone(p)) return false;
    const at = Number(p.metAt) || 0;
    if (!at) return false;                       // no stamp: no violation recorded, as in targetMet
    return at > graceDeadline(p);
  }
  // The other way to fail it, and the commoner one: the allowance ran out with work still to do.
  //
  // No midnight wrap to be careful about, unlike windowGone, and that is not an omission — it is what
  // makes this a stopwatch. A window that has gone may come round again tonight; an allowance that has
  // run out is spent for the day.
  function graceGone(p) {
    if (!graceStarted(p) || targetDone(p)) return false;
    return Date.now() > graceDeadline(p);
  }
  // "+10m" — the slack on its own, which is what the SETTING is. The goal is already shown beside it on
  // every screen that shows this, so repeating it would say the same number twice.
  function graceLabel(p) {
    if (!hasGrace(p)) return "";
    return "+" + fmtDur(Number(p.graceSec) || 0);
  }

  // Group targets into alternative clusters connected by OR, separated by AND
  function computeTargetGroups(sites) {
    const list = (sites || []).slice().sort((a, b) => (a.order || 0) - (b.order || 0));
    const groups = [];
    let curGroup = [];
    for (const s of list) {
      if (!s) continue;
      const op = s.operator === "OR" ? "OR" : "AND";
      if (curGroup.length === 0 || op === "AND") {
        if (curGroup.length > 0) groups.push(curGroup);
        curGroup = [s];
      } else {
        curGroup.push(s);
      }
    }
    if (curGroup.length > 0) groups.push(curGroup);
    return groups;
  }

  // Is today's study requirement met according to AND / OR logic?
  //
  // `targetMet`, not "is the time done": this is the question the blocking and the phone ask, so it is
  // the one place the per-row deadline has to bite. A row that finished outside its window is not a
  // row that finished, as far as anything being unlocked is concerned.
  //
  // The OR case falls out of this for free and is worth noticing: with two alternatives joined by OR,
  // one of them missing its deadline simply means the other is the one that has to carry the group.
  function evaluateTargets(sites) {
    const groups = computeTargetGroups(sites);
    if (!groups.length) return false;
    return groups.every(g => g.some(targetMet));
  }

  // ---- one step at a time --------------------------------------------------------------------
  //
  // Sequence mode. The order you dragged this list into stops being decoration and becomes the rule:
  // the first thing on it is the only work site you can open, and the rest are shut until it is
  // finished. Then the second opens and the first shuts behind you.
  //
  // The unit of a step is a GROUP, not a row, and that is the one decision the whole feature rests
  // on. computeTargetGroups above already cuts the list into AND-separated clusters of OR
  // alternatives, and a cluster is what "one thing to do" has always meant here: "Anki OR Khan
  // Academy" is a single decision with two doors, not two steps. Stepping row by row would have
  // quietly turned every OR in every existing profile into an AND — the second alternative locked
  // until the first was done, which is the exact opposite of what somebody meant when they chose OR.
  //
  // Nothing below is stored. There is no "current step" field anywhere in the extension and there
  // deliberately is not one: a saved pointer can disagree with the progress beside it — after a day
  // boundary, an import, a row deleted mid-sequence, a row switched off, a row that is not on today —
  // and a pointer aimed at a row that is no longer there locks the entire list with no way out.
  // Reading the position back out of the progress on every question cannot drift, because there is
  // nothing for it to drift from.

  // Can this row still be earned today at all?
  //
  // Only ever false for a row with a window, and it is the reason sequence mode is not a trap. Say
  // step one was due between 06:00 and 09:00 and it is now ten o'clock: targetMet will never be true
  // again today, so a sequence that insists on finishing steps in order would sit on step one until
  // midnight with every study site on the list locked behind it. That is a dead end — not a strict
  // rule but a broken one, because no amount of work can clear it.
  //
  // So a step that can no longer be satisfied is stepped OVER rather than waited on. The bar for
  // moving past it is "this is now impossible", never "this is hard" or "I would rather not": both
  // states below are ones the clock has already decided and the user cannot undo.
  //
  // windowGone is the window that closed on unfinished work; windowMissed is work finished after the
  // window shut. Both mean targetMet is false and can never turn true again today, and they are the
  // only two states in the extension of which that is true.
  function stepLive(p) {
    if (!p) return false;
    if (windowGone(p) || windowMissed(p)) return false;
    // And the same two failures for the stopwatch. A step whose allowance has run out is exactly as
    // unreachable as one whose window has shut, so the sequence has to step over it for the same reason
    // — otherwise a blown ten-minute grace on step one locks every study site for the rest of the day.
    if (graceGone(p) || graceMissed(p)) return false;
    return true;
  }

  // Which step is the one being worked on? A 0-based index into computeTargetGroups, or -1.
  //
  // -1 covers three different situations and answers all of them the same way, which is correct
  // rather than lazy: an empty list, every group finished, and every remaining group out of time.
  // In none of those is there a step the sequence could point at, so in none of them should the
  // sequence be shutting anything — see inCurrentStep, where -1 opens everything.
  function currentStepIndex(sites) {
    const groups = computeTargetGroups(sites);
    return groups.findIndex(g => !g.some(targetMet) && g.some(stepLive));
  }

  // The rows of the step being worked on — one row usually, more when they are OR alternatives.
  // Empty when there is no current step.
  function currentStepGroup(sites) {
    const groups = computeTargetGroups(sites);
    const i = currentStepIndex(sites);
    return i < 0 ? [] : groups[i];
  }

  // Is this row part of the step being worked on? The question the blocking asks.
  //
  // `sites` is whatever list the caller considers to be in play, and every caller hands it the same
  // thing the rest of the extension uses — activeTargets in the worker, today's rows on the pages.
  // Rows that are switched off or not scheduled for today are therefore not in the sequence at all,
  // which is the existing rule for those rows everywhere else and not a new one here.
  //
  // Matched by id first and by identity second. Two calls in the same tick are usually looking at
  // the same objects, but the blocked page rebuilds its rows from storage, so the ids are the only
  // thing the two sides reliably share.
  function inCurrentStep(p, sites) {
    if (!p) return false;
    const g = currentStepGroup(sites);
    if (!g.length) return true;          // no step to be out of: nothing is out of order
    return g.some(s => s === p || (s && s.id && p.id && s.id === p.id));
  }

  // Which step is this row, counting from 1? 0 when it is in no group at all.
  //
  // Purely for saying it out loud — "Step 3 of 5" on the settings row, "step 1" on the blocked page.
  // Separate from the three above because a number the user reads and a decision the worker makes
  // should not be the same call: this one is happy to describe a step that is finished or out of
  // time, and those are exactly the steps currentStepIndex refuses to point at.
  function stepNumberOf(p, sites) {
    if (!p) return 0;
    const groups = computeTargetGroups(sites);
    const i = groups.findIndex(g => g.some(s => s === p || (s && s.id && p.id && s.id === p.id)));
    return i < 0 ? 0 : i + 1;
  }

  // How many steps there are today. The denominator of the sentence above.
  function stepCount(sites) {
    return computeTargetGroups(sites).length;
  }

  // Calculate totals and progress according to AND / OR logic
  function calcTotals(sites) {
    const groups = computeTargetGroups(sites);
    if (!groups.length) {
      return { req: 0, spent: 0, left: 0, done: 0, total: 0, allDone: false, pct: 0, count: 0 };
    }
    let totalReq = 0;
    let totalSpent = 0;
    let totalLeft = 0;
    let doneGroups = 0;

    for (const g of groups) {
      // `targetMet` here too, so "all done" in the popup and on the settings page means the same thing
      // as "unlocked". A group whose only finished row missed its deadline counts as outstanding —
      // otherwise the page would claim the day was complete while every blocked site stayed shut,
      // which is the one disagreement a progress figure must not have with reality.
      //
      // The time figures below are deliberately unaffected: spent is spent, and a bar that refused to
      // show work somebody actually did would be the wrong way to report a missed deadline. That is
      // what windowMissed is for — a plain statement instead of a silently wrong number.
      const isGroupDone = g.some(targetMet);
      if (isGroupDone) {
        doneGroups++;
        const metSite = g.find(targetMet);
        const reqSec = metSite ? (metSite.requiredSec || 0) : Math.min(...g.map(p => p.requiredSec || 0));
        totalReq += reqSec;
        totalSpent += reqSec;
      } else {
        const reqSec = Math.min(...g.map(p => p.requiredSec || 0));
        const groupSpent = Math.max(0, ...g.map(p => Math.min(p.requiredSec || 0, p.spentSec || 0)));
        const groupLeft = Math.min(...g.map(p => Math.max(0, (p.requiredSec || 0) - (p.spentSec || 0))));
        totalReq += reqSec;
        totalSpent += groupSpent;
        totalLeft += groupLeft;
      }
    }

    const allDone = doneGroups === groups.length;
    const left = allDone ? 0 : totalLeft;
    const pct = allDone ? 100 : (totalReq > 0 ? Math.min(100, Math.round((totalSpent / totalReq) * 100)) : 0);

    return {
      req: totalReq,
      spent: totalSpent,
      left,
      done: doneGroups,
      total: groups.length,
      allDone,
      pct,
      count: sites.length
    };
  }

  // Format natural language text connecting items with their chosen logic operators (and / or)
  function formatLogicPlan(items, fmtFn) {
    if (!items || !items.length) return "";
    let out = fmtFn ? fmtFn(items[0], 0) : String(items[0]);
    for (let i = 1; i < items.length; i++) {
      const op = (items[i].operator === "OR" ? "or" : "and");
      const part = fmtFn ? fmtFn(items[i], i) : String(items[i]);
      out += ` ${op} ${part}`;
    }
    return out;
  }

  function fmtDur(sec) {
    sec = Math.max(0, Math.round(Number(sec) || 0));
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = sec % 60;
    if (h > 0) return `${h}h ${m}m`;
    if (m > 0) return s > 0 ? `${m}m ${s}s` : `${m}m`;
    return `${s}s`;
  }

  // ---- whole categories of site, in one press ---------------------------------------------------
  //
  // Typing "instagram.com" is easy. Remembering that you also meant Threads, and the mobile host, and
  // the one you only use on your phone, is not — and a blocklist with three of a category's ten doors
  // shut is a blocklist you walk around without noticing you did. That is the failure these fix: not
  // the effort of typing, the gaps.
  //
  // Read only by the settings page, and kept here anyway, because it is data rather than layout and
  // this is where the shared data lives. The worker never touches it: a category is a way of FILLING
  // a list, not a thing the lists are made of, so what gets stored is the ordinary domains and every
  // one of them can be removed on its own afterwards. Nothing anywhere has to know a category existed.
  //
  // Bare hosts, no "*." prefixes. Blocking a host covers its subdomains already (see hostMatches), and
  // on the allow list a bare host deliberately does not — which is the right default there too, since
  // opening one site should not open everything hanging off it.
  //
  // Not exhaustive and not trying to be: it is the well-known handful per category, the ones somebody
  // would actually reach for. The box beside it takes anything this misses.
  const SITE_CATEGORIES = [
    { id: "social", icon: "💬", name: "Social media", sites: [
      "facebook.com", "instagram.com", "threads.net", "twitter.com", "x.com", "tiktok.com",
      "snapchat.com", "linkedin.com", "tumblr.com", "vk.com", "weibo.com", "mastodon.social",
      "bsky.app", "pinterest.com", "quora.com" ] },
    { id: "chat", icon: "✉️", name: "Chats & messaging", sites: [
      "web.whatsapp.com", "web.telegram.org", "discord.com", "messenger.com", "slack.com",
      "teams.microsoft.com", "signal.org", "wechat.com", "line.me", "viber.com", "kik.com" ] },
    { id: "video", icon: "📺", name: "Video & streaming", sites: [
      "youtube.com", "netflix.com", "primevideo.com", "hotstar.com", "disneyplus.com", "hulu.com",
      "twitch.tv", "dailymotion.com", "vimeo.com", "hbomax.com", "max.com", "peacocktv.com",
      "zee5.com", "sonyliv.com", "jiocinema.com", "mxplayer.in", "crunchyroll.com" ] },
    { id: "shorts", icon: "📱", name: "Short video & reels", sites: [
      "tiktok.com", "youtube.com/shorts", "instagram.com/reels", "kwai.com", "triller.co",
      "josh.in", "moj.tv", "snackvideo.com" ] },
    { id: "games", icon: "🎮", name: "Games", sites: [
      "roblox.com", "store.steampowered.com", "steamcommunity.com", "epicgames.com", "miniclip.com",
      "poki.com", "crazygames.com", "y8.com", "friv.com", "addictinggames.com", "chess.com",
      "lichess.org", "coolmathgames.com", "itch.io", "kongregate.com", "agar.io", "slither.io",
      // No "epicgames.com/fortnite": epicgames.com is already on this list, and blocking a host
      // covers everything under it — a path entry beside its own host is a chip that changes nothing.
      "krunker.io", "ea.com", "battle.net", "xbox.com", "playstation.com" ] },
    { id: "news", icon: "📰", name: "News", sites: [
      "news.google.com", "bbc.com", "cnn.com", "nytimes.com", "theguardian.com", "foxnews.com",
      "ndtv.com", "timesofindia.indiatimes.com", "hindustantimes.com", "indianexpress.com",
      "aljazeera.com", "reuters.com", "apnews.com", "news.ycombinator.com", "washingtonpost.com",
      "dailymail.co.uk", "buzzfeed.com" ] },
    { id: "shopping", icon: "🛒", name: "Shopping", sites: [
      "amazon.com", "amazon.in", "flipkart.com", "ebay.com", "aliexpress.com", "myntra.com",
      "ajio.com", "meesho.com", "walmart.com", "target.com", "etsy.com", "shein.com", "temu.com",
      "nykaa.com", "snapdeal.com", "wish.com", "alibaba.com" ] },
    { id: "forums", icon: "🗣️", name: "Forums & aggregators", sites: [
      "reddit.com", "9gag.com", "4chan.org", "imgur.com", "digg.com", "voat.co", "somethingawful.com",
      "quora.com", "stackexchange.com" ] },
    { id: "music", icon: "🎧", name: "Music & podcasts", sites: [
      "spotify.com", "soundcloud.com", "music.apple.com", "music.youtube.com", "deezer.com",
      "pandora.com", "gaana.com", "jiosaavn.com", "wynk.in", "audiomack.com", "bandcamp.com",
      "last.fm", "tidal.com" ] },
    { id: "ai", icon: "🤖", name: "AI chatbots", sites: [
      "chatgpt.com", "chat.openai.com", "gemini.google.com", "claude.ai", "perplexity.ai",
      "copilot.microsoft.com", "character.ai", "poe.com", "deepseek.com", "grok.com",
      "huggingface.co/chat", "you.com" ] },
    { id: "sports", icon: "⚽", name: "Sports", sites: [
      "espn.com", "cricbuzz.com", "espncricinfo.com", "nba.com", "nfl.com", "fifa.com",
      "goal.com", "skysports.com", "bleacherreport.com", "sports.yahoo.com", "livescore.com",
      "formula1.com", "wwe.com" ] },
    { id: "mail", icon: "📧", name: "Email & webmail", sites: [
      "mail.google.com", "outlook.com", "outlook.live.com", "mail.yahoo.com", "mail.proton.me",
      "zoho.com/mail", "mail.com", "aol.com", "rediff.com" ] },
    { id: "anime", icon: "🌸", name: "Anime & manga", sites: [
      "crunchyroll.com", "myanimelist.net", "9anime.to", "gogoanime.tv", "animeflv.net",
      "mangadex.org", "manganato.com", "webtoons.com", "funimation.com", "anilist.co" ] },
    { id: "memes", icon: "😂", name: "Memes & humour", sites: [
      "9gag.com", "imgur.com", "knowyourmeme.com", "theonion.com", "cheezburger.com",
      "boredpanda.com", "collegehumor.com", "funnyjunk.com" ] },
    { id: "dating", icon: "💘", name: "Dating", sites: [
      "tinder.com", "bumble.com", "hinge.co", "okcupid.com", "match.com", "badoo.com",
      "grindr.com", "pof.com", "happn.com" ] },
    { id: "gambling", icon: "🎲", name: "Gambling & betting", sites: [
      "bet365.com", "draftkings.com", "fanduel.com", "pokerstars.com", "888casino.com",
      "williamhill.com", "betway.com", "stake.com", "dream11.com", "my11circle.com",
      "rummycircle.com" ] },
    { id: "crypto", icon: "📈", name: "Crypto & trading", sites: [
      "binance.com", "coinbase.com", "coinmarketcap.com", "coingecko.com", "kraken.com",
      "tradingview.com", "robinhood.com", "wazirx.com", "zerodha.com", "groww.in", "etoro.com",
      "bybit.com", "kucoin.com" ] },
    { id: "torrent", icon: "🏴", name: "Torrents & piracy", sites: [
      "thepiratebay.org", "1337x.to", "rarbg.to", "torrentgalaxy.to", "yts.mx", "nyaa.si",
      "kickasstorrents.to", "limetorrents.lol", "fitgirl-repacks.site", "libgen.is" ] },
    { id: "adult", icon: "🔞", name: "Adult", sites: [
      "pornhub.com", "xvideos.com", "xnxx.com", "xhamster.com", "redtube.com", "youporn.com",
      "onlyfans.com", "chaturbate.com", "stripchat.com", "brazzers.com", "spankbang.com",
      "eporner.com", "rule34.xxx", "nhentai.net" ] },
    { id: "images", icon: "🖼️", name: "Image boards & galleries", sites: [
      "deviantart.com", "artstation.com", "pixiv.net", "flickr.com", "500px.com",
      "unsplash.com", "weheartit.com", "behance.net" ] }
  ];

  // ---- showing somebody a switch we are not allowed to touch ------------------------------------
  //
  // "Allow access to file URLs" is off for every extension until the user turns it on, and while it
  // is off a local file can be neither timed nor opened. FocusGate cannot turn it on, cannot read
  // whether a click landed, and cannot even scroll the page it lives on: chrome://extensions is
  // Chrome's own, and an extension may not script it. Opening that page is the whole of what we can
  // do, and the page that opens is long, has four other switches on it, and looks nothing like
  // anything we said.
  //
  // So the only honest fix is to SHOW the switch before sending anyone there. Words had already been
  // tried — every message about this names the setting in bold — and naming a switch is not the same
  // as pointing at it.
  //
  // Drawn as an SVG rather than shipped as a PNG for three reasons that all matter here: it scales
  // from the 320px popup to a settings dialog without a second asset, it stays sharp on any display,
  // and it costs no extra file in the package. Every value is an attribute — no <style> block, no
  // external CSS — so it renders identically wherever it is dropped, including inside a dialog that
  // knows nothing about it.
  //
  // It shows the row twice on purpose: once as you will find it (off, ringed, with an arrow) and once
  // as it should end up (on). A picture of the problem alone leaves you checking your own work
  // against a memory of a sentence.
  function fileAccessGuideSvg() {
    // One row of the extension detail panel: a label and a switch.
    const row = (y, label, on, dim) => `
      <text x="26" y="${y + 5}" font-size="11" fill="${dim ? "#8b93a7" : "#e7eaf3"}"
            font-family="ui-sans-serif, system-ui, 'Segoe UI', Roboto, sans-serif">${label}</text>
      <rect x="298" y="${y - 6}" width="26" height="13" rx="6.5" fill="${on ? "#3b82f6" : "#4b5563"}"/>
      <circle cx="${on ? 317.5 : 304.5}" cy="${y + 0.5}" r="4.6" fill="${on ? "#ffffff" : "#9aa3b2"}"/>`;
    return `
    <svg viewBox="0 0 420 232" width="100%" role="img" aria-label="Chrome's extension page, with the Allow access to file URLs switch ringed in red and an arrow pointing at it"
         xmlns="http://www.w3.org/2000/svg" style="display:block">
      <text x="8" y="11" font-size="10" fill="#8b93a7" font-family="ui-monospace, monospace">chrome://extensions  ›  FocusGate</text>

      <!-- The panel, as Chrome draws it: a plain card with a switch per line. -->
      <rect x="8" y="20" width="336" height="150" rx="10" fill="#1c2130" stroke="#333c50" stroke-width="1"/>
      ${row(46, "Site access", true, true)}
      <line x1="16" y1="62" x2="336" y2="62" stroke="#262f42" stroke-width="1"/>
      ${row(78, "Pin to toolbar", true, true)}
      <line x1="16" y1="94" x2="336" y2="94" stroke="#262f42" stroke-width="1"/>
      ${row(110, "Allow access to file URLs", false, false)}
      <line x1="16" y1="126" x2="336" y2="126" stroke="#262f42" stroke-width="1"/>
      ${row(142, "Collect errors", true, true)}

      <!-- The one row that matters, ringed. Same red as the warning this drawing sits inside. -->
      <rect x="13" y="96" width="326" height="28" rx="6" fill="rgba(239,68,68,.10)"
            stroke="#ef4444" stroke-width="2"/>

      <!-- The arrow, coming in from outside the panel so it cannot be mistaken for part of it. -->
      <path d="M410 168 Q404 132 352 111" fill="none" stroke="#ef4444" stroke-width="2.4"
            stroke-linecap="round"/>
      <path d="M352 111 l11 -3.5 l-2 8.5 z" fill="#ef4444"/>

      <!-- What it should look like afterwards. The "before" picture on its own leaves you checking
           your work against a memory of a sentence. -->
      <text x="8" y="192" font-size="10" fill="#8b93a7"
            font-family="ui-sans-serif, system-ui, 'Segoe UI', Roboto, sans-serif">Turn it on, so it looks like this:</text>
      <rect x="8" y="198" width="336" height="28" rx="6" fill="rgba(34,197,94,.10)"
            stroke="#22c55e" stroke-width="1.5"/>
      <text x="26" y="217" font-size="11" fill="#e7eaf3"
            font-family="ui-sans-serif, system-ui, 'Segoe UI', Roboto, sans-serif">Allow access to file URLs</text>
      <rect x="298" y="206" width="26" height="13" rx="6.5" fill="#3b82f6"/>
      <circle cx="317.5" cy="212.5" r="4.6" fill="#ffffff"/>
      <path d="M356 212 l5 5 l9 -11" fill="none" stroke="#22c55e" stroke-width="2.6"
            stroke-linecap="round" stroke-linejoin="round"/>
    </svg>`;
  }

  function targetOpenUrl(p) {
    if (!p) return "";
    if (p.type === "local_file") {
      if (p.url) return p.url;
      const path = p.path || "";
      if (/^[a-zA-Z]:[/\\]|^\//.test(path)) return "file:///" + path.replace(/\\/g, "/").replace(/^\/+/, "");
      if (p.stored && p.id) {
        try { return chrome.runtime.getURL("viewer.html?t=" + encodeURIComponent(p.id)); } catch {}
      }
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

  G.FGSettings = {
    KEYS, CHEAT, EXCLUDED, STRICTER, SAYS,
    checkOne, exportFrom, importFrom,
    changeDir, loosens, loosensKey, tightens, tightensKey, describe,
    // The weekday schedule. Exported because four places need it and none of them should own a
    // second copy: the worker decides whether a row counts today, the settings page draws the
    // chips, the popup lists today's work, and this file validates what comes out of a file.
    DAY_ALL, DAY_WEEKDAYS, DAY_WEEKEND, DAY_ORDER,
    dayMask, weekdayNow, onDay, daysLabel,
    // AND / OR logic helpers for study site targets
    computeTargetGroups, evaluateTargets, calcTotals, formatLogicPlan,
    // Sequence mode: which step of the work list is the one you are allowed to be on. Built on the two
    // above rather than beside them, so a step is always a GROUP and an OR never becomes an AND.
    // Exported because four places ask: the worker blocks with it, the settings page dims the locked
    // rows with it, the blocked page names the step you owe, and the popup points at it.
    stepLive, currentStepIndex, currentStepGroup, inCurrentStep, stepNumberOf, stepCount,
    // The per-row deadline. Exported as a set because the distinction between them is the feature:
    // `targetDone` is what the bars show, `targetMet` is what the blocking asks, and `windowMissed`
    // plus `windowGone` are the two ways the gap between them opens up — finished too late, and
    // never finished at all — which are the only states on these screens that have to be explained
    // in words rather than shown as a number.
    hasWindow, inWindow, targetDone, targetMet, windowMissed, windowGone, windowLabel,
    // And the rule that a window is always long enough to finish its goal in.
    windowMinFor, windowSpan, windowFits, fitWindowEnd, winMaxMin,
    // The second deadline, and the same set of questions about it: is there one, is it running, how long
    // is left, and which of the two ways it can be failed happened. `graceMissed` and `graceGone` are the
    // exact mirrors of `windowMissed` and `windowGone`, which is what lets every screen that already
    // explains one explain the other in the same shape.
    hasGrace, graceStarted, graceDeadline, graceLeftSec, graceInTime, graceMissed, graceGone, graceLabel,
    // Storage is 24-hour; every screen shows 12-hour. Exported so none of them re-derives it.
    clock12,
    // Whole categories of site, for filling the two lists. Data only — nothing stores a category.
    SITE_CATEGORIES,
    // Target formatting and navigation helpers
    fmtDur, targetOpenUrl,
    // The one drawing in the extension. Lives here because all three pages that have to show it —
    // the popup, the settings page and the blocked screen — already load this file, and a picture
    // kept in three places is a picture that ends up different in three places.
    fileAccessGuideSvg
  };
})(typeof self !== "undefined" ? self : this);
