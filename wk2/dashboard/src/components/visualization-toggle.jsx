import clsx from "clsx";
import { useIMU } from "../contexts/IMUContext";
import { useEffect, useRef } from "react";

function GridHelperToggle() {
  const { enableHelper, setEnableHelper } = useIMU();

  return (
    <button
      type="button"
      onClick={() => setEnableHelper((prev) => !prev)}
      className={clsx(
        "px-2 py-1 rounded border text-xs",
        enableHelper
          ? "bg-white text-black border-white"
          : "bg-black/40 text-white border-white/30",
      )}
    >
      <span className={!enableHelper ? "line-through hover:no-underline" : "no-underline hover:line-through"}>
        GRID
      </span>
    </button>
  );
}

function DotmapToggle() {
  const { showDotmap, setShowDotmap } = useIMU();
  return (
    <button
      type="button"
      onClick={() => setShowDotmap((prev) => !prev)}
      className={clsx(
        "px-2 py-1 rounded border text-xs",
        showDotmap
          ? "bg-white text-black border-white"
          : "bg-black/40 text-white border-white/30",
      )}
    >
      <span className={!showDotmap ? "line-through hover:no-underline" : "no-underline hover:line-through"}>
        DOTMAP
      </span>
    </button>
  );
}

export default function VisualizationToggle({ isOpen, onClose, status }) {
  const displayRef = useRef(null);

  useEffect(() => {
    if (!isOpen) return;

    const handleClickAway = (event) => {
      if (!displayRef.current?.contains(event.target)) {
        onClose();
      }
    };

    document.addEventListener("mousedown", handleClickAway);
    return () => document.removeEventListener("mousedown", handleClickAway);
  }, [isOpen, onClose]);

  return (
    isOpen && (
      <div
        ref={displayRef}
        className="absolute top-16 left-4 w-fit h-fit bg-black/80 rounded-lg border border-white/20 p-2 flex flex-col gap-2"
        onClick={(e) => e.stopPropagation()}
      >
        <GridHelperToggle />
        <DotmapToggle />
        <div className="border-t border-white/10 pt-2 flex items-center justify-center gap-2 text-xs">
          <span className="text-xl">{status === 'connected' ? '🔗' : '⛓️‍💥'}</span>
          <span className="text-white/70">{status}</span>
        </div>
      </div>
    )
  );
}
