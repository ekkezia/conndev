import { useCallback, useMemo, useRef } from "react";
import { useWandCursor } from "../hooks/use-wand-cursor";
import WandCursorSVG from "./wand-cursor-svg";

function formatPlayedAt(value) {
  if (!value) return "Unknown time";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "Unknown time";
  return d.toLocaleString([], {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export default function HighScoreBoardOverlay({
  rows = [],
  wandOn = false,
  cursor,
  canvasRect,
  isDrawActive = true,
}) {
  const listScrollRef = useRef(null);
  const { activeCursor, trailItems, onMouseMove, onMouseLeave, clickKey, triggerClick } =
    useWandCursor(cursor, canvasRect);
  const items = useMemo(() => {
    const normalized = rows
      .filter(Boolean)
      .map((row) => ({
        id: String(row.id ?? `${row.name}-${row.playedAtMs}`),
        name: String(row.name ?? "PLAYER"),
        score: Number.isFinite(Number(row.score)) ? Number(row.score) : 0,
        songTitle: String(row.songTitle ?? "Unknown Song"),
        playedAt: row.playedAt,
        playedAtMs: Number.isFinite(Number(row.playedAtMs))
          ? Number(row.playedAtMs)
          : new Date(row.playedAt ?? 0).getTime() || 0,
      }))
      .sort((a, b) => b.score - a.score || b.playedAtMs - a.playedAtMs);
    return normalized;
  }, [rows]);

  const scrollListBy = useCallback((delta) => {
    const el = listScrollRef.current;
    if (!el) return;
    el.scrollBy({ top: delta, behavior: "auto" });
  }, []);

  return (
    <div
      className="absolute inset-0 z-50 flex items-center justify-center bg-cola-brown/74 backdrop-blur-md"
      onMouseMove={onMouseMove}
      onMouseLeave={onMouseLeave}
      onClick={triggerClick}
    >
      <svg className="absolute inset-0 z-[120] w-full h-full overflow-visible pointer-events-none">
        <WandCursorSVG
          activeCursor={activeCursor}
          trailItems={trailItems}
          clickKey={clickKey}
          isDrawActive={isDrawActive}
        />
      </svg>
      <div className="w-full max-w-5xl px-6">
        <div className="relative pointer-events-auto rounded-2xl border border-cream-soda/35 bg-gradient-to-br from-[#ff4fa3]/35 via-[#ff8a86]/35 to-[#ffb43b]/80 p-6 shadow-2xl"
          style={{
            background: 'linear-gradient(135deg, rgba(82, 6, 43, 0.5) 0%, rgba(255,138,134,0.5) 50%, rgba(255,180,59,0.5) 100%)',
          }}
        >
          <div className="flex items-center justify-between">
            <h2 className="text-cream-soda font-mono text-4xl font-bold tracking-tight">MagicWand™ Prodigies</h2>
            <p className="text-cream-soda/70 font-mono text-sm uppercase tracking-wider">
              magicwand: {wandOn ? "on" : "off"}
            </p>
          </div>

          {!items.length ? (
            <div className="mt-6 rounded-xl border border-cream-soda/35 bg-gradient-to-r from-[#ff4fa3]/26 to-[#ffb43b]/24 px-5 py-6 text-cream-soda/82 font-mono text-lg">
              no scores yet. play a song!
            </div>
          ) : (
            <div className="mt-4 flex items-stretch gap-3">
              <div
                ref={listScrollRef}
                className="flex-1 max-h-[52vh] overflow-y-auto pr-1 rounded-2xl bg-gradient-to-r from-[#ff4fa3]/22 via-[#ff8a86]/18 to-[#ffb43b]/24 p-2"
              >
                <div className="flex flex-col gap-2">
                  {items.map((row) => (
                    <div
                      key={row.id}
                      className="border-b border-cream-soda/40 bg-gradient-to-r from-[#ff4fa3]/24 via-[#ff8a86]/18 to-[#ffb43b]/26 px-4 py-1 flex items-center justify-between gap-4"
                    >
                      <div className="min-w-0">
                        <p className="text-cream-soda font-mono text-2xl leading-tight truncate">
                          {row.name} · {row.songTitle}
                        </p>
                        <p className="text-cream-soda/60 font-mono text-xs truncate">
                          {formatPlayedAt(row.playedAt)}
                        </p>
                      </div>
                      <p className="text-cream-soda font-mono text-2xl font-bold tabular-nums shrink-0">
                        {row.score}
                      </p>
                    </div>
                  ))}
                </div>
              </div>
              <div className="w-20 max-h-[52vh] rounded-2xl border border-cream-soda/35 bg-black/35 p-2.5 flex flex-col items-stretch">
                <button
                  type="button"
                  onClick={() => scrollListBy(-180)}
                  className="beat-menu-option w-full flex-1 rounded-lg font-mono text-2xl text-cream-soda flex items-center justify-center"
                  data-clickable="true"
                >
                  ▲
                </button>
                <button
                  type="button"
                  onClick={() => scrollListBy(180)}
                  className="beat-menu-option w-full flex-1 rounded-lg font-mono text-2xl text-cream-soda flex items-center justify-center mt-2.5"
                  data-clickable="true"
                >
                  ▼
                </button>
              </div>
            </div>
          )}

          <div className="fixed bottom-4 right-5 pointer-events-none text-right">
            <p className="text-cream-soda/90 font-mono text-[10px] md:text-xs uppercase tracking-wider mb-1 max-w-[200px]">
              FLIP THE WAND TO THE BACK AND FRONT FOR TUTORIAL
            </p>
            <img
              src="/images/magic-wand-tutorial.png"
              alt="Magic wand tutorial"
              className="ml-auto w-32 md:w-40 rounded-lg border border-cream-soda/45 shadow-lg object-cover"
            />
          </div>

          <div className="fixed bottom-4 left-5 pointer-events-none text-left">
            <p className="text-cream-soda/90 font-mono text-[10px] md:text-xs uppercase tracking-wider mb-1 max-w-[200px]">
              CLICK DRAW BUTTON TO TOGGLE BETWEEN TRAX LIST AND PRODIGY LIST
            </p>
            <img
              src="/images/magic-wand-draw.png"
              alt="Magic wand draw button"
              className="w-28 md:w-36 rounded-lg border border-cream-soda/45 shadow-lg object-cover"
            />
          </div>
        </div>
      </div>
    </div>
  );
}
