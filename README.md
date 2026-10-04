# FocusGate — Earn Your Distraction

A Chrome extension that **blocks distracting websites** until you've spent the **required time on your educational/productive websites or YouTube channels/playlists** for the day.

## Features
- 🎯 **Productive Targets**: Add any website (e.g. `duolingo.com`), an **exact page** (e.g. `drive.google.com/file/d/ABC/view`), a specific **YouTube channel** (e.g. `@veritasium`), or a **YouTube playlist** with custom required time per target — set in **hours / minutes / seconds**.
- 🗂️ **Files on this computer**: add a local file or folder (e.g. `D:\notes\physics.pdf`) and the time counts while you read it in Chrome, exactly like a website. See [Local file targets](#local-file-targets).
- 📍 **Whole site or exact page**: paste a bare domain to count the whole site, or paste a deeper URL to commit to that exact page. With an exact page, anything **deeper** also counts, while **the rest of that site gets locked** until you're done — no loitering on the homepage or slipping into another section. See [Exact-page targets](#exact-page-targets).
- ⏸️ **Anti-cheat inactivity pause**: the productive timer freezes if you stop interacting (no mouse/keyboard/scroll/touch) for a configurable number of seconds, and resumes when you move the mouse. Stops the "leave it open and walk away" cheat.
- 📷 **Anti-cheat face detection**: optionally require a face at the camera for the timer to count down. 100% local (no video leaves your device); pauses when you look away. Combine time + activity + face for the strictest focus lock.
- 🚀 **Speed up the timer when you face the camera**: the one check pointed the other way round — instead of only stopping the clock when you leave, it **rewards** being properly at your desk. A dashed square appears on the camera preview; fill it with your head and the clock runs **faster** (1.5× by default), sit back out of it and it runs **slower** (0.5×). Ten minutes of real work at 1.5× pays fifteen minutes off today's goal. Both speeds and the box size are yours to set, globally or per target. See [Timer speed](#timer-speed).
- 📅 **Which days each site is asked for**: seven chips on every work site — **Mon to Sun**. Set a site to weekdays only and it asks nothing of you at the weekend: no time counted, and it doesn't hold your locked sites shut. See [Days of the week](#days-of-the-week).
- ↕️ **Drag-to-reorder** priority among targets.
- 🚫 **Blocked Sites**: Add sites like `instagram.com`, `youtube.com`, etc. They get redirected to a motivational "earn it first" page until productive targets are met today.
- 🛡 **Whitelist Mode**: Optionally block ALL sites except an allowed list (super-strict mode).
- 🔄 **Live auto-refresh**: When you change settings, all currently-open tabs that match get refreshed and blocked instantly.
- ⏰ **Custom Daily Reset Time** (default 12:00 AM, fully editable).
- ⏱️ **Floating draggable countdown timer** appears on productive sites showing remaining time. Drag it anywhere; minimize it.
- 🔢 **Live toolbar icon badge & dynamic gauge**: Extension icon shows live remaining time across all added sites combined for today (with second-by-second countdown under 1m, and `✓` when done), dynamic progress ring on the icon, and full hover breakdown showing total target, remaining, and completed times.
- 🔒 **Master password protection** for popup AND settings page. Set on first launch. Can be changed.
- 📱 **Mobile app blocking via MacroDroid**: keep selected Android apps blocked until every productive target is met today, using MacroDroid webhooks.
- 💾 **Backup, restore and reset**: save your whole setup to a `.json` file, read one back in, or **reset settings to default**. Reset keeps your password, streak and XP — it clears rules, not what you earned — and is refused while strict mode is on, like importing.
- 💬 **Support links**: Email and WhatsApp.

## Exact-page targets
A productive target can be a whole site **or** one specific page. FocusGate decides based on whether you included a path.

**Bare domain — the whole site counts**

| You add | Counts as productive | Locked |
|---|---|---|
| `duolingo.com` | `duolingo.com`, `/learn`, `/lesson`, `/a/b/c` — everything | nothing extra |

**Deeper URL — that page and anything below it counts; the rest of that site is locked**

| You add | Counts as productive | Locked until done |
|---|---|---|
| `duolingo.com/lesson` | `/lesson`, `/lesson/1`, `/lesson/1/x` | everything else on `duolingo.com` — homepage, `/learn`, … |
| `drive.google.com/drive/folders/ABC` | `…/folders/ABC` and anything under it | `drive.google.com`, `/drive`, `/drive/folders`, `/drive/u/0/home`, `…/folders/OTHER`, … |
| `drive.google.com/file/d/XYZ/view?usp=sharing` | that file view and below | the rest of `drive.google.com` |

Notes:
- Committing to an exact page locks **the whole rest of that host** — pages above it *and* sibling sections — so you can't wander off inside the same site.
- **Query strings and `#fragments` are ignored** when matching, so a share link like `?usp=sharing` still works.
- **Other sites are untouched.** This only restricts the host you committed to.
- Adding **several exact pages on one host** keeps each of their areas open.
- Adding a **bare domain** for the same host opens the whole site again (the permissive rule wins).
- Everything unlocks as soon as that target's time is complete.
- The list shows a **Whole site** or **Exact page** badge so you can tell them apart at a glance.

## Local file targets
Not everything you study is on the web. A PDF, a downloaded lecture, an offline course of HTML pages — open any of them in Chrome and FocusGate can count that time towards today's work.

**Adding one**

| You add | Counts as productive |
|---|---|
| `D:\notes\physics.pdf` | that one file |
| `file:///D:/notes/physics.pdf` | the same thing — paste straight from the address bar |
| `D:\course` (a folder) | every file inside it, at any depth |
| `/Users/me/notes/week1.html` | that file (macOS / Linux) |

Ways to add it:
- **Press 🗂️** beside the address box. It lists the local files you already have open in Chrome, so you can click one instead of typing a path. (Chrome never tells an extension the real path of a file picked from a file dialog, which is why it works this way round.)
- **Paste the address bar** of the open file (`file:///…`), or type a plain path. Backslashes, `%20`, drive-letter case and a trailing slash all describe the same file, so any of them will do. Paths go **one per line** — commas aren't separators here, since a path can contain them.

**One switch to turn on first**

Chrome hides `file:///` pages from every extension until you allow it, so this has to be enabled once:

1. Go to `chrome://extensions/`
2. Open **Details** on FocusGate
3. Turn on **Allow access to file URLs**
4. Reload any local file tab you already had open

FocusGate shows a note in step 1 when this is still off, with a button that takes you to the right page.

Notes:
- Your own files are **never blocked**. A local file can only ever be work to do, not a distraction to lock — including in whitelist mode.
- A local file **locks nothing else**. Unlike an exact web page, committing to `D:\notes\physics.pdf` doesn't shut the rest of your disk.
- A local file behaves **exactly like a website**: the same floating countdown card, the same camera / eye / liveness checks, the same stillness pause, the same ⧉ float-on-top. Chrome runs the page script inside its PDF and image viewers too, so a PDF gets all of it.
- Backstop for anything Chrome renders without a page script: the time is counted from the background while that tab is in front of you and the window fills the screen. If your **camera or stillness checks are on**, that backstop deliberately **pauses instead of counting** — no time is handed out that nothing is watching.
- If the preview box can't be drawn by a particular viewer, the card says so and you can press **⧉** to float the card (and its camera) in its own always-on-top window.
- Everything else behaves as usual: the daily reset, points, streaks and the "everything is done" moment all count local files as work.

## Days of the week
Not every commitment is a daily one. Each work site carries its own row of seven chips, Monday first:

```
duolingo.com                 0s of 30m 0s
────────────────────────────────────────
Mo  Tu  We  Th  Fr  Sa  Su          ← amber = asked for, underlined = today
```

Click a chip to switch that day on or off. New sites start on **every day**, and so does every site you added before this existed — nothing changes until you say so.

**What a day off actually means**

On a day a site isn't asked for, it is treated exactly like a site you switched off:

- no time is counted on it
- it isn't part of today's goal, today's percentage, or the toolbar badge
- it doesn't hold your locked sites shut

That last one is the point. If **nothing** is scheduled for today, today is a day off — your locked sites simply open, rather than being blocked with no way to earn them.

**Notes**

- The row says why it isn't counting: *"not today — Mon–Fri only"*.
- A site needs **at least one day**. Clearing the last one is refused, because a site active on no day could never be finished and would lock your list for ever. "Not at all" is the icon beside its name.
- The day changes at **your** reset time, not at midnight. With the boundary at `04:00`, two in the morning on Tuesday is still Monday's session — so a Monday-only site keeps counting until 4am, which is when its counters actually zero.
- **Dropping** a day needs your password and is refused during strict mode; it's a day you no longer have to do the work. **Adding** one just asks you to confirm.
- Schedules travel in backups and are cleared by **Reset settings to default** along with the sites themselves.

## Timer speed
Every other camera check answers *does this second count*. This one answers *how fast*.

Turn on **Settings → ⚙️ Setup → 📷 Camera → Speed up the timer when I face the camera** and a dashed square appears on the camera preview. Put your head in it and the clock speeds up; sit back out of it and it slows down.

**What "in the box" means**

Two things, checked separately:

| | |
|---|---|
| **Size** | your head has to span at least **85%** of the box's width |
| **Position** | its centre has to sit within **45%** of the way from the middle of the box to its edge |

Both, not one or the other. A small face dead centre is not the same as sitting up close, and an earlier version that measured overlap alone let exactly that through.

**What you see**

- The box is **green** while you are in it and **amber** while you are not.
- When you are out, it says which way to move: *COME CLOSER*, *MOVE LEFT*, *MOVE UP*. The words allow for the mirror, so *MOVE LEFT* means your left.
- A badge in the corner of the preview shows the speed you are being credited at right now — **green** above normal, **amber** below.

**The three settings**

| | Range | Default | What it does |
|---|---|---|---|
| 🚀 Head fills the box | 1× – 4× | **1.5×** | speed while you are in. Leave it at 1× for a penalty with no bonus. |
| 🐢 Head outside the box | 0.1× – 1× | **0.5×** | speed while you are out. Leave it at 1× for a bonus with no penalty. |
| 🔲 Focus box size | 30% – 85% | **55%** | how much of the picture the box covers, so **how close you have to sit**. |

**Setting it: use the preview**

Press **👁 Preview** beside the switch (or just turn the switch on) and your camera opens in a panel at the bottom right of the settings page, with the dashed box drawn on it and the live multiplier in its title bar. **Moving the sliders changes the square as you drag**, so you can find the size you can actually fill without leaving the page. ✕ closes it and releases the camera.

Do use it, because there is no number here that is right for everyone — how much of the frame your head fills depends on your webcam's lens, your desk and how you sit.

**Don't set the box too big**

The detector's box hugs your face, not your whole head, so a head filling the entire picture measures only about **63%** of the frame's height. Being "in" needs 85% of the box covered — which makes a big box far more demanding than it looks. Measured against the real code:

| Your head fills… | box 50% | box 60% | box 70% |
|---|---|---|---|
| 35% of the frame (sitting back) | out, 82% | out, 69% | out, 59% |
| 45% (normal working distance) | **in** | out, 88% | out, 76% |
| 50% | **in** | out, 98% | out, 84% |
| 55% (leaning in) | **in** | **in** | out, 92% |
| 63% (filling the picture) | **in** | **in** | **in** |

So **50–60% is the useful range**. At 70% you have to fill almost the whole picture, which is not a posture anyone holds while working — the timer would sit on the slow speed all session and the feature would look broken.

You never have to guess where you are: when you are outside the box, the card's speed badge and the settings preview both say **how far along you are** ("head at 76% of the size needed"). If that figure sits in the eighties and will not move however far you lean in, the box is too big, not you.

The slider still allows up to 85%, because a wide-angle webcam gives your head less of the frame and a tight one gives more — the ceiling is your camera's, not a number that can be picked for you. Past 65% the settings page says so on the row.

Notes:
- Needs **Face detection** on, and switching this on switches that on too.
- **Off by default.** It is the one setting in FocusGate that can finish a goal in less time than the goal asks for, so strict mode and the password treat turning it **on** as easing a rule off.
- A **tilted head**, a **head down** over a notebook, and simply **being in the chair** all count as the slow speed, however forgiving the sensitivity dial is. Those rungs keep the clock *running*; they are not you facing the camera.
- No face at all means **no multiplier** — exactly 1×, not the slow speed. The clock is already stopped by the missing face.
- The slow speed never stops the clock, however low you set it: the part-seconds are carried, so 0.1× credits a second every ten rather than nothing at all.
- Per target, like the rest of the camera settings (**🛡️** beside a row). Leaning into the camera earns its keep on something you read, and makes no sense on a lecture you watch from across the room.
- Today's total and the toolbar badge count **credited** seconds, so the goal finishes in step with what the timer shows.

## Installation
1. Download and unzip `focusgate.zip`.
2. Open Chrome → `chrome://extensions/`
3. Enable **Developer mode** (top-right toggle).
4. Click **Load unpacked** → select the unzipped `focusgate` folder.
5. Click the FocusGate icon → **set your master password** on first run.
6. Open Settings → add Productive Targets and Blocked Sites.
7. Done. Distractions stay locked until you put in the work.

## Support
- Email: sinhanikhil549@gmail.com
- WhatsApp: +91 76930 75429

## Mobile App Blocking (MacroDroid) Setup
Block apps on your Android phone until you've earned your distraction on the desktop too.

1. Install **MacroDroid** on your phone (free from Play Store).
2. **Lock macro** — New Macro → Trigger: `Connectivity → Webhook (URL)`. Give the event a name like `lock`. Add actions that block your chosen apps, for example:
   - `Applications → Force close application` (loop over each distracting app), or
   - lock the screen / redirect to home launcher when those apps open.
3. **Unlock macro** — New Macro → Trigger: `Webhook (URL)` named `unlock`. Add actions that stop the blocking (disable the lock macro, clear the block flag, etc.).
4. Copy each macro's **webhook URL** (long-press the trigger → it shows a URL like `https://trigger.macrodroid.com/<id>/lock`).
5. In FocusGate: open **Settings → General → Mobile App Blocking (MacroDroid)**, tick **Enable**, paste both URLs, and **Save**.
6. Use **Test Lock / Test Unlock** to confirm your phone reacts.

How it behaves:
- While any productive target is unfinished today, FocusGate calls the **lock** webhook (and re-sends it every minute as a heartbeat).
- The moment all targets are met, it calls the **unlock** webhook.
- At the daily reset time, it locks again automatically.
- FocusGate appends `?state=locked` / `?state=unlocked` to the URL, so you can alternatively use a single macro that reads MacroDroid's `state` webhook variable.

> Requires the phone to be online so it can receive the webhook. MacroDroid handles the actual app-blocking; the desktop only signals lock/unlock.

Made with ⚡ discipline.
