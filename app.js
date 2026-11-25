'use strict';

const SVG_NS = 'http://www.w3.org/2000/svg';
const $ = (id) => document.getElementById(id);

const plane = $('plane');
const rose = $('rose');
const lettersG = $('letters');
const speedEl = $('speed');
const unitEl = $('unit');
const statusEl = $('status');
const headingDegEl = $('headingDeg');
const headingDirEl = $('headingDir');

const DEMO = new URLSearchParams(location.search).has('demo');
const MAX_TILT = 82; // degrees; keeps the ring from collapsing to a line

/* ---------- Build the dial ---------- */

function el(name, attrs, parent) {
  const n = document.createElementNS(SVG_NS, name);
  for (const k in attrs) n.setAttribute(k, attrs[k]);
  if (parent) parent.appendChild(n);
  return n;
}

(function buildDial() {
  const ticks = $('ticks');
  const R = 440;
  for (let a = 0; a < 360; a += 2) {
    const major = a % 30 === 0;
    const mid = a % 10 === 0;
    const len = major ? 34 : mid ? 28 : 24;
    el('line', {
      x1: 0, y1: -R, x2: 0, y2: -R + len,
      stroke: major ? '#fff' : '#777',
      'stroke-width': major ? 6 : 3,
      'stroke-linecap': 'round',
      transform: `rotate(${a})`,
    }, ticks);
  }

  const labels = $('labels');
  for (let a = 0; a < 360; a += 30) {
    const g = el('g', { transform: `rotate(${a})` }, labels);
    const t = el('text', { x: 0, y: -372 }, g);
    if (a % 90 === 0) t.setAttribute('class', 'major');
    t.textContent = String(a);
  }

  for (const [txt, a] of [['N', 0], ['E', 90], ['S', 180], ['W', 270]]) {
    const t = el('text', { 'data-a': a }, lettersG);
    t.textContent = txt;
  }
})();

/* ---------- State ---------- */

const raw = { heading: null, beta: 0, gamma: 0 };
const view = { heading: 0, beta: 0, gamma: 0 }; // smoothed
let speedKmh = null;
let useMph = false;
try { useMph = localStorage.getItem('unit') === 'mph'; } catch (_) {}

/* ---------- Orientation ---------- */

const rad = (d) => (d * Math.PI) / 180;
const deg = (r) => (r * 180) / Math.PI;
const norm360 = (d) => ((d % 360) + 360) % 360;
const angleDiff = (a, b) => ((((a - b) % 360) + 540) % 360) - 180; // a - b in [-180,180)

// Heading from absolute alpha/beta/gamma (W3C frame: x=east, y=north, z=up).
// Sums the horizontal projections of the device's top edge and its back,
// so it stays stable both when lying flat and when held upright.
function headingFromEuler(alpha, beta, gamma) {
  const a = rad(alpha), b = rad(beta), g = rad(gamma);
  const sA = Math.sin(a), cA = Math.cos(a);
  const sB = Math.sin(b), cB = Math.cos(b);
  const sG = Math.sin(g), cG = Math.cos(g);
  // top edge (device +y)
  const tx = -sA * cB, ty = cA * cB;
  // back of the device (device -z)
  const bx = -cA * sG - sA * sB * cG;
  const by = -sA * sG + cA * sB * cG;
  return norm360(deg(Math.atan2(tx + bx, ty + by)));
}

function screenAngle() {
  if (screen.orientation && typeof screen.orientation.angle === 'number') return screen.orientation.angle;
  return typeof window.orientation === 'number' ? window.orientation : 0;
}

let gotAbsolute = false;

function onOrientation(e, absolute) {
  if (e.beta != null) raw.beta = e.beta;
  if (e.gamma != null) raw.gamma = e.gamma;

  let h = null;
  if (typeof e.webkitCompassHeading === 'number' && e.webkitCompassHeading >= 0) {
    h = e.webkitCompassHeading; // iOS: already true-north-ish, tilt compensated
  } else if ((absolute || e.absolute) && e.alpha != null) {
    h = headingFromEuler(e.alpha, e.beta || 0, e.gamma || 0);
  }
  if (h != null) raw.heading = norm360(h + screenAngle());
}

function startOrientation() {
  if ('ondeviceorientationabsolute' in window) {
    window.addEventListener('deviceorientationabsolute', (e) => { gotAbsolute = true; onOrientation(e, true); });
  }
  window.addEventListener('deviceorientation', (e) => {
    if (gotAbsolute) { // only take tilt from the relative event
      if (e.beta != null) raw.beta = e.beta;
      if (e.gamma != null) raw.gamma = e.gamma;
      return;
    }
    onOrientation(e, false);
  });
}

/* ---------- Speed (GPS) ---------- */

let lastFix = null;

