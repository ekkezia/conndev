import { useEffect, useRef, useState } from "react";
import { useWandCursor } from "../hooks/use-wand-cursor";
import WandCursorSVG from "./wand-cursor-svg";

export default function StopPromptOverlay({
  cursor,
  canvasRect,
  uiScale = 1,
  onConfirm,
  onCancel,
}) {
  const [hoveredButtonId, setHoveredButtonId] = useState(null);
  const buttonRefs = useRef(new Map());
  const { activeCursor, trailItems, onMouseMove, onMouseLeave, clickKey, triggerClick } =
    useWandCursor(cursor, canvasRect, { enableTrail: true });

  useEffect(() => {
    if (!activeCursor) {
      setHoveredButtonId(null);
      return;
    }
    let hoveredId = null;
    for (const [id, el] of buttonRefs.current.entries()) {
      if (!el) continue;
      const rect = el.getBoundingClientRect();
      const inside =
        activeCursor.x >= rect.left &&
        activeCursor.x <= rect.right &&
        activeCursor.y >= rect.top &&
        activeCursor.y <= rect.bottom;
      if (inside) {
        hoveredId = id;
        break;
      }
    }
    setHoveredButtonId(hoveredId);
  }, [activeCursor]);

  const bindButtonRef = (id) => (el) => {
    if (!el) {
      buttonRefs.current.delete(id);
      return;
    }
    buttonRefs.current.set(id, el);
  };

  return (
    <div
      className="absolute inset-0 z-[220] flex items-center justify-center bg-black/70 backdrop-blur-[1px]"
      onMouseMove={onMouseMove}
      onMouseLeave={onMouseLeave}
      onClick={triggerClick}
    >
      <svg className="absolute inset-0 z-[221] w-full h-full overflow-visible pointer-events-none">
        <WandCursorSVG
          activeCursor={activeCursor}
          trailItems={trailItems}
          clickKey={clickKey}
          isDrawActive={true}
        />
      </svg>

      <div
        className="w-full max-w-xl px-6"
        style={{ transform: `scale(${uiScale})`, transformOrigin: "center center" }}
      >
        <div className="rounded-2xl border border-cream-soda/55 bg-cola-brown/95 p-7 md:p-8 shadow-2xl"
          style={{
            background: 'rgba(243, 74, 167, 0.9)',
          }}
        >
          <h3 className="text-cream-soda font-mono text-3xl font-bold tracking-tight">
            <span className="inline-block rounded-xl bg-pink-doll/35 px-3 py-2">
              r u sure u wanna stop making magic?
            </span>
          </h3>
          <p className="text-cream-soda/70 font-mono text-sm mt-2">
            your current run will end and return to song menu.
          </p>
          <div className="mt-6 flex flex-wrap items-center justify-center gap-3">
            <button
              type="button"
              ref={bindButtonRef("stop-confirm")}
              onClick={onConfirm}
              data-clickable="true"
              className={`
                beat-menu-start is-ready text-cream-soda rounded-xl px-7 py-4 min-h-[4.25rem] font-mono text-xl font-bold uppercase min-w-[9rem]
                ${hoveredButtonId === "stop-confirm" ? "imu-hover-target is-selected" : ""}
              `}
            >
              ya!
            </button>
            <button
              type="button"
              ref={bindButtonRef("stop-cancel")}
              onClick={onCancel}
              data-clickable="true"
              className={`
                beat-menu-option text-cream-soda rounded-xl px-7 py-4 min-h-[4.25rem] font-mono text-xl min-w-[9rem]
                ${hoveredButtonId === "stop-cancel" ? "imu-hover-target is-selected" : ""}
              `}
            >
              NOPE!
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
