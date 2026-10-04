// FocusGate face camera page (runs inside an extension-owned iframe).
// Uses pico.js — a tiny pure-JavaScript face detector (no WebGL, no WASM, no
// TensorFlow) so it works on any device, including ones without GPU/WebGL.
// Reports face presence to the parent (content script) via postMessage.
//
// The detection core here is the same one AnkiGate uses, line for line where it can
// be: the same sensitivity ladder, the same tilted-head pass, the same head-down
// rung, the same sliding-deadline movement / eye / blink checks, and the same
// numbers in every table. Two extensions asking the same question of the same
// webcam should not answer it differently, and every constant below has a reason
// written beside it that was paid for in a bug.
(function () {
  const v = document.getElementById("v");
  const statusEl = document.getElementById("status");
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d", { willReadFrequently: true });

  let ready = false;
  let detecting = false;
  let classify = null;
  let updateMemory = null;
  // No `faceNow` here, unlike the Anki version, and the difference is deliberate: there the
  // page itself has to answer "is a face present right now" for its own clock, so it keeps the
  // last verdict and pairs it with a staleness check. Here the verdict is posted out of this
  // frame the instant it is reached and the content script keeps the state, so a copy in here
  // would be a second answer to the same question with nothing keeping the two in step.

  // How hard to look for a face: 1 = strict, 5 = forgiving. It moves pico's
  // accumulated-quality bar: a lower bar keeps hold of you in dim light or at a
  // slight angle, which is what "the timer stopped while I was sitting here"
  // usually turns out to be.
  const QUAL_BY_SENS = { 1: 72, 2: 60, 3: 50, 4: 38, 5: 26 };
  let sensitivity = 3;
  function qualBar() { return QUAL_BY_SENS[sensitivity] || QUAL_BY_SENS[3]; }

  // How many frames of detections pico's memory folds together. The bar above is calibrated
  // against this sum — cluster_detections adds the scores of every overlapping window it merges
  // — so this number cannot be changed on its own without making every sensitivity setting mean
  // something different.
  //
  // It lives up here, beside the bar rather than beside the detection loop that uses it, because
  // it is half of a calibration pair and the two kept being read separately. Two constants
  // further down are shares of it: RAW_SEEN_SHARE and TILT_BAR_SHARE.
  const MEM_FRAMES = 5;

  // What counts as "you are still here" when the cascade can't find a face — and it often
  // can't, for reasons that have nothing to do with you leaving. pico was trained on
  // upright, forward-facing faces. Lean towards a shoulder and the score collapses while
  // you still look perfectly normal to a person. Bend over a notebook and there is no face
  // in the picture at all, only a scalp. Both used to stop the clock.
  //
  // So the dial is a ladder of evidence, each rung accepting one weaker kind:
  //
  //   1 strict  upright and facing the camera. Nothing else.
  //   2 firm    a tilted head counts.
  //   3 normal  and a head down over the desk, as long as the picture keeps changing.
  //   4 kind    and simply being in the chair, however you're sitting, even dead still.
  //   5 easy    the same, with far more patience before it decides the room is empty.
  //
  //   rolls  — extra angles to re-check the frame at, in degrees, tried both ways.
  //            Empty means the upright pass is the whole story. Each roll is tried both
  //            ways, so a list ending at 75 reaches a head laid right over on a shoulder
  //            once the cascade's own tolerance of roughly 15 either side is counted.
  //   down   — with no face findable at any angle, how long the picture may go unchanged
  //            before we accept you have gone. This is the head-down rung: writing at the
  //            desk keeps the frame moving, an empty chair does not. 0 turns it off.
  //   anchor — the ceiling on ALL of the faceless rungs, measured from the last face actually
  //            seen at any angle. It is the longest the clock will run on a guess before it
  //            wants to see you again, and one glance at the screen resets it. Never 0:
  //            an unbounded rung is how an empty chair gets credited with an evening of work.
  //   body   — for the rung that needs no movement at all: how long a completely
  //            frozen picture is tolerated when we can't tell whether the chair is full.
  //            When the empty-room reference IS available it decides instead, and this
  //            number stops mattering. 0 turns the rung off.
  const LOOSE_BY_SENS = {
    1: { rolls: [],                    down: 0,      anchor: 0,      body: 0      },  // strict
    2: { rolls: [15, 30],              down: 0,      anchor: 0,      body: 0      },  // firm
    3: { rolls: [15, 30, 45],          down: 20000,  anchor: 60000,  body: 0      },  // normal
    4: { rolls: [15, 30, 45, 60, 75],  down: 60000,  anchor: 150000, body: 120000 },  // kind
    5: { rolls: [15, 30, 45, 60, 75],  down: 300000, anchor: 420000, body: 900000 }   // easy
  };
  function looseCfg() { return LOOSE_BY_SENS[sensitivity] || LOOSE_BY_SENS[3]; }

  // Strict eye check: not just a face in frame, but eyes open and on the screen.
  // One slider moves these numbers: how open an eye must read, and how far a pupil may
  // drift before it counts as looking away.
  // wide/flat describe the shape that means "eyelid shut": the dark thing in the
  // socket stretches right across it but is only a thin line. A pupil is a compact
  // blob instead. Stricter settings call a shut eye shut sooner.
  //
  // Each row used to carry a `grace` as well — how long a glance away was forgiven. That is a
  // setting of its own now (eyeAwaySec), on the same sliding deadline as the movement and blink
  // checks, so the dial no longer decides it and the numbers are gone rather than left lying
  // here implying they still mean something.
  const EYE_BY_SENS = {
    1: { open: 0.42, off: 0.42, wide: 0.55, flat: 0.55 },  // strict
    2: { open: 0.38, off: 0.52, wide: 0.62, flat: 0.50 },
    3: { open: 0.34, off: 0.62, wide: 0.70, flat: 0.45 },  // normal
    4: { open: 0.29, off: 0.72, wide: 0.78, flat: 0.38 },
    5: { open: 0.24, off: 0.82, wide: 0.88, flat: 0.30 }   // easy
  };
  let eyeRequired = false, eyeSens = 3;
  function eyeCfg() { return EYE_BY_SENS[eyeSens] || EYE_BY_SENS[3]; }

  // ---------------- the sliding-deadline checks ----------------
  // Three of them — head movement, eyes on the screen, and blinking — and they all work the
  // same way, so they share one small machine rather than each growing its own rule.
  //
  // Do the thing at any point and you have the whole interval again. Go the entire interval
  // without doing it and the clock waits until you do. Nothing is ever asked of you on a
  // schedule: these only ever notice an absence.
  //
  //   interval 10s, blink at 4s  → next deadline 14s
  //   blink again at 12s         → next deadline 22s
  //   nothing by 22s             → clock waits, and resumes the moment you blink
  function makeWatch(seconds) {
    return { on: false, intervalMs: Math.max(0, seconds) * 1000, lastAt: Date.now(), idleSince: 0 };
  }
  // The thing happened: deadline slides forward from here.
  function watchBeat(w, now) { w.lastAt = now; w.idleSince = 0; }
  // A full interval with nothing. The stamp is taken once, so anything that eases off with
  // waiting measures from when the waiting began rather than from every frame of it.
  function watchOverdue(w, now) {
    if (now - w.lastAt <= w.intervalMs) return false;
    if (!w.idleSince) w.idleSince = now;
    return true;
  }
  function watchSeconds(w, seconds) {
    w.intervalMs = Math.max(0, Number(seconds) || 0) * 1000;
  }
  // Switched on, or the face came back after being lost: a full interval in hand, never a
  // debt inherited from before.
  function watchFresh(w) { w.lastAt = Date.now(); w.idleSince = 0; }

  const eyeWatch = makeWatch(10);
  const blinkWatch = makeWatch(10);

  // ---------------- the head-movement check ----------------
  // It used to work in rounds: wait N seconds, then demand a lean left AND a lean right, and
  // park the clock until it got both. That was the worst thing in either extension to be on
  // the receiving end of. It said "lean head ← then →", you leaned, nothing happened, and the
  // clock stayed parked. Two reasons it couldn't be satisfied — turning your head far enough
  // to move your face across the frame usually stops it being detected as a face at all, so
  // the act of obeying broke the measurement; and needing both directions meant one missed
  // frame at either extreme started you over.
  //
  // Now the deadline simply slides forward every time you move, like the other two checks.
  // Move at any point and you have another N seconds; go the full N seconds without moving
  // and the clock waits until you do. A photograph never moves, so it hits the deadline once
  // and stays there, which is the whole point.
  //
  // Watcher-shaped on purpose — intervalMs / lastAt / idleSince — so it runs on the same
  // makeWatch helpers as the eye and blink checks instead of keeping its own copy of the
  // rule. The extra fields are only the movement measurement itself.
  let liveness = { enabled: false, intervalMs: 10000, lastAt: Date.now(), seeded: false,
                   needFrac: 0.042, idleSince: 0, moved: 0, lastNoteAt: 0,
                   minCol: 0, maxCol: 0, minRow: 0, maxRow: 0, minSize: 0, maxSize: 0,
                   lastCol: 0, lastRow: 0, lastSize: 0 };
  // How much movement counts as movement, by the sensitivity dial. 1 wants a real shift in
  // your seat, 5 takes almost anything.
  const MOVE_BY_SENS = { 1: 0.075, 2: 0.056, 3: 0.042, 4: 0.030, 5: 0.020 };
  function moveFracFor(sens) {
    const n = Math.max(1, Math.min(5, parseInt(sens, 10) || 3));
    return MOVE_BY_SENS[n];
  }
  // However much the bar eases, it stops here — about five pixels on a 320-wide frame.
  //
  // Easing without a floor is how a photograph got through: slide the dial to its most
  // forgiving, wait twenty seconds, and the bar came down to roughly two pixels, which the
  // detector's own wobble covers on its own. Nothing below this floor can distinguish a person
  // from a still image, so there is no honest reason to go there.
  const MOVE_NEED_FLOOR = 0.016;
  function moveNeeded() {
    // Easier the longer you have been waiting, so a badly aimed camera or an unusually
    // still sitter can always get out of it. The dial sets the starting point; this only
    // ever lowers it, and never past the floor above.
    const waiting = liveness.idleSince ? Date.now() - liveness.idleSince : 0;
    const ease = waiting > 20000 ? 0.45 : waiting > 8000 ? 0.7 : 1;
    return Math.max(MOVE_NEED_FLOOR, liveness.needFrac * ease);
  }
  // Anything smaller than this, frame to frame, is the detector's own wobble rather than
  // you. Pico reports a box on a coarse grid — its search step is a tenth of the window
  // size it's testing — so a genuinely still face gives the same numbers over and over and
  // scores zero here, while a person who is merely sitting quietly crosses grid steps all
  // the time. That difference is the whole basis of the check.
  const MOVE_JITTER = 0.004;
  // Travelled distance fades, halving every second and a half.
  //
  // Without this it was a total that only ever grew, and given long enough ANY trickle
  // reaches the bar: a photograph sitting perfectly still still produces the odd frame where
  // the detector's box lands a pixel out, and over two minutes those crumbs added up to a
  // pass. Fading answers the question that actually matters — "have you moved recently" —
  // instead of "have you ever moved".
  const MOVE_HALF_LIFE = 1.5;
  // Start measuring afresh from where the face is now.
  function seedMovement(col, row, size) {
    liveness.seeded = true;
    liveness.minCol = liveness.maxCol = liveness.lastCol = col;
    liveness.minRow = liveness.maxRow = liveness.lastRow = row;
    liveness.minSize = liveness.maxSize = liveness.lastSize = size;
    liveness.moved = 0;
    liveness.lastNoteAt = 0;
  }
  function noteMovement(col, row, size, w, h, now) {
    liveness.minCol = Math.min(liveness.minCol, col);
    liveness.maxCol = Math.max(liveness.maxCol, col);
    liveness.minRow = Math.min(liveness.minRow, row);
    liveness.maxRow = Math.max(liveness.maxRow, row);
    liveness.minSize = Math.min(liveness.minSize, size);
    liveness.maxSize = Math.max(liveness.maxSize, size);
    // How far the face has travelled in total, added up frame by frame.
    //
    // This is the part that was missing, and it is why the clock kept stopping on someone
    // who was plainly there. The only test was how far the face had got from where it
    // started — so reading a page, where your head drifts a few pixels one way and back
    // again, never reached the bar no matter how long you did it for. Distance from a
    // starting point stays near zero; distance TRAVELLED does not.
    const dt = liveness.lastNoteAt ? Math.max(0, (now - liveness.lastNoteAt) / 1000) : 0;
    liveness.lastNoteAt = now;
    if (dt > 0) liveness.moved *= Math.pow(0.5, dt / MOVE_HALF_LIFE);
    const dx = (col - liveness.lastCol) / Math.max(1, w);
    const dy = (row - liveness.lastRow) / Math.max(1, h);
    const dz = (size - liveness.lastSize) / Math.max(1, liveness.lastSize);
    const step = Math.hypot(dx, dy) + Math.abs(dz) / 2.5;
    if (step > MOVE_JITTER) liveness.moved += step;
    liveness.lastCol = col;
    liveness.lastRow = row;
    liveness.lastSize = size;
  }
  // Travelled distance is only believed if the face has also actually gone somewhere — this
  // much of the dial's own setting, before any easing.
  //
  // Sensor noise on a photograph racks up travel without ever leaving the spot: the box
  // jitters a fraction of a pixel each way and the total creeps up, and because the bar eases
  // down the longer you wait, given a minute or two the two met in the middle and a
  // photograph passed. Noise cancels out over distance; a person who has been moving has
  // both a total AND somewhere they got to.
  //
  // There is also a floor under it that the dial cannot lower. At the forgiving end the
  // proportional gate shrinks to about two pixels, which is inside the noise — so sliding the
  // dial right handed a photograph a pass. This floor is roughly six pixels on a 320-wide
  // frame: nothing for a person, out of reach for a still image.
  const MOVE_RANGE_SHARE = 0.35;
  const MOVE_RANGE_FLOOR = 0.018;
  // The biggest movement seen since measuring began — sideways, up and down, or towards and
  // away from the camera, whichever is largest.
  //
  // Ranges rather than distance from a starting point, because the starting point can itself
  // be caught mid-movement: leaning back to a rest position then counted as no movement at
  // all. Sideways and vertical are combined as a diagonal rather than taken one at a time: a
  // slouch that moves you ten pixels across and ten down is plainly movement, and judging the
  // axes separately rejected it for being short on both. Size is divided down because moving
  // closer or further changes it proportionally much faster than a shift across the frame —
  // without that, breathing would pass the check.
  function movedBy(w, h) {
    const dx = (liveness.maxCol - liveness.minCol) / Math.max(1, w);
    const dy = (liveness.maxRow - liveness.minRow) / Math.max(1, h);
    const dz = (liveness.maxSize - liveness.minSize) / Math.max(1, liveness.minSize);
    const range = Math.max(Math.hypot(dx, dy), dz / 2.5);
    const gate = Math.max(MOVE_RANGE_FLOOR, liveness.needFrac * MOVE_RANGE_SHARE);
    const travelled = range >= gate ? liveness.moved : 0;
    // Whichever says most: one clear shift of position or distance from the camera, or a lot
    // of small movement added up while genuinely wandering. Either is a person.
    return Math.max(range, travelled);
  }

  // ---------------- blinks ----------------
  // A blink is eyes closing and opening again. Closing alone is not enough — that is also what
  // falling asleep looks like, and a photograph of someone mid-blink would pass for ever — so
  // it only counts once they open again, and only if the closure was short enough to have been
  // a blink rather than a rest.
  //
  // This is the strongest liveness signal the camera has. A photo cannot blink at all, a video
  // loop blinks on a schedule, and head movement can be faked by nudging a photo; nothing
  // short of a real face does this on demand.
  //
  // Its own dial, and its own idea of "closed". It first borrowed the eye check's threshold and
  // missed most blinks. Two reasons. That threshold answers "are you attentively looking at the
  // screen", which a half-closed eyelid mid-blink can still satisfy — and it is an absolute
  // number, when pupil contrast depends entirely on your face, your glasses and the lamp behind
  // you. The value that catches a blink on one setup never fires on another.
  //
  // So closure is measured as a DIP from your own open-eye reading, learned as you sit there.
  // `dip` is how much of a drop counts: 1 wants an unmistakable blink, 5 takes a flicker.
  // The window widens with it too, because a slower sampling rate sees a blink as one long
  // frame rather than several short ones.
  const BLINK_BY_SENS = {
    1: { dip: 0.55, minMs: 60, maxMs: 500 },   // clear
    2: { dip: 0.45, minMs: 50, maxMs: 600 },
    3: { dip: 0.35, minMs: 40, maxMs: 700 },   // normal
    4: { dip: 0.27, minMs: 20, maxMs: 900 },
    5: { dip: 0.20, minMs: 0, maxMs: 1200 }    // faint
  };
  let blinkRequired = false, blinkSens = 3, eyeWasOpen = true, eyeClosedAt = 0;
  // What your eyes look like open, in this light. Learned rather than assumed.
  let blinkBase = 0;
  function blinkCfg() { return BLINK_BY_SENS[blinkSens] || BLINK_BY_SENS[3]; }
  function noteBlink(read, now) {
    const cfg = blinkCfg();
    const score = Math.max(0, read.score || 0);
    // No usable reading — the eye patches fell outside the frame, or the face is too small to
    // find them in. analyseEyes reports that as a score of 0, which is indistinguishable from
    // pitch black, so it must not be read as a closure: a run of unreadable frames followed by
    // a good one would otherwise look exactly like a blink and hand out a free pass.
    if (score <= 0) return;
    if (blinkBase <= 0) blinkBase = score;
    // Shape as well as contrast: two flat lash lines are a closed pair of eyes whatever the
    // numbers say.
    const closed = read.lidShut === true || score <= blinkBase * (1 - cfg.dip);

    // eyeClosedAt doubles as "a blink might be happening": set while a closure could still
    // turn out to be one, cleared the moment it can't.
    if (closed) {
      if (eyeWasOpen) {
        eyeClosedAt = now;
      } else if (eyeClosedAt && now - eyeClosedAt > cfg.maxMs) {
        // Shut for longer than a blink lasts, so it isn't one. Two things look like this: eyes
        // resting, and the light changing — someone turns a lamp off and every reading drops
        // below a baseline learned in a brighter room. Give up on it as a blink either way, and
        // let the baseline learn its way to whatever this is now, because otherwise the reading
        // stays "closed" for ever and the check stalls with no way back.
        eyeClosedAt = 0;
      }
    } else {
      // A blink is closing AND opening again, soon enough to have been a blink. Eyes closed and
      // left closed is what falling asleep looks like, and a photograph caught mid-blink would
      // otherwise pass for ever.
      if (!eyeWasOpen && eyeClosedAt) {
        const shut = now - eyeClosedAt;
        if (shut >= cfg.minMs && shut <= cfg.maxMs) watchBeat(blinkWatch, now);
      }
      eyeClosedAt = 0;
    }
    // Teach the baseline slowly, and never from a frame that might be part of a blink —
    // otherwise a blink drags the baseline down to meet itself and the next one has nothing to
    // dip below. Frames whose closure has been given up on above do teach it, which is what
    // lets a darkened room be relearned.
    if (!eyeClosedAt) blinkBase = blinkBase * 0.97 + score * 0.03;
    eyeWasOpen = !closed;
  }

  // ---------------- eyes on the screen ----------------
  // Given the grayscale frame and the detected face box, work out whether the eyes
  // are open and pointed at the screen. An open eye looking forward puts a dark
  // pupil near the middle of its socket, so each eye patch is measured for how
  // much darker its darkest spot is than the patch average (eyelids flatten that
  // out) and where that spot sits across the patch (a glance aside pushes it to an
  // edge). A heuristic on a 320x240 webcam frame, not medical gaze tracking — it
  // catches "eyes shut" and "looking away from the screen", which is the point.
  function analyseEyes(gray, w, h, faceRow, faceCol, faceSize) {
    const out = { ok: false, open: false, centred: false, score: 0, lidShut: false, eyes: [] };
    if (!gray || !w || !h || !faceSize) return out;
    // Eye band: a bit above the middle of the face, one patch either side.
    const eyeY = faceRow - faceSize * 0.14;
    const dx = faceSize * 0.23;              // distance from centre to each eye
    const pw = Math.round(faceSize * 0.26);  // patch width
    const ph = Math.round(faceSize * 0.16);  // patch height
    if (pw < 6 || ph < 4) return out;
    const patch = (cx) => {
      const x0 = Math.max(0, Math.round(cx - pw / 2));
      const x1 = Math.min(w - 1, x0 + pw - 1);
      const yTop = Math.max(0, Math.round(eyeY - ph / 2));
      const y1 = Math.min(h - 1, yTop + ph - 1);
      // Skip the top slice of the patch: it is mostly eyebrow. A dark brow was
      // being taken for a pupil, which is why closed eyes still read as open.
      const y0 = Math.min(y1 - 1, yTop + Math.floor((y1 - yTop + 1) * 0.28));
      if (x1 <= x0 || y1 <= y0) return null;
      let sum = 0, n = 0, min = 255;
      for (let y = y0; y <= y1; y++) {
        for (let x = x0; x <= x1; x++) {
          const val = gray[y * w + x];
          sum += val; n++;
          if (val < min) min = val;
        }
      }
      if (!n) return null;
      const mean = sum / n;
      // Everything close to the darkest reading is "the dark thing in this socket".
      // Its SHAPE is what tells the two cases apart: a pupil is a compact blob, a
      // closed lid is a lash line stretching right across the socket. Judging by a
      // single darkest pixel could never tell them apart, because a lash or a brow
      // is just as dark as a pupil.
      const cut = mean - 0.45 * (mean - min);
      let dn = 0, sx = 0, sy = 0, xa = x1, xb = x0, ya = y1, yb = y0;
      for (let y = y0; y <= y1; y++) {
        for (let x = x0; x <= x1; x++) {
          if (gray[y * w + x] <= cut) {
            dn++; sx += x; sy += y;
            if (x < xa) xa = x;
            if (x > xb) xb = x;
            if (y < ya) ya = y;
            if (y > yb) yb = y;
          }
        }
      }
      const spanX = Math.max(1, x1 - x0), spanY = Math.max(1, y1 - y0);
      const cxp = dn ? sx / dn : (x0 + x1) / 2;
      const cyp = dn ? sy / dn : (y0 + y1) / 2;
      return {
        // How pronounced the dark thing is, 0..1. Open eye ≈ 0.4+, flat lid ≈ 0.15.
        contrast: mean > 0 ? (mean - min) / mean : 0,
        // How far the dark thing stretches, as a share of the socket.
        spreadX: dn ? (xb - xa) / spanX : 0,
        spreadY: dn ? (yb - ya) / spanY : 0,
        // Centre of the dark mass — steadier than one darkest pixel, so the marker
        // stops twitching and the left/right reading is more honest.
        offset: ((cxp - x0) / spanX) * 2 - 1,
        // Where to draw: the socket we looked in, and the pupil we found in it.
        box: { x0, y0, x1, y1 }, px: cxp, py: cyp
      };
    };
    const L = patch(faceCol - dx), R = patch(faceCol + dx);
    if (!L || !R) return out;
    const cfg = eyeCfg();       // every number comes from the sensitivity slider
    const lidShut = e => e.spreadX >= cfg.wide && e.spreadY <= cfg.flat;
    const isOpen = e => e.contrast >= cfg.open && !lidShut(e);
    const isCentred = e => Math.abs(e.offset) <= cfg.off;
    out.open = isOpen(L) && isOpen(R);
    out.centred = isCentred(L) && isCentred(R);
    out.score = Math.min(L.contrast, R.contrast);
    // Both lids reading as a lash line rather than a pupil. Handed out for the blink check,
    // which needs the shape evidence as well as the contrast: `&&` because one eye in shadow
    // must not read as a blink, and a blink closes both.
    out.lidShut = lidShut(L) && lidShut(R);
    out.ok = out.open && out.centred;
    // Per eye, so a marker can be green on the eye that passes and red on the one
    // that doesn't, instead of one verdict for both.
    out.eyes = [L, R].map(e => ({
      box: e.box, px: e.px, py: e.py,
      open: isOpen(e), centred: isCentred(e)
    }));
    return out;
  }

  // ---------------- the focus box ----------------
  // Everything above this line answers "does this second count". This answers "how fast", and
  // it is the only thing in FocusGate that does: put your head inside the dashed box on the
  // preview and the clock speeds up, sit back out of it and it slows down.
  //
  // Same geometry, same constants, as the Anki extension's version of this feature. Two
  // extensions asking the same question of the same webcam should not answer it differently.
  //
  // There is no distance estimate anywhere here, in metres or otherwise. Proximity is the
  // detector's own face box divided by the focus box: a head across the room is a small square,
  // a head leaning in is a big one. That number is already computed for every frame by the
  // cascade, so the whole feature costs nothing on top of the detection that was happening
  // anyway. An earlier version measured pupil separation instead and was dropped for exactly
  // that reason — it needed analyseEyes on every frame whether or not the eye check was on.
  const FOCUS_MIN = 0.3, FOCUS_MAX = 0.85;
  let focusSize = 0.55;                       // = paceBoxPct / 100
  // The percentage from storage becomes a fraction here, clamped in ONE place. The bounds match
  // the settings validator's, deliberately: two limits on the same number drift, and then the
  // page shows a box size the camera is not using.
  const focusClamp = (v, fb) => {
    const n = Number(v) / 100;
    return Number.isFinite(n) ? Math.max(FOCUS_MIN, Math.min(FOCUS_MAX, n)) : fb;
  };

  // Size and position are asked SEPARATELY, and that is the whole design.
  //
  // The first version of this tested how much of the box the face overlapped, which is a
  // product of the two — so a small face dead centre scored the same as a big face half out of
  // frame, and "I am sitting right back and it still speeds up" was the result. Two independent
  // conditions cannot be traded off against each other like that.
  //
  //   FOCUS_FIT   how much of the box's width the head must span. 0.85 rather than 1.0 because
  //               pico's box hugs the face rather than the head — measured on a 320x240 stream,
  //               a head filling the preview reads about 0.63 of the frame height, which is a
  //               fit of roughly 1.15 at the default box size, and a head at arm's length
  //               reads about 0.38, a fit of roughly 0.69. 0.85 sits between the two.
  //   FOCUS_OFF   how far off centre the head may sit, as a share of the way to the box edge.
  //   FOCUS_SLACK hysteresis, and spent only on STAYING in. Sitting exactly on the boundary
  //               otherwise flips the verdict several times a second.
  const FOCUS_FIT = 0.85;
  const FOCUS_OFF = 0.45;
  const FOCUS_SLACK = 0.12;
  let focusIn = false;
  // What to do about it, in two or three words, drawn on the picture. "" while you are in.
  let focusSay = "";
  // How much of the size the box asks for you actually have, 0..1. Reported out of this frame so
  // the settings page and the card can say "you are at 78% of the way there".
  //
  // "COME CLOSER" alone is not enough when the box has been set too big: at 70% and above, most
  // webcams cannot give a head that fills it, so the hint is asking for something that will never
  // happen and reads as the feature being broken. A number tells you whether you are nearly there
  // or nowhere near, which is the difference between leaning in and turning the box down.
  let focusReach = 0;

  // One definition of where the box is, used by the test AND by the drawing. If the two ever
  // came from separate arithmetic, the box you can see would stop being the box being measured
  // — which is the one thing this feature cannot afford, because the box IS the instruction.
  function focusRect(w, h) {
    // Square, off the SHORTER side, dead centre. A square is right because the thing being
    // measured is a square: pico reports one number for the size of the face it found.
    const side = Math.min(w, h) * focusSize;
    return { x: (w - side) / 2, y: (h - side) / 2, w: side, h: side };
  }
  // How the found face sits against the box: how much of it the head spans, and how far off
  // centre it is. nx / ny are signed and scaled so that 1 means "on the box edge".
  function focusFit(w, h, face) {
    if (!face || !(face.size > 0) || !(w > 0) || !(h > 0)) return null;
    const b = focusRect(w, h);
    if (!(b.w > 0) || !(b.h > 0)) return null;
    const nx = (face.col - (b.x + b.w / 2)) / (b.w / 2);
    const ny = (face.row - (b.y + b.h / 2)) / (b.h / 2);
    return { fit: face.size / b.w, nx, ny, off: Math.max(Math.abs(nx), Math.abs(ny)) };
  }
  // Mirror-aware, and it has to be: the video and the marker canvas both carry scaleX(-1) so
  // the preview reads like a mirror. Moving towards the left of the picture you see is moving
  // to your own right, so a hint that names a direction from the frame's coordinates would send
  // you the wrong way. Size first — being too far away is worth saying before being off centre,
  // since walking closer often fixes both.
  function focusHint(m) {
    if (!m) return "FACE THE CAMERA";
    if (m.fit < FOCUS_FIT) return "COME CLOSER";
    if (Math.abs(m.nx) > Math.abs(m.ny)) return m.nx < 0 ? "MOVE LEFT" : "MOVE RIGHT";
    return m.ny < 0 ? "MOVE DOWN" : "MOVE UP";
  }

  // ---------------- the multiplier ----------------
  // Two speeds and a ramp between them. The hard bounds are the widest the number may ever be,
  // whatever a hand-edited storage value says; the user's own two dials are applied where the
  // number is USED, in the background worker, so moving a slider takes effect on the next
  // second rather than whenever this frame next reports.
  const PACE_HARD_MIN = 0.1, PACE_HARD_MAX = 4;
  let paceOn = false;
  let paceFast = 1.5, paceSlow = 0.5;
  const paceClamp = (v, fb) => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.max(PACE_HARD_MIN, Math.min(PACE_HARD_MAX, n)) : fb;
  };
  let paceNow = 1;
  // How fast the number moves towards whichever speed is wanted. Two anti-flap mechanisms
  // rather than one, and they do different jobs: FOCUS_SLACK stops the in/out DECISION
  // chattering on the boundary, this stops the NUMBER stepping when the decision genuinely
  // changes. At the 25-120ms this loop runs at, a 0.15 pole settles in a few hundred
  // milliseconds — fast enough to feel like a response to leaning in, slow enough that it
  // reads as a slide rather than a jump.
  const PACE_SMOOTH = 0.15;

  function notePace(w, h, face) {
    const m = focusFit(w, h, face);
    // Size only, and capped at 1. Being off centre is a separate thing the hint already names, and
    // folding the two into one score would produce the same "80% of what?" confusion the number is
    // here to end.
    focusReach = m ? Math.min(1, m.fit / FOCUS_FIT) : 0;
    const slack = focusIn ? FOCUS_SLACK : 0;
    focusIn = !!m && m.fit >= (FOCUS_FIT - slack) && m.off <= (FOCUS_OFF + slack);
    focusSay = focusIn ? "" : focusHint(m);
    const want = focusIn ? paceFast : paceSlow;
    const next = paceNow + (want - paceNow) * PACE_SMOOTH;
    // Snapped once it is within a hair of the speed it is heading for. An exponential ramp
    // approaches asymptotically and never actually arrives, so the settled value is
    // 1.4999999999999998 rather than the 1.5 the user set. The badge rounds that away and the
    // difference is invisible — but the worker floors real arithmetic on it, so a multiplier a
    // hair under the one you asked for quietly costs a second every few hours.
    //
    // 1e-4 is reached after about 53 looks, so between three and four seconds of holding still
    // at 25-120ms a look. Long after the ramp has finished being something you can see.
    paceNow = Math.abs(want - next) < 1e-4 ? want : next;
  }
  // Nobody in the picture. Exactly 1, not paceSlow, and not ramped down to it either: with no
  // face there is nothing to be near or far from, and the clock is already stopped by the
  // missing face. A slow speed here would be a claim about a frame that has nobody in it.
  function resetPace() {
    paceNow = 1;
    focusIn = false;
    focusSay = "";
    focusReach = 0;
  }

  // The multiplier, over the corner of the picture. Painted from verdict() and nowhere else, so
  // it can never disagree with the words on the status line beside it — the number and the
  // reason are two halves of one answer, and this frame reaches an answer on every pass.
  const paceTag = document.getElementById("pacetag");
  function paintPaceTag(present) {
    if (!paceTag) return;
    const show = paceOn && !!present;
    paceTag.hidden = !show;
    if (!show) return;
    paceTag.textContent = paceNow.toFixed(1) + "×";
    // A band either side of 1 rather than a bare comparison. The ramp approaches its target
    // asymptotically and never quite arrives, so with paceSlow at 1 the number sits at
    // 0.999… for ever — and a badge that says "1.0×" in amber, meaning slow, while the clock
    // runs at exactly normal speed is worse than no badge.
    paceTag.className = "pacetag " + (paceNow >= 1.02 ? "up" : (paceNow <= 0.98 ? "down" : ""));
  }

  // ---------------- live markers ----------------
  // Draws what the detector is actually looking at: the face box, the two eye
  // sockets, and a dot on each pupil — green while that eye passes, red while it
  // doesn't. Purely a view of state already computed, so it can be switched off
  // without changing any decision.
  //
  // The focus box shares this canvas, but not its switch: markers are a debug view you turn on
  // when you want to know what the detector sees, and the box is an instruction you have to be
  // able to see in order to follow. See overlayLive.
  const ovc = document.getElementById("ov");
  const octx = ovc ? ovc.getContext("2d") : null;
  const ovBtn = document.getElementById("ovtog");
  let overlayOn = true;
  const GREEN = "#22c55e", RED = "#ef4444", AMBER = "#f59e0b";
  // Two independent reasons for the canvas to be on screen, and only one switch. The markers
  // button must not be able to hide the focus box: the box is the instruction for a feature you
  // switched on somewhere else entirely, and a hidden instruction is a feature that looks broken.
  function overlayLive() { return overlayOn || paceOn; }
  function setOverlayUI() {
    if (ovBtn) ovBtn.setAttribute("aria-pressed", overlayOn ? "true" : "false");
    if (!ovc) return;
    ovc.hidden = !overlayLive();
    // Cleared either way. Switching the markers off has to take them off the picture now rather
    // than at the next look, and when the box is the reason the canvas is still up, the next
    // look repaints it a few dozen milliseconds later.
    clearOverlay();
  }
  function clearOverlay() {
    if (octx && ovc) octx.clearRect(0, 0, ovc.width, ovc.height);
  }
  // The box, dashed, in the colour of its own verdict: green while your head is in it, amber
  // while it isn't. Drawn under the markers so a face box and a dot on each pupil stay readable
  // on top of it.
  // How many canvas pixels make one pixel on screen. The canvas is displayed far smaller than its
  // backing store — a 320-wide camera frame inside a 134px preview on the timer card — so a line
  // measured in frame pixels arrives at under half its width.
  //
  // That is why the box needs this and the solid marker boxes do not: a marker is read as "the
  // detector found something here" and a hairline says that perfectly well, while this box is an
  // instruction you have to be able to see from across a desk. At w/200 it came out under one
  // screen pixel on the card, which is the thinnest a line can be drawn and still be claimed to
  // be there.
  function toCanvasPx(w) {
    const ew = (ovc && ovc.clientWidth) || w;
    return (n) => Math.max(1, n * (w / (ew || w)));
  }
  function drawFocusBox(w, h) {
    if (!paceOn || !octx) return;
    const b = focusRect(w, h);
    const px = toCanvasPx(w);
    octx.save();
    // Dashed, so it reads as a target to put something in rather than as another thing the
    // detector has found. The solid boxes on this canvas all mean "here is what I see".
    octx.setLineDash([px(5), px(4)]);
    octx.lineWidth = px(2);
    octx.strokeStyle = focusIn ? GREEN : AMBER;
    // Drawn under its own shadow, so the box is visible against a bright window behind you as
    // well as a dark room. Amber on a white wall is otherwise almost nothing.
    octx.shadowColor = "rgba(2, 6, 23, .9)";
    octx.shadowBlur = px(2);
    octx.strokeRect(b.x, b.y, b.w, b.h);
    octx.restore();
    drawHint(w, h, b, focusSay);
  }
  // "COME CLOSER" and friends, on the picture, just under the box.
  //
  // Two transforms have to be undone to put readable text here. The canvas carries scaleX(-1)
  // for the mirror, so text drawn normally comes out backwards — hence the flip about the
  // centre line. And the canvas is displayed much smaller than its backing store (a 320-wide
  // frame inside a 134px preview), so a font size in canvas pixels arrives on screen at
  // roughly half of it — hence dividing by the display scale to land on a size in real screen
  // pixels instead.
  function drawHint(w, h, b, text) {
    if (!text || !octx || !ovc) return;
    const ew = ovc.clientWidth || w, eh = ovc.clientHeight || h;
    const scale = Math.min(ew / w, eh / h) || 1;
    // A share of the preview's own width, with a floor and a ceiling: too small to read on a
    // narrow card is no use, and the words are short enough that they need no more than this.
    const px = Math.max(9, Math.min(16, ew * 0.075)) / scale;
    // Below the box normally, and above it when below would fall off the bottom of the frame.
    // The floor on the way up is not decoration: at the largest box size there is only a sliver
    // of picture above it, and a baseline of 6 puts the tops of the letters off the canvas —
    // a hint you cannot read is worse than one sitting close to the box.
    const below = b.y + b.h + px * 1.25;
    const y = below + px * 0.2 <= h ? below : Math.max(px, b.y - px * 0.35);
    octx.save();
    octx.translate(w / 2, y);
    octx.scale(-1, 1);
    octx.font = "700 " + px.toFixed(1) + "px ui-sans-serif, system-ui, sans-serif";
    octx.textAlign = "center";
    octx.textBaseline = "alphabetic";
    // Outlined before it is filled, so the words survive whatever is behind them — a dark room
    // and a bright wall both happen, and one colour cannot be legible on both.
    octx.lineWidth = Math.max(2, px * 0.22);
    octx.strokeStyle = "rgba(2, 6, 23, .85)";
    octx.lineJoin = "round";
    octx.strokeText(text, 0, 0);
    octx.fillStyle = AMBER;
    octx.fillText(text, 0, 0);
    octx.restore();
  }
  function drawMarkers(w, h, face, eyes, verdict) {
    if (!octx || !ovc || !overlayLive()) return;
    if (ovc.width !== w || ovc.height !== h) { ovc.width = w; ovc.height = h; }
    octx.clearRect(0, 0, w, h);
    // First, and whether or not there is a face: "where do I put my head" is exactly the
    // question while the camera cannot see you, so this is the moment the box is most needed.
    drawFocusBox(w, h);
    if (!overlayOn) return;
    const colour = verdict === "ok" ? GREEN : verdict === "wait" ? AMBER : RED;
    if (face) {
      const half = face.size / 2;
      octx.strokeStyle = colour;
      octx.lineWidth = Math.max(1, Math.round(w / 220));
      // A tilted find comes back with the angle it was found at. Drawing its box square
      // would be a lie about what was measured, and the angle is the one piece of news
      // the picture can give you that the words cannot: it shows you the detector is
      // following your head over rather than merely tolerating it.
      if (face.roll) {
        octx.save();
        octx.translate(face.col, face.row);
        octx.rotate(face.roll * Math.PI / 180);
        octx.strokeRect(-half, -half, face.size, face.size);
        octx.restore();
      } else {
        octx.strokeRect(face.col - half, face.row - half, face.size, face.size);
      }
    }
    (eyes || []).forEach(e => {
      const good = e.open && e.centred;
      const c = good ? GREEN : RED;
      octx.strokeStyle = c;
      octx.lineWidth = Math.max(1, Math.round(w / 300));
      octx.strokeRect(e.box.x0, e.box.y0, e.box.x1 - e.box.x0, e.box.y1 - e.box.y0);
      // The pupil itself: a filled dot, so you can see it move as you look around.
      octx.beginPath();
      octx.arc(e.px, e.py, Math.max(2, w / 90), 0, Math.PI * 2);
      octx.fillStyle = c;
      octx.fill();
      if (!e.open) {   // eyelid down: a line through the socket reads as "shut"
        octx.beginPath();
        octx.moveTo(e.box.x0, (e.box.y0 + e.box.y1) / 2);
        octx.lineTo(e.box.x1, (e.box.y0 + e.box.y1) / 2);
        octx.strokeStyle = RED;
        octx.stroke();
      }
    });
  }
  if (ovBtn) {
    ovBtn.addEventListener("click", () => {
      overlayOn = !overlayOn;
      setOverlayUI();
      // Saved, so the setting is still there next time.
      try { chrome.storage.local.set({ camOverlayEnabled: overlayOn }); } catch (e) {}
    });
  }

  // ---------------- beep switch ----------------
  // The beep that tells you the clock stopped is switched on and off right here, on
  // the camera, instead of in a settings card. The page around this frame owns the
  // sound, so this only writes the setting and it picks it up.
  const sndBtn = document.getElementById("sndtog");
  let soundOn = true;
  function setSoundUI() {
    if (sndBtn) sndBtn.setAttribute("aria-pressed", soundOn ? "true" : "false");
  }
  if (sndBtn) {
    sndBtn.addEventListener("click", () => {
      soundOn = !soundOn;
      setSoundUI();
      try { chrome.storage.local.set({ soundEffectsEnabled: soundOn }); } catch (e) {}
    });
  }

  // ---------------- glow + media-pause switches ----------------
  // Neither effect happens in this frame — the glow goes round the work page and the
  // video being paused is on it — so both of these only write the setting, and the
  // page around this frame acts on it. Same arrangement as the beep above, and for
  // the same reason: this is where you are when either one matters.
  // Through the worker rather than straight into storage, and that is the whole of the fix for
  // "I switched the glow off and it still glows".
  //
  // A bare storage write only sets the global value, and the global value is not the last word:
  // a target with "its own cheating prevention" switched on carries a frozen copy of these keys
  // in its own profile, and the page prefers the target's copy — so the disc came undone on the
  // next tick, once a second, for as long as you sat there. setPageEffect writes the global
  // value and clears that one key from every target's profile, which is what makes the disc the
  // switch it looks like. See the handler in background.js.
  //
  // The storage write stays as the fallback, so a worker that has been torn down mid-click (or
  // an older one that has never heard of this message) still switches the thing off.
  function setEffect(key, value) {
    // Whichever route gets there first wins, and neither runs twice. Both of them write the same
    // value, so the flag is only there to stop the fallback undoing a message that has already
    // been handled — and to stop the timer below firing after a reply that came back fine.
    let settled = false;
    const fallback = () => {
      if (settled) return;
      settled = true;
      try { chrome.storage.local.set({ [key]: value }); } catch (e) {}
    };
    try {
      chrome.runtime.sendMessage({ type: "setPageEffect", key, value }, (r) => {
        // lastError has to be read, or Chrome logs an unchecked-error warning on every click
        // that lands while the worker is asleep.
        if (chrome.runtime.lastError || !r || !r.ok) fallback();
        else settled = true;
      });
    } catch (e) { fallback(); }
    // A worker that never calls back at all — killed between the send and the reply — would
    // otherwise leave the disc lit for a setting nothing wrote.
    setTimeout(fallback, 1200);
  }

  const glowBtn = document.getElementById("glowtog");
  let glowOn = true;
  function setGlowUI() {
    if (glowBtn) glowBtn.setAttribute("aria-pressed", glowOn ? "true" : "false");
  }
  if (glowBtn) {
    glowBtn.addEventListener("click", () => {
      glowOn = !glowOn;
      setGlowUI();
      setEffect("pageGlowEnabled", glowOn);
    });
  }

  const mpBtn = document.getElementById("mptog");
  // Ships off, like the glow beside it. Read `=== true` below for the same reason: nothing writes
  // DEFAULTS into storage on install, so on a fresh profile this key is absent here — and the
  // shipped value has to be the same whether it is read from DEFAULTS in the worker or from the
  // raw store in this frame.
  let mediaPauseOn = false;
  function setMediaPauseUI() {
    if (mpBtn) mpBtn.setAttribute("aria-pressed", mediaPauseOn ? "true" : "false");
  }
  if (mpBtn) {
    mpBtn.addEventListener("click", () => {
      mediaPauseOn = !mediaPauseOn;
      setMediaPauseUI();
      setEffect("mediaPauseEnabled", mediaPauseOn);
    });
  }

  // ---------------- auto resume ----------------
  // The other half of the disc above: once every condition is satisfied again, whatever was
  // paused carries on by itself. It has always existed as a setting and has only ever had a
  // switch on the settings page, which is the one place you are not when a lecture is sitting
  // frozen in front of you — so it gets a disc beside the one it belongs to.
  //
  // Not hidden while auto-pause is off, unlike the equivalent row on the settings page. Hiding
  // it would resize the tray as you flip the disc next to it, and a row of 19px targets that
  // moves under the pointer is worse than a disc that is momentarily academic. Its title says
  // what it depends on instead.
  const mrBtn = document.getElementById("mrtog");
  let mediaResumeOn = false;
  function setMediaResumeUI() {
    if (mrBtn) mrBtn.setAttribute("aria-pressed", mediaResumeOn ? "true" : "false");
  }
  if (mrBtn) {
    mrBtn.addEventListener("click", () => {
      mediaResumeOn = !mediaResumeOn;
      setMediaResumeUI();
      setEffect("mediaResumeEnabled", mediaResumeOn);
    });
  }

  // ---------------- options tray ----------------
  // The switches live behind one opener so they aren't sitting on your face all
  // session. Whether the tray is open is the state of one panel in one camera, not
  // a setting, so it isn't stored — storing it would also wake every other page's
  // storage listener just to announce that a tray moved.
  const camTools = document.getElementById("camtools");
  const camToolsBtn = document.getElementById("camtoolsBtn");
  function setToolsOpen(open) {
    if (!camTools || !camToolsBtn) return;
    camTools.classList.toggle("open", !!open);
    camToolsBtn.setAttribute("aria-expanded", open ? "true" : "false");
    camToolsBtn.setAttribute("title", open ? "Hide camera options" : "Camera options");
  }
  if (camToolsBtn) {
    camToolsBtn.addEventListener("click", () => setToolsOpen(!camTools.classList.contains("open")));
  }
  // Escape closes it, like anything else that opens over something else.
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && camTools && camTools.classList.contains("open")) setToolsOpen(false);
  });
  setToolsOpen(false);

  // ---- the discs are sized from the preview, not from a number in the stylesheet ----
  //
  // The preview's width is a setting the user can drag, and this row has to fit inside it or the
  // last disc — the settings cog — is simply cut off by the edge of the picture. A fixed size can
  // only ever be right for one preview width, and there is no longer one preview width.
  //
  // This frame's own window IS the preview, so `innerWidth` is the measurement, and no value has to
  // be passed in or kept in step with anything. The bounds are what makes it a target rather than a
  // dot: below 13px a disc is too small to hit and too small to read a glyph in, and above 22px
  // they start sitting on your face on a large preview, which is what putting them in a row along
  // the top strip was for in the first place.
  const DISC_COUNT = 7;         // the opener plus the six switches behind it
  const DISC_INSET = 4;         // .camtools left, and the same again kept clear on the right
  // Past 22px they start sitting on your face on a large preview, which is what putting them in a
  // row along the top strip was for in the first place.
  //
  // The floor is 6, and it is low on purpose. It is not a size anyone should normally see — the solve
  // below yields 8px at the smallest preview the card will go to — it is there so that the clamp can
  // never push a disc back UP past what fits. That is the direction this went wrong once already: a
  // floor of 10 against a 72px preview made the row 80px wide and cut the settings cog off the edge
  // of the picture, which is the one failure that matters here, because a control you cannot see is
  // a control you cannot get back.
  const DISC_MAX = 22, DISC_FLOOR = 6;
  const fitDisc = (room, gap) => Math.floor((room - (DISC_COUNT - 1) * gap) / DISC_COUNT);
  function sizeDiscs() {
    const room = Math.max(0, (window.innerWidth || 134) - DISC_INSET * 2);
    // Solve `n*d + (n-1)*g <= room` for the biggest disc that fits.
    //
    // The gap is solved WITH the disc rather than picked afterwards, and that ordering is the whole
    // correctness of this function: choosing a 2px gap once the disc size is already fixed spends
    // 6px the row was not measured with, and the last disc — the settings cog — goes off the edge of
    // the picture. A 2px gap is preferred because it looks better between large discs, and handed
    // straight back to the discs the moment the row is tight enough that a pixel of gap costs more
    // than it gives.
    let gap = 2;
    let d = fitDisc(room, gap);
    if (d < 18) { gap = 1; d = fitDisc(room, gap); }
    // `min` with what fits, never `max`: clamping a disc UP past the room available is the other way
    // to push the cog off the edge. The floor is below anything the solve produces in practice, so
    // it only applies to a window narrower than the extension will ever ask for.
    const disc = Math.max(DISC_FLOOR, Math.min(DISC_MAX, d));
    const root = document.documentElement;
    root.style.setProperty("--fg-disc", disc + "px");
    root.style.setProperty("--fg-disc-gap", gap + "px");
    // The glyph is a percentage of its disc, raised as the disc shrinks so it lands on roughly the
    // same number of real pixels rather than disappearing with it.
    root.style.setProperty("--fg-disc-glyph", (disc <= 15 ? 78 : disc <= 18 ? 72 : 66) + "%");
    // The speed badge in the opposite corner. Cosmetic rather than structural — it has the whole
    // right-hand side to itself and cannot be cut off — but 10px text on a 320px preview reads as a
    // mistake, and so does 10px text on a 72px one, so it moves with everything else.
    root.style.setProperty("--fg-tag", Math.max(8, Math.min(15, Math.round(disc * 0.62))) + "px");
  }
  sizeDiscs();
  // The preview is resized live from the settings page, and this frame is told about it the only
  // way a frame ever is: its own box changes. Cheap — three custom properties and no layout of our
  // own — so it is not debounced; a slider being dragged is exactly when it should keep up.
  window.addEventListener("resize", sizeDiscs, { passive: true });

  // ---------------- way out to Settings ----------------
  // Everything that needs a number or a label — sensitivity, the three deadlines,
  // which sites count — lives on the settings page, and there is no room for any of
  // it in a row of 24px discs. This frame is an extension page, so it can open that
  // page itself; the fallback is for the case where openOptionsPage is unavailable.
  const setBtn = document.getElementById("settog");
  // Hidden when this frame IS the settings page's own preview. The gear's whole job is to get
  // you to that page, and there you already are — pressing it would open a second copy of the
  // page you are standing on.
  const inPreview = (() => {
    try { return new URLSearchParams(location.search).get("preview") === "1"; } catch (e) { return false; }
  })();
  if (setBtn && inPreview) setBtn.hidden = true;
  else if (setBtn) {
    setBtn.addEventListener("click", () => {
      setToolsOpen(false);
      try {
        if (chrome.runtime && chrome.runtime.openOptionsPage) {
          chrome.runtime.openOptionsPage();
          return;
        }
      } catch (e) {}
      // Last resort: ask the page around this frame to open the page for us, since a
      // window.open from inside a cross-origin frame is the thing browsers block.
      post("openSettings", { url: chrome.runtime.getURL("options.html") });
    });
  }

  // The site being watched may keep its own no-cheating rules rather than the ones
  // in Setup. The content script resolves that and passes the answer in this
  // frame's address, so anything named here is fixed for the life of this camera
  // and storage no longer has a say over it. Nothing named means "follow Setup",
  // which is what every site does until it's told otherwise.
  const pinned = new Set();
  try {
    const q = new URLSearchParams(location.search);
    const num = (k) => { const n = parseFloat(q.get(k)); return Number.isFinite(n) ? n : null; };
    if (num("fs") !== null) { sensitivity = num("fs"); pinned.add("faceSensitivity"); }
    if (q.has("eye")) { eyeRequired = q.get("eye") === "1"; pinned.add("eyeTrackingEnabled"); }
    if (num("es") !== null) { eyeSens = num("es"); pinned.add("eyeSensitivity"); }
    if (num("ea") !== null) { watchSeconds(eyeWatch, num("ea")); pinned.add("eyeAwaySec"); }
    if (q.has("live")) { liveness.enabled = q.get("live") === "1"; pinned.add("livenessEnabled"); }
    if (num("li") !== null) { watchSeconds(liveness, num("li")); pinned.add("livenessIntervalSec"); }
    if (num("ms") !== null) { liveness.needFrac = moveFracFor(num("ms")); pinned.add("moveSensitivity"); }
    if (q.has("blink")) { blinkRequired = q.get("blink") === "1"; pinned.add("blinkRequired"); }
    if (num("bi") !== null) { watchSeconds(blinkWatch, num("bi")); pinned.add("blinkIntervalSec"); }
    if (num("bs") !== null) { blinkSens = Math.max(1, Math.min(5, num("bs") | 0)); pinned.add("blinkSensitivity"); }
    if (q.has("pace")) { paceOn = q.get("pace") === "1"; pinned.add("paceEnabled"); }
    if (num("pf") !== null) { paceFast = paceClamp(num("pf"), paceFast); pinned.add("paceFast"); }
    if (num("ps") !== null) { paceSlow = paceClamp(num("ps"), paceSlow); pinned.add("paceSlow"); }
    if (num("pb") !== null) { focusSize = focusClamp(num("pb"), focusSize); pinned.add("paceBoxPct"); }
  } catch (e) {}

  try {
    chrome.storage.local.get(["livenessEnabled", "livenessIntervalSec", "faceSensitivity",
                              "eyeTrackingEnabled", "eyeSensitivity", "camOverlayEnabled",
                              "soundEffectsEnabled", "pageGlowEnabled",
                              "mediaPauseEnabled", "mediaResumeEnabled",
                              "moveSensitivity", "blinkRequired", "blinkIntervalSec",
                              "blinkSensitivity", "eyeAwaySec",
                              "paceEnabled", "paceFast", "paceSlow", "paceBoxPct"], (r) => {
      if (!r) return;
      if (typeof r.soundEffectsEnabled === "boolean") soundOn = r.soundEffectsEnabled;
      setSoundUI();
      // Both read the way they ship, which is off — so `=== true` for each, and an absent or
      // garbled value leaves them off rather than reaching into somebody's page uninvited.
      //
      // These two used to disagree: the glow was `=== true` and media-pause `!== false`, on the
      // reasoning that a garbled value should not stop protecting a video. That was right while it
      // shipped on. Now that it ships off, the same expression would make an absent key mean "on"
      // here while DEFAULTS in the worker says "off" — and the disc on this camera would sit lit
      // for a feature the worker had switched off.
      glowOn = r.pageGlowEnabled !== false;
      setGlowUI();
      mediaPauseOn = r.mediaPauseEnabled === true;
      setMediaPauseUI();
      // Ships off with its parent, and read the same way for the same reason.
      mediaResumeOn = r.mediaResumeEnabled === true;
      setMediaResumeUI();
      if (!pinned.has("livenessEnabled") && typeof r.livenessEnabled === "boolean") liveness.enabled = r.livenessEnabled;
      // Typed, not truthy. Zero is a real setting — "the clock only counts while you are
      // actually moving" — and a truthiness check silently threw it away and left the
      // default standing, so the box said 0 and the camera behaved as though it said 180.
      if (!pinned.has("livenessIntervalSec") && typeof r.livenessIntervalSec === "number" && isFinite(r.livenessIntervalSec)) {
        watchSeconds(liveness, r.livenessIntervalSec);
      }
      if (!pinned.has("moveSensitivity") && r.moveSensitivity) liveness.needFrac = moveFracFor(r.moveSensitivity);
      if (!pinned.has("faceSensitivity") && r.faceSensitivity) sensitivity = r.faceSensitivity;
      if (!pinned.has("eyeTrackingEnabled") && typeof r.eyeTrackingEnabled === "boolean") eyeRequired = r.eyeTrackingEnabled;
      if (!pinned.has("eyeSensitivity") && r.eyeSensitivity) eyeSens = r.eyeSensitivity;
      if (!pinned.has("eyeAwaySec") && typeof r.eyeAwaySec === "number") watchSeconds(eyeWatch, r.eyeAwaySec);
      if (!pinned.has("blinkRequired") && typeof r.blinkRequired === "boolean") blinkRequired = r.blinkRequired;
      if (!pinned.has("blinkIntervalSec") && typeof r.blinkIntervalSec === "number") watchSeconds(blinkWatch, r.blinkIntervalSec);
      if (!pinned.has("blinkSensitivity") && r.blinkSensitivity) blinkSens = Math.max(1, Math.min(5, r.blinkSensitivity | 0));
      if (!pinned.has("paceEnabled") && typeof r.paceEnabled === "boolean") paceOn = r.paceEnabled;
      if (!pinned.has("paceFast")) paceFast = paceClamp(r.paceFast, paceFast);
      if (!pinned.has("paceSlow")) paceSlow = paceClamp(r.paceSlow, paceSlow);
      if (!pinned.has("paceBoxPct")) focusSize = focusClamp(r.paceBoxPct, focusSize);
      // Nothing to carry over: this frame is built fresh every time the card is, so the
      // multiplier starts at 1 and ramps to wherever the first look puts it.
      resetPace();
      // A full interval in hand for all three when this camera opens, deliberately NOT
      // carried over. This frame is built and destroyed every time you switch tabs, and a
      // camera opened five minutes later that inherited an old stamp would start already
      // past its deadline — the clock waiting on you before you had any chance to do
      // anything, which is most of "it pauses the moment I stop moving".
      watchFresh(liveness);
      watchFresh(eyeWatch);
      watchFresh(blinkWatch);
      if (typeof r.camOverlayEnabled === "boolean") overlayOn = r.camOverlayEnabled;
      setOverlayUI();
    });
    chrome.storage.onChanged.addListener((c, area) => {
      if (area !== "local") return;
      // Any of these changing gives you a full interval in hand, so flipping a switch or
      // moving a dial never lands you already past a deadline.
      if (c.livenessEnabled && !pinned.has("livenessEnabled")) {
        liveness.enabled = c.livenessEnabled.newValue === true;
        watchFresh(liveness);
        liveness.seeded = false;
      }
      if (c.livenessIntervalSec && !pinned.has("livenessIntervalSec")) {
        // `|| 180` was here, which turned a setting of 0 into three minutes.
        const secs = c.livenessIntervalSec.newValue;
        watchSeconds(liveness, typeof secs === "number" && isFinite(secs) ? secs : 10);
        watchFresh(liveness);
      }
      if (c.moveSensitivity && !pinned.has("moveSensitivity")) {
        liveness.needFrac = moveFracFor(c.moveSensitivity.newValue);
        // A dial change should be felt now, not after the current wait plays out.
        liveness.seeded = false;
      }
      if (c.faceSensitivity && !pinned.has("faceSensitivity")) sensitivity = c.faceSensitivity.newValue || 3;
      if (c.eyeTrackingEnabled && !pinned.has("eyeTrackingEnabled")) {
        eyeRequired = !!c.eyeTrackingEnabled.newValue;
        watchFresh(eyeWatch);
      }
      if (c.eyeSensitivity && !pinned.has("eyeSensitivity")) { eyeSens = c.eyeSensitivity.newValue || 3; watchFresh(eyeWatch); }
      if (c.eyeAwaySec && !pinned.has("eyeAwaySec")) { watchSeconds(eyeWatch, c.eyeAwaySec.newValue); watchFresh(eyeWatch); }
      if (c.blinkRequired && !pinned.has("blinkRequired")) { blinkRequired = !!c.blinkRequired.newValue; watchFresh(blinkWatch); }
      if (c.blinkIntervalSec && !pinned.has("blinkIntervalSec")) { watchSeconds(blinkWatch, c.blinkIntervalSec.newValue); watchFresh(blinkWatch); }
      if (c.blinkSensitivity && !pinned.has("blinkSensitivity")) {
        blinkSens = Math.max(1, Math.min(5, (c.blinkSensitivity.newValue | 0) || 3));
        // Relearn: the dial changes what counts as a dip, so the old baseline is measured
        // against a different rule.
        blinkBase = 0;
        watchFresh(blinkWatch);
      }
      // The timer speed. In practice the content script pins all four into this frame's address,
      // so these only fire for a camera opened without them — but they are here for the same
      // reason every other key is: whichever way a setting arrives, it arrives in one place.
      if (c.paceEnabled && !pinned.has("paceEnabled")) {
        paceOn = c.paceEnabled.newValue === true;
        resetPace();
        // The canvas may have just gained or lost its second reason to be on screen.
        setOverlayUI();
      }
      if (c.paceFast && !pinned.has("paceFast")) paceFast = paceClamp(c.paceFast.newValue, paceFast);
      if (c.paceSlow && !pinned.has("paceSlow")) paceSlow = paceClamp(c.paceSlow.newValue, paceSlow);
      // Moving the box changes what "in it" means, so the current verdict is about a box that is
      // no longer there. Measured again on the next look, a few dozen milliseconds away.
      if (c.paceBoxPct && !pinned.has("paceBoxPct")) focusSize = focusClamp(c.paceBoxPct.newValue, focusSize);
      if (c.camOverlayEnabled) { overlayOn = c.camOverlayEnabled.newValue !== false; setOverlayUI(); }
      if (c.soundEffectsEnabled) { soundOn = c.soundEffectsEnabled.newValue !== false; setSoundUI(); }
      if (c.pageGlowEnabled) { glowOn = c.pageGlowEnabled.newValue !== false; setGlowUI(); }
      if (c.mediaPauseEnabled) { mediaPauseOn = c.mediaPauseEnabled.newValue === true; setMediaPauseUI(); }
      if (c.mediaResumeEnabled) { mediaResumeOn = c.mediaResumeEnabled.newValue === true; setMediaResumeUI(); }
    });
  } catch (e) {}

  // ---------------- live tuning from the settings page ----------------
  // The settings page embeds this frame as a preview, so you can set the focus box while
  // watching yourself sit inside it. Dragging a slider has to move the square NOW.
  //
  // Rebuilding the frame per step was the obvious route and it is unusable: every reload is a
  // fresh getUserMedia, so the picture blinks out and the recording light flickers several times
  // across one drag of a slider. These three numbers are the only things that change, and none
  // of them needs the camera restarted — so they arrive as a message and are simply assigned.
  //
  // Only from the window that embedded us, and only these four fields. Anything else on this
  // channel is ignored: this frame runs inside arbitrary websites, and a page that could talk
  // its way to `pinned` would be able to detach the camera from your real settings.
  window.addEventListener("message", (e) => {
    const d = e.data;
    if (!d || d.source !== "focusgate-pace-tune") return;
    if (e.source !== parent) return;
    const n = (v) => { const x = Number(v); return Number.isFinite(x) ? x : null; };
    // Pinned as they land, for the same reason the URL pins them: while the settings page is
    // driving this preview, storage must not be able to argue with it.
    if (n(d.fast) !== null) { paceFast = paceClamp(d.fast, paceFast); pinned.add("paceFast"); }
    if (n(d.slow) !== null) { paceSlow = paceClamp(d.slow, paceSlow); pinned.add("paceSlow"); }
    if (n(d.box) !== null) { focusSize = focusClamp(d.box, focusSize); pinned.add("paceBoxPct"); }
    if (typeof d.on === "boolean") { paceOn = d.on; pinned.add("paceEnabled"); setOverlayUI(); }
    // Nothing is repainted from here. The box has just changed size, so the current in/out
    // verdict is about a square that no longer exists — and the next look is a few dozen
    // milliseconds away and will decide it properly. The multiplier deliberately ramps from
    // where it is rather than jumping, exactly as it does on a real page.
  });

  function post(type, extra) {
    // The channel name carries a number, and the number was raised on purpose.
    //
    // A copy of the content script orphaned by an extension reload keeps every listener it ever
    // registered, including the one that hears this. It cannot be unregistered from outside, and a
    // copy built before the handover was added does not know to stand down — so it went on acting
    // on these messages with a break flag frozen before the reload, which is what made a paused
    // card carry on beeping. Raising the name is what makes such a listener deaf immediately,
    // without waiting for the page to be reloaded by hand.
    //
    // This frame is always loaded fresh from the extension, so it always speaks the current name;
    // only a stale listener is left behind. Raise it again if this ever has to be done twice.
    try { parent.postMessage(Object.assign({ source: "focusgate-facecam-2", type }, extra || {}), "*"); }
    catch (e) {}
  }
  // The camera's own state, kept so the same words reach the status line and the page.
  let camReason = "";
  function setStatus(text, cls) {
    camReason = text || "";
    statusEl.textContent = text;
    document.body.className = cls || "";
  }

  // Convert RGBA pixels to a grayscale buffer that pico expects
  function rgbaToGrayscale(rgba, nrows, ncols) {
    const gray = new Uint8Array(nrows * ncols);
    for (let r = 0; r < nrows; r++) {
      for (let c = 0; c < ncols; c++) {
        const i = r * 4 * ncols + 4 * c;
        // luminance approximation
        gray[r * ncols + c] = (2 * rgba[i] + 7 * rgba[i + 1] + 1 * rgba[i + 2]) / 10;
      }
    }
    return gray;
  }

  // ---------------- is anything in the picture moving? ----------------
  // Deliberately not a face question. It exists for the case where there is no face to
  // ask about — head down over a notebook — and the only thing left to tell "working at
  // the desk" from "empty chair" is whether the picture is still changing.
  //
  // A coarse grid of cell averages, compared with the previous frame. Averaging is the
  // point: sensor noise is per-pixel and cancels, a moving arm does not. Two readings off
  // the same grid, because they fail in different directions — the mean catches a general
  // shuffle, the hot-cell count catches a small hand moving in an otherwise still frame.
  const MO_COLS = 24, MO_ROWS = 18;
  const MO_MEAN = 1.2;      // average grey-level change across the whole grid
  const MO_CELL = 10;       // a cell that changed by this much is "something happened here"
  const MO_HOT = 5;         // and this many of them is a thing moving, not a flicker
  // ---------------- and is the chair full? ----------------
  // A different question from movement, and the one the kind and easy settings rest on:
  // someone sitting perfectly still is invisible to a frame-to-frame comparison, but they
  // are still blocking most of the picture.
  //
  // Answering it needs to know what the room looks like WITHOUT you, and the only honest
  // way to learn that is to wait until you have demonstrably gone: no face found for a
  // good while AND the picture completely unchanging. Both, deliberately. Stillness alone
  // would learn you dozing at the desk as the wall behind you, and from then on it would
  // say the chair was empty every time you sat in it.
  const BG_FACE_MS = 45000;   // no face for this long: you are probably not in the room
  const BG_STILL_MS = 15000;  // and nothing has moved for this long: probably nobody is
  // And the quick route's version of "nothing is moving": once the departure test has said
  // you went, this is only waiting for the picture to stop swinging about as the door closes
  // behind you.
  const BG_SETTLE_MS = 4000;
  const BG_CELL = 12;         // grey levels away from the empty room = this cell is blocked
  const BG_FRAC = 0.12;       // and this share of the picture blocked is a person, not a shadow
  let bgGrid = null, bgAt = 0;
  let moHave = false, lastMotionAt = 0, lastFaceAt = 0, faceSceneAt = 0;
  let moNow = null, moPrev = null, moStartAt = 0;
  function noteMotion(gray, w, h, now) {
    const cells = MO_COLS * MO_ROWS;
    if (!moNow) { moNow = new Float32Array(cells); moPrev = new Float32Array(cells); }
    const cw = w / MO_COLS, ch = h / MO_ROWS;
    // Four samples across a cell, not every pixel in it. This runs on every frame beside
    // the cascade and the answer is one bit; reading the whole frame again to get it would
    // cost more than the bit is worth.
    const sx = Math.max(1, Math.floor(cw / 4)), sy = Math.max(1, Math.floor(ch / 4));
    for (let cy = 0; cy < MO_ROWS; cy++) {
      const y0 = Math.floor(cy * ch), y1 = Math.min(h, Math.floor((cy + 1) * ch));
      for (let cx = 0; cx < MO_COLS; cx++) {
        const x0 = Math.floor(cx * cw), x1 = Math.min(w, Math.floor((cx + 1) * cw));
        let sum = 0, n = 0;
        for (let y = y0; y < y1; y += sy) {
          const row = y * w;
          for (let x = x0; x < x1; x += sx) { sum += gray[row + x]; n++; }
        }
        moNow[cy * MO_COLS + cx] = n ? sum / n : 0;
      }
    }
    if (moHave) {
      // Compared against the average change, not against zero. A webcam's automatic gain
      // steps the brightness of the WHOLE picture at once, and often several levels at a
      // time — read literally that is every cell changing, which is indistinguishable from
      // the room being redecorated. Real movement is local: some cells change a lot while
      // the rest don't, so it survives having the frame-wide part taken out, and a gain step
      // doesn't.
      let mean = 0;
      for (let i = 0; i < cells; i++) mean += moNow[i] - moPrev[i];
      mean /= cells;
      let total = 0, hot = 0;
      for (let i = 0; i < cells; i++) {
        const d = Math.abs(moNow[i] - moPrev[i] - mean);
        total += d;
        if (d > MO_CELL) hot++;
      }
      if (total / cells >= MO_MEAN || hot >= MO_HOT) lastMotionAt = now;
    } else {
      moStartAt = now;   // stillness has to be measured from somewhere on the first frame
    }
    moPrev.set(moNow);
    moHave = true;

    // Learn the empty room, if this looks like one.
    //
    // Route 1, the quick one: the departure test says the scene no longer holds you, and it
    // has since settled. This is much faster than route 2 and safer, not less safe — the
    // thing route 2 has to guard against is memorising someone who has gone quiet at the
    // desk, and a person dozing there does not change the scene at all, so this route cannot
    // fire for them. It is also the only route that runs at all early in a session.
    //
    // Route 2, the patient one: no face for a long time and nothing moving for a while. Kept
    // for the case where there is no reference to compare against — the camera came up with
    // nobody in front of it, so route 1 has nothing to say and never will until a face turns
    // up once.
    const settled = stillFor(now) >= BG_SETTLE_MS;
    const learn = (faceSceneAt && settled && sceneChangedSinceFace() >= GONE_FRAC) ||
                  (lastFaceAt && now - lastFaceAt >= BG_FACE_MS && stillFor(now) >= BG_STILL_MS);
    if (learn) {
      if (!bgGrid) bgGrid = new Float32Array(cells);
      bgGrid.set(moNow);
      bgAt = now;
    }
  }
  // How long the picture has been unchanged. Before anything has ever moved there is no
  // lastMotionAt to measure from, so the first frame stands in for it.
  function stillFor(now) { return now - Math.max(lastMotionAt, moStartAt); }
  function movingRecently(now, withinMs) {
    return lastMotionAt > 0 && (now - lastMotionAt) <= withinMs;
  }

  // ---------------- have you left? ----------------
  // The one question the ladder was missing, and the only presence test here that can answer
  // the moment it happens.
  //
  // Everything else here is either "is there a face" (which a head over a notebook fails) or
  // "is anything moving" (which a curtain passes) or "does this match the empty room" (which
  // needs to have seen the room empty first, and so is no use for the first hour of a
  // session). Between them, the honest answer to "he stood up and walked off just now" was a
  // grace period — the clock kept running for as long as the dial said, because nothing could
  // tell that anything had changed.
  //
  // Something obvious HAD changed, though: the picture. So keep the picture as it was the last
  // time a face was actually in it, and compare against that instead of against an empty room
  // nobody has seen yet.
  //
  //   head down over a notebook — your head moves a foot; your shoulders, arms and the whole
  //   lower half of the frame stay exactly where they were. A small part of the picture differs.
  //
  //   out of the chair — head, shoulders, arms and torso all leave at once and the wall, the
  //   bed, the door behind you arrive in their place. A large part of the picture differs.
  //
  // That gap is what separates the posture the dial is meant to forgive from the absence it is
  // never meant to forgive, and it is available on the very first frame after you go.
  const GONE_FRAC = 0.22;     // this share of the picture different from "you, there" = you left
  // Two frames, not one. A hand swept across the lens, a door opening behind you, the camera's
  // own exposure lurching — any of those can spike one frame's difference, and stopping the
  // clock for a blink and starting it again is its own kind of broken. Two consecutive looks is
  // still under a tenth of a second at the rate this runs.
  const GONE_HITS = 2;
  let faceGrid = null, goneHits = 0;
  // Which cells your face filled when it was last seen, and how much detail was in them.
  //
  // This is the answer to "something is being held over my face and the clock keeps running".
  // A face is the most structured thing in the picture — brows, eye sockets, nostrils, a mouth
  // — so the cells it covers vary a lot. A lamp shade, a sheet of card, a palm, a book cover:
  // all of them are large and nearly featureless. Cover your face with one and the cells that
  // held all that structure go flat.
  //
  // Compared against the face's OWN reading rather than against a fixed number, because "flat"
  // is relative to the camera and the light: a dim webcam's face may vary less than a bright
  // one's desk. A share of what was there is scale-free; an absolute threshold would be tuned
  // to one room.
  let faceCells = null, faceSd = 0;
  // Under this share of the detail your face had, the thing in front of the lens is not your
  // face and is not your posture either.
  //
  // Note what this deliberately does NOT try to distinguish: an object over your face, and you
  // having left with a blank wall behind you. Both read the same here and both should stop the
  // clock, so there is nothing to separate. The one case it can cost is a head bent over a
  // plain pale desk, which reads flat too — and stopping there is the direction to be wrong in,
  // given the rung it is guarding is a guess about a face nobody can see.
  const BLANK_SHARE = 0.55;
  // Fewer cells than this and a spread means nothing — a face far from the camera covers a handful.
  const BLANK_MIN_CELLS = 6;
  // Standard deviation of the grid over a rectangle of cells. Two passes' worth of arithmetic in
  // one, which matters only because this runs beside the cascade.
  function cellSd(r) {
    if (!r || !moHave || !moNow) return -1;
    let n = 0, sum = 0, sum2 = 0;
    for (let y = r.r0; y <= r.r1; y++) {
      for (let x = r.c0; x <= r.c1; x++) {
        const val = moNow[y * MO_COLS + x];
        sum += val; sum2 += val * val; n++;
      }
    }
    if (n < BLANK_MIN_CELLS) return -1;
    const mean = sum / n;
    return Math.sqrt(Math.max(0, sum2 / n - mean * mean));
  }
  // The face box, in grid cells. Clamped to the grid rather than refused when it runs off the
  // edge: a face at the edge of frame is still a face, and the part of it that IS in shot is
  // what we can measure.
  function boxCells(w, h, box) {
    if (!box || !(w > 0) || !(h > 0) || !(box.size > 0)) return null;
    const half = box.size / 2;
    const c0 = Math.max(0, Math.min(MO_COLS - 1, Math.floor((box.col - half) / w * MO_COLS)));
    const c1 = Math.max(0, Math.min(MO_COLS - 1, Math.floor((box.col + half) / w * MO_COLS)));
    const r0 = Math.max(0, Math.min(MO_ROWS - 1, Math.floor((box.row - half) / h * MO_ROWS)));
    const r1 = Math.max(0, Math.min(MO_ROWS - 1, Math.floor((box.row + half) / h * MO_ROWS)));
    if (c1 < c0 || r1 < r0) return null;
    return { c0, c1, r0, r1 };
  }
  // Is the place your face was now featureless?
  function blankOverFace() {
    if (!faceCells || !(faceSd > 0)) return false;   // nothing measured to compare against
    const sd = cellSd(faceCells);
    if (sd < 0) return false;                        // not measurable, so no claim
    return sd < faceSd * BLANK_SHARE;
  }
  // Photographed at the moment a real face was in frame. Not on every frame: the point of the
  // reference is that it holds the scene WITH you in it, and refreshing it from faceless frames
  // would let it drift, one frame at a time, into a picture of the room without you.
  function noteFaceScene(w, h, box) {
    if (!moHave || !moNow) return;
    const cells = moNow.length;
    if (!faceGrid) faceGrid = new Float32Array(cells);
    faceGrid.set(moNow);
    faceSceneAt = 1;   // a flag, not a time: nothing here cares HOW old the reference is
    goneHits = 0;
    // And where the face was, with how much detail was in it — for blankOverFace. Taken here
    // rather than measured later because "how structured is a face" can only be answered while
    // one is actually in front of the camera.
    const r = boxCells(w, h, box);
    if (r) {
      const sd = cellSd(r);
      // Only kept if it is measurable AND actually structured. A reading of nearly zero would
      // make the comparison meaningless — everything is under half of nothing.
      if (sd > 2) { faceCells = r; faceSd = sd; }
    }
  }
  // How much of the picture no longer looks like it did when your face was last in it, 0..1.
  // Mean-subtracted, for the same reason as everywhere else here: a webcam that lifts its gain
  // when you leave its brightest object behind changes every cell at once, and read literally
  // that is a whole new room rather than the same room a little brighter.
  function sceneChangedSinceFace() {
    if (!faceSceneAt || !faceGrid || !moHave) return 0;
    const cells = faceGrid.length;
    let mean = 0;
    for (let i = 0; i < cells; i++) mean += moNow[i] - faceGrid[i];
    mean /= cells;
    let n = 0;
    for (let i = 0; i < cells; i++) if (Math.abs(moNow[i] - faceGrid[i] - mean) > BG_CELL) n++;
    return n / cells;
  }
  // true = the picture says you are not where you were. Kept as a counter rather than a single
  // reading so GONE_HITS can mean what it says.
  function gone(now) {
    if (!faceSceneAt) return false;
    if (sceneChangedSinceFace() >= GONE_FRAC) goneHits++;
    else goneHits = 0;
    return goneHits >= GONE_HITS;
  }

  // true = something substantial is in front of the camera, false = it looks like the empty
  // room, null = we have never seen the room empty and genuinely do not know. The three
  // answers are kept apart on purpose: "don't know" must not be read as "empty".
  function occupied() {
    if (!bgAt || !bgGrid || !moHave) return null;
    const cells = bgGrid.length;
    // Same reasoning as the movement check, and it matters more here. A camera that lifts its
    // gain after you walk out of shot would otherwise read as a whole new scene — which is to
    // say as a body — and at the bottom of the dial that would hold the clock open on an empty
    // chair. Taking the frame-wide part out leaves only the shape of what's blocking the view,
    // and a person blocks part of the picture rather than all of it evenly.
    let mean = 0;
    for (let i = 0; i < cells; i++) mean += moNow[i] - bgGrid[i];
    mean /= cells;
    let n = 0;
    for (let i = 0; i < cells; i++) if (Math.abs(moNow[i] - bgGrid[i] - mean) > BG_CELL) n++;
    return n / cells >= BG_FRAC;
  }

  // ---------------- is that candidate actually a face? ----------------
  // A verifier in front of the detector, which is how every serious face pipeline is built: a
  // cheap detector proposes boxes, and something else confirms them. pico is only the proposer
  // here, and on its own it is not a high enough bar — it is a decision tree over pairs of
  // pixel brightnesses, trained on faces, and a large smooth object can walk a path through it
  // by accident.
  //
  // The case that forced this: a lamp shade held up. A veto downstream of a detector that says
  // yes cannot help, because the detection itself refreshes the last-seen time and overwrites
  // the very reference such a test compares against. The detector has to stop saying yes.
  //
  // Two measurements, both inside the box, both cheap:
  //
  //   contrast  A face is the most structured thing in a normal frame — brows, eye sockets,
  //             nostrils, lips, all within a few dozen pixels. Its internal spread of
  //             brightness is large. A lamp shade, a sheet of card, a palm, a cushion: one
  //             tone and a gentle gradient. This is the test that does the work, and the two
  //             are not close: a face here measures thirty to sixty grey levels, a flat object
  //             under ten.
  //
  //   eye band  For a face the right way up, the band across the eyes and brows is darker than
  //             the band across the cheeks and mouth. Sockets are in shadow and lashes and
  //             brows are dark; cheeks catch the light. It is a weaker signal than contrast and
  //             it depends on the lighting, so it is asked only of the ROTATED pass — see
  //             findTilted for why that one needs a second opinion.
  //
  // The central portion is sampled, not the whole box. pico's box is generous and includes
  // hair, ears and background at the corners, and background is exactly what must not be
  // allowed to supply the contrast that makes a flat object look structured.
  const FACE_SD_MIN = 12;        // grey levels of internal spread. A face has far more.
  const FACE_EYE_DROP = 1.5;     // and the eye band this much darker, for a rotated find
  const FACE_MIN_SAMPLES = 24;   // fewer than this and a spread means nothing
  function faceCheck(gray, w, h, row, col, size) {
    const none = { ok: false, sd: 0, eyeDrop: 0 };
    if (!gray || !(size > 0)) return none;
    // 0.34, so the sampled square is about two thirds of the box's width — the part that is
    // reliably face rather than whatever is behind the head.
    const half = size * 0.34;
    const x0 = Math.max(0, Math.round(col - half)), x1 = Math.min(w - 1, Math.round(col + half));
    const y0 = Math.max(0, Math.round(row - half)), y1 = Math.min(h - 1, Math.round(row + half));
    if (x1 - x0 < 6 || y1 - y0 < 6) return none;
    // Subsampled to about 16 across. This runs on every accepted candidate, several times a
    // second, beside the cascade itself — and a spread does not need every pixel measured.
    const step = Math.max(1, Math.floor((x1 - x0) / 16));
    // The split between the two bands. 0.42 rather than a third: pico centres its box on the
    // whole face, so the eyes sit a little above the middle of it.
    const mid = y0 + (y1 - y0) * 0.42;
    let n = 0, sum = 0, sum2 = 0, nU = 0, sU = 0, nL = 0, sL = 0;
    for (let y = y0; y <= y1; y += step) {
      const off = y * w;
      for (let x = x0; x <= x1; x += step) {
        const val = gray[off + x];
        sum += val; sum2 += val * val; n++;
        if (y < mid) { sU += val; nU++; } else { sL += val; nL++; }
      }
    }
    if (n < FACE_MIN_SAMPLES) return none;
    const mean = sum / n;
    const sd = Math.sqrt(Math.max(0, sum2 / n - mean * mean));
    // Positive when the upper band is the darker one, which is the way round a face is.
    const eyeDrop = (nU > 0 && nL > 0) ? (sL / nL) - (sU / nU) : 0;
    return { sd, eyeDrop, ok: sd >= FACE_SD_MIN };
  }

  // ---------------- the tilted-head pass ----------------
  // Its own canvas, at its own size. Square, because a rotated rectangle needs the diagonal
  // to keep its corners, and a corner is exactly where a leaning head ends up.
  const rcanvas = document.createElement("canvas");
  const rctx = rcanvas.getContext("2d", { willReadFrequently: true });
  // Each angle costs a fresh getImageData and a fresh cascade run, so the copy is shrunk
  // first. Ten angles at full resolution would be ten times the most expensive thing on the
  // page; at this width they come to roughly one upright pass between them.
  //
  // The shrink does not make the smallest findable face any bigger: minsize below is scaled by
  // the same factor, so a tilted face has to be the same number of real pixels across as an
  // upright one. The floor is there only for cameras small enough that the arithmetic would
  // otherwise ask the cascade for a window narrower than it can score.
  const TILT_SIDE_MAX = 256;
  // What a rotated find has to score, as a share of the sensitivity bar.
  //
  // QUAL_BY_SENS is calibrated against pico's FIVE-FRAME memory: cluster_detections adds up
  // the scores of every window it merges, so the bar is a sum over five frames, and one frame
  // from a face that only just clears your setting contributes about a fifth of it.
  //
  // The rotated pass has no memory. It gets one frame. So a naive 0.7 of a five-frame bar
  // would be asking a single rotated frame for around three and a half times what a single
  // upright frame produces — at easy that means a score over 18 where a real face gives five
  // or ten, so the pass runs several cascades a second, all session, and essentially never
  // returns anything. That is "I tilt my head right over and even on easy it doesn't see me",
  // and no angle at any setting could have cleared it.
  //
  // Written as a share of MEM_FRAMES so it cannot drift away from the thing it is measured
  // against. Slightly above one frame's honest share (1.0/MEM_FRAMES), because a rotated hit
  // has no memory behind it to corroborate it and each extra angle is another chance for a
  // pattern in the room to score once.
  const TILT_BAR_SHARE = 1.2 / MEM_FRAMES;
  // Keep re-checking the angles for this long after the last face even in a still frame, or
  // the motion gate below would drop a tilted head that then sits perfectly still. A
  // successful tilted find refreshes it, so a leaning head goes on being found.
  const TILT_RECENT_MS = 20000;
  // And how fresh movement has to be to bother looking at all. This is what keeps an empty
  // room cheap: nothing moving, nobody seen lately, no rotated passes.
  const TILT_MOVE_MS = 4000;
  // The upright pass runs as often as the machine allows, but this one must not: it is several
  // cascade runs, and it happens on exactly the frames where nothing else found a face, which
  // is a whole second of them if you are simply reading with your head over. So it is searched
  // a few times a second and the answer stands between searches — a hold just long enough to
  // bridge the gap, not long enough to outlive a head that left.
  const TILT_EVERY_MS = 200;
  const TILT_HOLD_MS = 600;
  let tiltTryAt = 0, tiltAt = 0, tiltBox = null;

  // Searches the frame already sitting in `canvas` at each configured angle, nearest upright
  // first, stopping at the first believable hit. Returns the box in ordinary full-frame
  // coordinates, so nothing downstream has to know a rotation happened.
  function findTilted(w, h, bar) {
    const rolls = looseCfg().rolls;
    if (!rolls.length || !classify) return null;
    const scale = Math.min(1, TILT_SIDE_MAX / Math.max(w, h));
    const rw = Math.max(48, Math.round(w * scale)), rh = Math.max(48, Math.round(h * scale));
    const side = Math.ceil(Math.hypot(rw, rh));
    if (rcanvas.width !== side || rcanvas.height !== side) { rcanvas.width = side; rcanvas.height = side; }
    const inv = w / rw;                     // rotated-canvas pixels back to frame pixels
    const params = {
      shiftfactor: detectParams.shiftfactor,
      minsize: Math.max(32, Math.round(detectParams.minsize / inv)),
      maxsize: side,
      scalefactor: detectParams.scalefactor
    };
    for (let i = 0; i < rolls.length; i++) {
      for (let dir = -1; dir <= 1; dir += 2) {
        const rad = rolls[i] * dir * Math.PI / 180;
        const cos = Math.cos(rad), sin = Math.sin(rad);
        rctx.setTransform(1, 0, 0, 1, 0, 0);
        // Painted black rather than cleared: transparent corners come back as zero alpha,
        // and the grey conversion would hand the cascade a hard edge to chew on.
        rctx.fillStyle = "#000";
        rctx.fillRect(0, 0, side, side);
        rctx.translate(side / 2, side / 2);
        rctx.rotate(-rad);
        rctx.drawImage(canvas, -rw / 2, -rh / 2, rw, rh);
        rctx.setTransform(1, 0, 0, 1, 0, 0);
        const gray = rgbaToGrayscale(rctx.getImageData(0, 0, side, side).data, side, side);
        const dets = pico.cluster_detections(
          pico.run_cascade({ pixels: gray, nrows: side, ncols: side, ldim: side }, classify, params), 0.2);
        let best = 0, br = 0, bc = 0, bs = 0;
        for (let k = 0; k < dets.length; k++) {
          if (dets[k][3] > best) { best = dets[k][3]; br = dets[k][0]; bc = dets[k][1]; bs = dets[k][2]; }
        }
        if (best <= bar * TILT_BAR_SHARE) continue;
        // Scored well enough — now prove it is a face.
        //
        // This pass is where a false positive is most likely, by construction: ten rotations
        // of the frame, several times a second, each one an independent chance for something
        // to walk a path through the tree, and one frame's score behind it with no memory to
        // corroborate. The upright pass gets five frames of agreement; this gets one.
        //
        // So it is asked for both measurements, not just contrast. The frame in front of the
        // cascade here has been turned so that a leaning head is upright in it — which means
        // the eye band is horizontal in these coordinates and the band test is asked in the
        // one place it is valid.
        const q = faceCheck(gray, side, side, br, bc, bs);
        if (!q.ok || q.eyeDrop < FACE_EYE_DROP) continue;
        // Undo the rotation for the centre point: the draw turned the frame by -rad about the
        // canvas centre, so turning this offset by +rad puts it back on the frame.
        const ux = bc - side / 2, uy = br - side / 2;
        const col = (ux * cos - uy * sin + rw / 2) * inv;
        const row = (ux * sin + uy * cos + rh / 2) * inv;
        // A hit whose centre lands outside the picture is the cascade finding a face in the
        // black padding, which is not a face.
        if (col < 0 || col > w || row < 0 || row > h) continue;
        return { row, col, size: bs * inv, score: best, roll: rolls[i] * dir };
      }
    }
    return null;
  }

  // No upright face. Walk down the rungs the dial has unlocked, strongest evidence first, and
  // return the first that holds. At strict it unlocks nothing and this returns null on the
  // first line, which is the old behaviour exactly.
  function looseSeen(w, h, bar, now) {
    const cfg = looseCfg();

    // Rung 1: a tilted head. Still a real face, found by looking at the frame sideways.
    if (cfg.rolls.length &&
        (movingRecently(now, TILT_MOVE_MS) || (lastFaceAt && now - lastFaceAt <= TILT_RECENT_MS))) {
      if (now - tiltTryAt >= TILT_EVERY_MS) {
        tiltTryAt = now;
        // A failed search clears the hold at once. Only a hit is allowed to stand, and only
        // until the next search comes round.
        tiltBox = findTilted(w, h, bar);
        tiltAt = tiltBox ? now : 0;
      }
      if (tiltAt && now - tiltAt <= TILT_HOLD_MS) return { kind: "tilt", box: tiltBox };
    }

    // Everything below is presence without a face, so it can only ever extend a sighting that
    // actually happened. Nothing here can start the clock on its own.
    if (!lastFaceAt) return null;
    // And if we know what the room looks like empty, and this is it, then it is. That beats
    // every rung below — a draught moving a curtain is not somebody working.
    if (occupied() === false) return null;
    // The picture no longer holds what it held when your face was last in it. Whatever posture
    // the dial has been told to forgive, this is not a posture — it is an absence, and it is
    // checked at every setting including easy for that reason. The dial decides how much
    // evidence of you is enough; it does not get to decide that no evidence is enough.
    if (gone(now)) return null;
    // And whatever is where your face was, it has no detail in it — so it is not your face, and
    // it is not a posture either. A lamp shade held up, a sheet of card, a palm over the lens:
    // all of them are large, flat and bright, and to every rung below this they looked like "no
    // face, but the picture is changing", which is the head-down rung's entire evidence.
    if (blankOverFace()) return null;
    // One ceiling, checked once, covering every rung below. No faceless rung is unbounded at
    // any setting: what the dial changes is how long you may go without showing your face at
    // all, not whether you ever have to. Every rung here is inference, and a ceiling is what
    // keeps an inference from becoming a permanent claim. It is cheap to satisfy — a single
    // glance up at the screen is a real face, and the ceiling starts again.
    if (cfg.anchor && now - lastFaceAt > cfg.anchor) return null;

    // Rung 2: head down over the desk. No face at any angle, so the evidence is a picture that
    // is still changing — writing, turning a page, shifting in the chair.
    if (cfg.down && movingRecently(now, cfg.down)) {
      return { kind: "down", box: null };
    }

    // Rung 3: just being there, in any posture, moving or not. Carried by the empty-room
    // comparison where we have one; where we don't, by patience — a picture that has not
    // changed in this long is a room, not a person.
    if (cfg.body && (occupied() === true || stillFor(now) <= cfg.body)) {
      return { kind: "body", box: null };
    }
    return null;
  }
  // Movement this fresh stands in for the head-movement check while no face angle is readable.
  // It is the same question that check asks — person or photograph — answered from the whole
  // picture instead of from a box we haven't got.
  const LOOSE_MOVE_MS = 2500;

  // ---------------- the detection loop ----------------
  const detectParams = { shiftfactor: 0.1, minsize: 80, maxsize: 1000, scalefactor: 1.1 };
  let lastDetectAt = 0;

  // How often we're willing to look, decided from how long a look actually costs here.
  //
  // A fixed gap is either too slow or too greedy, because the cost depends on the camera's
  // resolution and the machine: the same 80ms was leaving a fast laptop idle between frames
  // while being most of the budget on a slow one. The real floor is the camera — a frame every
  // 33ms at 30fps, and nothing can know your face has gone before a frame shows it gone — so
  // the aim is to get down to that floor wherever the machine allows it, and to back off on its
  // own where it doesn't.
  //
  // Held at about a third of one core: look no more often than three times what a look costs.
  // This frame runs beside whatever site you are working on, and a face check that makes a page
  // stutter has cost more than it gained.
  const DETECT_GAP_MIN_MS = 25;       // ~40 looks a second: past the camera, no point going lower
  const DETECT_GAP_MAX_MS = 120;      // a slow machine still gets a usable answer
  const DETECT_DUTY = 3;
  let detectCostMs = 20;              // seeded pessimistically; the first real look corrects it
  let detectGapMs = 70;
  function noteDetectCost(ms) {
    // Smoothed, so one slow frame — a garbage-collection pause, a busy moment — doesn't halve
    // the rate for the rest of the session.
    detectCostMs = detectCostMs * 0.8 + ms * 0.2;
    detectGapMs = Math.max(DETECT_GAP_MIN_MS,
                           Math.min(DETECT_GAP_MAX_MS, Math.round(detectCostMs * DETECT_DUTY)));
  }

  // What a single frame must show to count as "still something there". A fraction of the average
  // contribution, not the average itself: a face that only just clears your sensitivity setting
  // contributes about a fifth of the bar per frame, and demanding exactly that would keep
  // dropping people who are only just over the line. An empty frame scores exactly 0 —
  // run_cascade only keeps windows it scored above zero — so what this really separates is
  // "something is there" from "nothing at all".
  const RAW_SEEN_SHARE = 0.5 / MEM_FRAMES;
  // Consecutive empty frames before we say you've gone. One is a dropped frame: a blink, a head
  // turn, a bad exposure. Two is you.
  const RAW_MISS_LIMIT = 2;
  let rawMisses = RAW_MISS_LIMIT;      // "gone" until a frame says otherwise

  // Separate from lastDetectAt: this one only says "we TRIED", and it drives the throttle.
  // lastDetectAt means "we SUCCEEDED", and only that counts as the detector being alive.
  let lastTryAt = 0;

  // One verdict, said once, to the status line and to the page around this frame.
  function verdict(present, reason, cls, w, h, face, eyes) {
    // One painter, with or without a face. This used to clear the canvas when there was none,
    // which is right for the markers — there is nothing to mark — and wrong for the focus box:
    // no face is exactly when you need to be shown where to put yours.
    drawMarkers(w, h, face, eyes || [], cls);
    setStatus(reason, cls);
    // Painted here rather than from notePace, so the number beside the words can never
    // contradict them: notePace runs before the eye, blink and movement checks have had their
    // say, and this runs after all of them.
    paintPaceTag(present);
    // The reason travels on a pass as well as on a stop. "face ✓ tilted" and "face ✓ looking
    // down" are the interesting case: the clock IS running, and the words are what tell you the
    // upright detector lost you and a weaker rung is carrying it. The card outside this frame
    // used to hardcode "face ✓" for anything that passed, which threw exactly that away.
    //
    // The speed rides along on the same message, on every pass, rather than being stored or sent
    // on a timer of its own. It is a claim about the frame that produced this verdict, so it
    // belongs to this verdict — and a reading that cannot outlive the page that made it needs no
    // freshness rules anywhere downstream.
    //
    // `boxed` is sent separately from the number and is not redundant: with paceSlow set to 1
    // both speeds are the same, so the multiplier alone cannot say whether you are in the box.
    // null means "the feature is off, so no opinion", which is a third answer, not a false.
    post("face", { present: !!present, reason: camReason,
                   pace: paceOn ? paceNow : 1,
                   boxed: paceOn ? focusIn : null,
                   reach: paceOn ? Math.round(focusReach * 100) : null });
  }

  function detectOnce() {
    const now = Date.now();
    if (!ready || detecting || now - lastTryAt < detectGapMs) return;
    lastTryAt = now;
    detecting = true;
    // Only a look that reached the cascade counts towards the cost. The early returns below are
    // free, and letting them into the average would drive the gap to its floor and then spin
    // there doing nothing.
    let classified = 0;
    try {
      // A paused or stalled video still draws — drawImage happily hands back the last frame it
      // had. The cascade then succeeds on that frozen picture, the freshness stamp refreshes,
      // and presence stays true off a still image. So the video has to actually be playing
      // before any of this means anything.
      if (v.paused || v.ended || v.readyState < 2) {
        try { v.play(); } catch (e) {}
        return;
      }
      const w = v.videoWidth || 320, h = v.videoHeight || 240;
      if (!w || !h) return;
      canvas.width = w; canvas.height = h;
      ctx.drawImage(v, 0, 0, w, h);
      const rgba = ctx.getImageData(0, 0, w, h).data;
      const image = { pixels: rgbaToGrayscale(rgba, h, w), nrows: h, ncols: w, ldim: w };
      // Every frame, whether or not a face turns up in it. The moment a face IS lost is the
      // moment "was anything moving just now" has to already be answered — working it out only
      // once needed would compare the first faceless frame against nothing.
      noteMotion(image.pixels, w, h, now);
      classified = performance.now();
      const raw = pico.run_cascade(image, classify, detectParams);
      // This frame on its own, before the five-frame memory is folded in. Clustered on a copy,
      // because cluster_detections sorts what it is given and the memory is holding that same
      // array.
      let rawBest = 0;
      const solo = pico.cluster_detections(raw.slice(), 0.2);
      for (let i = 0; i < solo.length; i++) if (solo[i][3] > rawBest) rawBest = solo[i][3];

      const dets = pico.cluster_detections(updateMemory(raw), 0.2);
      let best = 0, bestCol = w / 2, bestRow = h / 2, bestSize = 0;
      for (let i = 0; i < dets.length; i++) {
        if (dets[i][3] > best) { best = dets[i][3]; bestRow = dets[i][0]; bestCol = dets[i][1]; bestSize = dets[i][2]; }
      }
      // Past this point a frame really has been read and classified, so the detector is provably
      // alive. Anything above here can still have failed.
      lastDetectAt = now;
      const bar = qualBar();
      rawMisses = rawBest > bar * RAW_SEEN_SHARE ? 0 : rawMisses + 1;

      // Two questions, deliberately answered differently.
      //
      // Are you there? Still the calibrated five-frame score, so nothing is easier to fool than
      // it was — plus a shortcut for a frame that clears the whole bar on its own, which is MORE
      // evidence than the smoothed test asks for and so can be believed at once. That shortcut
      // is most of the delay on the way back gone.
      //
      // Have you gone? The current frame, not the memory. pico's memory holds up to four frames
      // of you after you have actually left, and waiting for that to drain was most of the
      // second it took for the clock to stop.
      //
      // Contrast only for this one. The band test is a lighting assumption and this path already
      // has five frames of agreement behind it, so the cheap certain half is enough here and the
      // fussy half is left to the rotated pass, which has neither. A false negative here stops
      // your clock while you are sitting in front of it, which is the expensive way to be wrong.
      const upright = faceCheck(image.pixels, w, h, bestRow, bestCol, bestSize);
      const seen = (best > bar || rawBest > bar) && rawMisses < RAW_MISS_LIMIT && upright.ok;
      // Only asked when the upright answer is no, so on a normal frame this costs nothing, and
      // at sensitivity 1 it is not asked at all.
      const loose = seen ? null : looseSeen(w, h, bar, now);
      // A real face, so this frame is what "you, in your chair" looks like. Photographed here so
      // the faceless rungs have something honest to be measured against — see gone() — along
      // with where the face was and how much detail was in it, for blankOverFace().
      if (seen) { lastFaceAt = now; noteFaceScene(w, h, { row: bestRow, col: bestCol, size: bestSize }); }

      if (!seen && !loose) {
        // Measure afresh when you come back. The jump between where your face was and wherever
        // it reappears is not movement you made — and crediting it would hand out a free pass
        // for covering the lens and uncovering it, which is the one thing a photograph can also
        // do.
        liveness.seeded = false;
        // Nothing can be judged about eyes or blinks with no face to read them from, so those
        // two deadlines start again from when you come back rather than counting your absence
        // against you. The clock is already stopped by the missing face.
        watchFresh(eyeWatch);
        watchFresh(blinkWatch);
        eyeWasOpen = true;
        eyeClosedAt = 0;
        // Learned for the face that just left. Whoever comes back — or the same person under a
        // different lamp — gets measured afresh rather than against someone else's eyes.
        blinkBase = 0;
        // Straight back to 1, not ramped down: there is nothing in the picture to be near or far
        // from. The clock is stopped by the missing face anyway, so any other number here would
        // be a claim about an empty frame.
        resetPace();
        verdict(false, "no face", "bad", w, h, null, null);
        return;
      }

      if (loose) {
        // You are here, but not at an angle anything below this line can read. The eye and blink
        // checks need pupils in a known place and get neither from a head on its side nor from a
        // scalp, so they are held fresh rather than failed — failing them would stop the clock
        // for exactly the posture this branch exists to allow.
        rawMisses = 0;
        // ONLY a tilted find refreshes this, and the distinction is the whole reason the faceless
        // rungs are safe. A tilt is a real face: the cascade scored it, just with the frame
        // turned. "Head down" and "you're there" are not faces at all — they are guesses that
        // lean on a face having been seen recently. Refreshing it for all three quietly disables
        // every limit built on top of it: the rungs are ceilinged at now - lastFaceAt and the
        // empty-room reference is only learned after a stretch with no face, so an empty room
        // with anything moving in it — a curtain, a fan, a webcam's own grain in low light —
        // would hold the clock open indefinitely.
        if (loose.kind === "tilt") { lastFaceAt = now; noteFaceScene(w, h, loose.box); }
        watchFresh(eyeWatch);
        watchFresh(blinkWatch);
        eyeWasOpen = true;
        eyeClosedAt = 0;
        // The box, when there is one, comes off a shrunk and rotated copy, so its numbers aren't
        // comparable with the upright ones the movement check has been collecting. Measure afresh
        // from the next upright frame instead of reading a rotation as travel.
        liveness.seeded = false;
        // Slow speed for all three of these rungs, and `null` rather than the tilted box on
        // purpose. A leaning head can be large and dead centre, so passing its box here would
        // let you earn the fast speed with your head on its shoulder — and the gesture this
        // feature rewards is facing the camera, not merely being close to it. The other two
        // rungs have no box at all: a scalp over a notebook and a body in a chair are guesses
        // that a face was recently seen, which is not the same as one being seen now.
        if (paceOn) notePace(w, h, null);
        if (liveness.enabled) {
          // Same question, different evidence: a photograph can't make the picture move.
          //
          // The bottom rung is exempt, and has to be. It exists because the dial was set to
          // "however you're sitting, even dead still" — asking for a movement there would take
          // back the one thing that rung grants.
          if (loose.kind === "body" || movingRecently(now, LOOSE_MOVE_MS)) watchBeat(liveness, now);
          else if (watchOverdue(liveness, now)) {
            verdict(false, "move your head", "wait", w, h, loose.box, null);
            return;
          }
        }
        // Worded so it's clear the clock is running and why it looks like it shouldn't be.
        verdict(true, loose.kind === "tilt" ? "face ✓ tilted"
                    : loose.kind === "down" ? "face ✓ looking down"
                    : "you're there ✓", "ok", w, h, loose.box, null);
        return;
      }

      // Measured once per frame and reused, so the markers can never disagree with the verdict
      // underneath them.
      const faceBox = { row: bestRow, col: bestCol, size: bestSize };
      // A real, upright face: the one case where the box test means anything. Placed here, above
      // the movement, eye and blink checks, because it must describe THIS frame — those checks
      // return early, and a multiplier that only updated on frames that passed all of them would
      // hold its last value through every "move your head" and every blink. The clock is already
      // stopped on those frames, so the number is not being applied; it just has to be right when
      // the clock starts again.
      if (paceOn) notePace(w, h, faceBox);
      // Also read when the blink check is on: a blink is measured from the same open/closed
      // signal the eye check uses, so there is nothing extra to compute for it.
      const eyeRead = (overlayOn || eyeRequired || blinkRequired)
        ? analyseEyes(image.pixels, w, h, bestRow, bestCol, bestSize)
        : { ok: true, open: true, centred: true, lidShut: false, score: 0, eyes: [] };
      if (blinkRequired || eyeRequired) noteBlink(eyeRead, now);

      // Liveness: are you a person, or a photograph propped in front of the lens? Watched
      // continuously rather than asked about — see the note on `liveness`.
      if (liveness.enabled) {
        if (!liveness.seeded) seedMovement(bestCol, bestRow, bestSize);
        noteMovement(bestCol, bestRow, bestSize, w, h, now);
        if (movedBy(w, h) >= moveNeeded()) {
          // Moved. The deadline slides forward and measurement restarts from here, so the same
          // movement can't be counted twice.
          watchBeat(liveness, now);
          seedMovement(bestCol, bestRow, bestSize);
        } else if (watchOverdue(liveness, now)) {
          verdict(false, "move your head", "wait", w, h, faceBox, eyeRead.eyes);
          return;
        }
      }

      // Eyes open and pointed at the screen — on the same sliding deadline as the rest. Every
      // frame where they are counts, so a glance away, a blink, or a look down at your keyboard
      // costs nothing; only a whole interval of not looking at the screen stops the clock.
      if (eyeRequired) {
        if (eyeRead.ok) watchBeat(eyeWatch, now);
        if (watchOverdue(eyeWatch, now)) {
          verdict(false, eyeRead.open ? "look at the screen" : "eyes closed", "bad", w, h, faceBox, eyeRead.eyes);
          return;
        }
      }

      // Blink at least once an interval.
      if (blinkRequired && watchOverdue(blinkWatch, now)) {
        verdict(false, "blink", "wait", w, h, faceBox, eyeRead.eyes);
        return;
      }

      verdict(true, "face ✓", "ok", w, h, faceBox, eyeRead.eyes);
    } catch (e) {
      // A throw must never leave a stale "face present" standing. The timestamp used to be
      // stamped before the work, so anything that threw every frame — a bad frame through the
      // cascade, a failed getImageData — kept refreshing the freshness stamp while the last
      // verdict stood, and presence went on being reported as true indefinitely. Every throw
      // now posts a stop of its own, so silence is never mistaken for a pass.
      setStatus("camera trouble", "bad");
      // Back to 1 along with the stop. A throw means we do not know what is in front of the lens,
      // and the last multiplier we happened to reach is not an answer to that.
      resetPace();
      paintPaceTag(false);
      post("face", { present: false, reason: "camera trouble", pace: 1, boxed: null });
    } finally {
      detecting = false;
      if (classified) noteDetectCost(performance.now() - classified);
    }
  }

  // Driven by the camera where the browser will say when a frame has arrived, and by a timer
  // where it won't. requestVideoFrameCallback is the honest signal — there is no point looking
  // at the same frame twice, and no way to know a face has gone before a frame shows it gone —
  // but it stops firing when the frame is hidden, so the timer stays as the fallback.
  let detectTimer = 0;
  function scheduleDetection() {
    if (v.requestVideoFrameCallback) {
      const onFrame = () => {
        detectOnce();
        try { v.requestVideoFrameCallback(onFrame); } catch (e) {}
      };
      try { v.requestVideoFrameCallback(onFrame); } catch (e) {}
    }
    // The gap moves with the measured cost, so this cannot be a setInterval fixed at load.
    clearTimeout(detectTimer);
    const loop = () => {
      detectOnce();
      detectTimer = setTimeout(loop, Math.max(DETECT_GAP_MIN_MS, detectGapMs));
    };
    detectTimer = setTimeout(loop, detectGapMs);
  }

  async function start() {
    // 1) Camera
    setStatus("starting…", "wait");
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: { width: 320, height: 240, facingMode: "user" }, audio: false
      });
    } catch (e) {
      setStatus("allow camera", "bad");
      post("status", { state: "cam" });
      return;
    }
    v.srcObject = stream;
    try { await v.play(); } catch (e) {}
    await new Promise(res => {
      if (v.readyState >= 2) return res();
      v.onloadeddata = () => res();
      setTimeout(res, 1500);
    });

    // 2) Library check
    if (typeof pico === "undefined") {
      setStatus("lib error", "bad");
      post("status", { state: "lib" });
      return;
    }

    // 3) Load the face-finder cascade (small binary, same-origin fetch)
    setStatus("loading…", "wait");
    try {
      const url = (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.getURL)
        ? chrome.runtime.getURL("lib/facefinder") : "lib/facefinder";
      const resp = await fetch(url);
      const buf = await resp.arrayBuffer();
      classify = pico.unpack_cascade(new Int8Array(buf));
      if (!classify) throw new Error("cascade unpack failed");
    } catch (e) {
      setStatus("model error", "bad");
      post("status", { state: "model" });
      return;
    }

    // Five frames, and the number is not free to change: QUAL_BY_SENS is calibrated against
    // this sum, and RAW_SEEN_SHARE and TILT_BAR_SHARE are both written as shares of it. It was
    // three here while the sensitivity bars were the five-frame ones, which quietly made every
    // setting stricter than its label. What used to be the cost of five frames — a slow "no
    // face" after you really left — is paid for instead by RAW_MISS_LIMIT, which asks the
    // current frame rather than the memory.
    updateMemory = pico.instantiate_detection_memory(MEM_FRAMES);
    ready = true;
    setStatus("looking…", "wait");
    post("status", { state: "ready" });
    scheduleDetection();
  }

  // Let the webcam go when this frame is torn down. Nothing stopped the tracks before, so the
  // recording light could stay on after the page was done with it — which flatly contradicts the
  // promise this page makes about the camera.
  window.addEventListener("pagehide", () => {
    ready = false;
    clearTimeout(detectTimer);
    try {
      const s = v && v.srcObject;
      if (s && s.getTracks) s.getTracks().forEach(t => { try { t.stop(); } catch (e) {} });
      if (v) v.srcObject = null;
    } catch (e) {}
  });

  start();
})();
