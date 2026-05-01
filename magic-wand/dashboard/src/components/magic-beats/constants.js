export const UNIT = 25;
export const SHOW_BEFORE = 4000;
export const HIT_WINDOW_BEFORE = 260;
export const HIT_WINDOW_AFTER = 550;
// Perfect timing window around onset:
// timeToOnset > 0 means early, < 0 means late.
// Keep early-perfect narrower than HIT_WINDOW_BEFORE so early hits can score near-perfect.
export const PERFECT_WINDOW_EARLY_MS = 160;
export const PERFECT_WINDOW_LATE_MS = 420;
export const BEAT_RADIUS = 70;
export const HIT_RADIUS = BEAT_RADIUS * 1.2;
export const APPROACH_START_RADIUS = 160;
export const SHAPES = ["circle", "heart", "triangle", "square"];

export const BEAT_LAYERS = [
  { scale: 1.0, color: "#ffb43b" },
  { scale: 0.72, color: "#ff6a2d" },
  { scale: 0.48, color: "#d93a6a" },
  { scale: 0.26, color: "#7a1f3a" },
];

export const TRAIL_PALETTE = ["#ff4fa3", "#ff9a5a", "#ffb43b", "#ff6a2d", "#d93a6a", "#ff1e7a"];
export const TRAIL_LIFETIME = 2000;
