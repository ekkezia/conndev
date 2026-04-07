import { useEffect, useRef, useState } from "react";
import paper from "paper";
import { useIMU } from "../contexts/IMUContext";
import SONGS from "../config/game.json";

const UNIT = 25;
const SHOW_BEFORE = 4000; // ms before onset to start showing approach circle
const HIT_WINDOW_AFTER = 400; // ms after onset to still register a hit
const BEAT_RADIUS = 70;
const APPROACH_START_RADIUS = 160;

// ─── SONG SELECTION MODAL ─────────────────────────────────────────────────────
function SongSelectModal({ onStart }) {
  const [selected, setSelected] = useState(null);

  return (
    <div className="absolute inset-0 z-50 flex items-center justify-center bg-black/85 backdrop-blur-sm">
      <div className="bg-black border border-white/15 rounded-2xl p-8 w-full max-w-sm flex flex-col gap-6 shadow-2xl">
        <div>
          <h2 className="text-white font-mono text-xl font-bold tracking-tight">beat game</h2>
          <p className="text-white/40 font-mono text-xs mt-1">select a track to play</p>
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
                  ? "border-fuchsia-500 bg-fuchsia-500/10 text-white"
                  : "border-white/10 bg-white/5 text-white/70 hover:border-white/30 hover:text-white"
                }
              `}
            >
              <span className="font-mono text-sm font-semibold">{song.title}</span>
              <span className="font-mono text-xs text-white/40">{song.artist} · {song.bpm} BPM</span>
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
              ? "bg-fuchsia-500 text-white hover:bg-fuchsia-400 active:scale-95 cursor-pointer"
              : "bg-white/5 text-white/20 cursor-not-allowed"
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

  const [activeSong, setActiveSong] = useState(null); // null = show modal
  const [score, setScore] = useState(0);

  // Paper layers
  const gridLayerRef = useRef(null);
  const gameLayerRef = useRef(null);
  const cursorLayerRef = useRef(null);
  const paperReadyRef = useRef(false);

  // Cursor state
  const cursorDotRef = useRef(null);
  const cursorLerpRef = useRef(null);
  const cursorTargetRef = useRef(null);
  const cursorCalibratedRef = useRef(false);

  // Game state
  const beatsRef = useRef([]);
  const nextOnsetRef = useRef(null);
  const canvasSizeRef = useRef({ width: 0, height: 0 });
  const gameRafRef = useRef(null);
  const audioRef = useRef(null);

  // ─── SETUP PAPER + GRID (once on mount) ────────────────────────────────────
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

    // Draw grid
    gridLayerRef.current.activate();
    for (let x = 0; x <= width; x += UNIT) {
      new paper.Path.Line({ from: [x, 0], to: [x, height], strokeColor: new paper.Color(1, 1, 1, 0.15), strokeWidth: 0.5 });
    }
    for (let y = 0; y <= height; y += UNIT) {
      new paper.Path.Line({ from: [0, y], to: [width, y], strokeColor: new paper.Color(1, 1, 1, 0.15), strokeWidth: 0.5 });
    }
    const cx = Math.round(width / 2 / UNIT) * UNIT;
    const cy = Math.round(height / 2 / UNIT) * UNIT;
    new paper.Path.Line({ from: [0, cy], to: [width, cy], strokeColor: new paper.Color(1, 1, 1, 0.6), strokeWidth: 1 });
    new paper.Path.Line({ from: [cx, 0], to: [cx, height], strokeColor: new paper.Color(1, 1, 1, 0.6), strokeWidth: 1 });

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

  // ─── START GAME when activeSong is set ─────────────────────────────────────
  useEffect(() => {
    if (!activeSong || !paperReadyRef.current) return;

    // Stop previous audio
    if (audioRef.current) { audioRef.current.pause(); audioRef.current = null; }

    // Clear leftover beats from a previous run
    if (gameLayerRef.current) {
      gameLayerRef.current.removeChildren();
      paper.view.draw();
    }
    beatsRef.current = [];
    cursorDotRef.current = null;
    setScore(0);

    // Start audio
    const audio = new Audio(activeSong.src);
    audio.volume = 0.8;
    audio.play().catch(() => {});
    audioRef.current = audio;

    const beatInterval = (60 / activeSong.bpm) * 1000;

    // Schedule first beat onset shortly after start
    nextOnsetRef.current = performance.now() + SHOW_BEFORE + 100;

    let running = true;

    function gameLoop(now) {
      if (!running) return;
      gameRafRef.current = requestAnimationFrame(gameLoop);
      if (!gameLayerRef.current || !cursorLayerRef.current) return;

      const { width, height } = canvasSizeRef.current;

      // ── Lerp cursor ──
      const target = cursorTargetRef.current;
      const lerp = cursorLerpRef.current;
      if (target && lerp) {
        const t = 0.22;
        lerp.x += (target.x - lerp.x) * t;
        lerp.y += (target.y - lerp.y) * t;

        const dotColor = cursorCalibratedRef.current
          ? new paper.Color(1, 1, 0, 0.9)      // yellow = calibrated
          : new paper.Color(1, 0, 1, 0.8);     // fuchsia = uncalibrated

        cursorLayerRef.current.activate();
        const pt = new paper.Point(lerp.x, lerp.y);
        if (!cursorDotRef.current) {
          cursorDotRef.current = new paper.Path.Circle({
            center: pt,
            radius: 6,
            fillColor: dotColor,
            strokeColor: new paper.Color(1, 1, 1, 0.6),
            strokeWidth: 1.5,
          });
        } else {
          cursorDotRef.current.position = pt;
          cursorDotRef.current.fillColor = dotColor;
        }
        cursorDotRef.current.bringToFront();
      }

      // ── Spawn beat ──
      if (nextOnsetRef.current !== null && now >= nextOnsetRef.current - SHOW_BEFORE) {
        const onsetTime = nextOnsetRef.current;
        const margin = BEAT_RADIUS + 20;
        const bx = margin + Math.random() * (width - margin * 2);
        const by = margin + Math.random() * (height - margin * 2);

        gameLayerRef.current.activate();

        const approachCircle = new paper.Path.Circle({
          center: new paper.Point(bx, by),
          radius: APPROACH_START_RADIUS,
          strokeColor: new paper.Color(1, 1, 1, 0.7),
          strokeWidth: 2,
          fillColor: null,
        });
        const beatCircle = new paper.Path.Circle({
          center: new paper.Point(bx, by),
          radius: BEAT_RADIUS,
          strokeColor: new paper.Color(1, 1, 1, 0.9),
          strokeWidth: 2,
          fillColor: new paper.Color(1, 1, 1, 0.12),
        });

        beatsRef.current.push({ x: bx, y: by, onsetTime, approachCircle, beatCircle, hit: false, missed: false });
        nextOnsetRef.current = onsetTime + beatInterval;
      }

      // ── Update beats ──
      const cursorX = lerp?.x ?? 0;
      const cursorY = lerp?.y ?? 0;

      beatsRef.current = beatsRef.current.filter((beat) => {
        if (!beat.beatCircle || !beat.approachCircle) return false;

        const timeToOnset = beat.onsetTime - now;

        // Check hit
        if (!beat.hit && !beat.missed) {
          const dx = cursorX - beat.x;
          const dy = cursorY - beat.y;
          const inArea = Math.sqrt(dx * dx + dy * dy) < BEAT_RADIUS;
          const inWindow = timeToOnset > -HIT_WINDOW_AFTER;

          if (inArea && inWindow) {
            beat.hit = true;
            const hue = (beat.x / width) * 360;
            const hitColor = new paper.Color({ hue, saturation: 1, brightness: 1, alpha: 1 });
            // Fill the beat area with hue color, remove stroke so it reads as a solid splash
            beat.beatCircle.fillColor = hitColor;
            beat.beatCircle.strokeColor = null;
            // Hide the approach ring immediately
            beat.approachCircle.opacity = 0;
            setScore((s) => s + 10);
          }
        }

        // Mark missed
        if (!beat.hit && !beat.missed && timeToOnset < -HIT_WINDOW_AFTER) {
          beat.missed = true;
          beat.beatCircle.strokeColor = new paper.Color(1, 0.2, 0.2, 0.8);
          beat.approachCircle.strokeColor = new paper.Color(1, 0.2, 0.2, 0.3);
        }

        // Fade out
        if (beat.hit || beat.missed) {
          const speed = beat.hit ? 0.06 : 0.03;
          beat.beatCircle.opacity = Math.max(0, beat.beatCircle.opacity - speed);
          beat.approachCircle.opacity = Math.max(0, beat.approachCircle.opacity - speed);
          if (beat.beatCircle.opacity <= 0) {
            beat.beatCircle.remove();
            beat.approachCircle.remove();
            return false;
          }
          return true;
        }

        // Approach animation
        const progress = Math.max(0, Math.min(1, 1 - timeToOnset / SHOW_BEFORE));
        const r = APPROACH_START_RADIUS - (APPROACH_START_RADIUS - BEAT_RADIUS) * progress;
        beat.approachCircle.bounds = new paper.Rectangle(beat.x - r, beat.y - r, r * 2, r * 2);

        // Onset pulse
        const pulseR = Math.abs(timeToOnset) < 80
          ? BEAT_RADIUS * (1 + 0.15 * (1 - Math.abs(timeToOnset) / 80))
          : BEAT_RADIUS;
        beat.beatCircle.bounds = new paper.Rectangle(beat.x - pulseR, beat.y - pulseR, pulseR * 2, pulseR * 2);

        return true;
      });

      paper.view.draw();
    }

    gameRafRef.current = requestAnimationFrame(gameLoop);

    return () => {
      running = false;
      if (gameRafRef.current) { cancelAnimationFrame(gameRafRef.current); gameRafRef.current = null; }
      if (audioRef.current) { audioRef.current.pause(); audioRef.current = null; }
    };
  }, [activeSong]);

  // ─── CURSOR TARGET from sensor data ────────────────────────────────────────
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
    if (!cursorLerpRef.current) cursorLerpRef.current = { x: cx, y: cy };
  }, [sensorData]);

  return (
    <div className={`absolute top-0 left-0 w-full h-full ${className ?? ''}`}>
      {/* Canvas always mounted so paper is set up */}
      <canvas ref={canvasRef} resize="true" className="w-full h-full bg-gray-400" />

      {/* HUD */}
      {activeSong && (
        <div className="absolute top-2 left-1/2 -translate-x-1/2 bg-black/60 text-white font-mono text-xs px-4 py-1.5 rounded-full flex items-center gap-4">
          <span className="pointer-events-none">{activeSong.title} — {activeSong.artist}</span>
          <span className="text-white/30 pointer-events-none">|</span>
          <span className="text-fuchsia-400 font-bold tabular-nums pointer-events-none">{score} pts</span>
          <button
            type="button"
            onClick={() => setActiveSong(null)}
            className="text-white/50 hover:text-white transition ml-1 leading-none"
            title="Back to menu"
          >
            ↩
          </button>
        </div>
      )}

      {/* Song selection modal */}
      {!activeSong && (
        <SongSelectModal onStart={(song) => setActiveSong(song)} />
      )}
    </div>
  );
}
