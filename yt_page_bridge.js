// FocusGate — the page-world bridge, for reading a video's subtitles.
//
// Runs in the PAGE's own JavaScript world (manifest: "world": "MAIN"), and that is the entire reason it
// exists as a separate file: it can read the variables YouTube's own scripts set, it can see the requests
// YouTube's own player makes, and its fetches go out AS the page rather than as an extension.
//
// ---------------------------------------------------------------------------
// Why the obvious approach does not work, in the order the obvious approaches fail
//
// This started life as twenty lines in the service worker: fetch the watch page, pull `captionTracks` out
// of the HTML, fetch the `baseUrl` it gives you. That is what every tutorial says, and it returns nothing.
// Three separate reasons, each of which only becomes visible once the one before it is fixed — the sibling
// extension in this workspace went through all three, and this file is the shape they leave behind.
//
//   1. A fetch from the worker is anonymous. YouTube answers 200 with an EMPTY BODY. Not an error, not a
//      403 — a successful response with no words in it, which reads exactly like "this video has no
//      subtitles". Moving the fetch into the page world fixes that one.
//
//   2. Looking for the player's data once, at the first instant, misses it. YouTube attaches the caption
//      tracklist a beat after the video details, and a soft navigation leaves the document-load copy
//      describing the previous video. So it has to be waited for, and checked against the video actually
//      being asked about.
//
//   3. And the real one. `captionTracks[].baseUrl` STILL comes back empty, because that URL does not
//      carry the proof-of-origin token (`pot`). The player appends it at request time; it is not in the
//      player response, and it is minted by BotGuard inside the player. So the premise of (1) — "the URL
//      the player minted already has what it needs" — is simply false.
//
// We cannot mint that token. We do not need to: when captions exist, the player itself fetches them, WITH
// the token, and this file is in the same world as that request. So the strategy is, in order of how well
// it works:
//
//   A. OBSERVE.  A passive wrapper around fetch and XHR, installed at document_start, notices the
//                player's own /api/timedtext calls and keeps the URL and the body. Costs no extra
//                request and needs no token of our own. This is the path that works.
//   B. REPLAY.   If a tokenned URL was seen but its body was not captured, fetch that URL again.
//   C. ASK COLD. Build a URL from captionTracks and try it, in a couple of formats. Cannot supply the
//                token, so it often fails — kept because it still works on some videos, and it costs
//                nothing to try once the other two have not.
//
// Every answer carries a `detail` string naming which path ran and what happened. Diagnosing this from a
// screenshot is what cost three rounds; the answer says so out loud instead.
//
// ---------------------------------------------------------------------------
// What this file may and may not do, stated plainly because it runs in somebody's YouTube
//
//   IT READS   the player's own response object, and the bodies of caption requests the player was
//              already making.
//   IT WRITES  one attribute on <html>, so the other half of the extension can tell "the bridge is
//              missing" from "the player is slow".
//   IT SENDS   nothing anywhere. It answers one question, by postMessage, to this same window. It has no
//              access to the extension, no key, and no idea what the topic is — it hands back text and
//              the decision is made elsewhere.
//
// The observer is PASSIVE TO A FAULT. It forwards every call untouched, reads only a clone of the
// response, and swallows every error of its own. A bug in here would break YouTube for the user, so it is
// written to do nothing at all rather than risk that.
(function () {
  "use strict";

  const CHANNEL = "fg-yt-bridge";

  // The two worlds cannot see each other's variables, but they share the DOM — so one attribute is enough
  // for the isolated-world half to know whether anybody is listening. Without it, "the bridge did not
  // load" and "the player is slow" look identical, and the only way to tell them apart is to wait out a
  // full timeout on every single video.
  try { document.documentElement.setAttribute("data-fg-bridge", "1"); } catch (e) {}

  // How much transcript is handed back. Generous, because the worker samples it down to what the prompt
  // has room for — and it samples ACROSS the video rather than truncating, so handing back less here would
  // pre-emptively throw away the middle and the end that its sampling exists to keep.
  const TRANSCRIPT_CHARS = 120000;

  // ONE overall deadline, not a pile of independent timeouts.
  //
  // The version this is modelled on learned that the hard way: a 9-second player wait and a 7-second
  // fetch timeout, applied per attempt across three tracks, is a bad case of thirty seconds in here — by
  // which time the caller had long since given up and released the video without ever asking the model.
  const BRIDGE_TOTAL_MS = 5500;
  const PLAYER_WAIT_MS = 3000;
  const PLAYER_POLL_MS = 200;
  const FETCH_TIMEOUT_MS = 2500;
  // How long to let the player make its OWN caption request before giving up on watching for it.
  // Deliberately a slice of the total rather than all of it: a video with captions switched off will never
  // produce one, and that case still has to reach path C with time left to try.
  const OBSERVE_WAIT_MS = 1800;
  const OBSERVE_POLL_MS = 120;

  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const msLeft = (deadline) => deadline - Date.now();

  // ---- A. watching the player fetch its own captions ------------------------

  const TIMEDTEXT_RE = /\/api\/timedtext/;
  const seen = new Map();          // videoId -> { url, body, at }
  const SEEN_LIMIT = 4;            // a transcript is a big string; this is bounded on purpose

  function remember(videoId, patch) {
    if (!videoId) return;
    const had = seen.get(videoId) || {};
    seen.delete(videoId);
    seen.set(videoId, Object.assign({ at: Date.now() }, had, patch));
    if (seen.size > SEEN_LIMIT) seen.delete(seen.keys().next().value);
  }
  function videoIdFromUrl(url) {
    try { return new URL(url, location.origin).searchParams.get("v") || ""; } catch (e) { return ""; }
  }
  function langFromUrl(url) {
    try { return new URL(url, location.origin).searchParams.get("lang") || ""; } catch (e) { return ""; }
  }
  function noteCaptionRequest(url, bodyPromise) {
    let id = "";
    try {
      if (!TIMEDTEXT_RE.test(String(url))) return;
      id = videoIdFromUrl(url);
      if (!id) return;
      // Worth keeping even with no body: the URL carries the token, so it can be replayed (path B).
      remember(id, { url: String(url) });
    } catch (e) { return; }
    if (!bodyPromise) return;
    // Never allowed to reject into the page.
    bodyPromise.then(text => { if (text) remember(id, { body: String(text) }); }, () => {});
  }

  function installObserver() {
    // Guard against installing twice — two copies of the extension, or a re-injection.
    try {
      if (window.__fgCaptionObserver) return;
      Object.defineProperty(window, "__fgCaptionObserver", {
        value: true, configurable: true, enumerable: false, writable: true
      });
    } catch (e) { /* if the flag cannot be set, installing twice is still harmless */ }
    try {
      const nativeFetch = window.fetch;
      if (typeof nativeFetch === "function") {
        window.fetch = function (input) {
          const result = nativeFetch.apply(this, arguments);
          try {
            const url = (input && typeof input === "object" && input.url) ? input.url : input;
            if (TIMEDTEXT_RE.test(String(url))) {
              // clone(), so the player's own read of the body is untouched. Reading it directly would
              // consume the stream and break captions on the page.
              noteCaptionRequest(url, result.then(
                res => { try { return res.clone().text(); } catch (e) { return ""; } },
                () => ""));
            }
          } catch (e) {}
          return result;
        };
      }
    } catch (e) {}
    try {
      // XMLHttpRequest as well: the player has used both over the years.
      const proto = XMLHttpRequest && XMLHttpRequest.prototype;
      const nativeOpen = proto && proto.open;
      if (typeof nativeOpen === "function") {
        proto.open = function (method, url) {
          try {
            if (TIMEDTEXT_RE.test(String(url))) {
              this.__fgCaptionUrl = String(url);
              this.addEventListener("load", () => {
                try {
                  const text = (typeof this.responseText === "string") ? this.responseText : "";
                  noteCaptionRequest(this.__fgCaptionUrl, Promise.resolve(text));
                } catch (e) {}
              });
            }
          } catch (e) {}
          return nativeOpen.apply(this, arguments);
        };
      }
    } catch (e) {}
  }
  installObserver();

  // ---- finding the player's own data ---------------------------------------
  //
  // Three places, because YouTube moves it between builds and a soft navigation leaves the document-load
  // copy describing the previous video.
  //
  // Deliberately does NOT demand a `.captions` key. Demanding it was a bug in the version this is modelled
  // on: a perfectly good response for the right video was discarded for not having the tracklist attached
  // yet, so "no response" and "no captions" became indistinguishable.
  function readPlayerResponse() {
    try {
      const player = document.getElementById("movie_player");
      if (player && typeof player.getPlayerResponse === "function") {
        const r = player.getPlayerResponse();
        if (r && r.videoDetails) return r;
      }
    } catch (e) {}
    try {
      const initial = window.ytInitialPlayerResponse;
      if (initial && initial.videoDetails) return initial;
    } catch (e) {}
    try {
      const args = window.ytplayer && window.ytplayer.config && window.ytplayer.config.args;
      const raw = args && args.raw_player_response;
      if (raw && raw.videoDetails) return raw;
    } catch (e) {}
    return null;
  }

  // ---- what is playing RIGHT NOW ----
  //
  // For the miniplayer. When a video plays on in the little corner player after you have scrolled to the
  // feed or opened another page, the address bar no longer names it — so the other half of the extension
  // cannot tell what is playing, and a refused video simply kept going. This answers that: the id and the
  // details of whatever #movie_player is actually showing.
  //
  // The LIVE player only, deliberately. readPlayerResponse above falls back to ytInitialPlayerResponse and
  // the config blob, both of which describe the last WATCH page and would name the wrong video the moment a
  // miniplayer is involved — which is the only moment this is asked. getVideoData/getPlayerState are the
  // player's own public methods (the same ones every embed uses), read through try/catch because a build
  // that renamed one must degrade to "don't know" rather than throw into the page.
  function liveInfo() {
    try {
      const p = document.getElementById("movie_player");
      if (!p) return null;
      let vid = "";
      try { if (typeof p.getVideoData === "function") vid = String((p.getVideoData() || {}).video_id || ""); } catch (e) {}
      let resp = null;
      try { if (typeof p.getPlayerResponse === "function") resp = p.getPlayerResponse(); } catch (e) {}
      if (!vid) { try { vid = String(((resp || {}).videoDetails || {}).videoId || ""); } catch (e) {} }
      if (!/^[A-Za-z0-9_-]{11}$/.test(vid)) return null;
      let state = -1;
      try { if (typeof p.getPlayerState === "function") state = Number(p.getPlayerState()); } catch (e) {}
      const d = (resp && resp.videoDetails) || {};
      const kw = Array.isArray(d.keywords) ? d.keywords.join(", ") : "";
      // Trimmed here as well as on the far side: this crosses postMessage, and a video with an enormous
      // description is not a reason to hand a megabyte across the boundary every time it is asked.
      return {
        videoId: vid,
        title: String(d.title || "").slice(0, 300),
        author: String(d.author || "").slice(0, 200),
        description: String(d.shortDescription || "").slice(0, 2000),
        keywords: String(kw).slice(0, 600),
        // YT.PlayerState: -1 unstarted, 0 ended, 1 playing, 2 paused, 3 buffering, 5 cued. The caller only
        // treats playing/buffering as "being watched"; a paused or ended miniplayer is not gated.
        state: Number.isFinite(state) ? state : -1
      };
    } catch (e) { return null; }
  }
  function videoIdOf(r) {
    try { return String((r && r.videoDetails && r.videoDetails.videoId) || ""); } catch (e) { return ""; }
  }
  function tracksOf(r) {
    try {
      const list = r.captions &&
                   r.captions.playerCaptionsTracklistRenderer &&
                   r.captions.playerCaptionsTracklistRenderer.captionTracks;
      return Array.isArray(list) ? list : null;
    } catch (e) { return null; }
  }
  // Waits for a response that describes the video we were actually asked about. Ends early the moment a
  // matching response HAS tracks, so a ready page costs one tick. A matching response with no tracks is
  // kept but does not end the wait: the tracklist can arrive a beat after the details, and treating that
  // first look as "no captions" is the false negative to avoid.
  async function awaitPlayerResponse(wantedId, hardDeadline) {
    const deadline = Math.min(Date.now() + PLAYER_WAIT_MS, hardDeadline);
    let best = null;
    for (;;) {
      const r = readPlayerResponse();
      if (r) {
        const actual = videoIdOf(r);
        if (!wantedId || !actual || actual === wantedId) {
          const tracks = tracksOf(r);
          if (tracks && tracks.length) return { response: r, tracks };
          best = r;
        }
      }
      if (Date.now() >= deadline) break;
      await sleep(Math.min(PLAYER_POLL_MS, Math.max(10, msLeft(deadline))));
    }
    if (best) return { response: best, tracks: tracksOf(best) };
    return { response: null, tracks: null, timeout: true };
  }

  // Every track, in preference order, because the preferred one's fetch can come back empty and the next
  // often works.
  //
  // LANGUAGE IS NEVER A FILTER, and that is a correction rather than an omission: preferring English picks
  // the machine-translated English track on a Hindi lecture, over the human Hindi one. That is a
  // second-hand copy of words that were already there, and a worse signal about a subject the user
  // probably described in Hindi terms. The model reads Hindi perfectly well — see FGAi.prompt, which says
  // so.
  //
  // Order is by fidelity to what was actually said: the video's own audio language, then the track
  // YouTube itself defaults to, then human over automatic, then an original over a translation.
  function rankTracks(tracks, response) {
    if (!Array.isArray(tracks) || !tracks.length) return [];
    const norm = (v) => String(v || "").toLowerCase().split("-")[0];
    let audioLang = "";
    try { audioLang = norm(response && response.videoDetails && response.videoDetails.defaultAudioLanguage); } catch (e) {}
    let defaultIndex = -1;
    try {
      const raw = response.captions.playerCaptionsTracklistRenderer.defaultCaptionTrackIndex;
      if (Number.isFinite(raw)) defaultIndex = Number(raw);
    } catch (e) {}
    const score = (t, i) => {
      let v = 0;
      if (audioLang && norm(t && t.languageCode) === audioLang) v += 8;
      if (i === defaultIndex) v += 4;
      if (t && t.kind !== "asr") v += 2;
      // A vssId beginning with "." marks a translated track on some builds.
      if (!/^\./.test(String((t && t.vssId) || ""))) v += 1;
      return v;
    };
    return tracks
      .map((t, i) => ({ t, i, s: score(t, i) }))
      // Stable: equal scores keep YouTube's own order, which is not arbitrary.
      .sort((a, b) => (b.s - a.s) || (a.i - b.i))
      .map(e => e.t)
      .filter(t => t && t.baseUrl);
  }

  // The URL shapes worth trying for one track, best first. None of these can supply the missing token —
  // that is what A and B are for — but they cost nothing and still work on some videos.
  function urlVariants(baseUrl) {
    const out = [];
    const build = (mutate) => {
      try {
        const u = new URL(baseUrl, location.origin);
        // Never ask YouTube to translate: a translation is a second-hand copy of the words.
        u.searchParams.delete("tlang");
        // An absent client parameter is one of the documented ways the response comes back empty, so it is
        // defaulted rather than left off.
        if (!u.searchParams.get("c")) u.searchParams.set("c", "WEB");
        mutate(u);
        return u.toString();
      } catch (e) { return ""; }
    };
    out.push(build(u => u.searchParams.set("fmt", "json3")));
    out.push(build(() => {}));                                  // exactly as given
    out.push(build(u => u.searchParams.set("fmt", "srv3")));
    return out.filter((u, i) => u && out.indexOf(u) === i);
  }

  function textFromJson3(body) {
    const events = (body && Array.isArray(body.events)) ? body.events : null;
    if (!events) return "";
    const parts = [];
    events.forEach(ev => {
      const segs = ev && Array.isArray(ev.segs) ? ev.segs : null;
      if (!segs) return;
      segs.forEach(s => { if (s && typeof s.utf8 === "string") parts.push(s.utf8); });
    });
    return parts.join(" ");
  }
  function textFromXml(xml) {
    return String(xml || "")
      .replace(/<[^>]+>/g, " ")
      .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
      .replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&nbsp;/g, " ");
  }
  function textFromBody(raw) {
    if (!raw) return "";
    try { return textFromJson3(JSON.parse(raw)); } catch (e) { return textFromXml(raw); }
  }

  // Collapses a word stuttered three or more times in a row — what rolling auto-captions produce.
  //
  // Deliberately conservative. Longer phrase-level repeats need n-gram matching to strip reliably, and an
  // over-eager version would delete real repetition ("very very important") and corrupt the evidence. A
  // stutter of three is safe: nobody writes that on purpose.
  function dedupe(text) {
    const words = String(text || "").split(/\s+/);
    const out = [];
    for (let i = 0; i < words.length; i++) {
      const w = words[i];
      if (!w) continue;
      const n = out.length;
      if (n >= 2 && w === out[n - 1] && w === out[n - 2]) continue;
      out.push(w);
    }
    return out.join(" ");
  }
  // Fits a transcript into the budget by sampling ACROSS it rather than truncating the front. The first
  // few minutes of a lecture are greetings and a channel plug — the least informative part of the
  // recording, and exactly what a head slice keeps.
  function condense(text, budget) {
    const clean = String(text || "").replace(/\s+/g, " ").trim();
    if (clean.length <= budget) return clean;
    const third = Math.floor(budget / 3);
    const mid = Math.floor(clean.length / 2 - third / 2);
    return clean.slice(0, third) + " […] " + clean.slice(mid, mid + third) + " […] " + clean.slice(clean.length - third);
  }

  function finish(text, lang, detail) {
    // Whitespace collapsed — a transcript arrives as thousands of cues and the breaks between them carry
    // no meaning — and nothing else touched while it fits. dedupe and condense only earn their place over
    // the cap: under it there is nothing to buy by editing the evidence.
    const clean = String(text || "").replace(/\s+/g, " ").trim();
    let out = clean;
    if (out.length > TRANSCRIPT_CHARS) out = dedupe(out);
    if (out.length > TRANSCRIPT_CHARS) out = condense(out, TRANSCRIPT_CHARS);
    if (!out) return null;
    // The size is part of the diagnosis: a ten-minute video whose transcript arrives as 40,000 characters
    // is telling you the track is full of rolling repeats, which is a different problem from a slow network.
    const size = out.length === clean.length ? (out.length + " chars")
                                             : (out.length + "/" + clean.length + " chars");
    return { state: "ok", text: out, lang: String(lang || ""), detail: String(detail || "") + " " + size };
  }

  async function fetchCaption(url, hardDeadline) {
    const budget = Math.min(FETCH_TIMEOUT_MS, msLeft(hardDeadline));
    // Reported rather than folded into "failed": "we ran out of time" and "YouTube would not give us the
    // text" are different facts, and only one of them is a statement about the video.
    if (budget <= 0) return { text: "", why: "no-time" };
    const ctl = (typeof AbortController !== "undefined") ? new AbortController() : null;
    const timer = ctl ? setTimeout(() => { try { ctl.abort(); } catch (e) {} }, budget) : null;
    try {
      // `include`, and this is the point of being in the page world: the request goes out as the page,
      // with its session, which is what an anonymous fetch from the worker could never do.
      const res = await fetch(url, { credentials: "include", signal: ctl ? ctl.signal : undefined });
      if (!res.ok) return { text: "", why: "http-" + res.status };
      const raw = await res.text();
      if (!raw) return { text: "", why: "empty-body" };
      return { text: raw, why: "" };
    } catch (err) {
      return { text: "", why: (err && err.name === "AbortError") ? "aborted" : "network" };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  // ---- making the player fetch its own captions ----------------------------
  //
  // Path A can only observe a request the player actually makes — and the caller holds the video PAUSED at
  // 0:00 while it waits for this answer, with captions switched off for most people. A player in that state
  // never asks for a caption track, so there was nothing to observe, every video fell through to path C, and
  // path C cannot work because it has no token. The observe path was right and it was being starved.
  //
  // So the player is asked. This uses its own option API — the same getOption / setOption / loadModule that
  // the IFrame Player API documents and that the on-page player object exposes — and selecting a track is
  // exactly what clicking the CC button does. The player then fetches it, with its token, and path A sees it.
  //
  // Everything here is guarded and REVERSIBLE. If any of it is missing or throws, nothing happens and the
  // older paths still run; and whatever the captions were set to is put back afterwards, so a check never
  // leaves subtitles burned onto somebody's video.
  let capRestore = null;
  function nudgeCaptions() {
    try {
      const p = document.getElementById("movie_player");
      if (!p || typeof p.getOption !== "function" || typeof p.setOption !== "function") return false;
      try { if (typeof p.loadModule === "function") p.loadModule("captions"); } catch (e) {}
      let list = null;
      try { list = p.getOption("captions", "tracklist"); } catch (e) { return false; }
      if (!Array.isArray(list) || !list.length) return false;
      let had = null;
      try { had = p.getOption("captions", "track"); } catch (e) {}
      // A track is already showing, so the player has already fetched it and there is nothing to nudge —
      // and turning it off and on again would be visible for no reason.
      if (had && had.languageCode) return false;
      capRestore = had || {};
      p.setOption("captions", "track", list[0]);
      return true;
    } catch (e) { return false; }
  }
  function unnudgeCaptions() {
    if (capRestore === null) return;
    const want = capRestore;
    capRestore = null;
    try {
      const p = document.getElementById("movie_player");
      if (p && typeof p.setOption === "function") p.setOption("captions", "track", want);
    } catch (e) {}
  }

  // → { state, text, lang, detail }
  //   "ok"          got the words
  //   "none"        this video genuinely has no caption track
  //   "unreadable"  it has tracks, they were fetched, and no text came back
  //   "unknown"     nothing was learned — a timing miss, worth asking again
  //
  // The last two are kept apart because only one of them is a fact about the video. Reporting "unknown" as
  // "unavailable" would be a claim about the video when it was really a claim about us.
  //
  // A wrapper, so the captions are put back on EVERY path out — including the throwing ones. The inner
  // function has eight returns and remembering to undo the nudge at each of them is seven chances to leave
  // somebody's subtitles switched on.
  async function readTranscript(wantedId) {
    try {
      return await readTranscriptInner(wantedId);
    } finally {
      unnudgeCaptions();
    }
  }
  async function readTranscriptInner(wantedId) {
    const startedAt = Date.now();
    const hardDeadline = startedAt + BRIDGE_TOTAL_MS;
    const notes = [];
    const stamp = (extra) => notes.concat(extra || []).concat("t=" + (Date.now() - startedAt) + "ms").join(" ");

    // ---- A: the player already fetched them, and we were watching ----
    //
    // WAITED FOR, not merely checked. The player's own caption request is often a beat behind the moment
    // this is asked, and losing that race sends us to path C — which cannot work, because it has no token.
    // So the whole retry ladder would be spent failing on a video whose captions the player was about to
    // fetch anyway.
    let hit = wantedId ? seen.get(wantedId) : null;
    if (!hit || !hit.body) {
      // Ask the player to load a track, so there is a request to observe at all. See nudgeCaptions: without
      // this, a video held paused with captions off never produces one and this wait is spent for nothing.
      if (nudgeCaptions()) notes.push("A:nudged");
      const until = Math.min(startedAt + OBSERVE_WAIT_MS, hardDeadline);
      while (Date.now() < until) {
        await sleep(OBSERVE_POLL_MS);
        hit = wantedId ? seen.get(wantedId) : null;
        if (hit && hit.body) break;
      }
      if (hit && hit.body) notes.push("A:waited-" + (Date.now() - startedAt) + "ms");
    }
    if (hit && hit.body) {
      const done = finish(textFromBody(hit.body), langFromUrl(hit.url), stamp("A:observed"));
      if (done) return done;
      notes.push("A:parsed-empty");
    } else if (hit) {
      notes.push("A:url-only");
    } else {
      notes.push("A:nothing-seen");
    }

    // ---- B: replay the URL the player used, token and all ----
    if (hit && hit.url) {
      const got = await fetchCaption(hit.url, hardDeadline);
      if (got.text) {
        const done = finish(textFromBody(got.text), langFromUrl(hit.url), stamp("B:replayed"));
        if (done) return done;
        notes.push("B:parsed-empty");
      } else {
        notes.push("B:" + got.why);
      }
    }

    // ---- C: build a URL ourselves. No token, so this often fails. ----
    const found = await awaitPlayerResponse(wantedId, hardDeadline);
    if (found.timeout) return { state: "unknown", text: "", lang: "", detail: stamp("C:no-player") };
    const ordered = rankTracks(found.tracks, found.response);
    if (!ordered.length) return { state: "none", text: "", lang: "", detail: stamp("C:no-tracks") };

    // `fetched` counts attempts that actually reached the network. A loop that only ran out of time has
    // learned nothing, and must not report "unavailable".
    let fetched = 0;
    for (let i = 0; i < ordered.length && msLeft(hardDeadline) > 0; i++) {
      const variants = urlVariants(ordered[i].baseUrl);
      for (let v = 0; v < variants.length && msLeft(hardDeadline) > 0; v++) {
        const got = await fetchCaption(variants[v], hardDeadline);
        if (got.why === "no-time") break;
        fetched++;
        if (!got.text) { notes.push("C" + i + "." + v + ":" + got.why); continue; }
        const done = finish(textFromBody(got.text), ordered[i].languageCode, stamp("C:t" + i + "v" + v));
        if (done) return done;
        notes.push("C" + i + "." + v + ":parsed-empty");
      }
    }
    if (!fetched) return { state: "unknown", text: "", lang: "", detail: stamp() };
    return { state: "unreadable", text: "", lang: "", detail: stamp() };
  }

  // ---- the one question this bridge answers --------------------------------
  window.addEventListener("message", (event) => {
    // Same-window messages only, and only our own shape. Anything else on the page is none of this
    // script's business.
    if (event.source !== window) return;
    const d = event.data;
    if (!d || d.channel !== CHANNEL || d.direction !== "ask") return;
    const reply = (payload) => {
      try {
        window.postMessage(Object.assign({ channel: CHANNEL, direction: "answer", id: d.id }, payload),
                           location.origin);
      } catch (e) {}
    };
    // "What is playing right now?" — the miniplayer question. A synchronous read of the live player,
    // answered at once rather than through the transcript ladder below.
    if (d.action === "info") { reply({ info: liveInfo() }); return; }
    if (d.action !== "transcript") return;
    readTranscript(String(d.videoId || "")).then(
      r => reply({ state: r.state, text: r.text, lang: r.lang || "", detail: r.detail || "" }),
      () => reply({ state: "unreadable", text: "", lang: "", detail: "threw" })
    );
  }, false);
})();
