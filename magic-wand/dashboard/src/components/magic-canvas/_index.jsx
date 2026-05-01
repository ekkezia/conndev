import { useEffect, useRef, useState } from "react";
import { io } from "socket.io-client";
import { REACT_APP_SERVER_URL } from "../../config";
import MenuButton from "../../menu-button";
import DashboardDisplay from "./dashboard-display";
import PlaybackDisplay from "./playback-display";
import VisualizationToggle from "./visualization-toggle";
import DrawingDisplay from "./drawing-display";
import BeatGame from "../magic-beats/_index";
import R3FCanvas from "./r3f-canvas";

const MODES = ["draw", "game", "light"];
const MODE_ICONS = { draw: "✏️", game: "🎮", light: "🔦" };

export default function MagicCanvas() {
  const [mode, setMode] = useState("draw");
  const [showVisualizationToggle, setShowVisualizationToggle] = useState(false);
  const socket = useRef(null);
  const [status, setStatus] = useState("disconnected");

  useEffect(() => {
    socket.current = io(REACT_APP_SERVER_URL, {
      path: '/socket.io',
      multiplex: false,
      transports: ['websocket', 'polling'],
      upgrade: true,
      rememberUpgrade: true,
      timeout: 8000,
      reconnection: true,
      reconnectionAttempts: Infinity,
      reconnectionDelay: 500,
      reconnectionDelayMax: 3000,
    });
    socket.current.on("connect", () => setStatus("connected"));
    socket.current.on("disconnect", () => setStatus("disconnected"));
    socket.current.on("connect_error", (err) => {
      console.error(
        `MagicCanvas socket connect_error (${REACT_APP_SERVER_URL}):`,
        err?.message || err,
      );
    });
    return () => socket.current?.disconnect();
  }, []);

  return (
    <div className="relative bg-black h-screen w-screen">
      <div className="w-full h-full z-10 fixed top-0 left-0">
        <div className="relative">
          <MenuButton
            className="top-4 left-4 items-center justify-center flex relative"
            onClick={() => setShowVisualizationToggle((prev) => !prev)}
          >
            <span className="text-xl">👁️</span>
          </MenuButton>
          <VisualizationToggle
            isOpen={showVisualizationToggle}
            onClose={() => setShowVisualizationToggle(false)}
            status={status}
          />
        </div>

        <MenuButton
          className="top-4 right-4 items-center justify-center flex"
          onClick={() => setMode((m) => MODES[(MODES.indexOf(m) + 1) % MODES.length])}
        >
          <span className="text-xl">{MODE_ICONS[mode]}</span>
        </MenuButton>

        <DashboardDisplay />

        <div className="fixed bottom-4 right-4 flex flex-col items-end gap-4 pointer-events-none">
          <PlaybackDisplay />
        </div>
      </div>

      {mode === "light" && <R3FCanvas />}
      {mode === "draw" && <DrawingDisplay />}
      {mode === "game" && <BeatGame />}
    </div>
  );
}
