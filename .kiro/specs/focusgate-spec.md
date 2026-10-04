# FocusGate Specification Document

## 1. Product Overview
FocusGate is a Chrome Extension (Manifest V3) designed to overcome digital distraction by enforcing an "earn your distraction" behavioral lock. Users define daily educational/productive targets (websites, exact URLs, YouTube channels/playlists, or local files). Non-whitelisted distracting sites remain blocked until all daily target requirements are satisfied.

## 2. Core Functional Specifications

### 2.1 Target Hierarchy & URL Matching Rules
- **Bare Domain Matching**: When a domain without path is added (e.g., `duolingo.com`), all subpaths (`/learn`, `/lesson`, `/courses`) are classified as productive. No other pages on the host are locked.
- **Exact-Page Target Isolation**: When a specific URL path is added (e.g., `drive.google.com/file/d/ABC/view`):
  - Any URL sharing this prefix is considered productive.
  - The rest of that host is locked until the target requirement is fulfilled.
  - Sibling domains and other hosts are unaffected.
  - Query parameters and hash fragments are sanitized prior to evaluation.
- **Local File Targets**: Support for `file:///` URLs (PDFs, local documents) utilizing Chrome file permissions.

### 2.2 Anti-Cheat State Machine
- **Inactivity Pause**:
  - Configurable idle threshold (default: 30 seconds).
  - Listens for user interactions (`mousemove`, `keydown`, `wheel`, `touchstart`).
  - Timer immediately freezes when user is idle, resuming strictly upon verified interaction.
- **Face-Detection Presence Verification**:
  - Utilizes local on-device camera processing.
  - Zero external telemetry or network streaming; all computation occurs in client memory.
  - Head position bounding box: When head is centered in the active box, apply speed multiplier (default: 1.5×); when absent or off-center, throttle to 0.5× or pause.

### 2.3 Schedule and Reset Architecture
- **Day-of-Week Mask**: Bitmask or array [Mon..Sun] determining if a target is active on the current calendar day. Inactive targets do not block access to restricted sites.
- **Daily Reset**: Fully customizable daily reset timestamp (default: 00:00:00). Daily accumulated times roll over and recalculate status atomically.

## 3. Requirements Specification (EARS Notation)
- **REQ-1 (Distraction Interception)**: WHEN an active target requirement is incomplete and the user navigates to a restricted domain THE SYSTEM SHALL redirect or lock the tab to `blocked.html`.
- **REQ-2 (Target Accrual)**: WHEN a user actively browses a whitelisted productive target URL THE SYSTEM SHALL decrement the target remaining countdown timer in real-time.
- **REQ-3 (Inactivity Pause)**: WHEN no user input (`mousemove`, `keydown`, `wheel`) is detected for 30 consecutive seconds THE SYSTEM SHALL pause the target accrual timer until verified user interaction resumes.
- **REQ-4 (Local Facecam Verification)**: WHEN the facecam feature is enabled and the user's face is verified centered in the bounding box THE SYSTEM SHALL apply a 1.5x study speed multiplier.
- **REQ-5 (Privacy Boundary)**: WHILE facecam presence verification is active THE SYSTEM SHALL process all image frames strictly in client memory without transmitting external network requests.
- **REQ-6 (Daily Rollover)**: WHEN the system clock passes the configured daily reset timestamp THE SYSTEM SHALL atomically reset accumulated study times according to the day-of-week schedule mask.

