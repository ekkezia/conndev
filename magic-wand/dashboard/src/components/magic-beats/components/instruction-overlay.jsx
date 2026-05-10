import { useEffect, useMemo, useRef, useState } from "react";
import { SFX } from "../../../config";
import { playSfx } from "../audio";
import { useWandCursor } from "../hooks/use-wand-cursor";
import StarTraceScreen from "./star-trace-screen";
import WandCursorSVG from "./wand-cursor-svg";

const STEPS = {
  INTRO: "intro",
  POWER: "power",
  CLICK: "click",
  SENSITIVITY: "sensitivity",
  DRAW: "draw",
  TRACE: "trace",
};

const IMAGE_BY_STEP = {
  [STEPS.INTRO]: "/images/magic-wand-product.png",
  [STEPS.POWER]: "/images/magic-wand-power.png",
  [STEPS.CLICK]: "/images/magic-wand-click.png",
  [STEPS.SENSITIVITY]: "/images/magic-wand-sensitivity.png",
  [STEPS.DRAW]: "/images/magic-wand-draw.png",
};

const COPY_BY_STEP = {
  [STEPS.INTRO]: "Meet your MagicWand™.",
  [STEPS.POWER]: "Power up your MagicWand™ by sliding the switch at the back",
  [STEPS.CLICK]:
    'Click the blue button to execute "Clicking" on your computer. The MagicWand™ is your mouse bestie!',
  [STEPS.SENSITIVITY]:
    "Adjust the sensitivity level that matches your magical movement speed.",
  [STEPS.DRAW]: "Press the DRAW START/STOP yellow button to play MagicBeats.",
};

function getLatestSensitivity(sensorData) {
  const latest = sensorData?.length ? sensorData[sensorData.length - 1] : null;
  const value = Number(latest?.sensor?.sensitivity);
  return Number.isFinite(value) ? value : null;
}

function SensitivityChip({ sensorData }) {
  const sensitivity = getLatestSensitivity(sensorData);
  if (!Number.isFinite(sensitivity)) return null;
  const pct = Math.max(0, Math.min(100, (sensitivity / 10) * 100));

  return (
    <div className="absolute top-3 left-3 z-20 pointer-events-none rounded-lg border border-cyan-300/45 bg-black/55 px-2.5 py-1.5">
      <div className="flex items-center gap-2">
        <span className="text-cyan-200 font-mono text-[9px] uppercase tracking-wider">sensitivity</span>
        <div className="w-20 h-1.5 rounded bg-cyan-950/70 overflow-hidden">
          <div
            className="h-full bg-gradient-to-r from-cyan-500 to-cyan-300"
            style={{ width: `${pct}%` }}
          />
        </div>
        <span className="text-cyan-100 font-mono text-[10px] tabular-nums">
          {sensitivity.toFixed(1)}
        </span>
      </div>
    </div>
  );
}

