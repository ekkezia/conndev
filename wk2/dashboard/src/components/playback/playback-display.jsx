import clsx from "clsx";
import MenuButton from "../../menu-button";
import { useIMU } from "../../contexts/IMUContext";
import { useMemo, useEffect, useRef, useState } from "react";

function formatPlaybackTime(ms) {
  const safeMs = Number.isFinite(ms) ? Math.max(0, ms) : 0;
  const totalSeconds = Math.floor(safeMs / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

// Small canvas thumbnail showing the drawn path for one session
function SessionPreview({ session }) {
  const canvasRef = useRef(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    
    // Convert data to array if it's a Firebase object
    let dataArray = [];
    if (session?.data) {
      if (Array.isArray(session.data)) {
        dataArray = session.data;
      } else if (typeof session.data === 'object') {
        dataArray = Object.values(session.data);
      }
    }
    
    if (dataArray.length === 0) return;
    
    const ctx = canvas.getContext("2d");
    const W = canvas.width;
    const H = canvas.height;
    ctx.clearRect(0, 0, W, H);

    // Collect valid points mapped to canvas space
    const points = dataArray
      .filter((e) => e?.sensor?.mouseTargetX != null && e?.screenSize)
      .map((e) => ({
        x: (e.sensor.mouseTargetX / e.screenSize.width) * W,
        y: (e.sensor.mouseTargetY / e.screenSize.height) * H,
        mag: e.sensor.mag ?? 1,
      }));

    if (points.length < 2) return;

    // Draw path
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    for (let i = 1; i < points.length; i++) {
      const prev = points[i - 1];
      const curr = points[i];
      const maxMag = 40;
      const width = Math.max(0.5, Math.min(4, (curr.mag / maxMag) * 4));
      ctx.beginPath();
      ctx.moveTo(prev.x, prev.y);
      ctx.lineTo(curr.x, curr.y);
      ctx.strokeStyle = "rgba(0, 0, 0, 0.85)";
      ctx.lineWidth = width;
      ctx.stroke();
    }
  }, [session]);

  const duration = useMemo(() => {
    let dataArray = [];
    if (session?.data) {
      if (Array.isArray(session.data)) {
        dataArray = session.data;
      } else if (typeof session.data === 'object') {
        dataArray = Object.values(session.data);
      }
    }
    
    if (dataArray.length === 0) return null;
    const first = dataArray[0]?.timestamp;
    const last = dataArray[dataArray.length - 1]?.timestamp;
    return Number.isFinite(first) && Number.isFinite(last) ? last - first : null;
  }, [session]);

  return (
    <div className="flex gap-2 items-center p-2 rounded-lg hover:bg-white/5 cursor-pointer transition">
      {/* Thumbnail */}
      <div className="relative flex-shrink-0 rounded overflow-hidden bg-gray-400 border border-white/10" style={{ width: 120, height: 68 }}>
        <canvas ref={canvasRef} width={120} height={68} className="w-full h-full" />
        {duration != null && (
          <span className="absolute bottom-1 right-1 text-[9px] font-mono bg-black/80 text-white px-1 rounded">
            {formatPlaybackTime(duration)}
          </span>
        )}
      </div>
      {/* Meta */}
      <div className="flex flex-col gap-0.5 min-w-0">
        <span className="text-xs text-white font-mono truncate">{session.id}</span>
        <span className="text-[10px] text-white/50 font-mono">
          {session.startTimestamp ? new Date(session.startTimestamp).toLocaleString() : "—"}
        </span>
        <span className="text-[10px] text-white/40 font-mono">{Array.isArray(session.data) ? session.data.length : (typeof session.data === 'object' ? Object.keys(session.data).length : 0)} pts</span>
      </div>
    </div>
  );
}

export default function PlaybackDisplay({ className }) {
  const {
    playbackMode: isOpen,
    setPlaybackMode: setIsOpen,
    playbackStatus,
    setPlaybackStatus,
    sessions,
    selectedSession,
    setSelectedSession,
    selectedSessionData,
    sessionsUpdated,
  } = useIMU();

  // Always-fresh data for the selected session (derived live in IMUContext)
  const activeData = selectedSessionData;
  const displayRef = useRef(null);
  const [sessionsPulse, setSessionsPulse] = useState(false);

  // Trigger pulse animation when sessions are updated
  useEffect(() => {
    if (sessionsUpdated) {
      setSessionsPulse(true);
      const timer = setTimeout(() => setSessionsPulse(false), 600);
      return () => clearTimeout(timer);
    }
  }, [sessionsUpdated]);

  // Reset playback head whenever the active data source changes
  useEffect(() => {
    const data = activeData || [];
    const now = Date.now();
    const filteredData = data.filter((d) => d.timestamp <= now);
    const closestTimestamp =
      filteredData.length > 0
        ? filteredData[filteredData.length - 1].timestamp
        : now;

    setPlaybackStatus((prev) => ({
      ...prev,
      clippedTimestamp: closestTimestamp,
      currentTimestamp: closestTimestamp,
      currentDataIdx: filteredData.length - 1,
      isPlaying: false,
    }));
  }, [isOpen, selectedSession]);

  // do not put set objects to useMemo dependencies to avoid infinite loop
  const clippedSensorData = useMemo(
    () =>
      (activeData || []).filter(
        (d) => d.timestamp <= playbackStatus.clippedTimestamp
      ), // only playback up until the current timestamp when user has clicked the playback button
    [activeData, playbackStatus.clippedTimestamp]
  );

  const progressSensorData = useMemo(() => {
    if (!clippedSensorData || clippedSensorData.length === 0) return 0;
    const firstTimestamp = activeData[0].timestamp;
    const lastTimestamp = playbackStatus.clippedTimestamp;
    const range = lastTimestamp - firstTimestamp;

    if (range <= 0) return 0;
    const progress = (playbackStatus.currentTimestamp - firstTimestamp) / range;
    return Math.min(Math.max(progress, 0), 1); // clamp between 0 and 1
  }, [clippedSensorData, playbackStatus, activeData]);

  const playbackTimes = useMemo(() => {
    const firstTimestamp = activeData?.[0]?.timestamp;
    if (!Number.isFinite(firstTimestamp)) {
      return { currentMs: 0, totalMs: 0 };
    }

    return {
      currentMs: Math.max(0, (playbackStatus.currentTimestamp ?? firstTimestamp) - firstTimestamp),
      totalMs: Math.max(0, (playbackStatus.clippedTimestamp ?? firstTimestamp) - firstTimestamp),
    };
  }, [activeData, clippedSensorData, playbackStatus.currentTimestamp, playbackStatus.clippedTimestamp]);

  // Playback effect: auto-advance currentTimestamp if it's less than clippedTimestamp
  useEffect(() => {
    if (!clippedSensorData || clippedSensorData.length === 0) return;

    // paused
    if (!playbackStatus.isPlaying) {
      // console.log(
      //   "Playback paused at timestamp:",
      //   playbackStatus.currentTimestamp
      // );
    } else {
      // autoplay — 1 point per tick, drawing-display lerps smoothly between them
      const interval = setInterval(() => {
        setPlaybackStatus((prev) => {
          // Stop if we've reached or exceeded the clipped timestamp
          if (prev.currentTimestamp >= prev.clippedTimestamp) {
            return prev;
          }

          // Use the stored currentDataIdx or default to 0
          let currentIndex = prev.currentDataIdx ?? 0;

          // If we're at the end, stop
          if (currentIndex >= clippedSensorData.length - 1) {
            return prev;
          }

          const nextIndex = currentIndex + 1;
          const nextTimestamp = clippedSensorData[nextIndex].timestamp;

          // Stop if we've exceeded the clipped timestamp
          if (nextTimestamp > prev.clippedTimestamp) {
            return prev;
          }

          return {
            ...prev,
            currentDataIdx: nextIndex,
            currentTimestamp: nextTimestamp,
          };
        });
      }, 800);

      return () => clearInterval(interval);
    }
  }, [clippedSensorData, setPlaybackStatus, playbackStatus.isPlaying]);

  useEffect(() => {
    if (!isOpen) return;

    const handleClickAway = (event) => {
      if (!displayRef.current?.contains(event.target)) {
        setIsOpen(false);
      }
    };

    document.addEventListener("mousedown", handleClickAway);
    return () => document.removeEventListener("mousedown", handleClickAway);
  }, [isOpen, setIsOpen]);

  return (
    <div ref={displayRef}>
      {/* Session history sidebar */}
      {isOpen && (
        <div className={`absolute w-72 top-[10%] right-2 bg-black/90 border border-white/10 rounded-xl max-h-[70vh] overflow-y-auto flex flex-col gap-0.5 p-1.5 transition-all duration-300 ${sessionsPulse ? 'ring-2 ring-cyan-400/50' : ''}`}>
          <div className="text-[10px] text-white/40 font-mono px-2 py-1 uppercase tracking-widest">Sessions</div>
          {sessions.length === 0 && (
            <div className="text-[11px] text-white/30 font-mono px-2 py-3 text-center">No sessions yet</div>
          )}
          {[...sessions].reverse().map((session) => (
            <div
              key={session.id}
              onClick={() => {
                let data = [];
                if (session.data) {
                  if (Array.isArray(session.data)) {
                    data = session.data;
                  } else if (typeof session.data === 'object') {
                    data = Object.values(session.data);
                  }
                }
                const first = data[0]?.timestamp;
                const last = data[data.length - 1]?.timestamp;
                console.log('[SessionPreview click]', {
                  id: session.id,
                  points: data.length,
                  firstTimestamp: first,
                  lastTimestamp: last,
                  durationMs: last - first,
                  firstDate: first ? new Date(first).toISOString() : null,
                });
                setSelectedSession(session);
              }}
              className={`rounded-lg outline outline-2 transition-all ${
                selectedSession?.id === session.id
                  ? 'outline-fuchsia-500'
                  : 'outline-transparent'
              }`}
            >
              <SessionPreview session={session} />
            </div>
          ))}
        </div>
      )}
      <MenuButton
        className={clsx(
          "bottom-4 right-4 z-50",
          isOpen ? "w-fit h-fit rounded-xl" : "w-12 h-12 rounded-full"
        )}
        onClick={!isOpen ? () => setIsOpen(true) : undefined}
      >
        {!isOpen && <span className="w-full h-full flex items-center justify-center text-xl">🕘</span>}
        {isOpen && (
          <div className={clsx("flex flex-col min-w-[80vw] h-fit p-2 max-w-[80vw] gap-2", className)} onClick={(e) => e.stopPropagation()}>
            <div className="rounded-lg border border-white/10 bg-black/80 px-3 py-2 flex items-center gap-3">
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  setPlaybackStatus((prev) => ({
                    ...prev,
                    isPlaying: !prev.isPlaying,
                  }));
                }}
                className="w-8 h-8 rounded-full bg-white/15 hover:bg-white/25 active:scale-95 transition text-white text-xs font-bold flex items-center justify-center"
                aria-label={playbackStatus.isPlaying ? "Pause playback" : "Play playback"}
              >
                {playbackStatus.isPlaying ? "❚❚" : "▶"}
              </button>
              <div className="flex-1">
                <SensorGraph
                  clippedSensorData={clippedSensorData}
                  playbackStatus={playbackStatus}
                  setPlaybackStatus={setPlaybackStatus}
                  progressSensorData={progressSensorData}
                />
              </div>
              <div className="text-[11px] font-mono text-white/70 tabular-nums whitespace-nowrap">
                {formatPlaybackTime(playbackTimes.currentMs)} / {formatPlaybackTime(playbackTimes.totalMs)}
              </div>
            </div>
          </div>
        )}
      </MenuButton>
    </div>
  );
}

