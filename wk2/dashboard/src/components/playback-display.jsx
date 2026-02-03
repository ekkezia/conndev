import clsx from "clsx";
import MenuButton from "../menu-button";
import { useIMU } from "../contexts/IMUContext";
import { useMemo, useEffect, useState } from "react";

export default function PlaybackDisplay({ className}) {
    const { playbackMode: isOpen, setPlaybackMode: setIsOpen, sensorData, isPlayingBack, setIsPlayingBack, playbackStatus, setPlaybackStatus } = useIMU();

    useEffect(() => {
        setIsPlayingBack(isOpen);
        setPlaybackStatus(prev => ({ ...prev, clippedTimestamp: Date.now(), currentTimestamp: Date.now() })); // in milliseconds, set the clippedtimestamp up until NOW when user clicks on the button!
        console.log('Playback mode changed:', Date.now());
    }, [isOpen])

    // do not put set objects to useMemo dependencies to avoid infinite loop
    const clippedSensorData = useMemo(
        () => (sensorData || []).filter(d => d.timestamp <= playbackStatus.clippedTimestamp), // only playback up until the current timestamp when user has clicked the playback button
        [sensorData, playbackStatus.clippedTimestamp]
    );

    const progressSensorData = useMemo(
        () => {
            if (!clippedSensorData || clippedSensorData.length === 0) return 0;
            const firstTimestamp = sensorData[0].timestamp;
            const lastTimestamp = playbackStatus.clippedTimestamp;
            const range = lastTimestamp - firstTimestamp;

            if (range <= 0) return 0;
            const progress = (playbackStatus.currentTimestamp - firstTimestamp) / range;
            return Math.min(Math.max(progress, 0), 1); // clamp between 0 and 1
        },
        [clippedSensorData, playbackStatus, sensorData]
    )

    function SensorGraph() {
        if (!clippedSensorData || !Array.isArray(clippedSensorData) || clippedSensorData.length === 0) return null;
        return (
            <div className="h-4 w-full rounded-full bg-grey-500/90 overflow-hidden relative"
                onClick={(e) => {
                const rect = e.currentTarget.getBoundingClientRect();
                const clickX = e.clientX - rect.left;
                const clickRatio = clickX / rect.width;
                const firstTimestamp = clippedSensorData[0].timestamp;
                const range = playbackStatus.clippedTimestamp - firstTimestamp;
                const newTimestamp = firstTimestamp + clickRatio * range;
                setPlaybackStatus(prev => ({ ...prev, currentTimestamp: newTimestamp }));
                console.log('Clicked playback bar:', newTimestamp);
            }}>
                
                <div 
                className="absolute top-0 left-0 h-full bg-red-500/90" 
                style={{ 
                    width: `${progressSensorData * 100}%`, 
                    }}>
                </div>
                <div className="absolute top-0 left-0 text-white">
                    {/* {progressSensorData}ms */}
                </div>
            </div>
        );
    }
    
  return (
        <MenuButton className={clsx("bottom-4 right-4", isOpen ? 'w-fit h-fit rounded-xl' : 'w-12 h-12 rounded-full')}>
        {
            isOpen &&
            <div className="flex flex-col min-w-[80vw] h-fit p-4 max-w-[80vw]">
                <div className="w-full h-full relative overflow-x-scroll overflow-y-hidden">
                    <SensorGraph />
                </div>
            </div>
        }
        </MenuButton>
  );
}