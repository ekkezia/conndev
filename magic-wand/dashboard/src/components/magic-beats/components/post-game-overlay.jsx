import { useMemo, useState } from "react";
import { useWandCursor } from "../hooks/use-wand-cursor";
import WandCursorSVG from "./wand-cursor-svg";

const MAX_NAME_LEN = 12;

const KEY_ROWS = [
  ["Q", "W", "E", "R", "T", "Y", "U", "I", "O", "P"],
  ["A", "S", "D", "F", "G", "H", "J", "K", "L"],
  ["Z", "X", "C", "V", "B", "N", "M"],
];

export default function PostGameOverlay({
  cursor,
  canvasRect,
  isDrawActive = true,
  song,
  score,
  playedAtMs,
  onSubmit,
}) {
  const [name, setName] = useState("");
  const { activeCursor, trailItems, onMouseMove, onMouseLeave, clickKey, triggerClick } = useWandCursor(cursor, canvasRect);

  const canSubmit = useMemo(() => name.trim().length > 0, [name]);
  const playedAtLabel = useMemo(() => {
    const d = new Date(playedAtMs ?? Date.now());
    if (Number.isNaN(d.getTime())) return "";
    return d.toLocaleString([], {
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
  }, [playedAtMs]);

  const appendChar = (ch) => {
    setName((prev) => {
      if (prev.length >= MAX_NAME_LEN) return prev;
      return prev + ch;
    });
  };

  const backspace = () => setName((prev) => prev.slice(0, -1));
  const clear = () => setName("");

  return (
    <div
      className="absolute inset-0 z-50 flex items-center justify-center bg-cola-brown/80 backdrop-blur-sm"
      onMouseMove={onMouseMove}
      onMouseLeave={onMouseLeave}
      onClick={triggerClick}
    >
      <svg className="absolute inset-0 w-full h-full overflow-visible pointer-events-none">
        <WandCursorSVG activeCursor={activeCursor} trailItems={trailItems} clickKey={clickKey} isDrawActive={isDrawActive} />
      </svg>

      <div className="w-full max-w-4xl px-6">
        <div className="rounded-2xl border border-cream-soda/40 bg-cola-brown/65 p-6 md:p-8 shadow-2xl">
          <div className="flex flex-col md:flex-row md:items-end md:justify-between gap-2">
            <div>
              <h2 className="text-cream-soda font-mono text-4xl font-bold tracking-tight">song complete</h2>
              <p className="text-cream-soda/70 font-mono text-lg mt-1">
                {song?.title} · {song?.artist}
              </p>
              <p className="text-cream-soda/60 font-mono text-xs mt-1">
                played at: {playedAtLabel}
              </p>
            </div>
            <p className="text-cream-soda font-mono text-2xl md:text-3xl font-bold">{score} pts</p>
          </div>

          <div className="mt-6">
            <p className="text-cream-soda/80 font-mono text-lg mb-2">type your name</p>
            <div className="min-h-[64px] rounded-xl border border-cream-soda/45 bg-black/30 px-4 py-3 text-cream-soda font-mono text-3xl tracking-wider flex items-center">
              {name || <span className="text-cream-soda/35 text-xl tracking-normal">YOUR NAME</span>}
            </div>
          </div>

          <div className="mt-4 flex flex-col gap-2">
            {KEY_ROWS.map((row, idx) => (
              <div key={idx} className="flex flex-wrap gap-2">
                {row.map((ch) => (
                  <button
                    key={ch}
                    type="button"
                    onClick={() => appendChar(ch)}
                    className="beat-menu-option text-cream-soda px-3 py-2 rounded-lg font-mono text-lg min-w-[2.8rem]"
                  >
                    {ch}
                  </button>
                ))}
              </div>
            ))}
            <div className="flex flex-wrap gap-2 pt-1">
              <button
                type="button"
                onClick={() => appendChar(" ")}
                className="beat-menu-option text-cream-soda px-4 py-2 rounded-lg font-mono text-lg min-w-[6rem]"
              >
                SPACE
              </button>
              <button
                type="button"
                onClick={backspace}
                className="beat-menu-option text-cream-soda px-4 py-2 rounded-lg font-mono text-lg min-w-[6rem]"
              >
                DELETE
              </button>
              <button
                type="button"
                onClick={clear}
                className="beat-menu-option text-cream-soda px-4 py-2 rounded-lg font-mono text-lg min-w-[6rem]"
              >
                CLEAR
              </button>
              <button
                type="button"
                disabled={!canSubmit}
                onClick={() => canSubmit && onSubmit(name.trim())}
                className={`
                  beat-menu-start rounded-lg px-6 py-2 font-mono text-lg font-bold uppercase
                  ${canSubmit ? "is-ready text-cream-soda cursor-pointer" : "is-disabled text-cream-soda/70 cursor-not-allowed"}
                `}
              >
                save & menu
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
