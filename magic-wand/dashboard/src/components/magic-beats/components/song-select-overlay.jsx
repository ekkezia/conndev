import { useState } from "react";
import SONGS from "../../../config/game.json";
import { useWandCursor } from "../hooks/use-wand-cursor";
import WandCursorSVG from "./wand-cursor-svg";

export default function SongSelectOverlay({ cursor, canvasRect, onStart, isDrawActive = true }) {
  const [selected, setSelected] = useState(null);
  const { activeCursor, trailItems, onMouseMove, onMouseLeave, clickKey, triggerClick } = useWandCursor(cursor, canvasRect);

  return (
    <div
      className="absolute inset-0 z-50 flex items-center justify-center bg-cola-brown/75 backdrop-blur-sm"
      onMouseMove={onMouseMove}
      onMouseLeave={onMouseLeave}
      onClick={triggerClick}
    >
      <svg className="absolute inset-0 w-full h-full overflow-visible pointer-events-none">
        <WandCursorSVG activeCursor={activeCursor} trailItems={trailItems} clickKey={clickKey} isDrawActive={isDrawActive} />
      </svg>
      <div className="p-10 w-full max-w-lg flex flex-col gap-6">
        <div>
          <h2 className="text-cream-soda font-mono text-4xl font-bold tracking-tight">beat game</h2>
          <p className="text-cream-soda/50 font-mono text-2xl mt-2">select a track to play</p>
        </div>

        <div className="flex flex-col gap-2">
          {SONGS.map((song) => (
            <button
              key={song.src}
              type="button"
              onClick={() => setSelected(song)}
              className={`
                beat-menu-option flex flex-col gap-0.5 text-left px-4 py-3 rounded-xl border transition-all duration-150
                ${selected?.src === song.src ? "is-selected text-cream-soda" : "is-idle text-cream-soda/95"}
              `}
            >
              <span className="font-mono text-2xl font-semibold">{song.title}</span>
              <span className="font-mono text-xl text-cream-soda/55">
                {song.artist} · {song.bpm} BPM
              </span>
            </button>
          ))}
        </div>

        <button
          type="button"
          disabled={!selected}
          onClick={() => selected && onStart(selected)}
          className={`
            beat-menu-start w-full py-4 rounded-xl font-mono text-2xl font-bold tracking-wider uppercase transition-all duration-150
            ${selected ? "is-ready text-cream-soda active:scale-95 cursor-pointer" : "is-disabled text-cream-soda/80 cursor-not-allowed"}
          `}
        >
          {selected ? "start" : "select a track"}
        </button>
      </div>
    </div>
  );
}
