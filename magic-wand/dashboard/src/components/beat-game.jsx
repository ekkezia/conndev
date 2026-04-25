import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import paper from "paper";
import { io } from "socket.io-client";
import { useIMU } from "../contexts/IMUContext";
import SONGS from "../config/game.json";
import { REACT_APP_SERVER_URL, CANVAS_RATIO, SFX } from "../config";
import MapillaryBg from "./mapillary-bg";

// ─── AUDIO HELPERS ────────────────────────────────────────────────────────────
// Uses Web Audio API so sounds can play from anywhere (not just gesture handlers).
// AudioContext is created + resumed on first user gesture, then stays unlocked.
let _audioCtx = null;
const _audioBuffers = {};

function getAudioCtx() {
  if (!_audioCtx) _audioCtx = new (window.AudioContext || window['webkitAudioContext'])();
  return _audioCtx;
}

async function preloadSfx(src) {
  if (_audioBuffers[src]) return;
  try {
    const ctx = getAudioCtx();
    const res = await fetch(src);
    const raw = await res.arrayBuffer();
    _audioBuffers[src] = await ctx.decodeAudioData(raw);
  } catch {}
}

function playSfx(src, vol = 0.7) {
  try {
    const ctx = getAudioCtx();
    if (ctx.state === 'suspended') ctx.resume();
    const buf = _audioBuffers[src];
    if (!buf) return;
    const source = ctx.createBufferSource();
    source.buffer = buf;
    const gain = ctx.createGain();
    gain.gain.value = vol;
    source.connect(gain);
    gain.connect(ctx.destination);
    source.start(0);
  } catch {}
}

const UNIT = 25;
const SHOW_BEFORE = 4000;
const HIT_WINDOW_BEFORE = 260;
const HIT_WINDOW_AFTER = 550;
const PERFECT_WINDOW_MS = 320;
const BEAT_RADIUS = 70;
const HIT_RADIUS = BEAT_RADIUS * 1.2;
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

// ─── STAR TRACE (full-screen, wand-cursor driven) ────────────────────────────
const TRAIL_PALETTE = ['#ff4fa3', '#ff9a5a', '#ffb43b', '#ff6a2d', '#d93a6a', '#ff1e7a'];
const TRAIL_LIFETIME = 2000;

function svgStarPoints(cx, cy, r1, r2, rotDeg) {
  return Array.from({ length: 8 }, (_, i) => {
    const angle = (rotDeg + i * 45) * Math.PI / 180;
    const r = i % 2 === 0 ? r2 : r1;
    return `${cx + r * Math.cos(angle)},${cy + r * Math.sin(angle)}`;
  }).join(' ');
}

// Generate dots evenly spaced along the 10-segment star perimeter
function generateStarDots(cx, cy, R, r, dotsPerSegment) {
  const verts = Array.from({ length: 10 }, (_, i) => {
    const angle = (-90 + i * 36) * Math.PI / 180;
    const rad = i % 2 === 0 ? R : r;
    return { x: cx + rad * Math.cos(angle), y: cy + rad * Math.sin(angle) };
  });
  const dots = [];
  for (let seg = 0; seg < 10; seg++) {
    const from = verts[seg], to = verts[(seg + 1) % 10];
    for (let j = 0; j < dotsPerSegment; j++) {
      const t = j / dotsPerSegment;
      dots.push({ x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t });
    }
  }
  return dots;
}

