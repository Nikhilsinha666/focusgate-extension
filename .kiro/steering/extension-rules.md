# FocusGate Steering Document: Architectural & Privacy Constraints

## 1. Manifest V3 Service Worker Lifecycle
- The background service worker (`background.js`) must be treated as ephemeral.
- Never rely on persistent global in-memory state in the service worker across browser idling.
- Always persist state transitions (time banks, session flags, locks) directly to `chrome.storage.local`.
- Use `chrome.alarms` rather than long-running `setInterval` for recurring checks and daily resets.

## 2. Privacy & Camera Security Rules
- All webcam processing (face detection, head alignment) must strictly execute on-device in the sandboxed facecam window/content context.
- Under NO circumstances may video frames, canvas snapshots, or biometric data be serialized, saved to disk, or transmitted across network endpoints.
- If camera permissions are revoked, degrade gracefully to inactivity-based tracking without crashing.

## 3. Sandboxing & Isolation
- Content scripts must avoid polluting global page scope on third-party sites (`yt_page_bridge.js` runs in MAIN world only when strictly required for YouTube internal state hooks; all other scripts run in ISOLATED world).
- UI overlays (floating timers, badges) must use scoped CSS prefixes or shadow DOM to prevent host-page CSS leaks.

## 4. Atomic Storage & Consistency
- Read-modify-write cycles to `chrome.storage.local` must be synchronized or batched to prevent race conditions when multiple tabs report elapsed time concurrently.
