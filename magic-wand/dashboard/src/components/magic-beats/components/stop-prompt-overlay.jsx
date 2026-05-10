import { useWandCursor } from "../hooks/use-wand-cursor";
import WandCursorSVG from "./wand-cursor-svg";

export default function StopPromptOverlay({
  cursor,
  canvasRect,
  isDrawActive = true,
  onConfirm,
  onCancel,
}) {
  const { activeCursor, trailItems, onMouseMove, onMouseLeave, clickKey, triggerClick } =
    useWandCursor(cursor, canvasRect);

  return (
    <div
      className="absolute inset-0 z-[70] flex items-center justify-center bg-black/65 backdrop-blur-sm"
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
              onClick={onConfirm}
              data-clickable="true"
              className="beat-menu-start is-ready text-cream-soda rounded-xl px-7 py-3 font-mono text-xl font-bold uppercase min-w-[9rem]"
            >
              ya!
            </button>
            <button
              type="button"
              onClick={onCancel}
              data-clickable="true"
              className="beat-menu-option text-cream-soda rounded-xl px-7 py-3 font-mono text-xl min-w-[9rem]"
            >
              nope
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
