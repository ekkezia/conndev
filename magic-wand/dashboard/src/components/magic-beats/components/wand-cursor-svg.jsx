import { useEffect, useRef } from "react";
import { TRAIL_LIFETIME } from "../constants";
import { svgStarPoints } from "../geometry";

export default function WandCursorSVG({ activeCursor, trailItems, clickKey = 0, isDrawActive = true }) {
  const scaleAnimRef = useRef(null);
  const colorAnimRef = useRef(null);
  const baseFill = isDrawActive ? "rgba(255,180,59,0.9)" : "rgba(160,160,160,0.9)";

  useEffect(() => {
    if (clickKey > 0) {
      scaleAnimRef.current?.beginElement();
      colorAnimRef.current?.beginElement();
    }
  }, [clickKey]);

  return (
    <>
      {trailItems.map((item) => {
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
          <circle cx={0} cy={0} r={28} fill={baseFill} stroke="rgba(255,241,221,0.6)" strokeWidth="3">
            <animateTransform
              ref={scaleAnimRef}
              attributeName="transform"
              type="scale"
              values="1;1.9;1"
              dur="0.35s"
              begin="indefinite"
              calcMode="spline"
              keySplines="0.2 0 0.2 1;0.2 0 0.2 1"
            />
            <animate
              ref={colorAnimRef}
              attributeName="fill"
              values={`${baseFill};rgba(255,70,130,0.95);${baseFill}`}
              dur="0.35s"
              begin="indefinite"
            />
          </circle>
        </g>
      )}
    </>
  );
}
