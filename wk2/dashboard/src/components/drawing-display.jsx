import { useEffect, useRef, useState } from "react";
import paper from "paper";
import { useIMU } from "../contexts/IMUContext";

const unit = 25;

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

    // ----- DRAW GRID -----
const gridGroup = new paper.Group();
gridGroup.sendToBack();

const spacing = unit;
const viewWidth = paper.view.size.width;
const viewHeight = paper.view.size.height;

for (let x = 0; x <= viewWidth; x += spacing) {
  const vLine = new paper.Path.Line({
    from: [x, 0],
    to: [x, viewHeight],
    strokeColor: new paper.Color(1, 1, 1, 0.15),
    strokeWidth: 1
  });
  gridGroup.addChild(vLine);
}

for (let y = 0; y <= viewHeight; y += spacing) {
  const hLine = new paper.Path.Line({
    from: [0, y],
    to: [viewWidth, y],
    strokeColor: new paper.Color(1, 1, 1, 0.15),
    strokeWidth: 1
  });
  gridGroup.addChild(hLine);
}

    // ----- CENTER LABEL -----
    const rawCenter = paper.view.center;
    const center = new paper.Point(
      Math.round(rawCenter.x / unit) * unit,
      Math.round(rawCenter.y / unit) * unit
    );

    // Draw main axes
    const xAxis = new paper.Path.Line({
      from: [0, center.y],
      to: [viewWidth, center.y],
      strokeColor: "red",
      strokeWidth: 1
    });

    const yAxis = new paper.Path.Line({
      from: [center.x, 0],
      to: [center.x, viewHeight],
      strokeColor: "green",
      strokeWidth: 1
    });

    // ---- Numbering ----

    // X axis numbers
    let xIndex = 0;
    for (let x = center.x; x <= viewWidth; x += spacing) {
      const value = xIndex;

      new paper.PointText({
        point: [x, center.y + 15],
        content: value.toString(),
        fillColor: "white",
        fontSize: 10,
        justification: "center"
      });

      xIndex++;
    }

    xIndex = -1;
    for (let x = center.x - spacing; x >= 0; x -= spacing) {
      new paper.PointText({
        point: [x, center.y + 15],
        content: xIndex.toString(),
        fillColor: "white",
        fontSize: 10,
        justification: "center"
      });

      xIndex--;
    }


    // Y axis numbers
    let yIndex = 0;
    for (let y = center.y; y >= 0; y -= spacing) {
      new paper.PointText({
        point: [center.x + 4, y + 4],
        content: yIndex.toString(),
        fillColor: "white",
        fontSize: 10,
        justification: "left"
      });

      yIndex++;
    }

    yIndex = -1;
    for (let y = center.y + spacing; y <= viewHeight; y += spacing) {
      new paper.PointText({
        point: [center.x + 4, y + 4],
        content: yIndex.toString(),
        fillColor: "white",
        fontSize: 10,
        justification: "left"
      });

      yIndex--;
    }


    // ---- Big X and Y labels ----

    new paper.PointText({
      point: [viewWidth - 20, center.y - 10],
      content: "X",
      fillColor: "white",
      fontSize: 16,
      fontWeight: "bold"
    });

    new paper.PointText({
      point: [center.x + 10, 20],
      content: "Y",
      fillColor: "white",
      fontSize: 16,
      fontWeight: "bold"
    });


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
  if (Math.abs(gx) > 50 || Math.abs(gy) > 50) {
    // mark as ready to draw
    setDrawState(true);
  } else {
    // set a timeout of 1s, if device stays stable, set drawing state to false
    setTimeout(() => {
      if (Math.abs(gx) < 4 && Math.abs(gy) < 4) setDrawState(false);
    }, 1000);
  }

  if (!drawState) return; 

  const pos = positionRef.current;
  const vel = velocityRef.current;

  // ---- tuning ----
  const strokeScale = 1;

  // const speed = Math.sqrt(speedX * speedX + speedY * speedY);
  const radians = (heading * Math.PI) / 180; // direction
  
  // Store previous position before updating
  const prevPos = previousPosRef.current ? previousPosRef.current.clone() : pos.clone();
  
  // scalar
  pos.x += Math.cos(radians) * unit * -1;
  pos.y += Math.sin(radians) * unit * -1;

  // clamp position to stay within canvas bounds
  pos.x = Math.max(0, Math.min(pos.x, paper.view.size.width));
  pos.y = Math.max(0, Math.min(pos.y, paper.view.size.height));

  // stroke width from magnitude of ax & ay and gx & gy
  let motion = Math.sqrt(ax*ax + ay*ay) + Math.sqrt(gx*gx + gy*gy);
  const maxMotion = 40;
  const maxStrokeWidth = 4;
  const minStrokeWidth = 0.1;
  let strokeWidth = (motion - 0) * (maxStrokeWidth - minStrokeWidth) / (maxMotion - 0) + minStrokeWidth;


  // Create a new segment path with its own stroke width
  const segmentPath = new paper.Path({
    strokeColor: "black",
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
    motion: motion.toFixed(2),
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

        <span className={`fixed top-1/2 left-1/2 transform-x-[-50%] transform-y-[-50%] z-99 ${drawState ? 'hidden' : 'block'}`}>Swing your 🪄 to start drawing!</span>
      <canvas
        ref={canvasRef}
        resize="true"
        className="w-full h-full border border-white/20 rounded-lg shadow-center bg-gray-400"
      />
    </div>
  );
}
