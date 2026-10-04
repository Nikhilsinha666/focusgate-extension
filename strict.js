// FocusGate — strict mode, in one place.
//
// Strict mode has two shapes, and they are independent. Either one being active freezes
// your settings:
//
//   • The DAILY FREEZE is a schedule. Settings lock between two clock times and lift
//     again each morning. For an evening routine.
//   • The DEADLINE is a stretch. Strict mode stays on continuously, day and night, from
//     now until a date and time you pick. It does not lift, so nothing — including the
//     two switches themselves — can be loosened before it expires. For the week before
//     an exam.
//
// This file exists because the rule had two copies, one in options.js and one in
// popup.js, and their fallbacks for a missing time already differed: the settings card
// displayed 15:00 → 08:00 while both guards fell back to 00:00 → 00:00, which is a
// zero-length window and therefore no window at all. So the page could show strict mode
// armed while the guard answered "not now" — and the copy in popup.js is the one deciding
// whether the power switch works, which is the worst place for a rule to be wrong. One
// definition, loaded by both pages, is the fix that cannot come apart again.
//
// No chrome.* anywhere: pure functions over a plain state object, so any page can load it
// as an ordinary script.
(function (G) {
  "use strict";

  // The window offered when storage holds no times yet, and the fallback every guard
  // uses. The two have to be the same value or the bug in the note above comes back.
  const STRICT_FROM = "15:00";
  const STRICT_TO = "08:00";
  // How far ahead a commitment may reach. Long enough for a course, short enough that a
  // slip of the year box isn't a decade.
  const YEARS_AHEAD = 20;
  const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
  const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun",
                  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const MONTHS_LONG = ["January", "February", "March", "April", "May", "June",
                       "July", "August", "September", "October", "November", "December"];

  function fin(v) { const n = parseInt(v, 10); return Number.isFinite(n) ? n : 0; }
  function plural(n, word) { return n === 1 ? word : word + "s"; }
  // "9:5" and "" and null all have to land somewhere sensible, and on the same value
  // wherever they are read.
  function hhmm(v, fallback) {
    const m = /^(\d{1,2}):(\d{1,2})$/.exec(String(v == null ? "" : v).trim());
    if (!m) return fallback;
    const h = Math.min(23, Math.max(0, fin(m[1])));
    const mi = Math.min(59, Math.max(0, fin(m[2])));
    return String(h).padStart(2, "0") + ":" + String(mi).padStart(2, "0");
  }
  const minsOf = (t) => { const p = t.split(":"); return fin(p[0]) * 60 + fin(p[1]); };
  // Duck-typed rather than `now instanceof Date`, so a Date handed in from another page
  // still counts. An instanceof against the local constructor fails across realms, and it
  // would fail silently — answering about right now instead of the moment asked about.
  const nowMs = (now) => (now && typeof now.getTime === "function") ? now.getTime() : Date.now();
  const nowDate = (now) => (now && typeof now.getTime === "function") ? new Date(now.getTime()) : new Date();

  // ---- part one: the daily freeze ----
  // Inside today's window? Handles the ordinary case of a window that crosses midnight.
  function dailyStrict(s, now) {
    if (!s || !s.strictModeEnabled) return false;
    const startM = minsOf(hhmm(s.strictStart, STRICT_FROM));
    const endM = minsOf(hhmm(s.strictEnd, STRICT_TO));
    if (startM === endM) return false;              // zero length is "never", not "always"
    const d = nowDate(now);
    const nowM = d.getHours() * 60 + d.getMinutes();
    return startM < endM ? (nowM >= startM && nowM < endM)
                         : (nowM >= startM || nowM < endM);
  }

  // ---- part two: the deadline ----
  // The stored date, or "" for no commitment. Anything that is not exactly YYYY-MM-DD
  // reads as no commitment rather than as some best guess: a half-parsed date here would
  // either lock somebody out for a decade or let them out today, and both are worse than
  // the feature simply being off.
  function strictUntil(s) {
    const v = s && s.strictUntil;
    return (typeof v === "string" && DATE_RE.test(v.trim())) ? v.trim() : "";
  }
  // The default is 23:59 rather than 00:00, so "until the 21st" means the whole of the
  // 21st. Midnight would end the 21st before it began, and "until today" would already
  // be over the moment you set it.
  function strictUntilTime(s) { return hhmm(s && s.strictUntilTime, "23:59"); }
  // The end of the commitment, as a moment. Local time throughout — the date and the
  // clock both came from this machine, so there is no timezone arithmetic to get wrong.
  function strictDeadlineAt(s) {
    const d = strictUntil(s);
    if (!d) return 0;
    const parts = d.split("-").map(fin);
    const t = strictUntilTime(s).split(":").map(fin);
    const at = new Date(parts[0], parts[1] - 1, parts[2], t[0], t[1], 0, 0).getTime();
    return Number.isFinite(at) ? at : 0;
  }
  // Still running? Needs its own switch on AND a date set. The switch exists so a date
  // can sit in storage unused, which is what lets the boxes remember what you last
  // picked instead of starting blank every time you open the row.
  function strictDeadlineActive(s, now) {
    if (!s || !s.strictUntilEnabled) return false;
    const at = strictDeadlineAt(s);
    if (!at) return false;
    return nowMs(now) < at;
  }

  // A commitment whose moment has been and gone, while its switch is still on.
  //
  // Nothing is being held at this point — strictDeadlineActive already answers "no" off the
  // same comparison — so this is not a second opinion about enforcement. It is only the
  // difference between a switch that still reads ON and a commitment that is over, which
  // matters because a switch nobody can trust is worse than no switch.
  function strictDeadlineSpent(s, now) {
    if (!s || !s.strictUntilEnabled) return false;
    const at = strictDeadlineAt(s);
    if (!at) return false;
    return nowMs(now) >= at;
  }

  // ---- THE question ----
  // Are the settings frozen right now, for either reason? Every guard on every page asks
  // this one and nothing else, so there is one answer.
  function strictNow(s, now) {
    return dailyStrict(s, now) || strictDeadlineActive(s, now);
  }

  // The next time of day the clock will read `mins` past midnight, as a moment.
  //
  // Calendar arithmetic rather than "+ 86400000". Adding a day's worth of milliseconds lands
  // an hour out either side of a daylight-saving change, which would be a page that unfreezes
  // an hour late twice a year — rare enough never to be noticed and never to be found.
  function nextClockAt(mins, base) {
    const d = new Date(base);
    d.setHours(0, 0, 0, 0);
    d.setMinutes(mins);                 // minutes past midnight; overflow rolls into hours
    if (d.getTime() <= base) {
      d.setDate(d.getDate() + 1);
      d.setHours(0, 0, 0, 0);
      d.setMinutes(mins);
    }
    return d.getTime();
  }

  // The next moment strictNow could answer differently. 0 when nothing is scheduled.
  //
  // Deliberately "could change" and not "will lift". Working out when a freeze finally ends
  // means solving the two halves together — a daily window that closes at 08:00 does not lift
  // anything while a deadline three days out is still running, and the window comes back at
  // 15:00 regardless — and that is a calculation with corners to get wrong. The next EDGE is
  // simple and needs no cases: wake up there, ask strictNow again, and arm the next one. The
  // state machine does the reasoning instead of a formula.
  function strictNextChangeAt(s, now) {
    const base = nowMs(now);
    const at = [];
    if (s && s.strictModeEnabled) {
      const startM = minsOf(hhmm(s.strictStart, STRICT_FROM));
      const endM = minsOf(hhmm(s.strictEnd, STRICT_TO));
      // A zero-length window never turns on, so it has no edges.
      if (startM !== endM) { at.push(nextClockAt(startM, base)); at.push(nextClockAt(endM, base)); }
    }
    if (s && s.strictUntilEnabled) {
      const d = strictDeadlineAt(s);
      if (d > base) at.push(d);
    }
    const future = at.filter(t => t > base);
    return future.length ? Math.min.apply(null, future) : 0;
  }

  // How much of the commitment is left, in words. Two units at most: "3 days 4 hours" is
  // worth reading, "3 days 4 hours 11 minutes 6 seconds" is a stopwatch nobody asked for.
  function strictLeftText(s, now) {
    const at = strictDeadlineAt(s);
    if (!at) return "";
    let left = Math.floor((at - nowMs(now)) / 1000);
    if (left <= 0) return "";
    const d = Math.floor(left / 86400); left -= d * 86400;
    const h = Math.floor(left / 3600); left -= h * 3600;
    const m = Math.floor(left / 60);
    if (d) return d + plural(d, " day") + (h ? " " + h + plural(h, " hour") : "");
    if (h) return h + plural(h, " hour") + (m ? " " + m + plural(m, " minute") : "");
    return Math.max(1, m) + plural(Math.max(1, m), " minute");
  }

  // "20 Aug 2026". Spelled out from a table rather than handed to toLocaleDateString, so
  // the date on screen cannot come back in a format that reads as a different day —
  // 08/20 and 20/08 are the same string to two different readers, and this one is a
  // commitment you cannot take back.
  function strictUntilLabel(v) {
    const d = String(v == null ? "" : v).trim();
    if (!DATE_RE.test(d)) return "";
    const p = d.split("-").map(fin);
    if (p[1] < 1 || p[1] > 12) return "";
    return p[2] + " " + MONTHS[p[1] - 1] + " " + p[0];
  }

  // Today as a sortable "2026-08-20", with the daily reset boundary respected: before the
  // boundary you are still in yesterday, the same day the reset and the streak use.
  // Padded, because this one is asked "is it past yet" rather than compared for equality.
  function todayStamp(s, now) {
    const d = nowDate(now);
    const t = hhmm(s && s.dailyResetTime, "00:00").split(":").map(fin);
    if (d.getHours() * 60 + d.getMinutes() < t[0] * 60 + t[1]) d.setDate(d.getDate() - 1);
    const p = (n) => String(n).padStart(2, "0");
    return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate());
  }

  // How long the month the boxes are pointing at actually is. Day 0 of the next month is
  // the last day of this one.
  function lastDayOf(y, m) { return new Date(y, m, 0).getDate(); }

  G.FGStrict = {
    STRICT_FROM, STRICT_TO, YEARS_AHEAD, MONTHS, MONTHS_LONG,
    fin, hhmm, lastDayOf,
    dailyStrict, strictUntil, strictUntilTime, strictDeadlineAt, strictDeadlineActive,
    strictDeadlineSpent, strictNow, strictNextChangeAt, nextClockAt,
    strictLeftText, strictUntilLabel, todayStamp
  };
})(typeof self !== "undefined" ? self : this);
