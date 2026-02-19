import clsx from "clsx";
import MenuButton from "../menu-button";
import { useIMU } from "../contexts/IMUContext";
import { useMemo, useEffect } from "react";

export default function PlaybackDisplay({ className }) {
  const {
    playbackMode: isOpen,
    sensorData,
    playbackStatus,
    setPlaybackStatus,
  } = useIMU();

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

  // Playback effect: auto-advance currentTimestamp if it's less than clippedTimestamp
  useEffect(() => {
    if (!clippedSensorData || clippedSensorData.length === 0) return;

    // paused
    if (!playbackStatus.isPlaying) {
      console.log(
        "Playback paused at timestamp:",
        playbackStatus.currentTimestamp
      );
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

  function SensorGraph() {
    if (
      !clippedSensorData ||
      !Array.isArray(clippedSensorData) ||
      clippedSensorData.length === 0
    )
      return null;
    return (
      <div
        className="h-4 w-full rounded-full bg-grey-500/90 overflow-hidden relative"
        onClick={(e) => {
          const rect = e.currentTarget.getBoundingClientRect();
          const clickX = e.clientX - rect.left;
          const clickRatio = clickX / rect.width;
          const firstTimestamp = clippedSensorData[0].timestamp;
          const range = playbackStatus.clippedTimestamp - firstTimestamp;
          const targetTimestamp = firstTimestamp + clickRatio * range;

          // Find the closest sensor data point to the clicked timestamp
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
          // console.log('Clicked playback bar at index:', actualIndex, 'timestamp:', actualTimestamp);
        }}
      >
        <div
          className="absolute top-0 left-0 h-full bg-red-500/90 flex items-end justify-center text-xs font-mono"
          style={{
            width: `${progressSensorData * 100}%`,
            color: "white",
            transition: "width 1800ms cubic-bezier(0.25, 0.46, 0.45, 0.94)",
          }}
        >
          {playbackStatus.currentTimestamp.toFixed(0)}ms
        </div>
        <div className="absolute top-0 left-0 text-white">
          {/* {progressSensorData}ms */}
        </div>
      </div>
    );
  }

  return (
    <MenuButton
      className={clsx(
        "bottom-4 right-4",
        isOpen ? "w-fit h-fit rounded-xl" : "w-12 h-12 rounded-full"
      )}
    >
      {isOpen && (
        <div className="flex flex-col min-w-[80vw] h-fit p-4 max-w-[80vw]">
          <div
            onClick={() =>
              setPlaybackStatus({
                ...playbackStatus,
                isPlaying: !playbackStatus.isPlaying,
              })
            }
            className={
              (`rounded-full p-2 w-fit`,
              !playbackStatus.isPlaying ? "bg-green-900" : "bg-red-900")
            }
          >
            {playbackStatus.isPlaying ? "pause" : "play"}
          </div>
          <div className="w-full h-full relative overflow-x-scroll overflow-y-hidden">
            <SensorGraph />
          </div>
        </div>
      )}
    </MenuButton>
  );
}
