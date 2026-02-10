import { useEffect, useRef, useState } from "react";
import paper from "paper";
import { useIMU } from "../contexts/IMUContext";

export default function DrawingDisplay({ className }) {
  const canvasRef = useRef(null);
  const pathRef = useRef(null);
  const positionRef = useRef(null);
  const previousPosRef = useRef(null);
  const velocityRef = useRef({ x: 0, y: 0 });

  const { sensorData } = useIMU();

  const [drawState, setDrawState] = useState(false); 

  // ---- DEBUG STATE ----
  const [debug, setDebug] = useState({
    points: 0,
    x: 0,
    y: 0,
    vx: 0,
    vy: 0,
    ax: 0,
    ay: 0,
    az: 0
  });

  // ---------- SETUP PAPER ----------
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    paper.setup(canvas);

    const { width, height } = canvas.getBoundingClientRect();
    if (width && height) {
      canvas.width = width;
      canvas.height = height;
      paper.view.viewSize = new paper.Size(width, height);
    }

    // start at center
    positionRef.current = new paper.Point(
      paper.view.size.width / 2,
      paper.view.size.height / 2
    );

    velocityRef.current = { x: 0, y: 0 };
    previousPosRef.current = new paper.Point(
      paper.view.size.width / 2,
      paper.view.size.height / 2
    );

    paper.view.draw();

    return () => {
      paper.project.clear();
    };
  }, []);

  // ---------- UPDATE FROM IMU ----------
  useEffect(() => {
  if (!sensorData || !positionRef.current) return;

  const s = sensorData[sensorData.length - 1];
  // console.log('sensor data:', s, sensorData.length);
  if (!s?.sensor) return;

  const { ax = 0, ay = 0, az = 0, gx = 0, gy = 0, heading = 0 } = s.sensor;

  // activate the paint brush by flicking the device (detect via gy)
  if (Math.abs(gx) > 80 || Math.abs(gy) > 80) {
    // mark as ready to draw
    setDrawState(true);
  } else {
    // set a timeout of 2s, if device stays stable, set drawing state to false
    setTimeout(() => {
      if (ax < 0.2 && ay < 0.2) setDrawState(false);
    }, 2000);
  }

  if (!drawState) return; 

  const pos = positionRef.current;
  const vel = velocityRef.current;

  // ---- tuning ----
  const strokeScale = 4;

  // const speed = Math.sqrt(speedX * speedX + speedY * speedY);
  const radians = (heading * Math.PI) / 180;
  
  // Store previous position before updating
  const prevPos = previousPosRef.current ? previousPosRef.current.clone() : pos.clone();
  
  pos.x += Math.cos(radians) * 1;
  pos.y += Math.sin(radians) * 1;

  // clamp position to stay within canvas bounds
  pos.x = Math.max(0, Math.min(pos.x, paper.view.size.width));
  pos.y = Math.max(0, Math.min(pos.y, paper.view.size.height));

  // stroke width from magnitude of ax & ay (pressure)
  const magAxAy = Math.sqrt(ax * ax + ay * ay);
  const strokeWidth = Math.max(1, magAxAy * strokeScale);

  // Create a new segment path with its own stroke width
  const segmentPath = new paper.Path({
    strokeColor: "red",
    strokeWidth: strokeWidth,
    strokeCap: "round",
    strokeJoin: "round"
  });
  segmentPath.add(prevPos);
  segmentPath.add(pos.clone());
  
  // Update previous position for next iteration
  previousPosRef.current = pos.clone();

  setDebug({
    points: 0, // segment-based paths don't have a single point count
    x: pos.x.toFixed(1),
    y: pos.y.toFixed(1),
    vx: vel.x.toFixed(2),
    vy: vel.y.toFixed(2),
    magAxAy: Math.sqrt(ax * ax + ay * ay).toFixed(2),
    gx: gx.toFixed(2),
    gy: gy.toFixed(2),
    ax: ax.toFixed(2),
    ay: ay.toFixed(2),
    az: az.toFixed(2),
    heading: heading.toFixed(2),
  });

  paper.view.draw();
}, [sensorData, drawState]);


  return (
    <div
      className={`absolute top-0 left-0 w-full h-full flex items-center justify-center z-0 pointer-events-none ${className}`}
    >
      {/* DEBUG HUD */}
      <div
        style={{
          position: "fixed",
          top: 60,
          left: "50%",
          transform: "translateX(-50%)",
          background: "rgba(0,0,0,0.75)",
          color: "lime",
          fontFamily: "monospace",
          fontSize: 12,
          padding: "6px 10px",
          borderRadius: 6,
          zIndex: 9999,
          pointerEvents: "none",
          whiteSpace: "nowrap"
        }}
      >
        pts: {debug.points} | 
        x:{debug.x} y:{debug.y} | 
        vx:{debug.vx} vy:{debug.vy} | 
        gx: {debug.gx} gy:{debug.gy} |
        ax:{debug.ax} ay:{debug.ay} | magAxAy:{debug.magAxAy} |
        heading:{debug.heading}
      </div>

      <canvas
        ref={canvasRef}
        resize="true"
        className="w-full h-full border border-white/20 rounded-lg shadow-center bg-gray-400"
      />
    </div>
  );
}
