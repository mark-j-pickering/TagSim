// Analog wheel + pedal input (e.g. a Moza R5 base with pedals) via the browser Gamepad API.
//
// Mapping and calibration are NOT configured here — they're whatever public/input-tester.html saved
// to localStorage (key `tagsim.input.<gamepad id>`, one entry per device). localStorage is
// per-origin, so the tester has to be opened from the same server as the sim (the header's "Input
// Tester" button does exactly that) for the sim to see its mappings.
//
// steerValue/pedalValue below are copies of the tester's own normalisation functions — the tester
// is a dependency-free standalone page and can't import this module. Keep the two in sync: if the
// tester's normalisation changes, the sim would otherwise read a calibration differently from how
// the tester displayed it.

const STORE_PREFIX = "tagsim.input.";
const ROLES = ["steer", "throttle", "brake"];
// Horn = this button on the steering device (Moza R5 setup: button 19). The tester doesn't map
// buttons yet; a saved config can override it with a `hornButton` index.
const DEFAULT_HORN_BUTTON = 19;

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

function applyDeadzone(v, dz) {
  const a = Math.abs(v);
  if (a <= dz) return 0;
  return (Math.sign(v) * (a - dz)) / (1 - dz);
}

// -1 (full left) .. 1 (full right), centre-referenced so an asymmetric calibration still reads 0 at
// the recorded centre.
function steerValue(pad, c) {
  const v = pad.axes[c.axis];
  let n = v >= c.center
    ? (v - c.center) / Math.max(1e-6, c.max - c.center)
    : (v - c.center) / Math.max(1e-6, c.center - c.min);
  n = clamp(n, -1, 1);
  if (c.invert) n = -n;
  return applyDeadzone(n, c.deadzone);
}

// 0 (released) .. 1 (fully pressed).
function pedalValue(pad, c) {
  const span = c.full - c.rest;
  if (Math.abs(span) < 1e-6) return 0;
  const n = clamp((pad.axes[c.axis] - c.rest) / span, 0, 1);
  return n <= c.deadzone ? 0 : (n - c.deadzone) / (1 - c.deadzone);
}

// All saved device mappings, keyed by gamepad id. Cheap enough to call on demand (a handful of
// localStorage reads) — callers re-run it on the `storage` event (the tester tab saving a change)
// and on `gamepadconnected`, not every frame.
export function loadWheelConfigs() {
  const out = {};
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (!key || !key.startsWith(STORE_PREFIX)) continue;
      try {
        out[key.slice(STORE_PREFIX.length)] = JSON.parse(localStorage.getItem(key));
      } catch (e) { /* one bad entry shouldn't hide the others */ }
    }
  } catch (e) { /* storage unavailable (private window, blocked site data) — no mappings */ }
  return out;
}

function connectedPads() {
  if (typeof navigator === "undefined" || !navigator.getGamepads) return [];
  return Array.from(navigator.getGamepads()).filter(Boolean);
}

// For each role, the first connected pad whose saved mapping covers it. Roles may come from
// different devices — some pedal sets enumerate as their own USB device rather than as extra axes
// on the wheel base.
function resolveRoles(configs) {
  const roles = {};
  for (const pad of connectedPads()) {
    const cfg = configs[pad.id];
    if (!cfg) continue;
    for (const role of ROLES) {
      const c = cfg[role];
      if (!roles[role] && c && c.axis != null && pad.axes[c.axis] != null) roles[role] = { pad, c };
    }
  }
  return roles;
}

// Live values this frame. Each is null when that role isn't mapped on any connected device, so the
// caller can tell "pedal released" (0) apart from "no pedal at all" (null).
export function readWheelInput(configs) {
  const roles = resolveRoles(configs);
  return {
    steer: roles.steer ? steerValue(roles.steer.pad, roles.steer.c) : null,
    throttle: roles.throttle ? pedalValue(roles.throttle.pad, roles.throttle.c) : null,
    brake: roles.brake ? pedalValue(roles.brake.pad, roles.brake.c) : null,
    horn: roles.steer ? hornPressed(roles.steer.pad, configs[roles.steer.pad.id]) : false,
  };
}

function hornPressed(pad, cfg) {
  const b = pad.buttons[cfg.hornButton ?? DEFAULT_HORN_BUTTON];
  return !!b && (b.pressed || b.value > 0.5);
}

// Display-only summary for the side panel: which device(s) are in use and which roles are mapped.
// Returned as a string key so the caller can cheaply skip a setState when nothing changed.
export function describeWheelInput(configs) {
  const pads = connectedPads();
  if (!pads.length) return { key: "none", text: null, mapped: false };
  const roles = resolveRoles(configs);
  const mappedRoles = ROLES.filter((r) => roles[r]);
  if (!mappedRoles.length) {
    return { key: "unmapped:" + pads.map((p) => p.id).join("|"), text: `${shortName(pads[0].id)} — not mapped yet`, mapped: false };
  }
  const names = [...new Set(mappedRoles.map((r) => shortName(roles[r].pad.id)))].join(" + ");
  const text = `${names} — ${mappedRoles.join(", ")}`;
  return { key: text, text, mapped: true };
}

// Gamepad ids look like "MOZA R5 Base (Vendor: 346e Product: 0004)" — drop the vendor/product tail.
function shortName(id) {
  return id.replace(/\s*\(.*$/, "").trim() || id;
}
