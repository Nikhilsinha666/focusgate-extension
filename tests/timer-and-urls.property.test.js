/**
 * Property-Based Testing Suite for FocusGate
 * Validates fundamental system invariants using generative pseudo-randomized inputs.
 */

const assert = require('assert');

// 1. URL Path & Exact Page Invariant Functions
function normalizeUrl(url) {
  try {
    const parsed = new URL(url.startsWith('http') ? url : `https://${url}`);
    return {
      host: parsed.hostname.toLowerCase().replace(/^www\./, ''),
      pathname: parsed.pathname.replace(/\/+$/, '') || '/'
    };
  } catch (e) {
    return null;
  }
}

function isProductiveMatch(targetRule, currentUrl) {
  const normRule = normalizeUrl(targetRule);
  const normCurrent = normalizeUrl(currentUrl);
  if (!normRule || !normCurrent) return false;
  if (normRule.host !== normCurrent.host) return false;

  // Bare domain matches everything on that host
  if (normRule.pathname === '/') return true;

  // Exact page matches the path and any sub-path
  return normCurrent.pathname === normRule.pathname || normCurrent.pathname.startsWith(normRule.pathname + '/');
}

// 2. Countdown Timer State Invariant Function
function updateTimerState(state, deltaSeconds, speedMultiplier) {
  const effectiveDelta = Math.max(0, deltaSeconds * Math.max(0, speedMultiplier));
  const newRemaining = Math.max(0, state.remainingSeconds - effectiveDelta);
  return {
    targetSeconds: state.targetSeconds,
    remainingSeconds: newRemaining,
    isCompleted: newRemaining === 0
  };
}

// -------------------------------------------------------------
// Generative Invariant Verification (Property-Based Tests)
// -------------------------------------------------------------

console.log('Running FocusGate Property-Based Test Suite...\n');

// Invariant 1: Host Isolation Property
// Random queries to unrelated hosts must NEVER match productive target rules.
console.log('Testing Property 1: Host Isolation Invariant...');
const hosts = ['google.com', 'duolingo.com', 'khanacademy.org', 'youtube.com', 'wikipedia.org', 'coursera.org'];
for (let i = 0; i < 500; i++) {
  const h1 = hosts[Math.floor(Math.random() * hosts.length)];
  let h2 = hosts[Math.floor(Math.random() * hosts.length)];
  while (h2 === h1) {
    h2 = hosts[Math.floor(Math.random() * hosts.length)];
  }
  const randomPath = '/' + Math.random().toString(36).substring(2, 8);
  const targetRule = `${h1}/study`;
  const testedUrl = `https://${h2}${randomPath}`;

  assert.strictEqual(
    isProductiveMatch(targetRule, testedUrl),
    false,
    `Property violation: Target ${targetRule} incorrectly matched ${testedUrl}`
  );
}
console.log('  ✓ Invariant 1 Passed (500 generative iterations)');

// Invariant 2: Prefix Monotonicity Property
// If path A is a prefix of path B on the same host, B must match if target is A.
console.log('Testing Property 2: Deep URL Prefix Containment Invariant...');
for (let i = 0; i < 500; i++) {
  const host = hosts[Math.floor(Math.random() * hosts.length)];
  const sub1 = Math.random().toString(36).substring(2, 6);
  const sub2 = Math.random().toString(36).substring(2, 6);
  
  const targetRule = `${host}/${sub1}`;
  const deepUrl = `https://${host}/${sub1}/${sub2}`;

  assert.strictEqual(
    isProductiveMatch(targetRule, deepUrl),
    true,
    `Property violation: Target ${targetRule} failed to match subpath ${deepUrl}`
  );
}
console.log('  ✓ Invariant 2 Passed (500 generative iterations)');

// Invariant 3: Timer Non-Negativity & Monotonicity Invariant
// For any initial remaining time >= 0 and any delta >= 0, remaining time must remain non-negative
// and monotonically non-increasing.
console.log('Testing Property 3: Countdown Non-Negativity & Monotonic Decrement...');
for (let i = 0; i < 1000; i++) {
  const targetSec = Math.floor(Math.random() * 3600);
  let state = {
    targetSeconds: targetSec,
    remainingSeconds: targetSec,
    isCompleted: targetSec === 0
  };

  const steps = Math.floor(Math.random() * 20) + 1;
  for (let s = 0; s < steps; s++) {
    const prevRemaining = state.remainingSeconds;
    const delta = Math.random() * 60; // 0 to 60 seconds
    const speed = Math.random() < 0.2 ? 0 : (Math.random() * 2); // 0x to 2x speed

    state = updateTimerState(state, delta, speed);

    // Invariants:
    assert(state.remainingSeconds >= 0, 'Property violation: Timer remaining went negative');
    assert(state.remainingSeconds <= prevRemaining, 'Property violation: Timer was non-monotonic');
    if (state.remainingSeconds === 0) {
      assert.strictEqual(state.isCompleted, true, 'Property violation: isCompleted must be true when remaining is 0');
    }
  }
}
console.log('  ✓ Invariant 3 Passed (1000 generative iterations)');

// Invariant 4: Day Bitmask Idempotence Invariant
console.log('Testing Property 4: Day-of-Week Schedule Filtering...');
function isDayActive(activeDaysArray, currentDayIndex) {
  return Boolean(activeDaysArray[currentDayIndex]);
}

for (let i = 0; i < 500; i++) {
  const dayIndex = Math.floor(Math.random() * 7);
  const schedule = Array.from({ length: 7 }, () => Math.random() > 0.5);
  const expected = schedule[dayIndex];
  
  assert.strictEqual(
    isDayActive(schedule, dayIndex),
    expected,
    'Property violation: Schedule day check mismatch'
  );
}
console.log('  ✓ Invariant 4 Passed (500 generative iterations)');

console.log('\nAll Property-Based Testing Invariants Verified Successfully! (2500 total random trials)');
