import { useEffect, useRef, useState } from "react";
import paper from "paper";
import { useIMU } from "../contexts/IMUContext";

const UNIT = 25;

export default function DrawingDisplay({ className }) {
  const canvasRef = useRef(null);

  // ----- LAYERS -----
  const gridLayerRef = useRef(null);
  const realtimeLayerRef = useRef(null);
  const playbackLayerRef = useRef(null);

  // ----- REALTIME STATE -----
  const realtimePosRef = useRef(null);
  const realtimePrevRef = useRef(null);

  // ----- PLAYBACK STATE -----
  const playbackPosRef = useRef(null);
  const playbackPrevRef = useRef(null);

  const { sensorData, playbackMode, playbackStatus, enableHelper, mousePos } = useIMU();
  const mouseDotRef = useRef(null);
  const mousePathRef = useRef(null); // persistent paper.Path for the mouse trail
  const [drawState, setDrawState] = useState(true); // todo: change later

  // =================================================
  // SETUP PAPER + GRID + CARTESIAN AXES
  // =================================================
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    paper.setup(canvas);

    const { width, height } = canvas.getBoundingClientRect();
    canvas.width = width;
    canvas.height = height;
    paper.view.viewSize = new paper.Size(width, height);

    const center = new paper.Point(
      Math.round(width / 2 / UNIT) * UNIT,
      Math.round(height / 2 / UNIT) * UNIT
    );

    // ----- CREATE LAYERS -----
    gridLayerRef.current = new paper.Layer();
    realtimeLayerRef.current = new paper.Layer();
    playbackLayerRef.current = new paper.Layer();

    gridLayerRef.current.sendToBack();
    realtimeLayerRef.current.insertAbove(gridLayerRef.current);
    playbackLayerRef.current.insertAbove(realtimeLayerRef.current);

    // ----- INIT POSITIONS -----
    realtimePosRef.current = center.clone();
    realtimePrevRef.current = center.clone();
    playbackPosRef.current = center.clone();
    playbackPrevRef.current = center.clone();

    // =========================
    // DRAW GRID
    // =========================
    gridLayerRef.current.activate();

    const spacing = UNIT;

    for (let x = 0; x <= width; x += spacing) {
      new paper.Path.Line({
        from: [x, 0],
        to: [x, height],
        strokeColor: new paper.Color(1, 1, 1, 0.15),
        strokeWidth: 1,
      });
    }

    for (let y = 0; y <= height; y += spacing) {
      new paper.Path.Line({
        from: [0, y],
        to: [width, y],
        strokeColor: new paper.Color(1, 1, 1, 0.15),
        strokeWidth: 1,
      });
    }

    // =========================
    // DRAW AXES
    // =========================
    new paper.Path.Line({
      from: [0, center.y],
      to: [width, center.y],
      strokeColor: "red",
      strokeWidth: 2,
    });

    new paper.Path.Line({
      from: [center.x, 0],
      to: [center.x, height],
      strokeColor: "green",
      strokeWidth: 2,
    });

    // =========================
    // NUMBERING
    // =========================

    // X positive →
    let xIndex = 0;
    for (let x = center.x; x <= width; x += spacing) {
      new paper.PointText({
        point: [x, center.y + 15],
        content: xIndex.toString(),
        fillColor: "white",
        fontSize: 10,
        justification: "center",
      });
      xIndex++;
    }

    // X negative ←
    xIndex = -1;
    for (let x = center.x - spacing; x >= 0; x -= spacing) {
      new paper.PointText({
        point: [x, center.y + 15],
        content: xIndex.toString(),
        fillColor: "white",
        fontSize: 10,
        justification: "center",
      });
      xIndex--;
    }

    // Y positive ↑
    let yIndex = 0;
    for (let y = center.y; y >= 0; y -= spacing) {
      new paper.PointText({
        point: [center.x + 5, y + 4],
        content: yIndex.toString(),
        fillColor: "white",
        fontSize: 10,
        justification: "left",
      });
      yIndex++;
    }

    // Y negative ↓
    yIndex = -1;
    for (let y = center.y + spacing; y <= height; y += spacing) {
      new paper.PointText({
        point: [center.x + 5, y + 4],
        content: yIndex.toString(),
        fillColor: "white",
        fontSize: 10,
        justification: "left",
      });
      yIndex--;
    }

    // Big axis labels
    new paper.PointText({
      point: [width - 25, center.y - 10],
      content: "X",
      fillColor: "white",
      fontSize: 16,
      fontWeight: "bold",
    });

    new paper.PointText({
      point: [center.x + 10, 20],
      content: "Y",
      fillColor: "white",
      fontSize: 16,
      fontWeight: "bold",
    });

    paper.view.draw();

    return () => {
      paper.project.clear();
      mouseDotRef.current = null;
      mousePathRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (!gridLayerRef.current) return;
    gridLayerRef.current.visible = enableHelper;
    paper.view.draw();
  }, [enableHelper]);

  useEffect(() => {
    if (!playbackLayerRef.current) return;
    playbackLayerRef.current.visible = playbackMode;
    paper.view.draw();
  }, [playbackMode]);

  // =================================================
  // GENERIC DRAW FUNCTION
  // =================================================
  function drawLine(mouseTargetX, mouseTargetY, mag, layer, posRef, prevRef, opacity = 1) {
    if (!layer || !posRef.current || !prevRef.current) return;

    layer.activate();

    const pos = posRef.current;

    const prevPos = prevRef.current.clone();

    // posX = sin(heading), posY = cos(heading) — unit vectors in [-1, 1]
    // mag controls step size and stroke width
    const NORMALIZE_MAG = 0.01;

    pos.x += mouseTargetX * mag * NORMALIZE_MAG * UNIT;
    pos.y -= mouseTargetY * mag * NORMALIZE_MAG * UNIT;

    console.log('sensor', pos, mouseTargetX, mouseTargetY, mag);

    pos.x = Math.max(0, Math.min(pos.x, paper.view.size.width));
    pos.y = Math.max(0, Math.min(pos.y, paper.view.size.height));

    const motion = mag;
    const maxMotion = 40;
    const maxStrokeWidth = 4;
    const minStrokeWidth = 0.2;

    const strokeWidth =
      ((motion - 0) * (maxStrokeWidth - minStrokeWidth)) / (maxMotion - 0) +
      minStrokeWidth;

    // Determine color based on layer
    let strokeColor;
    if (layer === playbackLayerRef.current) {
      strokeColor = new paper.Color(0, 1, 1, opacity); // cyan with adjustable opacity
    } else {
      strokeColor = new paper.Color(1, 0, 1, opacity); // fuchsia with adjustable opacity
    }

    const segment = new paper.Path({
      strokeColor,
      strokeWidth,
      strokeCap: "round",
      strokeJoin: "round",
    });

    segment.add(prevPos);
    segment.add(pos.clone());

    prevRef.current = pos.clone();

    paper.view.draw();
  }

  // =================================================
  // REALTIME MODE — draws using posX and posY from sensor data
  // =================================================
  useEffect(() => {
    if (playbackMode || !sensorData || !realtimeLayerRef.current) return;

    const s = sensorData?.[sensorData.length - 1];
    if (!s?.sensor) return;

    const { mouseTargetX, mouseTargetY, mag } = s.sensor;

    drawLine(
      mouseTargetX,
      mouseTargetY,
      mag,
      realtimeLayerRef.current,
      realtimePosRef,
      realtimePrevRef
    );
  }, [sensorData, playbackMode]);

  // =================================================
  // MOUSE POSITION CURSOR — maps screen coords to canvas
  // =================================================
  useEffect(() => {
    if (!mousePos || !realtimeLayerRef.current) return;

    const canvasWidth = paper.view.size.width;
    const canvasHeight = paper.view.size.height;
    const screenW = window.screen.width;
    const screenH = window.screen.height;

    const canvasX = (mousePos.x / screenW) * canvasWidth;
    const canvasY = (mousePos.y / screenH) * canvasHeight;

    realtimeLayerRef.current.activate();

    const pt = new paper.Point(canvasX, canvasY);

    // Draw a small filled dot at this position (same technique as playback which works)
    new paper.Path.Circle({
      center: pt,
      radius: 2.5,
      fillColor: new paper.Color(1, 0, 1, 0.8), // fuchsia
    });

    // Update or create the yellow cursor dot (always on top)
    if (!mouseDotRef.current) {
      mouseDotRef.current = new paper.Path.Circle({
        center: pt,
        radius: 6,
        fillColor: new paper.Color(1, 1, 0, 0.9), // yellow
        strokeColor: new paper.Color(1, 1, 1, 0.6),
        strokeWidth: 1.5,
      });
    } else {
      mouseDotRef.current.position = pt;
    }
    mouseDotRef.current.bringToFront();

    paper.view.draw();
  }, [mousePos]);

  // Helper function to convert HSL to RGB
  function hslToRgb(h, s, l) {
    s /= 100;
    l /= 100;
    const k = n => (n + h / 30) % 12;
    const a = s * Math.min(l, 1 - l);
    const f = n => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
    return [f(0), f(8), f(4)];
  }

  // =================================================
  // PLAYBACK MODE
  // =================================================
  useEffect(() => {
    if (!playbackMode || !sensorData) return;

    const width = paper.view.size.width;
    const height = paper.view.size.height;
    const center = new paper.Point(width / 2, height / 2);

    playbackLayerRef.current.removeChildren();
    playbackPosRef.current = center.clone();

    const maxIdx = playbackStatus.currentDataIdx || 0;

    // First pass: count visits per grid cell for heatmap
    const cellSize = 8;
    const heatmapGrid = {};
    let pos = center.clone();
    const NORMALIZE_MAG = 0.01;

    for (let i = 0; i <= maxIdx; i++) {
      const s = sensorData[i];
      if (!s?.sensor) continue;

      const { mouseTargetX, mouseTargetY, mag } = s.sensor;
      pos.x += mouseTargetX * mag * NORMALIZE_MAG * UNIT;
      pos.y -= mouseTargetY * mag * NORMALIZE_MAG * UNIT;
      pos.x = Math.max(0, Math.min(pos.x, width));
      pos.y = Math.max(0, Math.min(pos.y, height));

      const gridKey = `${Math.floor(pos.x / cellSize)},${Math.floor(pos.y / cellSize)}`;
      heatmapGrid[gridKey] = (heatmapGrid[gridKey] || 0) + 1;
    }

    const maxVisits = Math.max(...Object.values(heatmapGrid), 1);

    // Second pass: draw dots with heatmap colors
    playbackLayerRef.current.activate();
    pos = center.clone();

    for (let i = 0; i <= maxIdx; i++) {
      const s = sensorData[i];
      if (!s?.sensor) continue;

      const { mouseTargetX, mouseTargetY, mag } = s.sensor;
      pos.x += mouseTargetX * mag * NORMALIZE_MAG * UNIT;
      pos.y -= mouseTargetY * mag * NORMALIZE_MAG * UNIT;
      pos.x = Math.max(0, Math.min(pos.x, width));
      pos.y = Math.max(0, Math.min(pos.y, height));

      const gridKey = `${Math.floor(pos.x / cellSize)},${Math.floor(pos.y / cellSize)}`;
      const visits = heatmapGrid[gridKey] || 1;
      const normalizedHeat = visits / maxVisits;

      // HSL: purple (280°) for low visits → red (0°) for high visits
      const hue = 280 * (1 - normalizedHeat);
      const saturation = 100;
      const lightness = 50;

      const [r, g, b] = hslToRgb(hue, saturation, lightness);

      new paper.Path.Circle({
        center: pos.clone(),
        radius: 4,
        fillColor: new paper.Color(r, g, b, 0.6),
      });
    }

    playbackPosRef.current = pos.clone();
    paper.view.draw();
  }, [playbackMode, playbackStatus.currentDataIdx, sensorData]);

  return (
    <div className={`absolute top-0 left-0 w-full h-full ${className}`}>
      <canvas
        ref={canvasRef}
        resize="true"
        className="w-full h-full bg-gray-400"
      />
      {mousePos && (
        <div className="absolute top-2 right-2 bg-black/60 text-yellow-300 font-mono text-xs px-2 py-1 rounded pointer-events-none">
          🖱 x: {mousePos.x} y: {mousePos.y}
        </div>
      )}
    </div>
  );
}
