import clsx from "clsx";
import MenuButton from "../menu-button";
import { useState } from "react";
import { useRef } from "react";
import { useEffect } from "react";
import { useIMU } from "../contexts/IMUContext";
import GraphDashboard from "./playback/graph-dashboard";

export default function DashboardDisplay({ className}) {
    const [isOpen, setIsOpen] = useState(false);
    const { sensorData } = useIMU();
    const displayRef = useRef(null);
    
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

    useEffect(() => {
        if (!isOpen) return;

        const handleClickAway = (event) => {
            if (!displayRef.current?.contains(event.target)) {
                setIsOpen(false);
            }
        };

        document.addEventListener("pointerdown", handleClickAway);
        return () => document.removeEventListener("pointerdown", handleClickAway);
    }, [isOpen]);
    
  return (
    <div ref={displayRef} className={clsx(isOpen ? "z-40" : "z-50")}>
        <MenuButton
            className={clsx(
                "bottom-4 left-4",
                isOpen ? "w-fit h-fit rounded-xl" : "w-12 h-12 rounded-full"
            )}
            onClick={() => setIsOpen((prev) => !prev)}
        >
            {!isOpen && <span className="w-full h-full flex items-center justify-center text-xl">📊</span>}
            {isOpen && (
                <div className="relative w-fit h-fit flex flex-col gap-2 p-2 pointer-events-auto" onClick={(e) => e.stopPropagation()}>
                    <div className="rounded-xl border border-white/20 bg-black/70 p-3 min-w-[80vw] max-w-[80vw]">
                        <GraphDashboard embedded className="min-w-0 max-w-full h-[44vh]" />
                    </div>
                </div>
            )}
        </MenuButton>
    </div>
  );
}