export default function InstructionOverlay({
  runKey,
  cursor,
  canvasRect,
  isDrawActive = true,
  drawState,
  powerState,
  sensorData,
  instructionCompleted = false,
  canShowTraceAfterCompleted = false,
  onCompleteInstruction,
}) {
  const [step, setStep] = useState(STEPS.INTRO);
  const [flash, setFlash] = useState(null);
  const [imageSrc, setImageSrc] = useState(IMAGE_BY_STEP[STEPS.INTRO]);
  const flashTimerRef = useRef(null);
  const flashKeyRef = useRef(0);
  const dataBaselineLenRef = useRef(0);
  const dataSeenRef = useRef(false);
  const sensitivityBaselineRef = useRef(null);
  const drawBaselineRef = useRef(Boolean(drawState?.draw));
  const { activeCursor, trailItems, onMouseMove, onMouseLeave, clickKey, triggerClick } =
    useWandCursor(cursor, canvasRect);

  const latestSensitivity = useMemo(() => getLatestSensitivity(sensorData), [sensorData]);

  const moveToStep = (nextStep, { reward = true } = {}) => {
    if (reward) {
      playSfx(SFX.perfect, 0.72);
    }
    setStep(nextStep);
    if (IMAGE_BY_STEP[nextStep]) {
      setImageSrc(IMAGE_BY_STEP[nextStep]);
    }
  };

  const spawnFlash = (text) => {
    flashKeyRef.current += 1;
    setFlash({
      id: flashKeyRef.current,
      text,
      left: `${18 + Math.random() * 64}%`,
      top: `${20 + Math.random() * 50}%`,
    });
    clearTimeout(flashTimerRef.current);
    flashTimerRef.current = setTimeout(() => setFlash(null), 900);
  };

  useEffect(() => {
    setStep(STEPS.INTRO);
    setImageSrc(IMAGE_BY_STEP[STEPS.INTRO]);
    setFlash(null);
    playSfx(SFX.instruction, 0.72);
    dataBaselineLenRef.current = Array.isArray(sensorData) ? sensorData.length : 0;
    dataSeenRef.current = false;
    sensitivityBaselineRef.current = null;
    drawBaselineRef.current = Boolean(drawState?.draw);
  }, [runKey]);

  useEffect(() => {
    if (step !== STEPS.INTRO) return undefined;
    const timer = setTimeout(() => {
      moveToStep(STEPS.POWER);
    }, 3000);
    return () => clearTimeout(timer);
  }, [step]);

  useEffect(() => {
    if (step !== STEPS.POWER) return;
    const len = Array.isArray(sensorData) ? sensorData.length : 0;
    if (len > dataBaselineLenRef.current) dataSeenRef.current = true;
    const powerOn = powerState?.power === true;
    if (!dataSeenRef.current && !powerOn) return;
    moveToStep(STEPS.CLICK);
  }, [step, sensorData, powerState?.power, powerState?.transition, powerState?.timestamp]);

  useEffect(() => {
    if (step !== STEPS.CLICK) return undefined;
    const onImuClick = () => {
      spawnFlash("MAGIC CLICK!");
      moveToStep(STEPS.SENSITIVITY);
    };
    window.addEventListener("imu-click", onImuClick);
    return () => window.removeEventListener("imu-click", onImuClick);
  }, [step]);

  useEffect(() => {
    if (step !== STEPS.SENSITIVITY) return;
    if (!Number.isFinite(latestSensitivity)) return;
    if (!Number.isFinite(sensitivityBaselineRef.current)) {
      sensitivityBaselineRef.current = latestSensitivity;
      return;
    }
    if (Math.abs(latestSensitivity - sensitivityBaselineRef.current) < 0.05) return;
    spawnFlash("MAGIC ADJUSTED!");
    moveToStep(STEPS.DRAW);
  }, [step, latestSensitivity]);

  useEffect(() => {
    if (step !== STEPS.DRAW) return;
    const nowDraw = Boolean(drawState?.draw);
    if (nowDraw === drawBaselineRef.current) return;
    const shouldShowTrace = !instructionCompleted || canShowTraceAfterCompleted;
    if (!shouldShowTrace) {
      playSfx(SFX.perfect, 0.72);
      onCompleteInstruction?.();
      return;
    }
    moveToStep(STEPS.TRACE);
  }, [
    step,
    drawState?.draw,
    drawState?.timestamp,
    instructionCompleted,
    canShowTraceAfterCompleted,
    onCompleteInstruction,
  ]);

  useEffect(() => {
    return () => {
      clearTimeout(flashTimerRef.current);
    };
  }, []);

  const statusText =
    step === STEPS.POWER && !dataSeenRef.current
      ? "waiting for live wand signal..."
      : step === STEPS.CLICK
        ? "press the wand click button"
      : step === STEPS.SENSITIVITY
        ? "change sensitivity to continue"
      : step === STEPS.DRAW
        ? "toggle DRAW START/STOP to continue"
        : step === STEPS.TRACE
          ? "trace the star to complete tutorial"
          : "getting started...";

  if (step === STEPS.TRACE) {
    return (
      <div className="absolute inset-0 z-[90]">
        <StarTraceScreen
          cursor={cursor}
          canvasRect={canvasRect}
          isDrawActive={isDrawActive}
          sensitivityValue={latestSensitivity}
          onPerfectTraceHit={() => {}}
          onComplete={() => {
            playSfx(SFX.perfect, 0.72);
            onCompleteInstruction?.();
          }}
        />
      </div>
    );
  }

  return (
    <div
      className="absolute inset-0 z-[90] flex items-center justify-center bg-cola-brown/88 backdrop-blur-md"
      onMouseMove={onMouseMove}
      onMouseLeave={onMouseLeave}
      onClick={triggerClick}
    >
      <svg className="absolute inset-0 w-full h-full overflow-visible pointer-events-none">
        <WandCursorSVG
          activeCursor={activeCursor}
          trailItems={trailItems}
          clickKey={clickKey}
          isDrawActive={isDrawActive}
        />
      </svg>

      <SensitivityChip sensorData={sensorData} />

      <div className="w-full max-w-5xl px-6">
        <div className="rounded-3xl border border-cream-soda/55 bg-gradient-to-br from-[#ff4fa3]/52 via-[#ff8a86]/36 to-[#ffb43b]/48 shadow-2xl backdrop-blur-md p-7 md:p-9">
          <div className="flex items-center justify-between gap-4 mb-6">
            <h2 className="text-cream-soda font-mono text-4xl font-bold tracking-tight">
              magicwand guide
            </h2>
            <p className="text-cream-soda/70 font-mono text-xs uppercase tracking-wider">
              flip front-back-front to toggle guide
            </p>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)] gap-6 items-center">
            <div className="rounded-2xl border border-cream-soda/35 bg-black/35 p-3 min-h-[280px] flex items-center justify-center">
              <img
                src={imageSrc}
                alt="Magic wand instruction"
                className="w-full max-h-[360px] object-contain rounded-xl"
                onError={(event) => {
                  if (event.currentTarget.src.includes("magic-wand-product.png")) return;
                  event.currentTarget.src = "/images/magic-wand-product.png";
                }}
              />
            </div>
            <div className="rounded-2xl border border-cream-soda/35 bg-black/30 px-6 py-5 min-h-[280px] flex flex-col justify-between">
              <p className="text-cream-soda font-mono text-2xl leading-relaxed">
                {COPY_BY_STEP[step]}
              </p>
              <p className="text-cream-soda/75 font-mono text-sm uppercase tracking-wide mt-4">
                {statusText}
              </p>
            </div>
          </div>
        </div>
      </div>

      {flash && (
        <div
          key={flash.id}
          className="absolute pointer-events-none z-[95]"
          style={{ left: flash.left, top: flash.top, transform: "translate(-50%, -50%)" }}
        >
          <span
            className="retro-text text-4xl font-bold tracking-widest whitespace-nowrap text-cream-soda"
            style={{ animation: "perfectPop 0.9s ease-out forwards" }}
          >
            {flash.text}
          </span>
        </div>
      )}
    </div>
  );
}
