import { useEffect, useRef, useState } from "react";
import paper from "paper";
import { io } from "socket.io-client";
import { useIMU } from "../contexts/IMUContext";
import SONGS from "../config/game.json";
import { REACT_APP_SERVER_URL } from "../config";
import MapillaryBg from "./mapillary-bg";

const UNIT = 25;
const SHOW_BEFORE = 4000;
const HIT_WINDOW_AFTER = 400;
const BEAT_RADIUS = 70;
const APPROACH_START_RADIUS = 160;
const SHAPES = ['circle', 'heart', 'triangle', 'square'];

// Concentric layers: outside → in
const BEAT_LAYERS = [
  { scale: 1.00, color: '#ffb43b' }, // orange-mango-shine
  { scale: 0.72, color: '#ff6a2d' }, // orange-tangerine-pop
  { scale: 0.48, color: '#d93a6a' }, // pink-rose-punch
  { scale: 0.26, color: '#7a1f3a' }, // berry-shadow
];

// ─── BEZIER HELPERS ───────────────────────────────────────────────────────────
function evalBezier(b, t) {
  const mt = 1 - t;
  return {
    x: mt*mt*mt*b.from.x + 3*mt*mt*t*b.cp1.x + 3*mt*t*t*b.cp2.x + t*t*t*b.to.x,
    y: mt*mt*mt*b.from.y + 3*mt*mt*t*b.cp1.y + 3*mt*t*t*b.cp2.y + t*t*t*b.to.y,
  };
}

// ─── SHAPE HELPERS ────────────────────────────────────────────────────────────
function createHeartPath(cx, cy, r) {
  const w = r * 1.15;
  const h = r * 1.2;
  const path = new paper.Path();
  path.moveTo(cx, cy + h * 0.5);
  path.cubicCurveTo(
    new paper.Point(cx - w * 0.1, cy + h * 0.1),
    new paper.Point(cx - w, cy - h * 0.05),
    new paper.Point(cx - w * 0.65, cy - h * 0.35)
  );
  path.cubicCurveTo(
    new paper.Point(cx - w * 0.3, cy - h * 0.85),
    new paper.Point(cx + w * 0.2, cy - h * 0.7),
    new paper.Point(cx, cy - h * 0.15)
  );
  path.cubicCurveTo(
    new paper.Point(cx - w * 0.2, cy - h * 0.7),
    new paper.Point(cx + w * 0.3, cy - h * 0.85),
    new paper.Point(cx + w * 0.65, cy - h * 0.35)
  );
  path.cubicCurveTo(
    new paper.Point(cx + w, cy - h * 0.05),
    new paper.Point(cx + w * 0.1, cy + h * 0.1),
    new paper.Point(cx, cy + h * 0.5)
  );
  path.closed = true;
  return path;
}

function createShape(shapeType, cx, cy, r) {
  const center = new paper.Point(cx, cy);
  switch (shapeType) {
    case 'circle':   return new paper.Path.Circle({ center, radius: r });
    case 'triangle': return new paper.Path.RegularPolygon({ center, sides: 3, radius: r });
    case 'square':   return new paper.Path.RegularPolygon({ center, sides: 4, radius: r });
    default:         return createHeartPath(cx, cy, r);
  }
}

function makeBeatGroup(cx, cy, shapeType) {
  const group = new paper.Group();

  for (const { scale, color } of BEAT_LAYERS) {
    const shape = createShape(shapeType, cx, cy, BEAT_RADIUS * scale);
    shape.fillColor = new paper.Color(color);
    shape.strokeColor = null;
    group.addChild(shape);
  }

  // 4-pointed sparkles at diagonals
  for (let i = 0; i < 4; i++) {
    const angle = (45 + i * 90) * (Math.PI / 180);
    const dist = BEAT_RADIUS * 1.45;
    const sparkle = new paper.Path.Star({
      center: new paper.Point(cx + Math.cos(angle) * dist, cy + Math.sin(angle) * dist),
      points: 4,
      radius1: 10,
      radius2: 20,
      fillColor: new paper.Color('#fff1dd'),
      strokeColor: null,
    });
    group.addChild(sparkle);
  }

  return group;
}