// ─── SHARED WAND CURSOR HOOK ─────────────────────────────────────────────────
// Merges server wand cursor + mouse fallback; drives the sparkle trail.
function useWandCursor(cursor, canvasRect) {
  const [mousePos, setMousePos] = useState(null);
  const [clickKey, setClickKey] = useState(0);
  const [trailItems, setTrailItems] = useState([]);
  const trailRef = useRef([]);
  const lastTrailPosRef = useRef(null);
  const trailFrameRef = useRef(0);
  const cursorRef = useRef(null);

  // Mouse inside the canvas acts as a local debug override.
  // Otherwise, fall back to the Arduino-driven cursor.
  const activeCursor = mousePos ?? cursor;
  useEffect(() => { cursorRef.current = activeCursor; }, [activeCursor]);

  useEffect(() => {
    let rafId;
    function loop(now) {
      rafId = requestAnimationFrame(loop);
      const cur = cursorRef.current;
      if (cur) {
        const last = lastTrailPosRef.current;
        const moved = last ? Math.hypot(cur.x - last.x, cur.y - last.y) : Infinity;
        if (moved > 5) {
          trailFrameRef.current++;
          trailRef.current.push({
            id: trailFrameRef.current,
            x: cur.x, y: cur.y, spawnTime: now,
            color: TRAIL_PALETTE[trailFrameRef.current % TRAIL_PALETTE.length],
            r1: 12 + Math.random() * 10,
            r2: 38 + Math.random() * 22,
            rot: Math.random() * 360,
          });
          lastTrailPosRef.current = { x: cur.x, y: cur.y };
        }
      }
      const alive = trailRef.current.filter(item => now - item.spawnTime < TRAIL_LIFETIME);
      trailRef.current = alive;
      setTrailItems(alive.map(item => ({ ...item, age: now - item.spawnTime })));
    }
    rafId = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(rafId);
  }, []);

  const onMouseMove = useCallback((e) => {
    if (!canvasRect) {
      setMousePos({ x: e.clientX, y: e.clientY });
      return;
    }
    const insideCanvas =
      e.clientX >= canvasRect.x &&
      e.clientX <= canvasRect.x + canvasRect.width &&
      e.clientY >= canvasRect.y &&
      e.clientY <= canvasRect.y + canvasRect.height;
    if (!insideCanvas) {
      setMousePos(null);
      return;
    }
    setMousePos({ x: e.clientX, y: e.clientY });
  }, [canvasRect]);
  const onMouseLeave = useCallback(() => setMousePos(null), []);
  const triggerClick = useCallback(() => {
    playSfx(SFX.click, 0.5);
    setClickKey(k => k + 1);
  }, []);
  return { activeCursor, trailItems, onMouseMove, onMouseLeave, clickKey, triggerClick };
}

// Reusable SVG trail + cursor dot (renders into an existing SVG)
function WandCursorSVG({ activeCursor, trailItems, clickKey = 0 }) {
  const scaleAnimRef = useRef(null);
  const colorAnimRef = useRef(null);

  useEffect(() => {
    if (clickKey > 0) {
      scaleAnimRef.current?.beginElement();
      colorAnimRef.current?.beginElement();
    }
  }, [clickKey]);

  return (
    <>
      {trailItems.map(item => {
        const t = item.age / TRAIL_LIFETIME;
        return (
          <polygon
            key={item.id}
            points={svgStarPoints(item.x, item.y, item.r1, item.r2, item.rot)}
            fill={item.color}
            opacity={Math.pow(1 - t, 1.5)}
            transform={`scale(${1 - t * 0.85})`}
            style={{ transformOrigin: `${item.x}px ${item.y}px` }}
          />
        );
      })}
      {activeCursor && (
        <g transform={`translate(${activeCursor.x},${activeCursor.y})`}>
          <circle cx={0} cy={0} r={28} fill="rgba(255,180,59,0.9)" stroke="rgba(255,241,221,0.6)" strokeWidth="3">
            <animateTransform
              ref={scaleAnimRef}
              attributeName="transform" type="scale"
              values="1;1.9;1" dur="0.35s" begin="indefinite"
              calcMode="spline" keySplines="0.2 0 0.2 1;0.2 0 0.2 1"
            />
            <animate
              ref={colorAnimRef}
              attributeName="fill"
              values="rgba(255,180,59,0.9);rgba(255,70,130,0.95);rgba(255,180,59,0.9)"
              dur="0.35s" begin="indefinite"
            />
          </circle>
        </g>
      )}
    </>
  );
}

