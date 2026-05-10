import { useCallback, useEffect, useRef, useState } from "react";
import paper from "paper";
import { io } from "socket.io-client";
import { useIMU } from "../../contexts/IMUContext";
import { REACT_APP_SERVER_URL, CANVAS_RATIO, SFX } from "../../config";
import MapillaryBg from "./mapillary-bg";
import { preloadSfx } from "./audio";
import {
  APPROACH_START_RADIUS,
  BEAT_RADIUS,
  HIT_RADIUS,
  HIT_WINDOW_AFTER,
  HIT_WINDOW_BEFORE,
  PERFECT_WINDOW_EARLY_MS,
  PERFECT_WINDOW_LATE_MS,
  SHAPES,
  SHOW_BEFORE,
  TRAIL_LIFETIME,
  UNIT,
} from "./constants";
import { evalBezier, makeApproachGroup, makeBeatGroup } from "./geometry";
import SongSelectOverlay from "./components/song-select-overlay";
import StarTraceScreen from "./components/star-trace-screen";
import PostGameOverlay from "./components/post-game-overlay";
import HighScoreBoardOverlay from "./components/high-score-board-overlay";
import InstructionOverlay from "./components/instruction-overlay";

const PERFECT_HIT_WORDS = ["PERFECT", "MAGIC", "WOW", "SASSY", "AMAZING"];
const GOOD_HIT_WORDS = ["GREAT", "NICE", "OK", "GOOD"];
const pickRandomWord = (words) => words[Math.floor(Math.random() * words.length)];
const FEEDBACK_TRAIL_STARS = 5;
const HIT_TRAIL_GRADIENT = ["#fff18a", "#dfff68", "#b8ff52", "#86f94a", "#49e35a"];
const MISS_TRAIL_GRADIENT = ["#ffc1dd", "#ff9bc7", "#ff79b6", "#ff5aa7", "#ff3e9a"];
const BEAT_HUE_EARLY = 0;
const BEAT_HUE_ON_TIME = 310;
const DESKTOP_MOUSE_TAKEOVER_MS = 220;
const SCOREBOARD_STORAGE_KEY = "magicbeats-highscores-v1";
const FLIP_GX_THRESHOLD = 3.2;
const FLIP_PATTERN_WINDOW_MS = 3200;
const FLIP_TOGGLE_COOLDOWN_MS = 2200;

