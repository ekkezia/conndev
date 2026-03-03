import { useEffect, useRef, useState } from "react";
import paper from "paper";
import { useIMU } from "../contexts/IMUContext";
import CalibrationIndicator from "./calibration-indicator";

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

  const { sensorData, playbackMode, playbackStatus, enableHelper, mousePos, clear, setClear } = useIMU();
  const mouseDotRef = useRef(null);
  const mousePathRef = useRef(null); // persistent paper.Path for no the mouse trail
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

  // =================================================
  // CLEAR REALTIME CANVAS
  // =================================================
  useEffect(() => {
    if (!clear || !realtimeLayerRef.current) return;

    realtimeLayerRef.current.removeChildren();
    mouseDotRef.current = null;
    paper.view.draw();

    const timer = setTimeout(() => setClear(false), 300);
    return () => clearTimeout(timer);
  }, [clear]);

  useEffect(() => {
    if (!playbackLayerRef.current) return;
    playbackLayerRef.current.visible = playbackMode;
    paper.view.draw();
  }, [playbackMode]);

  // =================================================
  // GENERIC DRAW FUNCTION
  // canvasX/canvasY are already mapped to canvas coordinate space
  // =================================================
  function drawLine(canvasX, canvasY, mag, layer, posRef, prevRef, opacity = 1) {
    if (!layer || !posRef.current || !prevRef.current) return;
    if (isNaN(canvasX) || isNaN(canvasY)) return;

    layer.activate();

    const prevPos = prevRef.current.clone();
    const pos = new paper.Point(
      Math.max(0, Math.min(canvasX, paper.view.size.width)),
      Math.max(0, Math.min(canvasY, paper.view.size.height))
    );

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
  // REALTIME MODE — maps screen coords to canvas and draws
  // =================================================
  useEffect(() => {
    if (playbackMode || !sensorData || !realtimeLayerRef.current) return;

    const s = sensorData?.[sensorData.length - 1];
    if (!s?.sensor || !s?.screenSize) return;

    const { mouseTargetX, mouseTargetY, mag } = s.sensor;
    const { width: screenW, height: screenH } = s.screenSize;
    if (!screenW || !screenH) return;

    const canvasW = paper.view.size.width;
    const canvasH = paper.view.size.height;
    const canvasX = (mouseTargetX / screenW) * canvasW;
    const canvasY = (mouseTargetY / screenH) * canvasH;

    drawLine(canvasX, canvasY, mag, realtimeLayerRef.current, realtimePosRef, realtimePrevRef);
  }, [sensorData, playbackMode]);

  // =================================================
  // MOUSE POSITION CURSOR — maps screen coords to canvas
  // =================================================
  useEffect(() => {
    if (!mousePos || !realtimeLayerRef.current || !sensorData) return;
    
    let color = {
      path: new paper.Color(1, 0, 1, 0.8), // fuchsia
      unCalibratedMouse: new paper.Color(1, 0, 0, 0.8), // red
      calibratedMouse: new paper.Color(1, 1, 0, 0.9), // yellow
    }

    let currentMouseColor = color.unCalibratedMouse;
    // State: calibrated
    if (sensorData?.[sensorData.length - 1]?.calibrated) {
      currentMouseColor = color.calibratedMouse;
    } else {
      currentMouseColor = color.unCalibratedMouse;
    }

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
      fillColor: color.path, // path: fuchsia
    });

    // Update or create the yellow cursor dot (always on top)
    if (!mouseDotRef.current) {
      mouseDotRef.current = new paper.Path.Circle({
        center: pt,
        radius: 6,
        fillColor: currentMouseColor, // red (uncalibrated), yellow (calibrated)
        strokeColor: new paper.Color(1, 1, 1, 0.6),
        strokeWidth: 1.5,
      });
    } else {
      mouseDotRef.current.position = pt;
    }
    mouseDotRef.current.bringToFront();

    paper.view.draw();
  }, [mousePos, sensorData]);

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

    const computePos = (mouseTargetX, mouseTargetY, screenW, screenH) => {
      if (!screenW || !screenH) return null;
      const x = Math.max(0, Math.min((mouseTargetX / screenW) * width, width));
      const y = Math.max(0, Math.min((mouseTargetY / screenH) * height, height));
      if (isNaN(x) || isNaN(y)) return null;
      return { x, y };
    };

    for (let i = 0; i <= maxIdx; i++) {
      const s = sensorData[i];
      if (!s?.sensor || !s?.screenSize) continue;

      const { mouseTargetX, mouseTargetY, mag } = s.sensor;
      const { width: screenW, height: screenH } = s.screenSize;
      if (mouseTargetX == null || mouseTargetY == null || mag == null) continue;

      const result = computePos(mouseTargetX, mouseTargetY, screenW, screenH);
      if (!result) continue;
      const { x, y } = result;

      const gridKey = `${Math.floor(x / cellSize)},${Math.floor(y / cellSize)}`;
      heatmapGrid[gridKey] = (heatmapGrid[gridKey] || 0) + 1;
    }

    const maxVisits = Math.max(...Object.values(heatmapGrid), 1);

    // Second pass: draw dots with heatmap colors
    playbackLayerRef.current.activate();
    let lastPos = center.clone();

    for (let i = 0; i <= maxIdx; i++) {
      const s = sensorData[i];
      if (!s?.sensor || !s?.screenSize) continue;

      const { mouseTargetX, mouseTargetY, mag } = s.sensor;
      const { width: screenW, height: screenH } = s.screenSize;
      if (mouseTargetX == null || mouseTargetY == null || mag == null) continue;

      const result = computePos(mouseTargetX, mouseTargetY, screenW, screenH);
      if (!result) continue;
      const { x, y } = result;

      const pos = new paper.Point(x, y);

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
      lastPos = pos;
    }

    playbackPosRef.current = lastPos.clone();
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

      <CalibrationIndicator />
    </div>
  );
}
