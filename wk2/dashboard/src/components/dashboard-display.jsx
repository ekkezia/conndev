import clsx from "clsx";
import MenuButton from "../menu-button";
import { useState } from "react";
import { useRef } from "react";
import { useEffect } from "react";
import { useIMU } from "../contexts/IMUContext";

export default function DashboardDisplay({ className}) {
    const [isOpen, setIsOpen] = useState(false);
    const { sensorData } = useIMU();
    const [mode, setMode] = useState('gyro'); // 'gyro' or 'accel'

    const mapValue = (value, inMin, inMax, outMin, outMax) => {
        return (value - inMin) * (outMax - outMin) / (inMax - inMin) + outMin;
    };

    function SensorGraph({ keyName, color = 'bg-green-500/50', kind = 'gyro' }) {
        if (!sensorData || !Array.isArray(sensorData) || sensorData.length === 0) return null;
        return (
            <div className="flex gap-1 items-center absolute top-0 h-[30vh] px-4">
                    {sensorData.map((entry, idx) => {
                    const { sensor, timestamp } = entry || {};
                    const raw = sensor?.[keyName];
                    if (raw === undefined || raw === null) return <div key={idx} className="w-2 h-2 transparent" />;
                    const mappedSensor = kind === 'gyro'
                        ? mapValue(raw, -180, 180, -50, 50)
                        : mapValue(raw, -2, 2, -50, 50);
                    return (
                        <div
                            key={`${timestamp}-${idx}`}
                            className="relative inline-block w-4 h-4 group"
                            style={{ transform: `translateY(${mappedSensor}px)` }}
                        >
                            <div className={clsx('w-4 h-4', color, 'blur-xs', 'rounded-full', 'text-white', 'inline-block', 'shadow-sm', 'shadow-white/100') } />
                            <div className="absolute -top-10 left-1/2 transform -translate-x-1/2 px-2 py-1 bg-black/80 text-xs rounded text-white opacity-0 pointer-events-none group-hover:opacity-100 transition-opacity z-50">
                                <div className="font-mono">{keyName} {(raw ?? 0).toFixed(2)}</div>
                                <div className="font-mono text-[10px] opacity-70">{new Date(timestamp).toLocaleString()}</div>
                            </div>
                        </div>
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
                <div ref={containerRef} className="relative w-full h-full relative overflow-x-scroll overflow-y-hidden">
                    {/* left axis showing measurement range -180..180 */}
                    <div className="sticky h-[30vh] left-0 top-0 bottom-0 w-14 flex flex-col items-center justify-between text-white text-xs opacity-80 pointer-events-none z-40">
                        <div className="mt-2">180</div>
                        <div className="">0</div>
                        <div className="mb-2">-180</div>
                        <div className="absolute right-0 top-0 bottom-0 w-px bg-white/30" />
                    </div>
                    <div className="flex items-start gap-2 mb-2 absolute left-20 top-2 z-50">
                        <button onClick={() => setMode('gyro')} className={clsx('px-2 py-1 rounded', mode === 'gyro' ? 'bg-white text-black' : 'bg-black/40 text-white')}>Gyro</button>
                        <button onClick={() => setMode('accel')} className={clsx('px-2 py-1 rounded', mode === 'accel' ? 'bg-white text-black' : 'bg-black/40 text-white')}>Accel</button>
                    </div>

                    {mode === 'gyro' ? (
                        <>
                            <SensorGraph keyName="gx" color="bg-red-500/50" kind="gyro" />
                            <SensorGraph keyName="gy" color="bg-green-500/50" kind="gyro" />
                            <SensorGraph keyName="gz" color="bg-blue-500/50" kind="gyro" />
                        </>
                    ) : (
                        <>
                            <SensorGraph keyName="ax" color="bg-red-500/50" kind="accel" />
                            <SensorGraph keyName="ay" color="bg-green-500/50" kind="accel" />
                            <SensorGraph keyName="az" color="bg-blue-500/50" kind="accel" />
                        </>
                    )}

                </div>
                <div className="text-white text-sm opacity-50 mt-2 z-0 h-[100px] overflow-y-scroll border border-white rounded-xl">
                    {[...sensorData].reverse().map((data, idx) => {
                        const s = data.sensor || {};
                        return (
                            <div key={`${idx}-${data.timestamp}`} className={`mb-1 ${idx === 0 ? 'text-green-400 font-bold' : ''}`}>
                                <span className="font-mono">[{new Date(data.timestamp).toLocaleTimeString()}]</span>{' '}
                                {mode === 'gyro' ? (
                                    <span className="font-mono">Gyro: (X: {s.gx?.toFixed(2) || 'N/A'}, Y: {s.gy?.toFixed(2) || 'N/A'}, Z: {s.gz?.toFixed(2) || 'N/A'})</span>
                                ) : (
                                    <span className="font-mono">Accel: (X: {s.ax?.toFixed(2) || 'N/A'}, Y: {s.ay?.toFixed(2) || 'N/A'}, Z: {s.az?.toFixed(2) || 'N/A'})</span>
                                )}
                            </div>
                        );
                    })}
                </div>
            </div>
        }
        </MenuButton>
  );
}