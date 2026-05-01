import { useEffect, useMemo, useRef, useState } from "react";
import { SFX } from "../../../config";
import { playSfx } from "../audio";
import { generateStarDots } from "../geometry";
import { useWandCursor } from "../hooks/use-wand-cursor";
import WandCursorSVG from "./wand-cursor-svg";

const STAR_TRACE_HIT_RADIUS = 70;

export default function StarTraceScreen({ cursor, canvasRect, onComplete, onPerfectTraceHit, isDrawActive = true }) {
  const [hitCount, setHitCount] = useState(0);
  const hitRef = useRef(0);
  const doneRef = useRef(false);
  const { activeCursor, trailItems, onMouseMove, onMouseLeave, clickKey, triggerClick } = useWandCursor(cursor, canvasRect);

  const dots = useMemo(() => {
    const rect = canvasRect ?? { x: 0, y: 0, width: window.innerWidth, height: window.innerHeight };
    const cx = rect.x + rect.width / 2;
    const cy = rect.y + rect.height / 2;
    const R = Math.min(rect.width, rect.height) * 0.32;
    const r = R * 0.38;
    return generateStarDots(cx, cy, R, r, 5);
  }, [canvasRect]);

  useEffect(() => {
    if (!activeCursor || doneRef.current || hitRef.current >= dots.length) return;
    const pt = dots[hitRef.current];
    if (Math.hypot(activeCursor.x - pt.x, activeCursor.y - pt.y) < STAR_TRACE_HIT_RADIUS) {
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
        <WandCursorSVG activeCursor={activeCursor} trailItems={trailItems} clickKey={clickKey} isDrawActive={isDrawActive} />
        {dots.map((pt, i) => {
          const isHit = i < hitCount;
          const isNext = i === hitCount;
          return (
            <circle
              key={i}
              cx={pt.x}
              cy={pt.y}
              r={isNext ? 13 : 8}
              fill={isHit ? "#4ade80" : isNext ? "rgba(255,255,255,0.9)" : "rgba(255,255,255,0.28)"}
            />
          );
        })}
      </svg>
      <div
        className="absolute text-center pointer-events-none"
        style={
          canvasRect
            ? { left: canvasRect.x, width: canvasRect.width, top: canvasRect.y + canvasRect.height - 40 }
            : { left: 0, right: 0, bottom: 40 }
        }
      >
        <p className="text-cream-soda/45 font-mono text-sm tracking-widest uppercase">
          {hitCount === 0 ? "trace the star to begin" : hitCount < dots.length ? `${pct}%` : "unlocked!"}
        </p>
      </div>
    </div>
  );
}
