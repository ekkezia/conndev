import { useEffect, useMemo, useState } from "react";

const VISIBLE_ROWS = 8;
const ROLL_INTERVAL_MS = 1600;

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

export default function HighScoreBoardOverlay({ rows = [], wandOn = false }) {
  const [offset, setOffset] = useState(0);

  const items = useMemo(() => {
    const normalized = rows
      .filter(Boolean)
      .map((row) => ({
        id: String(row.id ?? `${row.name}-${row.playedAtMs}`),
        name: String(row.name ?? "PLAYER"),
        score: Number.isFinite(Number(row.score)) ? Number(row.score) : 0,
        songTitle: String(row.songTitle ?? "Unknown Song"),
        playedAt: row.playedAt,
      }));
    return normalized;
  }, [rows]);

  useEffect(() => {
    setOffset(0);
  }, [items.length]);

  useEffect(() => {
    if (items.length <= 1) return;
    const t = setInterval(() => {
      setOffset((prev) => (prev + 1) % items.length);
    }, ROLL_INTERVAL_MS);
    return () => clearInterval(t);
  }, [items.length]);

  const visible = useMemo(() => {
    if (!items.length) return [];
    const list = [];
    const n = Math.min(VISIBLE_ROWS, items.length);
    for (let i = 0; i < n; i++) {
      list.push(items[(offset + i) % items.length]);
    }
    return list;
  }, [items, offset]);

  return (
    <div className="absolute inset-0 z-50 flex items-center justify-center bg-cola-brown/55 backdrop-blur-sm pointer-events-none">
      <div className="w-full max-w-5xl px-6">
        <div className="rounded-2xl border border-cream-soda/45 bg-cola-brown/70 p-6 shadow-2xl">
          <div className="flex items-center justify-between">
            <h2 className="text-cream-soda font-mono text-4xl font-bold tracking-tight">high scores</h2>
            <p className="text-cream-soda/70 font-mono text-sm uppercase tracking-wider">
              magicwand: {wandOn ? "on" : "off"}
            </p>
          </div>
          <p className="text-cream-soda/55 font-mono text-sm mt-1">score · player · song · date/time</p>

          {!visible.length ? (
            <div className="mt-6 rounded-xl border border-cream-soda/25 bg-black/25 px-5 py-6 text-cream-soda/55 font-mono text-lg">
              no scores yet. play a song to create the first entry.
            </div>
          ) : (
            <div className="mt-4 flex flex-col gap-2">
              {visible.map((row) => (
                <div
                  key={row.id}
                  className="rounded-xl border border-cream-soda/30 bg-black/25 px-4 py-3 flex items-center justify-between gap-4"
                >
                  <div className="min-w-0">
                    <p className="text-cream-soda font-mono text-xl leading-tight truncate">
                      {row.name} · {row.songTitle}
                    </p>
                    <p className="text-cream-soda/60 font-mono text-xs mt-1 truncate">
                      {formatPlayedAt(row.playedAt)}
                    </p>
                  </div>
                  <p className="text-cream-soda font-mono text-2xl font-bold tabular-nums shrink-0">
                    {row.score}
                  </p>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
