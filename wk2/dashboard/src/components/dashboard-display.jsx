import clsx from "clsx";
import MenuButton from "../menu-button";
import { useState } from "react";
import { useRef } from "react";
import { useEffect } from "react";
import { useIMU } from "../contexts/IMUContext";
import GridHelperToggle from "./grid-helper-toggle";

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
    <>
        <MenuButton
            className={clsx("bottom-4 left-4 z-[999] w-12 h-12 rounded-full", className)}
            onClick={() => setIsOpen((prev) => !prev)}
        >
            <span className="w-full h-full flex items-center justify-center text-xl">⚙️</span>
        </MenuButton>
        <div ref={displayRef}>
            <MenuButton
                className={clsx(
                    "bottom-4 left-4",
                    isOpen ? "w-fit h-fit rounded-xl" : "w-12 h-12 rounded-full"
                )}
            >
            {
                isOpen &&
                <div className="relative w-fit h-fit min-w-[120px] p-2 pb-16" onClick={(e) => e.stopPropagation()}>
                    <GridHelperToggle />
                </div>
            }
            </MenuButton>
        </div>
    </>
  );
}