// ─── MAIN COMPONENT ───────────────────────────────────────────────────────────
export default function BeatGame({ className }) {
  const canvasRef = useRef(null);
  const { sensorData, mousePos, drawState, powerState } = useIMU();

  const [activeSong, setActiveSong] = useState(null);
  const [traced, setTraced] = useState(true);
  const [menuCursor, setMenuCursor] = useState(null);
  const [canvasRect, setCanvasRect] = useState(null);
  const [score, setScore] = useState(0);
  const [pendingResult, setPendingResult] = useState(null);
  const [gridVisible, setGridVisible] = useState(false);
  const [isPreviewingSong, setIsPreviewingSong] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(
    typeof document !== "undefined" ? Boolean(document.fullscreenElement) : false,
  );
  const [lastHitPos, setLastHitPos] = useState(null);
  const [mapReady, setMapReady] = useState(false);
  const [hitFeedback, setHitFeedback] = useState(null);
  const [scoreboardRows, setScoreboardRows] = useState([]);
  const [forceSongMenu, setForceSongMenu] = useState(false);
  const [stopPromptOpen, setStopPromptOpen] = useState(false);
  const [instructionOpen, setInstructionOpen] = useState(false);
  const [instructionRunKey, setInstructionRunKey] = useState(0);
  const hitFeedbackTimerRef = useRef(null);
  const perfectSfxRef = useRef(null);
  const greatSfxRef = useRef(null);
  const perfectKeyRef = useRef(0);

  const triggerHitFeedback = useCallback((x, y, isPerfect) => {
    if (isPerfect) {
      if (!perfectSfxRef.current) {
        perfectSfxRef.current = new Audio(SFX.perfect);
        perfectSfxRef.current.volume = 0.7;
      }
      perfectSfxRef.current.currentTime = 0;
      perfectSfxRef.current.play().catch(() => {});
    } else {
      if (!greatSfxRef.current) {
        greatSfxRef.current = new Audio(SFX.great);
        greatSfxRef.current.volume = 0.7;
      }
      greatSfxRef.current.currentTime = 0;
      greatSfxRef.current.play().catch(() => {});
    }

    const text = isPerfect
      ? pickRandomWord(PERFECT_HIT_WORDS)
      : pickRandomWord(GOOD_HIT_WORDS);

    perfectKeyRef.current += 1;
    setHitFeedback({ key: perfectKeyRef.current, x, y, text, isPerfect });
    clearTimeout(hitFeedbackTimerRef.current);
    hitFeedbackTimerRef.current = setTimeout(() => setHitFeedback(null), 900);
  }, []);

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
  const desktopMouseTakeoverUntilRef = useRef(0);

  const beatsRef = useRef([]);        // active beats (not yet hit/missed)
  const fadingRef = useRef([]);       // { beatGroup, approachGroup, speed }
  const nextOnsetRef = useRef(null);
  const canvasSizeRef = useRef({ width: 0, height: 0 });
  const gameRafRef = useRef(null);
  const audioRef = useRef(null);
  const idleAudioRef = useRef(null);
  const scoreRef = useRef(0);
  const isGamePausedRef = useRef(false);
  const isDrawActiveRef = useRef(false);

  const trailItemsRef = useRef([]);
  const lastTrailPosRef = useRef(null);
  const trailFrameCountRef = useRef(0);
  const trailStateRef = useRef('normal'); // 'normal' | 'hit' | 'miss'
  const trailStateTimerRef = useRef(null);
  const trailFeedbackRef = useRef({ type: "normal", remaining: 0, index: 0 });
  const socketRef = useRef(null);
  const hasHandledInitialPowerSyncRef = useRef(false);
  const prevDrawActiveRef = useRef(Boolean(drawState?.draw));
  const prevDrawStopPromptRef = useRef(Boolean(drawState?.draw));
  const lastLoggedSensitivityRef = useRef(null);
  const flipOrientationRef = useRef(null);
  const flipEventRef = useRef([]);
  const lastFlipToggleAtRef = useRef(0);
  const flipStageRef = useRef(0); // 0 wait-front, 1 wait-back, 2 wait-front
  const flipStartedAtRef = useRef(0);

  const isMagicWandOn = Boolean(drawState?.draw);
  const showHighScoreBoard = !isMagicWandOn && !activeSong && !pendingResult && !forceSongMenu;

  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      const raw = window.localStorage.getItem(SCOREBOARD_STORAGE_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return;
      const sanitized = parsed
        .filter((row) => row && typeof row === "object")
        .map((row) => ({
          id: String(row.id ?? `${row.name ?? "player"}-${row.playedAtMs ?? Date.now()}`),
          name: String(row.name ?? "PLAYER"),
          score: Number.isFinite(Number(row.score)) ? Number(row.score) : 0,
          songTitle: String(row.songTitle ?? "Unknown Song"),
          songArtist: String(row.songArtist ?? ""),
          playedAt: String(row.playedAt ?? new Date().toISOString()),
          playedAtMs: Number.isFinite(Number(row.playedAtMs)) ? Number(row.playedAtMs) : Date.now(),
        }))
        .sort((a, b) => b.score - a.score || b.playedAtMs - a.playedAtMs)
        .slice(0, 120);
      setScoreboardRows(sanitized);
    } catch {}
  }, []);

  const addScoreboardRow = useCallback((row) => {
    setScoreboardRows((prev) => {
      const next = [row, ...prev]
        .sort((a, b) => b.score - a.score || b.playedAtMs - a.playedAtMs)
        .slice(0, 120);
      try {
        if (typeof window !== "undefined") {
          window.localStorage.setItem(SCOREBOARD_STORAGE_KEY, JSON.stringify(next));
        }
      } catch {}
      return next;
    });
  }, []);

  const addScore = useCallback((delta) => {
    setScore((current) => {
      const next = current + delta;
      scoreRef.current = next;
      return next;
    });
  }, []);

  const emitPerfectTraceHit = useCallback((x, y) => {
    socketRef.current?.emit('beat-hit', { perfect: true, x, y, source: 'star-trace' });
  }, []);
  const cursorBezierRef = useRef(null);
  const cursorClickTimeRef = useRef(-Infinity);
  const cursorSmoothRef = useRef(null); // EMA-filtered sensor position

  const isDrawActive = (() => {
    if (typeof drawState?.draw === "boolean") return drawState.draw;
    const latest = sensorData?.length ? sensorData[sensorData.length - 1] : null;
    if (latest?.draw === "start") return true;
    if (latest?.draw === "stop") return false;
    return false;
  })();

  useEffect(() => {
    isDrawActiveRef.current = isDrawActive;
  }, [isDrawActive]);

  const openStopPrompt = useCallback(() => {
    if (!activeSong || stopPromptOpen) return;
    setStopPromptOpen(true);
    isGamePausedRef.current = true;
    if (audioRef.current && !audioRef.current.paused) {
      audioRef.current.pause();
    }
  }, [activeSong, stopPromptOpen]);

  const resumeFromStopPrompt = useCallback(() => {
    setStopPromptOpen(false);
    isGamePausedRef.current = false;
    if (audioRef.current && audioRef.current.paused) {
      audioRef.current.play().catch(() => {});
    }
  }, []);

  const confirmStopToMenu = useCallback(() => {
    setStopPromptOpen(false);
    isGamePausedRef.current = false;
    if (audioRef.current) {
      audioRef.current.pause();
    }
    setPendingResult(null);
    setActiveSong(null);
    setTraced(true);
    setForceSongMenu(true);
  }, []);

  useEffect(() => {
    if (powerState?.transition === "on") {
      setTraced(false);
      return;
    }
    if (
      !hasHandledInitialPowerSyncRef.current &&
      powerState?.transition === "sync" &&
      powerState?.power === true
    ) {
      hasHandledInitialPowerSyncRef.current = true;
      setTraced(false);
      return;
    }
    if (powerState?.transition === "off") {
      setTraced(true);
    }
  }, [powerState?.transition, powerState?.timestamp, powerState?.power]);

  useEffect(() => {
    const wasOn = prevDrawActiveRef.current;
    const isOn = Boolean(drawState?.draw);
    if (!wasOn && isOn) {
      setTraced(false);
    } else if (wasOn && !isOn) {
      setTraced(true);
    }
    prevDrawActiveRef.current = isOn;
  }, [drawState?.draw, drawState?.timestamp]);

  useEffect(() => {
    const wasOn = prevDrawStopPromptRef.current;
    const isOn = Boolean(drawState?.draw);
    if (activeSong && wasOn && !isOn) {
      openStopPrompt();
    }
    prevDrawStopPromptRef.current = isOn;
  }, [activeSong, drawState?.draw, drawState?.timestamp, openStopPrompt]);

  useEffect(() => {
    if (typeof window === "undefined") return;

    window.magicBeatGame = {
      endSong: () => {
        const audio = audioRef.current;
        if (!audio || !activeSong) return false;
        audio.dispatchEvent(new Event("ended"));
        return true;
      },
      state: () => ({
        hasActiveSong: Boolean(activeSong),
        score: scoreRef.current,
        activeSongTitle: activeSong?.title ?? null,
      }),
    };

    return () => {
      if (window.magicBeatGame) delete window.magicBeatGame;
    };
  }, [activeSong]);

  const toggleInstructionOverlay = useCallback(() => {
    setInstructionOpen((prev) => {
      const next = !prev;
      if (next) {
        setInstructionRunKey((k) => k + 1);
      } else {
        setForceSongMenu(false);
      }
      return next;
    });
  }, []);

  const enterInstructionOverlay = useCallback(() => {
    setInstructionRunKey((k) => k + 1);
    setInstructionOpen(true);
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    window.magicInstruction = {
      open: () => {
        enterInstructionOverlay();
        return true;
      },
      close: () => {
        setInstructionOpen(false);
        setForceSongMenu(false);
        return true;
      },
      toggle: () => {
        toggleInstructionOverlay();
        return true;
      },
      state: () => ({
        open: instructionOpen,
        runKey: instructionRunKey,
      }),
    };
    return () => {
      if (window.magicInstruction) delete window.magicInstruction;
    };
  }, [enterInstructionOverlay, instructionOpen, instructionRunKey, toggleInstructionOverlay]);

  useEffect(() => {
    console.log("🪄 instruction-view:", instructionOpen ? "OPEN" : "CLOSED");
  }, [instructionOpen]);

  useEffect(() => {
    const latest = sensorData?.length ? sensorData[sensorData.length - 1] : null;
    if (!latest?.sensor) return;
    const gx = Number(latest.sensor.gx);
    if (!Number.isFinite(gx)) return;

    const orientation =
      gx >= FLIP_GX_THRESHOLD ? "front" : gx <= -FLIP_GX_THRESHOLD ? "back" : null;
    if (!orientation) return;
    if (flipOrientationRef.current === orientation) return;
    flipOrientationRef.current = orientation;

    const now = Date.now();
    const nextEvents = [...flipEventRef.current, { orientation, at: now, gx }]
      .filter((evt) => now - evt.at <= FLIP_PATTERN_WINDOW_MS);
    flipEventRef.current = nextEvents;

    const cooldownOk = now - lastFlipToggleAtRef.current > FLIP_TOGGLE_COOLDOWN_MS;
    if (!cooldownOk) {
      console.log("🪄 flip cooldown active");
      return;
    }

    const stage = flipStageRef.current;
    if (stage === 0) {
      if (orientation === "front") {
        flipStageRef.current = 1;
        flipStartedAtRef.current = now;
        console.log("🪄 flip stage 1/3: FRONT", { gx: gx.toFixed(2) });
      }
      return;
    }

    if (now - flipStartedAtRef.current > FLIP_PATTERN_WINDOW_MS) {
      console.log("🪄 flip sequence timeout, resetting");
      flipStageRef.current = orientation === "front" ? 1 : 0;
      flipStartedAtRef.current = now;
      return;
    }

    if (stage === 1) {
      if (orientation === "back") {
        flipStageRef.current = 2;
        console.log("🪄 flip stage 2/3: BACK", { gx: gx.toFixed(2) });
      } else if (orientation === "front") {
        console.log("🪄 flip stage 1/3 re-affirm FRONT", { gx: gx.toFixed(2) });
      }
      return;
    }

    if (stage === 2) {
      if (orientation === "front") {
        console.log("🪄 flip stage 3/3: FRONT -> TOGGLE instruction");
        flipStageRef.current = 0;
        flipStartedAtRef.current = 0;
        flipEventRef.current = [];
        lastFlipToggleAtRef.current = now;
        toggleInstructionOverlay();
      } else if (orientation === "back") {
        console.log("🪄 flip stage 2/3 re-affirm BACK", { gx: gx.toFixed(2) });
      }
    }
  }, [sensorData, toggleInstructionOverlay]);

  useEffect(() => {
    if (activeSong || isPreviewingSong) {
      if (idleAudioRef.current) {
        idleAudioRef.current.pause();
      }
      return;
    }
    if (!mapReady) return;

    if (!idleAudioRef.current) {
      const idle = new Audio("/music/steady.mp3");
      idle.loop = true;
      idle.volume = 0.45;
      idleAudioRef.current = idle;
    }
    idleAudioRef.current.play().catch(() => {});
  }, [activeSong, isPreviewingSong, mapReady]);

  useEffect(() => {
    return () => {
      if (idleAudioRef.current) {
        idleAudioRef.current.pause();
        idleAudioRef.current = null;
      }
    };
  }, []);

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

  const applyCursorTarget = useCallback((cx, cy, calibrated = false) => {
    const { width, height } = canvasSizeRef.current;
    const clampedX = Math.max(0, Math.min(cx, width));
    const clampedY = Math.max(0, Math.min(cy, height));

    cursorTargetRef.current = { x: clampedX, y: clampedY };
    cursorCalibratedRef.current = !!calibrated;

    // EMA pre-filter: smooth the raw sensor position before feeding to bezier
    const EMA = 0.35; // lower = more smoothing, higher = more responsive
    const sm = cursorSmoothRef.current ?? { x: clampedX, y: clampedY };
    sm.x = sm.x + (clampedX - sm.x) * EMA;
    sm.y = sm.y + (clampedY - sm.y) * EMA;
    cursorSmoothRef.current = sm;

    // Build a cubic bezier from current cursor position to the smoothed target.
    // cp1 extends along the current travel direction (C1 continuity),
    // cp2 arrives tangentially so the join is smooth.
    const prevLerp = cursorLerpRef.current;
    const from = prevLerp ? { x: prevLerp.x, y: prevLerp.y } : { x: sm.x, y: sm.y };
    const tcx = sm.x;
    const tcy = sm.y;
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
  }, []);

  const startTrailFeedback = useCallback((type) => {
    trailStateRef.current = type;
    trailFeedbackRef.current = {
      type,
      remaining: FEEDBACK_TRAIL_STARS,
      index: 0,
    };
    clearTimeout(trailStateTimerRef.current);
    trailStateTimerRef.current = setTimeout(() => {
      trailStateRef.current = "normal";
      trailFeedbackRef.current = { type: "normal", remaining: 0, index: 0 };
    }, type === "miss" ? 1000 : 1500);
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
  }, [triggerHitFeedback, startTrailFeedback]);

  // ─── PRELOAD SFX ──────────────────────────────────────────────────────────
  useEffect(() => { Object.values(SFX).forEach(preloadSfx); }, []);

  // ─── SOCKET ───────────────────────────────────────────────────────────────
  useEffect(() => {
    socketRef.current = io(REACT_APP_SERVER_URL, {
      path: '/socket.io',
      multiplex: false,
      transports: ['websocket', 'polling'],
      upgrade: true,
      rememberUpgrade: true,
      timeout: 8000,
      reconnection: true,
      reconnectionAttempts: Infinity,
      reconnectionDelay: 500,
      reconnectionDelayMax: 3000,
    });
    socketRef.current.on("connect_error", (err) => {
      console.error(
        `BeatGame socket connect_error (${REACT_APP_SERVER_URL}):`,
        err?.message || err,
      );
    });
    return () => socketRef.current?.disconnect();
  }, []);

  // ─── H/F KEYS: grid + fullscreen ───────────────────────────────────────────
  useEffect(() => {
    const isEditableTarget = (target) =>
      target instanceof HTMLElement &&
      (target.isContentEditable ||
        target.tagName === "INPUT" ||
        target.tagName === "TEXTAREA" ||
        target.tagName === "SELECT");

    const toggleFullscreen = async () => {
      const doc = document;
      if (!doc.fullscreenElement) {
        await doc.documentElement.requestFullscreen?.();
      } else {
        await doc.exitFullscreen?.();
      }
    };

    const handleKey = async (e) => {
      if (isEditableTarget(e.target)) return;

      if ((e.key === 'h' || e.key === 'H') && gridLayerRef.current) {
        const next = !gridLayerRef.current.visible;
        gridLayerRef.current.visible = next;
        setGridVisible(next);
        paper.view.draw();
        return;
      }

      if (e.key === "f" || e.key === "F") {
        e.preventDefault();
        try {
          await toggleFullscreen();
        } catch (err) {
          console.warn("Fullscreen toggle failed:", err);
        }
      }
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, []);

  useEffect(() => {
    const syncFullscreen = () => {
      setIsFullscreen(Boolean(document.fullscreenElement));
    };
    document.addEventListener("fullscreenchange", syncFullscreen);
    return () => document.removeEventListener("fullscreenchange", syncFullscreen);
  }, []);

  // ─── CLICK TO HIT ─────────────────────────────────────────────────────────
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const handleClick = (e) => {
      if (!paperReadyRef.current || !audioRef.current) return;
      if (isGamePausedRef.current) return;
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
        const isPerfect =
          timeToOnset <= PERFECT_WINDOW_EARLY_MS &&
          timeToOnset >= -PERFECT_WINDOW_LATE_MS;
        beat.hit = true;
        const hitColor = new paper.Color(isPerfect ? '#aaff44' : '#44dd88');
        for (let i = 0; i < 4 && i < beat.beatGroup.children.length; i++) {
          beat.beatGroup.children[i].fillColor = hitColor;
        }
        socketRef.current?.emit('beat-hit', { perfect: isPerfect, x: beat.x, y: beat.y });
        triggerHitFeedback(beat.x, beat.y, isPerfect);
        cursorClickTimeRef.current = performance.now();
        startTrailFeedback("hit");
        addScore(isPerfect ? 30 : 10);
        const { width, height } = canvasSizeRef.current;
        setLastHitPos({ xNorm: beat.x / width, yNorm: beat.y / height });
        break;
      }
    };
    canvas.addEventListener('click', handleClick);
    return () => canvas.removeEventListener('click', handleClick);
  }, [triggerHitFeedback, startTrailFeedback, addScore]);

  // ─── START GAME ────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!activeSong || !paperReadyRef.current) return;

    if (audioRef.current) { audioRef.current.pause(); audioRef.current = null; }
    if (gameLayerRef.current) { gameLayerRef.current.removeChildren(); paper.view.draw(); }
    setStopPromptOpen(false);
    isGamePausedRef.current = false;
    beatsRef.current = [];
    cursorDotRef.current = null;
    setScore(0);
    scoreRef.current = 0;

    const audio = new Audio(activeSong.src);
    audio.volume = 0.8;
    audio.loop = false;
    audio.play().catch((err) => console.warn('Audio play failed:', err));
    const handleSongEnded = () => {
      setPendingResult({
        song: activeSong,
        score: scoreRef.current,
        endedAtMs: Date.now(),
      });
      setActiveSong(null);
    };
    audio.addEventListener("ended", handleSongEnded);
    audioRef.current = audio;

    const beatInterval = (60 / activeSong.bpm) * 1000;
    nextOnsetRef.current = performance.now() + SHOW_BEFORE + 100;

    let running = true;

    function gameLoop(now) {
      if (!running) return;
      gameRafRef.current = requestAnimationFrame(gameLoop);
      if (!gameLayerRef.current || !cursorLayerRef.current) return;
      if (isGamePausedRef.current) {
        paper.view.draw();
        return;
      }

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

        const dotColor = isDrawActiveRef.current
          ? new paper.Color(1, 0.706, 0.231, 0.9)
          : new paper.Color(0.62, 0.62, 0.62, 0.9);

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
        const lastPos = lastTrailPosRef.current;
        const moved = lastPos ? Math.hypot(lerp.x - lastPos.x, lerp.y - lastPos.y) : Infinity;

        if (moved > 5) {
          trailFrameCountRef.current++;
          const feedback = trailFeedbackRef.current;
          let color;
          if (feedback.remaining > 0 && (feedback.type === "hit" || feedback.type === "miss")) {
            const gradient =
              feedback.type === "hit" ? HIT_TRAIL_GRADIENT : MISS_TRAIL_GRADIENT;
            const idx = Math.min(feedback.index, gradient.length - 1);
            color = new paper.Color(gradient[idx]);
            feedback.remaining -= 1;
            feedback.index += 1;
          } else {
            color = new paper.Color({
              hue: Math.random() * 360,
              saturation: 0.86,
              brightness: 1,
            });
          }

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
        const colorLayerCount = Math.max(0, beatGroup.children.length - 4);
        for (let i = 0; i < colorLayerCount; i++) {
          beatGroup.children[i].fillColor = new paper.Color({
            hue: BEAT_HUE_EARLY,
            saturation: Math.max(0.58, 0.9 - i * 0.08),
            brightness: Math.max(0.4, 0.98 - i * 0.16),
          });
        }

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
        const colorProgress = Math.max(
          0,
          Math.min(1, (SHOW_BEFORE - Math.max(timeToOnset, 0)) / SHOW_BEFORE),
        );
        const hueNow = BEAT_HUE_EARLY + (BEAT_HUE_ON_TIME - BEAT_HUE_EARLY) * colorProgress;
        const colorLayerCount = Math.max(0, beat.beatGroup.children.length - 4);
        for (let i = 0; i < colorLayerCount; i++) {
          beat.beatGroup.children[i].fillColor = new paper.Color({
            hue: (hueNow + i * 6) % 360,
            saturation: Math.max(0.58, 0.9 - i * 0.08),
            brightness: Math.max(0.4, 0.98 - i * 0.16),
          });
        }

        // Gyro hit
        const dx = cursorX - beat.x;
        const dy = cursorY - beat.y;
        const inArea = Math.sqrt(dx * dx + dy * dy) < HIT_RADIUS;
        const inWindow =
          timeToOnset <= HIT_WINDOW_BEFORE && timeToOnset >= -HIT_WINDOW_AFTER;

        if (inArea && inWindow) {
          const isPerfect =
            timeToOnset <= PERFECT_WINDOW_EARLY_MS &&
            timeToOnset >= -PERFECT_WINDOW_LATE_MS;
          const hitColor = new paper.Color(isPerfect ? '#aaff44' : '#44dd88');
          for (let i = 0; i < 4 && i < beat.beatGroup.children.length; i++) {
            beat.beatGroup.children[i].fillColor = hitColor;
          }
          beat.approachGroup.opacity = 0;
          socketRef.current?.emit('beat-hit', { perfect: isPerfect, x: beat.x, y: beat.y });
          triggerHitFeedback(beat.x, beat.y, isPerfect);
          cursorClickTimeRef.current = performance.now();
          startTrailFeedback("hit");
          addScore(isPerfect ? 30 : 10);
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
          startTrailFeedback("miss");
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
      audio.removeEventListener("ended", handleSongEnded);
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
      trailFeedbackRef.current = { type: "normal", remaining: 0, index: 0 };
    };
  }, [activeSong, setCursorDotScale, triggerHitFeedback, startTrailFeedback, addScore]);

  // ─── CURSOR TARGET from sensor data ───────────────────────────────────────
  useEffect(() => {
    const s = sensorData?.length ? sensorData[sensorData.length - 1] : null;
    if (Date.now() < desktopMouseTakeoverUntilRef.current) return;

    if (s?.sensor && s?.screenSize) {
      const { mouseTargetX, mouseTargetY } = s.sensor;
      const { width: screenW, height: screenH } = s.screenSize;
      if (mouseTargetX != null && mouseTargetY != null && screenW && screenH) {
        const { width, height } = canvasSizeRef.current;
        const cx = (mouseTargetX / screenW) * width;
        const cy = (mouseTargetY / screenH) * height;
        applyCursorTarget(cx, cy, !!s.calibrated);
        return;
      }
    }

    // Fallback for menu/song-list control if packet shape changes:
    // use live server mouse position stream.
    if (mousePos?.x != null && mousePos?.y != null) {
      const screenW = window.innerWidth || window.screen.width;
      const screenH = window.innerHeight || window.screen.height;
      const { width, height } = canvasSizeRef.current;
      const cx = (mousePos.x / screenW) * width;
      const cy = (mousePos.y / screenH) * height;
      applyCursorTarget(cx, cy, false);
    }
  }, [sensorData, mousePos, applyCursorTarget]);

  // Debug support: when game is active, local desktop mouse can directly drive the in-game cursor.
  useEffect(() => {
    if (!activeSong) return;
    const canvas = canvasRef.current;
    if (!canvas) return;

    const onMove = (e) => {
      const rect = canvas.getBoundingClientRect();
      if (
        e.clientX < rect.left ||
        e.clientX > rect.right ||
        e.clientY < rect.top ||
        e.clientY > rect.bottom
      ) {
        return;
      }
      desktopMouseTakeoverUntilRef.current = Date.now() + DESKTOP_MOUSE_TAKEOVER_MS;
      applyCursorTarget(e.clientX - rect.left, e.clientY - rect.top, true);
    };

    window.addEventListener("mousemove", onMove);
    return () => window.removeEventListener("mousemove", onMove);
  }, [activeSong, applyCursorTarget]);

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

  useEffect(() => {
    const latest = sensorData?.length ? sensorData[sensorData.length - 1] : null;
    const next = Number(latest?.sensor?.sensitivity);
    if (!Number.isFinite(next)) return;
    if (lastLoggedSensitivityRef.current === next) return;
    lastLoggedSensitivityRef.current = next;
    console.log("🎛️ sensitivity:", next, "timestamp:", latest?.timestamp ?? Date.now());
  }, [sensorData]);

  return (
    <div className={`retro-text absolute top-0 left-0 w-full h-full ${className ?? ''}`}>
      <div
        className="absolute z-0"
        style={!isFullscreen && canvasRect
          ? { left: canvasRect.x, top: canvasRect.y, width: canvasRect.width, height: canvasRect.height }
          : { inset: 0 }}
      >
        <MapillaryBg
          lastHitPos={lastHitPos}
          active={!!activeSong}
          startLocation={activeSong?.location}
          onReady={() => setMapReady(true)}
        />
      </div>
      <canvas ref={canvasRef} resize="true" className="absolute bg-transparent z-10" />

      {sensorData && sensorData.length > 0 && sensorData[sensorData.length - 1]?.sensor?.sensitivity != null && (
        <div className="absolute top-3 left-3 z-30 pointer-events-none rounded-lg border border-cyan-300/45 bg-black/55 px-2.5 py-1.5">
          <div className="flex items-center gap-2">
            <span className="text-cyan-200 font-mono text-[9px] uppercase tracking-wider">sens</span>
            <div className="w-16 h-1.5 rounded bg-cyan-950/70 overflow-hidden">
              <div
                className="h-full bg-gradient-to-r from-cyan-500 to-cyan-300"
                style={{
                  width: `${Math.max(0, Math.min(100, (Number(sensorData[sensorData.length - 1]?.sensor?.sensitivity) / 10) * 100))}%`,
                }}
              />
            </div>
            <span className="text-cyan-100 font-mono text-[10px] tabular-nums">
              {Number(sensorData[sensorData.length - 1]?.sensor?.sensitivity).toFixed(1)}
            </span>
          </div>
        </div>
      )}

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

      {hitFeedback && (
        <div
          key={hitFeedback.key}
          className="absolute pointer-events-none z-20"
          style={{ left: (canvasRect?.x ?? 0) + hitFeedback.x, top: (canvasRect?.y ?? 0) + hitFeedback.y, transform: 'translate(-50%, -130%)' }}
        >
          <span
            className="retro-text text-4xl font-bold tracking-widest whitespace-nowrap"
            style={{
              animation: 'perfectPop 0.9s ease-out forwards',
              color: hitFeedback.isPerfect ? '#fff7e6' : '#d6ffd9',
            }}
          >
            {hitFeedback.text}
          </span>
        </div>
      )}

      {/* key hints */}
      <div className="absolute bottom-2 right-2 text-cream-soda/30 font-mono text-[10px] pointer-events-none">
        H: grid · F: fullscreen
      </div>

      {!instructionOpen && !activeSong && mapReady && !traced && !showHighScoreBoard && (
        <StarTraceScreen
          cursor={menuCursor}
          canvasRect={canvasRect}
          onComplete={() => setTraced(true)}
          onPerfectTraceHit={emitPerfectTraceHit}
          sensitivityValue={sensorData?.length ? sensorData[sensorData.length - 1]?.sensor?.sensitivity : null}
          isDrawActive={isDrawActive}
        />
      )}
      {!instructionOpen && !activeSong && mapReady && showHighScoreBoard && (
        <HighScoreBoardOverlay
          rows={scoreboardRows}
          wandOn={isMagicWandOn}
        />
      )}
      {!instructionOpen && !activeSong && mapReady && traced && !pendingResult && !showHighScoreBoard && (
        <SongSelectOverlay
          cursor={menuCursor}
          canvasRect={canvasRect}
          onPreviewStateChange={setIsPreviewingSong}
          onStart={(song) => {
            setPendingResult(null);
            setForceSongMenu(false);
            setIsPreviewingSong(false);
            setActiveSong(song);
          }}
          isDrawActive={isDrawActive}
        />
      )}
      {!instructionOpen && !activeSong && mapReady && traced && pendingResult && (
        <PostGameOverlay
          cursor={menuCursor}
          canvasRect={canvasRect}
          song={pendingResult.song}
          score={pendingResult.score}
          playedAtMs={pendingResult.endedAtMs}
          isDrawActive={isDrawActive}
          onSubmit={(name) => {
            const nowMs = pendingResult.endedAtMs ?? Date.now();
            const nowIso = new Date(nowMs).toISOString();
            const row = {
              id: `${name}-${nowMs}-${Math.floor(Math.random() * 1000)}`,
              name,
              score: pendingResult.score,
              songTitle: pendingResult.song?.title ?? "Unknown Song",
              songArtist: pendingResult.song?.artist ?? "",
              playedAt: nowIso,
              playedAtMs: nowMs,
            };
            addScoreboardRow(row);
            socketRef.current?.emit("beat-score-submit", {
              name,
              score: pendingResult.score,
              title: pendingResult.song?.title ?? null,
              artist: pendingResult.song?.artist ?? null,
              playedAt: nowIso,
            });
            setPendingResult(null);
          }}
        />
      )}

      {instructionOpen && mapReady && (
        <InstructionOverlay
          runKey={instructionRunKey}
          cursor={menuCursor}
          canvasRect={canvasRect}
          isDrawActive={isDrawActive}
          drawState={drawState}
          sensorData={sensorData}
          onCompleteDrawToggle={() => {
            setInstructionOpen(false);
            setPendingResult(null);
            setActiveSong(null);
            setTraced(true);
            setForceSongMenu(true);
            setStopPromptOpen(false);
          }}
        />
      )}

      {activeSong && stopPromptOpen && (
        <div className="absolute inset-0 z-[70] flex items-center justify-center bg-black/65 backdrop-blur-sm">
          <div className="w-full max-w-xl px-6">
            <div className="rounded-2xl border border-cream-soda/55 bg-cola-brown/95 p-7 md:p-8 shadow-2xl">
              <h3 className="text-cream-soda font-mono text-3xl font-bold tracking-tight">
                r u sure u wanna stop making magic?
              </h3>
              <p className="text-cream-soda/70 font-mono text-sm mt-2">
                your current run will end and return to song menu.
              </p>
              <div className="mt-6 flex flex-wrap items-center justify-center gap-3">
                <button
                  type="button"
                  onClick={confirmStopToMenu}
                  className="beat-menu-start is-ready text-cream-soda rounded-xl px-7 py-3 font-mono text-xl font-bold uppercase min-w-[8rem]"
                >
                  ya!
                </button>
                <button
                  type="button"
                  onClick={resumeFromStopPrompt}
                  className="beat-menu-option text-cream-soda rounded-xl px-7 py-3 font-mono text-xl min-w-[8rem]"
                >
                  nope
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
