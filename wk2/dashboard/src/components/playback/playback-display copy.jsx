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

export default function PlaybackDisplay({ className }) {
  const {
    playbackMode: isOpen,
    setPlaybackMode: setIsOpen,
    sensorData,
    playbackStatus,
    setPlaybackStatus,
    sessions
  } = useIMU();
  const displayRef = useRef(null);

  // clipped timestamp is the timestamp in the sensor data that matches the latest timestamp before the current Date.now()
  // current timestamp is the timestamp that the user has clicked on the playback bar
  useEffect(() => {
    const now = Date.now();

    // Find the closest timestamp in sensorData that is <= now
    const filteredData = (sensorData || []).filter((d) => d.timestamp <= now);
    const closestTimestamp =
      filteredData.length > 0
        ? filteredData[filteredData.length - 1].timestamp
        : now;

    setPlaybackStatus((prev) => ({
      ...prev,
      clippedTimestamp: closestTimestamp,
      currentTimestamp: closestTimestamp,
    }));
    // console.log('Playback mode changed:', closestTimestamp);
  }, [isOpen, sensorData]);

  // do not put set objects to useMemo dependencies to avoid infinite loop
  const clippedSensorData = useMemo(
    () =>
      (sensorData || []).filter(
        (d) => d.timestamp <= playbackStatus.clippedTimestamp
      ), // only playback up until the current timestamp when user has clicked the playback button
    [sensorData, playbackStatus.clippedTimestamp]
  );

  const progressSensorData = useMemo(() => {
    if (!clippedSensorData || clippedSensorData.length === 0) return 0;
    const firstTimestamp = sensorData[0].timestamp;
    const lastTimestamp = playbackStatus.clippedTimestamp;
    const range = lastTimestamp - firstTimestamp;

    if (range <= 0) return 0;
    const progress = (playbackStatus.currentTimestamp - firstTimestamp) / range;
    return Math.min(Math.max(progress, 0), 1); // clamp between 0 and 1
  }, [clippedSensorData, playbackStatus, sensorData]);

  const playbackTimes = useMemo(() => {
    const firstTimestamp = clippedSensorData?.[0]?.timestamp;
    if (!Number.isFinite(firstTimestamp)) {
      return { currentMs: 0, totalMs: 0 };
    }

    return {
      currentMs: Math.max(0, (playbackStatus.currentTimestamp ?? firstTimestamp) - firstTimestamp),
      totalMs: Math.max(0, (playbackStatus.clippedTimestamp ?? firstTimestamp) - firstTimestamp),
    };
  }, [clippedSensorData, playbackStatus.currentTimestamp, playbackStatus.clippedTimestamp]);

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
      // autoplay
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
            // console.log('Playback reached end at index:', clippedSensorData.length - 1);
            return prev;
          }

          // Move to next data point
          const nextIndex = currentIndex + 1;
          const nextTimestamp = clippedSensorData[nextIndex].timestamp;

          // console.log('Playing back sensor data at index:', nextIndex, 'timestamp:', clippedSensorData[nextIndex].timestamp);

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
      }, 500);

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

  function SensorGraph() {
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
        isPlaying: true,
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

  return (
    <div ref={displayRef}>
      {/* Preview */}
      {isOpen && <div className="absolute w-fit h-fit top-[50%] right-2 bg-black rounded-lg h-max-[50vh] overflow-y-scroll">
          {
            sessions.map((session) => (
              <div key={session.id} className="border-b border-white/10 p-2">
                <div className="text-sm text-white/70 font-mono mb-1">
                  {session.id} - {new Date(session.startTimestamp).toLocaleString()}
                </div>
                <div className="text-xs text-white/50 font-mono max-h-32 overflow-y-auto">
                  {session.data.map((entry, idx) => (
                    <div key={idx}>
                      {new Date(entry.timestamp).toLocaleTimeString()}: gx={entry.sensor.gx.toFixed(2)}, gy={entry.sensor.gy.toFixed(2)}, gz={entry.sensor.gz.toFixed(2)}, mag={entry.sensor.mag.toFixed(2)}
                    </div>
                  ))}
                </div>
              </div>
            ))
          }
          </div>}
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
            {/* <h3 className="text-white text-xl font-bold opacity-50 z-0">Dashboard</h3> */}
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
                <SensorGraph />
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