function haversine(p, q) {
  const R = 6371000;
  const dLat = rad(q.latitude - p.latitude);
  const dLon = rad(q.longitude - p.longitude);
  const s = Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(p.latitude)) * Math.cos(rad(q.latitude)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

function onPosition(pos) {
  const c = pos.coords;
  let mps = (typeof c.speed === 'number' && !Number.isNaN(c.speed)) ? c.speed : null;

  if (mps == null && lastFix) {
    const dt = (pos.timestamp - lastFix.timestamp) / 1000;
    const d = haversine(lastFix.coords, c);
    // ignore movement smaller than the GPS uncertainty
    if (dt > 0.5) mps = d > Math.max(c.accuracy, lastFix.coords.accuracy) ? d / dt : 0;
  }
  lastFix = pos;

  if (mps != null) {
    const kmh = Math.max(0, mps * 3.6);
    speedKmh = speedKmh == null ? kmh : speedKmh * 0.4 + kmh * 0.6;
  }
  statusEl.textContent = `GPS ±${Math.round(c.accuracy)} m`;
  renderSpeed();
}

function onPositionError(err) {
  const msg = {
    1: 'אין הרשאת מיקום – אפשר אותה בהגדרות הדפדפן',
    2: 'המיקום לא זמין',
    3: 'מחכה ל-GPS…',
  }[err.code] || err.message;
  statusEl.textContent = msg;
}

function startGps() {
  if (!('geolocation' in navigator)) {
    statusEl.textContent = 'הדפדפן לא תומך במיקום';
    return;
  }
  navigator.geolocation.watchPosition(onPosition, onPositionError, {
    enableHighAccuracy: true,
    maximumAge: 0,
    timeout: 15000,
  });
}

function renderSpeed() {
  if (speedKmh == null) { speedEl.textContent = '--'; return; }
  let v = useMph ? speedKmh / 1.609344 : speedKmh;
  if (v < 1) v = 0;
  speedEl.textContent = String(Math.round(v));
  unitEl.textContent = useMph ? 'mph' : 'km/h';
}

unitEl.addEventListener('click', () => {
  useMph = !useMph;
  try { localStorage.setItem('unit', useMph ? 'mph' : 'kmh'); } catch (_) {}
  renderSpeed();
  unitEl.textContent = useMph ? 'mph' : 'km/h';
});

/* ---------- Render loop ---------- */

const DIRS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

function frame() {
  if (DEMO) demoTick();

  if (raw.heading != null) {
    view.heading = norm360(view.heading + angleDiff(raw.heading, view.heading) * 0.18);
  }
  view.beta += (raw.beta - view.beta) * 0.2;
  view.gamma += (raw.gamma - view.gamma) * 0.2;

  // Counter-rotate the ring so it stays parallel to the ground.
  const b = clamp(view.beta, -MAX_TILT, MAX_TILT);
  const g = clamp(view.gamma, -MAX_TILT, MAX_TILT);
  plane.style.transform = `rotateY(${-g}deg) rotateX(${b}deg)`;

  const h = view.heading;
  rose.setAttribute('transform', `rotate(${-h})`);

  // Letters move with the ring but stay upright.
  for (const t of lettersG.children) {
    const a = rad(Number(t.dataset.a) - h);
    t.setAttribute('x', (Math.sin(a) * 272).toFixed(1));
    t.setAttribute('y', (-Math.cos(a) * 272).toFixed(1));
  }

  if (raw.heading != null) {
    const shown = Math.round(h) % 360;
    headingDegEl.textContent = `${shown}°`;
    headingDirEl.textContent = DIRS[Math.round(shown / 45) % 8];
  }
  requestAnimationFrame(frame);
}

/* ---------- Demo mode (?demo) for desktop testing ---------- */

let demoT = 0;
function demoTick() {
  demoT += 1 / 60;
  raw.heading = norm360(287 + Math.sin(demoT * 0.3) * 40);
  raw.beta = 35 + Math.sin(demoT * 0.5) * 30;
  raw.gamma = Math.sin(demoT * 0.37) * 20;
  speedKmh = 48 + Math.sin(demoT * 0.2) * 12;
  renderSpeed();
  statusEl.textContent = 'מצב הדגמה';
}

/* ---------- Start ---------- */

let wakeLock = null;
async function keepAwake() {
  try {
    if ('wakeLock' in navigator) wakeLock = await navigator.wakeLock.request('screen');
  } catch (_) {}
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && wakeLock) keepAwake();
});

async function start() {
  $('start').classList.add('hidden');
  if (DEMO) return;

  // iOS 13+ requires an explicit permission request from a user gesture.
  try {
    if (typeof DeviceOrientationEvent !== 'undefined' &&
        typeof DeviceOrientationEvent.requestPermission === 'function') {
      await DeviceOrientationEvent.requestPermission();
    }
  } catch (_) {}

  startOrientation();
  startGps();
  keepAwake();
}

$('startBtn').addEventListener('click', start);
if (DEMO) start();

if (!window.isSecureContext && !DEMO) {
  statusEl.textContent = 'נדרש HTTPS כדי לגשת למיקום ולחיישנים';
}

if ('serviceWorker' in navigator && window.isSecureContext) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}

requestAnimationFrame(frame);