function StarTraceScreen({ cursor, canvasRect, onComplete, onPerfectTraceHit }) {
  const [hitCount, setHitCount] = useState(0);
  const hitRef = useRef(0);
  const doneRef = useRef(false);
  const { activeCursor, trailItems, onMouseMove, onMouseLeave, clickKey, triggerClick } = useWandCursor(cursor, canvasRect);

  // 50 dots total (5 per segment × 10 segments) along the star perimeter
  // Centered inside the canvas rect, which is letterboxed within the viewport
  const dots = useMemo(() => {
    const rect = canvasRect ?? { x: 0, y: 0, width: window.innerWidth, height: window.innerHeight };
    const cx = rect.x + rect.width  / 2;
    const cy = rect.y + rect.height / 2;
    const R  = Math.min(rect.width, rect.height) * 0.32;
    const r  = R * 0.38;
    return generateStarDots(cx, cy, R, r, 5);
  }, [canvasRect]);

  // Hit detection: cursor must pass through dots in order
  useEffect(() => {
    if (!activeCursor || doneRef.current || hitRef.current >= dots.length) return;
    const pt = dots[hitRef.current];
    if (Math.hypot(activeCursor.x - pt.x, activeCursor.y - pt.y) < 45) {
      hitRef.current += 1;
      setHitCount(hitRef.current);
      playSfx(SFX.starHit, 0.6);
      onPerfectTraceHit?.(pt.x, pt.y);
      if (hitRef.current >= dots.length) {
        doneRef.current = true;
        playSfx(SFX.magic, 0.75);
        setTimeout(onComplete, 500);
      }
    }
  }, [activeCursor, dots, onComplete, onPerfectTraceHit]);

  const pct = Math.round((hitCount / dots.length) * 100);

  return (
    <div
      className="absolute inset-0 z-50 bg-cola-brown/85 backdrop-blur-sm"
      onMouseMove={onMouseMove}
      onMouseLeave={onMouseLeave}
      onClick={triggerClick}
    >
      <svg className="absolute inset-0 w-full h-full overflow-visible pointer-events-none">
        <WandCursorSVG activeCursor={activeCursor} trailItems={trailItems} clickKey={clickKey} />
        {/* star perimeter dots */}
        {dots.map((pt, i) => {
          const isHit = i < hitCount;
          const isNext = i === hitCount;
          return (
            <circle
              key={i}
              cx={pt.x} cy={pt.y}
              r={isNext ? 9 : 5}
              fill={isHit ? '#4ade80' : isNext ? 'rgba(255,255,255,0.9)' : 'rgba(255,255,255,0.28)'}
            />
          );
        })}
      </svg>
      <div
        className="absolute text-center pointer-events-none"
        style={canvasRect
          ? { left: canvasRect.x, width: canvasRect.width, top: canvasRect.y + canvasRect.height - 40 }
          : { left: 0, right: 0, bottom: 40 }}
      >
        <p className="text-cream-soda/45 font-mono text-sm tracking-widest uppercase">
          {hitCount === 0 ? 'trace the star to begin' : hitCount < dots.length ? `${pct}%` : 'unlocked!'}
        </p>
      </div>
    </div>
  );
}

