import { useCallback, useEffect, useRef, useState } from "react";
import SONGS from "../../../config/game.json";
import { useWandCursor } from "../hooks/use-wand-cursor";
import WandCursorSVG from "./wand-cursor-svg";

export default function SongSelectOverlay({ cursor, canvasRect, onStart, isDrawActive = true }) {
  const [selected, setSelected] = useState(null);
  const previewAudioRef = useRef(null);
  const previewSrcRef = useRef(null);
  const songButtonRefs = useRef([]);
  const listScrollRef = useRef(null);
  const hoveredSongSrcRef = useRef(null);
  const { activeCursor, trailItems, onMouseMove, onMouseLeave, clickKey, triggerClick } = useWandCursor(cursor, canvasRect);

  const stopPreview = useCallback(() => {
    if (previewAudioRef.current) {
      previewAudioRef.current.pause();
      previewAudioRef.current = null;
    }
    previewSrcRef.current = null;
  }, []);

  const playPreview = useCallback((song) => {
    if (!song?.src) return;
    if (previewAudioRef.current && previewSrcRef.current === song.src) {
      previewAudioRef.current.play().catch(() => {});
      return;
    }
    stopPreview();
    const preview = new Audio(song.src);
    preview.volume = 0.35;
    preview.loop = true;
    preview.currentTime = 0;
    preview.play().catch(() => {});
    previewAudioRef.current = preview;
    previewSrcRef.current = song.src;
  }, [stopPreview]);

  useEffect(() => () => {
    stopPreview();
  }, [stopPreview]);

  const scrollListBy = useCallback((delta) => {
    const el = listScrollRef.current;
    if (!el) return;
    el.scrollBy({ top: delta, behavior: "smooth" });
  }, []);

  useEffect(() => {
    if (!activeCursor) return;

    let hoveredSong = null;
    for (let idx = 0; idx < SONGS.length; idx += 1) {
      const el = songButtonRefs.current[idx];
      if (!el) continue;
      const rect = el.getBoundingClientRect();
      const inside =
        activeCursor.x >= rect.left &&
        activeCursor.x <= rect.right &&
        activeCursor.y >= rect.top &&
        activeCursor.y <= rect.bottom;
      if (inside) {
        hoveredSong = SONGS[idx];
        break;
      }
    }

    const hoveredSrc = hoveredSong?.src ?? null;
    if (hoveredSrc && hoveredSrc !== hoveredSongSrcRef.current) {
      hoveredSongSrcRef.current = hoveredSrc;
      setSelected(hoveredSong);
      playPreview(hoveredSong);
    } else if (!hoveredSrc) {
      hoveredSongSrcRef.current = null;
    }
  }, [activeCursor, playPreview]);

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
      <div className="w-full max-w-2xl px-6">
        <div className="rounded-3xl border border-cream-soda/45 bg-cola-brown/82 shadow-2xl backdrop-blur-md p-8 md:p-10 flex flex-col gap-6">
        <div>
          <h2 className="text-cream-soda font-mono text-4xl font-bold tracking-tight">MagicBeats</h2>
          <p className="text-cream-soda/50 font-mono text-2xl mt-2">select a track to play</p>
        </div>

        <p className="text-cream-soda/55 font-mono text-sm uppercase tracking-wider">track list</p>

        <div className="flex items-stretch gap-3">
          <div ref={listScrollRef} className="flex-1 flex flex-col gap-2 max-h-[50vh] overflow-y-auto pr-1 select-none">
            {SONGS.map((song, idx) => (
              <button
                key={`${song.src}-${idx}`}
                type="button"
                draggable={false}
                ref={(el) => {
                  songButtonRefs.current[idx] = el;
                }}
                onClick={() => {
                  setSelected(song);
                  stopPreview();
                  onStart(song);
                }}
                onMouseEnter={() => {
                  setSelected(song);
                  playPreview(song);
                }}
                onFocus={() => {
                  setSelected(song);
                  playPreview(song);
                }}
                className={`
                  beat-menu-option flex flex-col gap-0.5 text-left px-4 py-3 rounded-xl border transition-all duration-150 select-none
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

          <div className="w-14 max-h-[50vh] rounded-2xl border border-cream-soda/35 bg-black/35 p-2 flex flex-col items-center">
            <button
              type="button"
              onClick={() => scrollListBy(-180)}
              className="beat-menu-option w-full h-12 rounded-lg font-mono text-xl text-cream-soda flex items-center justify-center"
              data-clickable="true"
            >
              ▲
            </button>
            <div className="my-2 w-2 flex-1 rounded-full bg-cream-soda/20 relative overflow-hidden">
              <div className="absolute inset-x-0 top-1/4 h-1/4 rounded-full bg-cream-soda/55" />
            </div>
            <button
              type="button"
              onClick={() => scrollListBy(180)}
              className="beat-menu-option w-full h-12 rounded-lg font-mono text-xl text-cream-soda flex items-center justify-center"
              data-clickable="true"
            >
              ▼
            </button>
          </div>
        </div>
        </div>
      </div>
    </div>
  );
}
