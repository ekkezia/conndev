import { useEffect, useMemo, useRef, useState } from "react";
import { SFX } from "../../../config";
import { playSfx } from "../audio";
import { useWandCursor } from "../hooks/use-wand-cursor";
import WandCursorSVG from "./wand-cursor-svg";

const STAR_TRACE_HIT_RADIUS = 70;
const TRACE_POINTS_PER_SEGMENT = 24;

function createTraceControlPoints(rect) {
  const cx = rect.x + rect.width / 2;
  const cy = rect.y + rect.height / 2;
  const R = Math.min(rect.width, rect.height) * 0.36;

  const outer = Array.from({ length: 5 }, (_, i) => {
    const angle = (-90 + i * 72) * Math.PI / 180;
    return { x: cx + R * Math.cos(angle), y: cy + R * Math.sin(angle) };
  });

  // Start from lower-left and draw a continuous pentagram path.
  return [outer[3], outer[0], outer[2], outer[4], outer[1], outer[3]];
}

function createTraceDots(points, dotsPerSegment = TRACE_POINTS_PER_SEGMENT) {
  const dots = [];
  for (let i = 0; i < points.length - 1; i++) {
    const from = points[i];
    const to = points[i + 1];
    for (let j = 0; j < dotsPerSegment; j++) {
      const t = j / dotsPerSegment;
      dots.push({
        x: from.x + (to.x - from.x) * t,
        y: from.y + (to.y - from.y) * t,
      });
    }
  }
  dots.push(points[points.length - 1]);
  return dots;
}

function toProceduralPath(points) {
  if (!points.length) return "";
  let d = `M ${points[0].x} ${points[0].y}`;
  for (let i = 1; i < points.length; i++) {
    d += ` L ${points[i].x} ${points[i].y}`;
  }
  return d;
}

function rainbowDotColor(index, total, alpha = 0.92) {
  const safeTotal = Math.max(1, total);
  const hue = (index / safeTotal) * 360;
  return `hsla(${hue}, 90%, 62%, ${alpha})`;
}

export default function StarTraceScreen({ cursor, canvasRect, onComplete, onPerfectTraceHit, isDrawActive = true }) {
  const [hitCount, setHitCount] = useState(0);
  const hitRef = useRef(0);
  const doneRef = useRef(false);
  const { activeCursor, trailItems, onMouseMove, onMouseLeave, clickKey, triggerClick } = useWandCursor(cursor, canvasRect);

  const tracePoints = useMemo(() => {
    const rect = canvasRect ?? { x: 0, y: 0, width: window.innerWidth, height: window.innerHeight };
    return createTraceControlPoints(rect);
  }, [canvasRect]);
  const tracePath = useMemo(() => toProceduralPath(tracePoints), [tracePoints]);
  const dots = useMemo(() => createTraceDots(tracePoints), [tracePoints]);
  const traceLabelPos = useMemo(() => {
    if (!tracePoints.length) return null;
    let minX = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const pt of tracePoints) {
      if (pt.x < minX) minX = pt.x;
      if (pt.x > maxX) maxX = pt.x;
      if (pt.y > maxY) maxY = pt.y;
    }
    return { x: (minX + maxX) / 2, y: maxY + 46 };
  }, [tracePoints]);

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

  return (
    <div
      className="absolute inset-0 z-50"
      onMouseMove={onMouseMove}
      onMouseLeave={onMouseLeave}
      onClick={triggerClick}
    >
      <svg className="absolute inset-0 w-full h-full overflow-visible pointer-events-none">
        <path
          d={tracePath}
          fill="none"
          stroke={hitCount >= dots.length ? "rgba(255,255,255,0.95)" : "rgba(255,255,255,0.88)"}
          strokeWidth={6}
          strokeLinecap="round"
          strokeLinejoin="round"
          style={{
            filter: "drop-shadow(0 0 10px rgba(255,255,255,0.08))",
          }}
        />
        {dots.map((pt, i) => {
          const isHit = i < hitCount;
          const isNext = i === hitCount;
          return (
            <circle
              key={`trace-dot-${i}`}
              cx={pt.x}
              cy={pt.y}
              r={isNext ? 10 : 7}
              fill={
                isHit
                  ? rainbowDotColor(i, dots.length, 0.95)
                  : isNext
                    ? rainbowDotColor(i, dots.length, 0.98)
                    : "rgba(255, 255, 255, 0.30)"
              }
              style={{
                filter: isNext ? `drop-shadow(0 0 8px ${rainbowDotColor(i, dots.length, 0.8)})` : "none",
              }}
            />
          );
        })}
        <WandCursorSVG activeCursor={activeCursor} trailItems={trailItems} clickKey={clickKey} isDrawActive={isDrawActive} />
      </svg>
      {traceLabelPos && (
        <div
          className="absolute text-center pointer-events-none"
          style={{
            left: traceLabelPos.x,
            top: traceLabelPos.y,
            transform: "translateX(-50%)",
          }}
        >
          <p className="text-white/70 font-mono text-lg tracking-widest uppercase">
            TRACE THE STAR!
          </p>
        </div>
      )}
    </div>
  );
}