// ─── SONG SELECTION OVERLAY ───────────────────────────────────────────────────
function SongSelectOverlay({ cursor, canvasRect, onStart }) {
  const [selected, setSelected] = useState(null);
  const { activeCursor, trailItems, onMouseMove, onMouseLeave, clickKey, triggerClick } = useWandCursor(cursor, canvasRect);

  return (
    <div
      className="absolute inset-0 z-50 flex items-center justify-center bg-cola-brown/75 backdrop-blur-sm"
      onMouseMove={onMouseMove}
      onMouseLeave={onMouseLeave}
      onClick={triggerClick}
    >
      <svg className="absolute inset-0 w-full h-full overflow-visible pointer-events-none">
        <WandCursorSVG activeCursor={activeCursor} trailItems={trailItems} clickKey={clickKey} />
      </svg>
      <div className="p-10 w-full max-w-lg flex flex-col gap-6">
        <div>
          <h2 className="text-cream-soda font-mono text-2xl font-bold tracking-tight">beat game</h2>
          <p className="text-cream-soda/40 font-mono text-xs mt-1">select a track to play</p>
        </div>

        <div className="flex flex-col gap-2">
          {SONGS.map((song) => (
            <button
              key={song.src}
              type="button"
              onClick={() => setSelected(song)}
              className={`
                beat-menu-option flex flex-col gap-0.5 text-left px-4 py-3 rounded-xl border transition-all duration-150
                ${selected?.src === song.src
                  ? "is-selected text-cream-soda"
                  : "is-idle text-cream-soda/95"
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
            beat-menu-start w-full py-3 rounded-xl font-mono text-sm font-bold tracking-widest uppercase transition-all duration-150
            ${selected
              ? "is-ready text-cream-soda active:scale-95 cursor-pointer"
              : "is-disabled text-cream-soda/80 cursor-not-allowed"
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
  const [traced, setTraced] = useState(false);
  const [menuCursor, setMenuCursor] = useState(null);
  const [canvasRect, setCanvasRect] = useState(null);
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
      perfectSfxRef.current = new Audio(SFX.perfect);
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

  const canvasRectRef = useRef(null);

  const cursorDotRef = useRef(null);
  const cursorDotScaleRef = useRef(1);
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

  const emitPerfectTraceHit = useCallback((x, y) => {
    socketRef.current?.emit('beat-hit', { perfect: true, x, y, source: 'star-trace' });
  }, []);
  const cursorBezierRef = useRef(null);
  const cursorClickTimeRef = useRef(-Infinity);
  const cursorSmoothRef = useRef(null); // EMA-filtered sensor position

  const setCursorDotScale = useCallback((nextScale) => {
    const dot = cursorDotRef.current;
    if (!dot) return;
    const currentScale = cursorDotScaleRef.current || 1;
    const safeNext = Math.max(0.05, nextScale);
    const factor = safeNext / currentScale;
    if (!Number.isFinite(factor) || Math.abs(factor - 1) < 0.0001) return;
    dot.scale(factor);
    cursorDotScaleRef.current = safeNext;
  }, []);

  // ─── SETUP PAPER + GRID ────────────────────────────────────────────────────
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    paper.setup(canvas);
    const viewW = window.innerWidth;
    const viewH = window.innerHeight;
    const height = viewW / viewH >= CANVAS_RATIO ? viewH : viewW / CANVAS_RATIO;
    const width  = height * CANVAS_RATIO;
    const left   = Math.round((viewW - width)  / 2);
    const top    = Math.round((viewH - height) / 2);
    canvas.style.left   = left   + 'px';
    canvas.style.top    = top    + 'px';
    canvas.style.width  = width  + 'px';
    canvas.style.height = height + 'px';
    canvas.width  = width;
    canvas.height = height;
    paper.view.viewSize = new paper.Size(width, height);
    canvasSizeRef.current = { width, height };
    const rect = { x: left, y: top, width, height };
    setCanvasRect(rect);
    canvasRectRef.current = rect;
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

    function onResize() {
      const vW = window.innerWidth, vH = window.innerHeight;
      const h = vW / vH >= CANVAS_RATIO ? vH : vW / CANVAS_RATIO;
      const w = h * CANVAS_RATIO;
      const l = Math.round((vW - w) / 2);
      const t = Math.round((vH - h) / 2);
      canvas.style.left = l + 'px'; canvas.style.top = t + 'px';
      canvas.style.width = w + 'px'; canvas.style.height = h + 'px';
      canvas.width = w; canvas.height = h;
      paper.view.viewSize = new paper.Size(w, h);
      canvasSizeRef.current = { width: w, height: h };
      const r = { x: l, y: t, width: w, height: h };
      setCanvasRect(r);
      canvasRectRef.current = r;
    }
    window.addEventListener('resize', onResize);

    return () => {
      window.removeEventListener('resize', onResize);
      if (gameRafRef.current) cancelAnimationFrame(gameRafRef.current);
      if (audioRef.current) { audioRef.current.pause(); audioRef.current = null; }
      paper.project.clear();
      cursorDotRef.current = null;
      beatsRef.current = [];
      paperReadyRef.current = false;
    };
  }, []);

  // ─── PRELOAD SFX ──────────────────────────────────────────────────────────
  useEffect(() => { Object.values(SFX).forEach(preloadSfx); }, []);

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
        if (Math.sqrt(dx * dx + dy * dy) >= HIT_RADIUS) continue;
        const timeToOnset = beat.onsetTime - now;
        const inWindow =
          timeToOnset <= HIT_WINDOW_BEFORE && timeToOnset >= -HIT_WINDOW_AFTER;
        if (!inWindow) continue;
        const isPerfect = Math.abs(timeToOnset) <= PERFECT_WINDOW_MS;
        beat.hit = true;
        const hitColor = new paper.Color(isPerfect ? '#aaff44' : '#44dd88');
        for (let i = 0; i < 4 && i < beat.beatGroup.children.length; i++) {
          beat.beatGroup.children[i].fillColor = hitColor;
        }
        socketRef.current?.emit('beat-hit', { perfect: isPerfect, x: beat.x, y: beat.y });
        if (isPerfect) triggerPerfect(beat.x, beat.y);
        cursorClickTimeRef.current = performance.now();
        trailStateRef.current = 'hit';
        clearTimeout(trailStateTimerRef.current);
        trailStateTimerRef.current = setTimeout(() => { trailStateRef.current = 'normal'; }, 1500);
        setScore((s) => s + (isPerfect ? 30 : 10));
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
            radius: 28,
            fillColor: dotColor,
            strokeColor: new paper.Color(1, 0.945, 0.867, 0.6),
            strokeWidth: 3,
          });
          cursorDotScaleRef.current = 1;
        } else {
          cursorDotRef.current.position = pt;
          const clickAge = now - cursorClickTimeRef.current;
          if (clickAge < 350) {
            const t = clickAge / 350;
            const pulse = t < 0.4 ? 1 + (t / 0.4) * 0.9 : 1 + (1 - (t - 0.4) / 0.6) * 0.9;
            setCursorDotScale(pulse);
            cursorDotRef.current.fillColor = t < 0.5
              ? new paper.Color(1, 0.275, 0.51, 0.95)
              : dotColor;
          } else {
            setCursorDotScale(1);
            cursorDotRef.current.fillColor = dotColor;
          }
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
            radius1: 12 + Math.random() * 10,
            radius2: 38 + Math.random() * 22,
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
        const inArea = Math.sqrt(dx * dx + dy * dy) < HIT_RADIUS;
        const inWindow =
          timeToOnset <= HIT_WINDOW_BEFORE && timeToOnset >= -HIT_WINDOW_AFTER;

        if (inArea && inWindow) {
          const isPerfect = Math.abs(timeToOnset) <= PERFECT_WINDOW_MS;
          const hitColor = new paper.Color(isPerfect ? '#aaff44' : '#44dd88');
          for (let i = 0; i < 4 && i < beat.beatGroup.children.length; i++) {
            beat.beatGroup.children[i].fillColor = hitColor;
          }
          beat.approachGroup.opacity = 0;
          socketRef.current?.emit('beat-hit', { perfect: isPerfect, x: beat.x, y: beat.y });
          if (isPerfect) triggerPerfect(beat.x, beat.y);
          cursorClickTimeRef.current = performance.now();
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
      if (gameLayerRef.current) gameLayerRef.current.removeChildren();
      if (cursorLayerRef.current) cursorLayerRef.current.removeChildren();
      beatsRef.current = [];
      cursorDotRef.current = null;
      cursorDotScaleRef.current = 1;
      lastTrailPosRef.current = null;
      clearTimeout(trailStateTimerRef.current);
      trailStateRef.current = 'normal';
    };
  }, [activeSong, setCursorDotScale]);

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

  // ─── MENU CURSOR LOOP (bezier playback when no song is active) ────────────
  useEffect(() => {
    if (activeSong) return;
    let rafId;
    function loop() {
      rafId = requestAnimationFrame(loop);
      const lerp = cursorLerpRef.current;
      const bezier = cursorBezierRef.current;
      if (!lerp || !bezier) {
        setMenuCursor((prev) => (prev ? null : prev));
        return;
      }
      if (bezier.t < 1) {
        bezier.t = Math.min(1, bezier.t + 0.07);
        const pos = evalBezier(bezier, bezier.t);
        bezier.vel = { x: pos.x - lerp.x, y: pos.y - lerp.y };
        lerp.x = pos.x;
        lerp.y = pos.y;
      }
      const off = canvasRectRef.current;
      setMenuCursor({ x: lerp.x + (off?.x ?? 0), y: lerp.y + (off?.y ?? 0) });
    }
    rafId = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(rafId);
  }, [activeSong]);

  // Ensure no stale game artifacts remain visible in menu mode.
  useEffect(() => {
    if (activeSong || !paperReadyRef.current) return;

    if (gameLayerRef.current) gameLayerRef.current.removeChildren();
    if (cursorLayerRef.current) cursorLayerRef.current.removeChildren();

    beatsRef.current = [];
    fadingRef.current = [];
    trailItemsRef.current = [];
    cursorDotRef.current = null;
    cursorDotScaleRef.current = 1;
    lastTrailPosRef.current = null;
    cursorClickTimeRef.current = -Infinity;

    paper.view.draw();
  }, [activeSong]);

  return (
    <div className={`retro-text absolute top-0 left-0 w-full h-full ${className ?? ''}`}>
      <div
        className="absolute z-0"
        style={canvasRect
          ? { left: canvasRect.x, top: canvasRect.y, width: canvasRect.width, height: canvasRect.height }
          : { inset: 0 }}
      >
        <MapillaryBg lastHitPos={lastHitPos} active={!!activeSong} onReady={() => setMapReady(true)} />
      </div>
      <canvas ref={canvasRef} resize="true" className="absolute bg-transparent z-10" />

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

      {gridVisible && sensorData && sensorData.length > 0 && (
        <div className="absolute top-12 left-1/2 -translate-x-1/2 bg-black/60 text-yellow-300 font-mono text-xs px-2 py-1 rounded pointer-events-none flex flex-col gap-0.5 items-center z-30">
          {(() => {
            const s = sensorData[sensorData.length - 1];
            return (
              <>
                {s?.sensor?.sensitivity != null && (
                  <div className="w-48 flex items-center gap-2">
                    <span className="text-cyan-300 text-[10px] whitespace-nowrap">sensitivity</span>
                    <div className="flex-1 h-2 bg-black border border-cyan-300 rounded overflow-hidden">
                      <div className="h-full bg-gradient-to-r from-cyan-500 to-cyan-300"
                        style={{ width: `${(s.sensor.sensitivity / 10) * 100}%` }} />
                    </div>
                    <span className="text-cyan-300 text-[10px] w-6 text-right">{s.sensor.sensitivity.toFixed(1)}</span>
                  </div>
                )}
                {s?.sensor != null && (
                  <span className="text-green-300">
                    🎯 x: {s.sensor.mouseTargetX?.toFixed(2) ?? '—'} y: {s.sensor.mouseTargetY?.toFixed(2) ?? '—'}
                  </span>
                )}
                {canvasRect && (
                  <span className="text-yellow-200/60 text-[10px]">
                    canvas {Math.round(canvasRect.width)}×{Math.round(canvasRect.height)} @ ({Math.round(canvasRect.x)},{Math.round(canvasRect.y)})
                  </span>
                )}
              </>
            );
          })()}
        </div>
      )}

      {showPerfect && (
        <div
          key={showPerfect.key}
          className="absolute pointer-events-none z-20"
          style={{ left: (canvasRect?.x ?? 0) + showPerfect.x, top: (canvasRect?.y ?? 0) + showPerfect.y, transform: 'translate(-50%, -130%)' }}
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

      {!activeSong && mapReady && !traced && (
        <StarTraceScreen
          cursor={menuCursor}
          canvasRect={canvasRect}
          onComplete={() => setTraced(true)}
          onPerfectTraceHit={emitPerfectTraceHit}
        />
      )}
      {!activeSong && mapReady && traced && (
        <SongSelectOverlay
          cursor={menuCursor}
          canvasRect={canvasRect}
          onStart={(song) => setActiveSong(song)}
        />
      )}
    </div>
  );
}