function SensorGraph({ clippedSensorData, playbackStatus, setPlaybackStatus, progressSensorData }) {
    const [hoverRatio, setHoverRatio] = useState(null);

    if (
      !clippedSensorData ||
      !Array.isArray(clippedSensorData) ||
      clippedSensorData.length === 0
    )
      return null;
    const firstTimestamp = clippedSensorData[0].timestamp;
    const range = playbackStatus.clippedTimestamp - firstTimestamp;

    const getRatioFromPointer = (event) => {
      const rect = event.currentTarget.getBoundingClientRect();
      const pointerX = event.clientX - rect.left;
      return Math.min(Math.max(pointerX / rect.width, 0), 1);
    };

    const scrubToRatio = (ratio) => {
      const targetTimestamp = firstTimestamp + ratio * range;

      // Find the closest sensor data point to the target timestamp
      const closestIndex = clippedSensorData.findIndex(
        (d) => d.timestamp >= targetTimestamp
      );
      const actualIndex =
        closestIndex === -1 ? clippedSensorData.length - 1 : closestIndex;
      const actualTimestamp = clippedSensorData[actualIndex].timestamp;

      setPlaybackStatus((prev) => ({
        ...prev,
        currentDataIdx: actualIndex,
        currentTimestamp: actualTimestamp,
        isPlaying: prev.isPlaying, // preserve current play/pause state
      }));
    };

    const hoverTimestamp =
      hoverRatio === null ? null : firstTimestamp + hoverRatio * range;
    const hoverTimeMs =
      hoverTimestamp === null
        ? 0
        : Math.max(0, hoverTimestamp - firstTimestamp);

    return (
      <div
        className="h-6 w-full relative flex items-center"
        onClick={(e) => {
          e.stopPropagation();
          scrubToRatio(getRatioFromPointer(e));
        }}
        onMouseMove={(e) => setHoverRatio(getRatioFromPointer(e))}
        onMouseEnter={(e) => setHoverRatio(getRatioFromPointer(e))}
        onMouseLeave={() => setHoverRatio(null)}
      >
        <div
          className="h-1.5 w-full rounded-full bg-white/20 overflow-hidden relative cursor-pointer"
        >
          <div
            className="absolute top-0 left-0 h-full bg-red-600"
            style={{
              width: `${progressSensorData * 100}%`,
              transition: "width 300ms ease-out",
            }}
          />
          <div
            className="absolute top-1/2 h-2.5 w-2.5 rounded-full bg-red-600 -translate-y-1/2 shadow shadow-black/80 pointer-events-none"
            style={{ left: `calc(${progressSensorData * 100}% - 5px)` }}
          />
          {hoverRatio !== null && (
            <>
              <div
                className="absolute top-1/2 h-3.5 w-3.5 rounded-full border border-white/90 bg-red-500 -translate-y-1/2 pointer-events-none"
                style={{ left: `calc(${hoverRatio * 100}% - 7px)` }}
              />
              <div
                className="absolute -top-7 -translate-x-1/2 px-1.5 py-0.5 rounded bg-black/90 border border-white/20 text-[10px] text-white font-mono whitespace-nowrap pointer-events-none"
                style={{ left: `${hoverRatio * 100}%` }}
              >
                {formatPlaybackTime(hoverTimeMs)}
              </div>
            </>
          )}
        </div>
        {hoverRatio !== null && (
          <div
            className="absolute h-6 w-px bg-white/35 pointer-events-none"
            style={{ left: `${hoverRatio * 100}%` }}
          />
        )}
      </div>
    );
  }