function makeApproachGroup(cx, cy, shapeType) {
  const group = new paper.Group();

  // Two concentric stroke outlines — outer orange-mango-shine, inner orange-tangerine-pop
  const outer = createShape(shapeType, cx, cy, BEAT_RADIUS);
  outer.fillColor = null;
  outer.strokeColor = new paper.Color('#ffb43b');
  outer.strokeWidth = 3.5;
  group.addChild(outer);

  const inner = createShape(shapeType, cx, cy, BEAT_RADIUS * 0.82);
  inner.fillColor = null;
  inner.strokeColor = new paper.Color('#ff6a2d');
  inner.strokeWidth = 2;
  group.addChild(inner);

  // Scale up to approach start radius
  const startScale = APPROACH_START_RADIUS / BEAT_RADIUS;
  group.scale(startScale, new paper.Point(cx, cy));

  return group;
}

// ─── SONG SELECTION MODAL ─────────────────────────────────────────────────────
function SongSelectModal({ onStart }) {
  const [selected, setSelected] = useState(null);

  return (
    <div className="absolute inset-0 z-50 flex items-center justify-center bg-cola-brown/85 backdrop-blur-sm">
      <div className="bg-cola-brown border border-cream-soda/15 rounded-2xl p-8 w-full max-w-sm flex flex-col gap-6 shadow-2xl">
        <div>
          <h2 className="text-cream-soda font-mono text-xl font-bold tracking-tight">beat game</h2>
          <p className="text-cream-soda/40 font-mono text-xs mt-1">select a track to play</p>
        </div>

        <div className="flex flex-col gap-2">
          {SONGS.map((song) => (
            <button
              key={song.src}
              type="button"
              onClick={() => setSelected(song)}
              className={`
                flex flex-col gap-0.5 text-left px-4 py-3 rounded-xl border transition-all
                ${selected?.src === song.src
                  ? "border-pink-doll bg-pink-doll/10 text-cream-soda"
                  : "border-cream-soda/10 bg-cream-soda/5 text-cream-soda/70 hover:border-cream-soda/30 hover:text-cream-soda"
                }
              `}
            >
              <span className="font-mono text-sm font-semibold">{song.title}</span>
              <span className="font-mono text-xs text-cream-soda/40">{song.artist} · {song.bpm} BPM</span>
            </button>
          ))}
        </div>

        <button
          type="button"
          disabled={!selected}
          onClick={() => selected && onStart(selected)}
          className={`
            w-full py-3 rounded-xl font-mono text-sm font-bold tracking-widest uppercase transition-all
            ${selected
              ? "bg-pink-doll text-cream-soda hover:bg-pink-hot-ribbon active:scale-95 cursor-pointer"
              : "bg-cream-soda/5 text-cream-soda/20 cursor-not-allowed"
            }
          `}
        >
          {selected ? "start" : "select a track"}
        </button>
      </div>
    </div>
  );
}

