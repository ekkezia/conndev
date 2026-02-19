import { useEffect, useRef, useState } from "react";
import paper from "paper";
import { useIMU } from "../contexts/IMUContext";

const unit = 25;

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

  const { sensorData, playbackMode, playbackStatus } = useIMU();
  const [drawState, setDrawState] = useState(false);

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
      Math.round(width / 2 / unit) * unit,
      Math.round(height / 2 / unit) * unit
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

    const spacing = unit;

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
    };
  }, []);

  // =================================================
  // GENERIC DRAW FUNCTION
  // =================================================
  function drawLine(ax, ay, gx, gy, heading, layer, posRef, prevRef) {
    if (!layer || !posRef.current || !prevRef.current) return;

    layer.activate();

    const pos = posRef.current;
    const prevPos = prevRef.current.clone();

    const radians = (heading * Math.PI) / 180;

    pos.x += Math.sin(radians) * unit;
    pos.y += Math.cos(radians) * -unit;

    pos.x = Math.max(0, Math.min(pos.x, paper.view.size.width));
    pos.y = Math.max(0, Math.min(pos.y, paper.view.size.height));

    const motion = Math.sqrt(ax * ax + ay * ay) + Math.sqrt(gx * gx + gy * gy);
    const maxMotion = 40;
    const maxStrokeWidth = 4;
    const minStrokeWidth = 0.2;

    const strokeWidth =
      ((motion - 0) * (maxStrokeWidth - minStrokeWidth)) / (maxMotion - 0) +
      minStrokeWidth;

    const segment = new paper.Path({
      strokeColor: layer === playbackLayerRef.current ? "cyan" : "fuchsia",
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
  // REALTIME MODE
  // =================================================
  useEffect(() => {
    if (!sensorData || playbackMode) return;

    const s = sensorData[sensorData.length - 1];
    if (!s?.sensor) return;

    const { ax = 0, ay = 0, gx = 0, gy = 0, heading = 0 } = s.sensor;

    if (Math.abs(gx) > 50 || Math.abs(gy) > 50) {
      setDrawState(true);
    }

    if (!drawState) return;

    drawLine(
      ax,
      ay,
      gx,
      gy,
      heading,
      realtimeLayerRef.current,
      realtimePosRef,
      realtimePrevRef
    );
  }, [sensorData, drawState, playbackMode]);

  // =================================================
  // PLAYBACK MODE
  // =================================================
  useEffect(() => {
    if (!playbackMode || !sensorData) return;

    const width = paper.view.size.width;
    const height = paper.view.size.height;
    const center = new paper.Point(width / 2, height / 2);

    // Clear playback layer only
    playbackLayerRef.current.removeChildren();

    // Reset playback position only
    playbackPosRef.current = center.clone();
    playbackPrevRef.current = center.clone();

    const maxIdx = playbackStatus.currentDataIdx || 0;

    for (let i = 0; i <= maxIdx; i++) {
      const s = sensorData[i];
      if (!s?.sensor) continue;

      const { ax = 0, ay = 0, gx = 0, gy = 0, heading = 0 } = s.sensor;

      drawLine(
        ax,
        ay,
        gx,
        gy,
        heading,
        playbackLayerRef.current,
        playbackPosRef,
        playbackPrevRef
      );
    }
  }, [playbackMode, playbackStatus.currentDataIdx, sensorData]);

  return (
    <div className={`absolute top-0 left-0 w-full h-full ${className}`}>
      <canvas
        ref={canvasRef}
        resize="true"
        className="w-full h-full bg-gray-400"
      />
    </div>
  );
}
