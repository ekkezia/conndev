import { useEffect, useRef, useState } from "react";
import paper from "paper";
import { useIMU } from "../contexts/IMUContext";

export default function DrawingDisplay({ className }) {
  const canvasRef = useRef(null);
  const pathRef = useRef(null);
  const positionRef = useRef(null);
  const velocityRef = useRef({ x: 0, y: 0 });

  const { sensorData } = useIMU();

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

    // start at center
    positionRef.current = new paper.Point(
      paper.view.size.width / 2,
      paper.view.size.height / 2
    );

    velocityRef.current = { x: 0, y: 0 };

    pathRef.current = new paper.Path({
      strokeColor: "red",      // FORCE visibility
      strokeWidth: 4,
      strokeCap: "round",
      strokeJoin: "round"
    });

    // first point
    pathRef.current.add(positionRef.current.clone());

    paper.view.draw();

    return () => {
      paper.project.clear();
    };
  }, []);

  // ---------- UPDATE FROM IMU ----------
  useEffect(() => {
  if (!sensorData || !pathRef.current || !positionRef.current) return;

  const s = sensorData[sensorData.length - 1];
  if (!s?.sensor) return;

  const { ax = 0, ay = 0, az = 0 } = s.sensor;

  const pos = positionRef.current;
  const vel = velocityRef.current;

  // ---- tuning ----
  const accelToVel = 8;
  const friction = 0.9;
  const strokeScale = 4;
  const deadzone = 0.05;
  const centerForce = 0.002;

  // deadzone (kills gravity drift)
  const ayEff = Math.abs(ay) < deadzone ? 0 : ay;
  const azEff = Math.abs(az - 1) < deadzone ? 0 : az - 1; // normalize az by 1 

  // accel → velocity
  vel.x += ayEff * accelToVel;
  vel.y += azEff * -1 * accelToVel;// opposite dir

  // gentle pull back to center
  vel.x += (paper.view.size.width / 2 - pos.x) * centerForce;
  vel.y += (paper.view.size.height / 2 - pos.y) * centerForce;

  // friction
  vel.x *= friction;
  vel.y *= friction;

  // velocity → position
  pos.x += vel.x;
  pos.y += vel.y;

  // if out of bounds → restart from center
  const out =
    pos.x <= 0 ||
    pos.x >= paper.view.size.width ||
    pos.y <= 0 ||
    pos.y >= paper.view.size.height;

  if (out) {
    pathRef.current.remove();

    pathRef.current = new paper.Path({
      strokeColor: "red",
      strokeWidth: 4,
      strokeCap: "round",
      strokeJoin: "round"
    });

    pos.x = paper.view.size.width / 2;
    pos.y = paper.view.size.height / 2;
    vel.x = 0;
    vel.y = 0;

    pathRef.current.add(pos.clone());
    paper.view.draw();
    return;
  }

  // stroke width from ax (pressure)
  pathRef.current.strokeWidth = Math.max(
    1,
    Math.abs(ax) * strokeScale
  );

  pathRef.current.add(pos.clone());

  setDebug({
    points: pathRef.current.segments.length,
    x: pos.x.toFixed(1),
    y: pos.y.toFixed(1),
    vx: vel.x.toFixed(2),
    vy: vel.y.toFixed(2),
    ax: ax.toFixed(2),
    ay: ay.toFixed(2),
    az: az.toFixed(2)
  });

  paper.view.draw();
}, [sensorData]);


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
        ax:{debug.ax} ay:{debug.ay} az:{debug.az}
      </div>

      <canvas
        ref={canvasRef}
        resize="true"
        className="w-full h-full border border-white/20 rounded-lg shadow-center bg-gray-400"
      />
    </div>
  );
}
