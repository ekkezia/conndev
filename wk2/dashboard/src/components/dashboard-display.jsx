import clsx from "clsx";
import MenuButton from "../menu-button";
import { useState } from "react";
import { useRef } from "react";
import { useEffect } from "react";
import { useIMU } from "../contexts/IMUContext";

export default function DashboardDisplay({ className}) {
    const [isOpen, setIsOpen] = useState(false);
    const { sensorData } = useIMU();

    const mapValue = (value, inMin, inMax, outMin, outMax) => {
        return (value - inMin) * (outMax - outMin) / (inMax - inMin) + outMin;
    };

    function SensorGraph({ keyName, color = 'bg-green-500/50' }) {
        if (!sensorData || !Array.isArray(sensorData) || sensorData.length === 0) return null;
        return (
            <div className="flex gap-1 items-center absolute top-0 h-full px-4">
                {sensorData.map((entry, idx) => {
                    const s = entry.sensor || {};
                    const raw = s?.[keyName];
                    if (raw === undefined || raw === null) return <div key={idx} className="w-2 h-2 transparent" />;
                    const mappedSensor = mapValue(raw, -180, 180, -50, 50);
                    return (
                        <div
                            key={idx}
                            className={clsx('w-4 h-4', color, 'blur-xs', 'rounded-full', 'text-white', 'inline-block', 'shadow-sm', 'shadow-white/100')}
                            style={{ transform: `translateY(${mappedSensor}px)` }}
                        />
                    );
                })}
            </div>
        );
    }
    
    // keep scroll locked to right (show newest entries)
    const containerRef = useRef(null);
    useEffect(() => {
        const el = containerRef.current;
        if (!el) return;
        // scroll to far right so newest items are visible
        try {
            el.scrollTo({ left: el.scrollWidth, behavior: 'smooth' });
        } catch (e) {
            // fallback
            el.scrollLeft = el.scrollWidth;
        }
    }, [sensorData?.length]);
    
  return (
        <MenuButton className={clsx("bottom-4 left-4", isOpen ? 'w-fit h-fit rounded-xl' : 'w-12 h-12 rounded-full')} onClick={() => setIsOpen(!isOpen)}>
        {
            isOpen &&
            <div className="flex flex-col min-w-[80vw] h-[50vh] max-w-[80vw]">
                <h3 className="text-white text-xl font-bold opacity-50 z-0">Dashboard</h3>
                <div ref={containerRef} className="w-full h-full relative overflow-x-scroll overflow-y-hidden">
                    <SensorGraph keyName="gx" color="bg-red-500/50" />
                    <SensorGraph keyName="gy" color="bg-green-500/50" />
                    <SensorGraph keyName="gz" color="bg-blue-500/50" />

                </div>
            </div>
        }
        </MenuButton>
  );
}