// ─── MAIN COMPONENT ───────────────────────────────────────────────────────────
export default function BeatGame({ className }) {
  const canvasRef = useRef(null);
  const { sensorData } = useIMU();

  const [activeSong, setActiveSong] = useState(null);
  const [score, setScore] = useState(0);
  const [gridVisible, setGridVisible] = useState(false);
  const [lastHitPos, setLastHitPos] = useState(null);
  const [mapReady, setMapReady] = useState(false);
  const [showPerfect, setShowPerfect] = useState(false);
  const perfectTimerRef = useRef(null);
  const perfectSfxRef = useRef(null);
  const perfectKeyRef = useRef(0);

  const triggerPerfect = (x, y) => {
    if (!perfectSfxRef.current) {
      perfectSfxRef.current = new Audio('/perfect.mp3');
      perfectSfxRef.current.volume = 0.7;
    }
    perfectSfxRef.current.currentTime = 0;
    perfectSfxRef.current.play().catch(() => {});
    perfectKeyRef.current += 1;
    setShowPerfect({ key: perfectKeyRef.current, x, y });
    clearTimeout(perfectTimerRef.current);
    perfectTimerRef.current = setTimeout(() => setShowPerfect(null), 900);
  };

  const gridLayerRef = useRef(null);
  const gameLayerRef = useRef(null);
  const cursorLayerRef = useRef(null);
  const paperReadyRef = useRef(false);

  const cursorDotRef = useRef(null);
  const cursorLerpRef = useRef(null);
  const cursorTargetRef = useRef(null);
  const cursorCalibratedRef = useRef(false);

  const beatsRef = useRef([]);        // active beats (not yet hit/missed)
  const fadingRef = useRef([]);       // { beatGroup, approachGroup, speed }
  const nextOnsetRef = useRef(null);
  const canvasSizeRef = useRef({ width: 0, height: 0 });
  const gameRafRef = useRef(null);
  const audioRef = useRef(null);

  const trailItemsRef = useRef([]);
  const lastTrailPosRef = useRef(null);
  const trailFrameCountRef = useRef(0);
  const trailStateRef = useRef('normal'); // 'normal' | 'hit' | 'miss'
  const trailStateTimerRef = useRef(null);
  const socketRef = useRef(null);
  const cursorBezierRef = useRef(null);
  const cursorSmoothRef = useRef(null); // EMA-filtered sensor position

  // ─── SETUP PAPER + GRID ────────────────────────────────────────────────────
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    paper.setup(canvas);
    const { width, height } = canvas.getBoundingClientRect();
    canvas.width = width;
    canvas.height = height;
    paper.view.viewSize = new paper.Size(width, height);
    canvasSizeRef.current = { width, height };
    paperReadyRef.current = true;

    gridLayerRef.current = new paper.Layer();
    gameLayerRef.current = new paper.Layer();
    cursorLayerRef.current = new paper.Layer();
    gridLayerRef.current.sendToBack();
    gameLayerRef.current.insertAbove(gridLayerRef.current);
    cursorLayerRef.current.insertAbove(gameLayerRef.current);

    gridLayerRef.current.activate();
    for (let x = 0; x <= width; x += UNIT) {
      new paper.Path.Line({ from: [x, 0], to: [x, height], strokeColor: new paper.Color(1, 0.945, 0.867, 0.15), strokeWidth: 0.5 });
    }
    for (let y = 0; y <= height; y += UNIT) {
      new paper.Path.Line({ from: [0, y], to: [width, y], strokeColor: new paper.Color(1, 0.945, 0.867, 0.15), strokeWidth: 0.5 });
    }
    const cx = Math.round(width / 2 / UNIT) * UNIT;
    const cy = Math.round(height / 2 / UNIT) * UNIT;
    new paper.Path.Line({ from: [0, cy], to: [width, cy], strokeColor: new paper.Color(1, 0.945, 0.867, 0.6), strokeWidth: 1 });
    new paper.Path.Line({ from: [cx, 0], to: [cx, height], strokeColor: new paper.Color(1, 0.945, 0.867, 0.6), strokeWidth: 1 });

    // Grid + axes hidden by default; press H to toggle
    gridLayerRef.current.visible = false;

    paper.view.draw();

    return () => {
      if (gameRafRef.current) cancelAnimationFrame(gameRafRef.current);
      if (audioRef.current) { audioRef.current.pause(); audioRef.current = null; }
      paper.project.clear();
      cursorDotRef.current = null;
      beatsRef.current = [];
      paperReadyRef.current = false;
    };
  }, []);

  // ─── SOCKET ───────────────────────────────────────────────────────────────
  useEffect(() => {
    socketRef.current = io(REACT_APP_SERVER_URL);
    return () => socketRef.current?.disconnect();
  }, []);

  // ─── H KEY: toggle grid ────────────────────────────────────────────────────
  useEffect(() => {
    const handleKey = (e) => {
      if ((e.key === 'h' || e.key === 'H') && gridLayerRef.current) {
        const next = !gridLayerRef.current.visible;
        gridLayerRef.current.visible = next;
        setGridVisible(next);
        paper.view.draw();
      }
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, []);

  // ─── CLICK TO HIT ─────────────────────────────────────────────────────────
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const handleClick = (e) => {
      if (!paperReadyRef.current || !audioRef.current) return;
      const rect = canvas.getBoundingClientRect();
      const cx = e.clientX - rect.left;
      const cy = e.clientY - rect.top;
      const now = audioRef.current.currentTime * 1000;
      for (const beat of beatsRef.current) {
        if (beat.hit || beat.missed) continue;
        const dx = cx - beat.x;
        const dy = cy - beat.y;
        if (Math.sqrt(dx * dx + dy * dy) >= BEAT_RADIUS) continue;
        const timeToOnset = beat.onsetTime - now;
        if (timeToOnset < -HIT_WINDOW_AFTER) continue;
        beat.hit = true;
        for (let i = 0; i < 4 && i < beat.beatGroup.children.length; i++) {
          beat.beatGroup.children[i].fillColor = new paper.Color('#aaff44');
        }
        socketRef.current?.emit('beat-hit', { perfect: true, x: beat.x, y: beat.y });
        triggerPerfect(beat.x, beat.y);
        trailStateRef.current = 'hit';
        clearTimeout(trailStateTimerRef.current);
        trailStateTimerRef.current = setTimeout(() => { trailStateRef.current = 'normal'; }, 1500);
        setScore((s) => s + 30);
        const { width, height } = canvasSizeRef.current;
        setLastHitPos({ xNorm: beat.x / width, yNorm: beat.y / height });
        break;
      }
    };
    canvas.addEventListener('click', handleClick);
    return () => canvas.removeEventListener('click', handleClick);
  }, []);

  // ─── START GAME ────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!activeSong || !paperReadyRef.current) return;

    if (audioRef.current) { audioRef.current.pause(); audioRef.current = null; }
    if (gameLayerRef.current) { gameLayerRef.current.removeChildren(); paper.view.draw(); }
    beatsRef.current = [];
    cursorDotRef.current = null;
    setScore(0);

    const audio = new Audio(activeSong.src);
    audio.volume = 0.8;
    audio.loop = true;
    audio.play().catch((err) => console.warn('Audio play failed:', err));
    audioRef.current = audio;

    const beatInterval = (60 / activeSong.bpm) * 1000;
    nextOnsetRef.current = performance.now() + SHOW_BEFORE + 100;

    let running = true;

    function gameLoop(now) {
      if (!running) return;
      gameRafRef.current = requestAnimationFrame(gameLoop);
      if (!gameLayerRef.current || !cursorLayerRef.current) return;

      const { width, height } = canvasSizeRef.current;

      // ── Bezier cursor ──
      const lerp = cursorLerpRef.current;
      const bezier = cursorBezierRef.current;
      if (bezier && lerp) {
        if (bezier.t < 1) {
          bezier.t = Math.min(1, bezier.t + 0.07);
          const pos = evalBezier(bezier, bezier.t);
          bezier.vel = { x: pos.x - lerp.x, y: pos.y - lerp.y };
          lerp.x = pos.x;
          lerp.y = pos.y;
        }

        const dotColor = cursorCalibratedRef.current
          ? new paper.Color(1, 0.706, 0.231, 0.9)
          : new paper.Color(1, 0.310, 0.639, 0.8);

        cursorLayerRef.current.activate();
        const pt = new paper.Point(lerp.x, lerp.y);
        if (!cursorDotRef.current) {
          cursorDotRef.current = new paper.Path.Circle({
            center: pt,
            radius: 16,
            fillColor: dotColor,
            strokeColor: new paper.Color(1, 0.945, 0.867, 0.6),
            strokeWidth: 2,
          });
        } else {
          cursorDotRef.current.position = pt;
          cursorDotRef.current.fillColor = dotColor;
        }

        // ── Trail ──
        const TRAIL_PALETTE = ['#ff4fa3', '#ff9a5a', '#ffb43b', '#ff6a2d', '#d93a6a', '#ff1e7a'];
        const TRAIL_LIFETIME = 2000;
        const lastPos = lastTrailPosRef.current;
        const moved = lastPos ? Math.hypot(lerp.x - lastPos.x, lerp.y - lastPos.y) : Infinity;

        if (moved > 5) {
          trailFrameCountRef.current++;
          const state = trailStateRef.current;
          const color = state === 'hit'
            ? new paper.Color('#aaff00')
            : state === 'miss'
            ? new paper.Color('#ff4fa3')
            : new paper.Color(TRAIL_PALETTE[trailFrameCountRef.current % TRAIL_PALETTE.length]);

          const trailPath = new paper.Path.Star({
            center: pt,
            points: 4,
            radius1: 6 + Math.random() * 6,
            radius2: 22 + Math.random() * 14,
            fillColor: color,
            strokeColor: null,
          });
          trailPath.rotate(Math.random() * 360, pt);

          trailItemsRef.current.push({ path: trailPath, spawnTime: now });
          lastTrailPosRef.current = { x: lerp.x, y: lerp.y };
        }

        // Decay trail — newer = larger, older = smaller
        const alive = [];
        for (const item of trailItemsRef.current) {
          const age = now - item.spawnTime;
          if (age >= TRAIL_LIFETIME) {
            item.path.remove();
          } else {
            const t = age / TRAIL_LIFETIME;
            item.path.opacity = Math.pow(1 - t, 1.5);
            // absolute scale: newest=1.0, oldest=0.15
            item.path.scaling = new paper.Point(1 - t * 0.85, 1 - t * 0.85);
            alive.push(item);
          }
        }
        trailItemsRef.current = alive;

        cursorDotRef.current.bringToFront();
      }

      // ── Spawn beat ──
      if (nextOnsetRef.current !== null && now >= nextOnsetRef.current - SHOW_BEFORE) {
        const onsetTime = nextOnsetRef.current;
        const margin = BEAT_RADIUS + 20;
        const bx = margin + Math.random() * (width - margin * 2);
        const by = margin + Math.random() * (height - margin * 2);
        const shapeType = SHAPES[Math.floor(Math.random() * SHAPES.length)];

        gameLayerRef.current.activate();

        const approachGroup = makeApproachGroup(bx, by, shapeType);
        const beatGroup = makeBeatGroup(bx, by, shapeType);

        beatsRef.current.push({
          x: bx, y: by, onsetTime,
          approachGroup, approachScale: APPROACH_START_RADIUS / BEAT_RADIUS,
          beatGroup, hit: false, missed: false,
        });
        nextOnsetRef.current = onsetTime + beatInterval;
      }

      // ── Update beats ──
      const cursorX = lerp?.x ?? 0;
      const cursorY = lerp?.y ?? 0;

      // ── Fade out resolved beats ──
      fadingRef.current = fadingRef.current.filter(({ beatGroup, approachGroup, speed }) => {
        beatGroup.opacity = Math.max(0, beatGroup.opacity - speed);
        if (beatGroup.opacity <= 0) {
          beatGroup.remove();
          approachGroup.remove();
          return false;
        }
        return true;
      });

      // ── Update active beats ──
      beatsRef.current = beatsRef.current.filter((beat) => {
        if (!beat.beatGroup || !beat.approachGroup) return false;

        const timeToOnset = beat.onsetTime - now;

        // Gyro hit
        const dx = cursorX - beat.x;
        const dy = cursorY - beat.y;
        const inArea = Math.sqrt(dx * dx + dy * dy) < BEAT_RADIUS;
        const inWindow = timeToOnset > -HIT_WINDOW_AFTER;

        if (inArea && inWindow) {
          const isPerfect = Math.abs(timeToOnset) < 200;
          const hitColor = new paper.Color(isPerfect ? '#aaff44' : '#44dd88');
          for (let i = 0; i < 4 && i < beat.beatGroup.children.length; i++) {
            beat.beatGroup.children[i].fillColor = hitColor;
          }
          beat.approachGroup.opacity = 0;
          socketRef.current?.emit('beat-hit', { perfect: isPerfect, x: beat.x, y: beat.y });
          if (isPerfect) triggerPerfect(beat.x, beat.y);
          trailStateRef.current = 'hit';
          clearTimeout(trailStateTimerRef.current);
          trailStateTimerRef.current = setTimeout(() => { trailStateRef.current = 'normal'; }, 1500);
          setScore((s) => s + (isPerfect ? 30 : 10));
          const { width, height } = canvasSizeRef.current;
          setLastHitPos({ xNorm: beat.x / width, yNorm: beat.y / height });
          fadingRef.current.push({ beatGroup: beat.beatGroup, approachGroup: beat.approachGroup, speed: 0.06 });
          return false;
        }

        // Auto-miss
        if (timeToOnset < -HIT_WINDOW_AFTER) {
          const missColor = new paper.Color('#ff2222');
          for (let i = 0; i < 4 && i < beat.beatGroup.children.length; i++) {
            beat.beatGroup.children[i].fillColor = missColor;
          }
          beat.approachGroup.opacity = 0;
          socketRef.current?.emit('beat-miss', { x: beat.x, y: beat.y });
          trailStateRef.current = 'miss';
          clearTimeout(trailStateTimerRef.current);
          trailStateTimerRef.current = setTimeout(() => { trailStateRef.current = 'normal'; }, 1000);
          fadingRef.current.push({ beatGroup: beat.beatGroup, approachGroup: beat.approachGroup, speed: 0.03 });
          return false;
        }

        // Click hit (already colored by click handler, just move to fading)
        if (beat.hit) {
          beat.approachGroup.opacity = 0;
          fadingRef.current.push({ beatGroup: beat.beatGroup, approachGroup: beat.approachGroup, speed: 0.06 });
          return false;
        }

        // Approach animation — scale delta each frame to avoid cumulative drift
        const progress = Math.max(0, Math.min(1, 1 - timeToOnset / SHOW_BEFORE));
        const pulse = Math.abs(timeToOnset) < 80
          ? 1 + 0.15 * (1 - Math.abs(timeToOnset) / 80)
          : 1;
        const targetR = (APPROACH_START_RADIUS - (APPROACH_START_RADIUS - BEAT_RADIUS) * progress) * pulse;
        const newScale = targetR / BEAT_RADIUS;
        const factor = newScale / beat.approachScale;
        if (Math.abs(factor - 1) > 0.00001) {
          beat.approachGroup.scale(factor, new paper.Point(beat.x, beat.y));
          beat.approachScale = newScale;
        }

        return true;
      });

      paper.view.draw();
    }

    gameRafRef.current = requestAnimationFrame(gameLoop);

    return () => {
      running = false;
      if (gameRafRef.current) { cancelAnimationFrame(gameRafRef.current); gameRafRef.current = null; }
      if (audioRef.current) { audioRef.current.pause(); audioRef.current = null; }
      trailItemsRef.current.forEach(item => item.path?.remove());
      trailItemsRef.current = [];
      fadingRef.current.forEach(({ beatGroup, approachGroup }) => { beatGroup?.remove(); approachGroup?.remove(); });
      fadingRef.current = [];
      lastTrailPosRef.current = null;
      clearTimeout(trailStateTimerRef.current);
      trailStateRef.current = 'normal';
    };
  }, [activeSong]);

  // ─── CURSOR TARGET from sensor data ───────────────────────────────────────
  useEffect(() => {
    if (!sensorData || sensorData.length === 0) return;
    const s = sensorData[sensorData.length - 1];
    if (!s?.sensor || !s?.screenSize) return;
    const { mouseTargetX, mouseTargetY } = s.sensor;
    const { width: screenW, height: screenH } = s.screenSize;
    if (mouseTargetX == null || mouseTargetY == null || !screenW || !screenH) return;

    const { width, height } = canvasSizeRef.current;
    const cx = Math.max(0, Math.min((mouseTargetX / screenW) * width, width));
    const cy = Math.max(0, Math.min((mouseTargetY / screenH) * height, height));
    cursorTargetRef.current = { x: cx, y: cy };
    cursorCalibratedRef.current = !!s.calibrated;

    // EMA pre-filter: smooth the raw sensor position before feeding to bezier
    const EMA = 0.35; // lower = more smoothing, higher = more responsive
    const sm = cursorSmoothRef.current ?? { x: cx, y: cy };
    sm.x = sm.x + (cx - sm.x) * EMA;
    sm.y = sm.y + (cy - sm.y) * EMA;
    cursorSmoothRef.current = sm;

    // Build a cubic bezier from current cursor position to the smoothed target.
    // cp1 extends along the current travel direction (C1 continuity),
    // cp2 arrives tangentially so the join is smooth.
    const prevLerp = cursorLerpRef.current;
    const from = prevLerp ? { x: prevLerp.x, y: prevLerp.y } : { x: sm.x, y: sm.y };
    const tcx = sm.x, tcy = sm.y; // use smoothed target, not raw
    const prevBez = cursorBezierRef.current;
    const vel = prevBez?.vel ?? { x: 0, y: 0 };
    const segLen = Math.max(1, Math.hypot(tcx - from.x, tcy - from.y));
    const velLen = Math.max(0.01, Math.hypot(vel.x, vel.y));
    const TENSION = 0.45;
    cursorBezierRef.current = {
      from,
      cp1: {
        x: from.x + (vel.x / velLen) * segLen * TENSION,
        y: from.y + (vel.y / velLen) * segLen * TENSION,
      },
      cp2: {
        x: tcx - (tcx - from.x) * TENSION,
        y: tcy - (tcy - from.y) * TENSION,
      },
      to: { x: tcx, y: tcy },
      t: 0,
      vel,
    };
    if (!cursorLerpRef.current) cursorLerpRef.current = { x: tcx, y: tcy };
  }, [sensorData]);

  return (
    <div className={`retro-text absolute top-0 left-0 w-full h-full ${className ?? ''}`}>
      <MapillaryBg className="z-0" lastHitPos={lastHitPos} active={!!activeSong} onReady={() => setMapReady(true)} />
      <canvas ref={canvasRef} resize="true" className="absolute inset-0 w-full h-full bg-transparent z-10" />

      {activeSong && gridVisible && (
        <div className="absolute top-2 left-1/2 -translate-x-1/2 bg-cola-brown/60 text-cream-soda font-mono text-xs px-4 py-1.5 rounded-full flex items-center gap-4">
          <span className="pointer-events-none">{activeSong.title} — {activeSong.artist}</span>
          <span className="text-cream-soda/30 pointer-events-none">|</span>
          <span className="text-pink-doll font-bold tabular-nums pointer-events-none">{score} pts</span>
          <button
            type="button"
            onClick={() => setActiveSong(null)}
            className="text-cream-soda/50 hover:text-cream-soda transition ml-1 leading-none"
            title="Back to menu"
          >↩</button>
        </div>
      )}

      {showPerfect && (
        <div
          key={showPerfect.key}
          className="absolute pointer-events-none z-20"
          style={{ left: showPerfect.x, top: showPerfect.y, transform: 'translate(-50%, -130%)' }}
        >
          <span
            className="retro-text text-4xl font-bold tracking-widest whitespace-nowrap"
            style={{ animation: 'perfectPop 0.9s ease-out forwards' }}
          >
            PERFECT!
          </span>
        </div>
      )}

      {/* key hints */}
      <div className="absolute bottom-2 right-2 text-cream-soda/30 font-mono text-[10px] pointer-events-none">
        H: grid · P: pixel
      </div>

      {!activeSong && mapReady && <SongSelectModal onStart={(song) => setActiveSong(song)} />}
    </div>
  );
}
