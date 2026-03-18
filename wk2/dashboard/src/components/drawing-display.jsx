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
  const realtimePosRef = useRef(null);        // (kept for drawSmoothedLine compat)
  const realtimePrevRef = useRef(null);       // (kept for drawSmoothedLine compat)
  const realtimeLerpRef = useRef(null);       // { x, y, mag } smoothed cursor position
  const realtimeLastDrawnRef = useRef(null);  // { x, y } last position a stroke segment was drawn from
  const realtimeAnimRef = useRef(null);       // persistent rAF loop ID
  const realtimeTargetRef = useRef(null);     // { x, y, mag } latest raw sensor target
  const drawStateRef = useRef(null);          // mirror of drawState for rAF closure

  // ----- PLAYBACK STATE -----
  const playbackPosRef = useRef(null);
  const playbackPrevRef = useRef(null);
  const lastDrawnIdxRef = useRef(-1);   // last data index fully painted on the layer
  const animFrameRef = useRef(null);    // in-flight requestAnimationFrame id
  const lerpPosRef = useRef(null);      // { x, y } lerp cursor, survives between effect calls

  const { sensorData, playbackMode, playbackStatus, enableHelper, mousePos, clear, setClear, selectedSession, selectedSessionData, drawState } = useIMU();
  // Always-fresh data for the selected session (derived live in IMUContext)
  const playbackData = selectedSessionData;
  const mouseDotRef = useRef(null);
  const mousePathRef = useRef(null); // persistent paper.Path for the mouse trail
  // drawState is now provided by context

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
        strokeWidth: 0.5,
      });
    }

    for (let y = 0; y <= height; y += spacing) {
      new paper.Path.Line({
        from: [0, y],
        to: [width, y],
        strokeColor: new paper.Color(1, 1, 1, 0.15),
        strokeWidth: 0.5,
      });
    }

    // Axes
    new paper.Path.Line({
      from: [0, center.y],
      to: [width, center.y],
      strokeColor: new paper.Color(1, 1, 1, 0.6),
      strokeWidth: 1,
    });
    new paper.Path.Line({
      from: [center.x, 0],
      to: [center.x, height],
      strokeColor: new paper.Color(1, 1, 1, 0.6),
      strokeWidth: 1,
    });

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
      if (realtimeAnimRef.current) cancelAnimationFrame(realtimeAnimRef.current);
      if (animFrameRef.current) cancelAnimationFrame(animFrameRef.current);
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

    // Cancel any in-flight realtime animation
    if (realtimeAnimRef.current) {
      cancelAnimationFrame(realtimeAnimRef.current);
      realtimeAnimRef.current = null;
    }

    // Remove all children except the mouse dot
    if (realtimeLayerRef.current && mouseDotRef.current) {
      const children = realtimeLayerRef.current.children.slice();
      for (const child of children) {
        if (child !== mouseDotRef.current) {
          child.remove();
        }
      }
    } else if (realtimeLayerRef.current) {
      realtimeLayerRef.current.removeChildren();
    }
    realtimePosRef.current = null;
    realtimePrevRef.current = null;
    realtimeLerpRef.current = null;
    realtimeTargetRef.current = null;
    realtimeLastDrawnRef.current = null;
    drawStateRef.current = null;
    // Do not clear mouseDotRef.current so the dot persists
    paper.view.draw();

    const timer = setTimeout(() => setClear(false), 300);
    return () => clearTimeout(timer);
  }, [clear]);

  useEffect(() => {
    if (!playbackLayerRef.current) return;
    
    // Cancel realtime animation when switching to playback
    if (playbackMode && realtimeAnimRef.current) {
      cancelAnimationFrame(realtimeAnimRef.current);
      realtimeAnimRef.current = null;
    }
    
    playbackLayerRef.current.visible = playbackMode;
    paper.view.draw();
  }, [playbackMode]);

  // =================================================
  // GENERIC DRAW FUNCTION — draws smooth curves
  // canvasX/canvasY are already mapped to canvas coordinate space
  // =================================================
  function drawSmoothedLine(canvasX, canvasY, mag, layer, posRef, prevRef, opacity = 1) {
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
    const minStrokeWidth = 0.5;

    const strokeWidth =
      ((motion - 0) * (maxStrokeWidth - minStrokeWidth)) / (maxMotion - 0) +
      minStrokeWidth;

    // Determine color based on layer
    let strokeColor;
    if (layer === playbackLayerRef.current) {
      strokeColor = new paper.Color(0, 0, 0, opacity); // black
    } else {
      strokeColor = new paper.Color(1, 0, 1, opacity); // fuchsia
    }

    // Draw smooth curve from previous to current position
    const segment = new paper.Path({
      strokeColor,
      strokeWidth,
      strokeCap: "round",
      strokeJoin: "round",
    });

    segment.add(prevPos);
    segment.add(pos.clone());
    segment.smooth(); // Smooth the path for curves

    // Store position and magnitude for next animation frame
    prevRef.current = pos.clone();
    prevRef.current.mag = mag;

    paper.view.draw();
  }

  // --- RED DOT (MOUSE CURSOR) ---
  useEffect(() => {
    if (!realtimeLayerRef.current || !sensorData || sensorData.length === 0) return;

    // Use the latest sensor data for mouse position, just like playback
    const s = sensorData[sensorData.length - 1];
    if (!s?.sensor || !s?.screenSize) return;
    const { mouseTargetX, mouseTargetY } = s.sensor;
    const { width: screenW, height: screenH } = s.screenSize;
    if (mouseTargetX == null || mouseTargetY == null || !screenW || !screenH) return;

    const canvasWidth = paper.view.size.width;
    const canvasHeight = paper.view.size.height;
    const canvasX = Math.max(0, Math.min((mouseTargetX / screenW) * canvasWidth, canvasWidth));
    const canvasY = Math.max(0, Math.min((mouseTargetY / screenH) * canvasHeight, canvasHeight));

    // Color logic
    let color = {
      path: new paper.Color(1, 0, 1, 0.8), // fuchsia
      unCalibratedMouse: new paper.Color(1, 0, 0, 0.8), // red
      calibratedMouse: new paper.Color(1, 1, 0, 0.9), // yellow
    };
    let currentMouseColor = color.unCalibratedMouse;
    if (s.calibrated) {
      currentMouseColor = color.calibratedMouse;
    }

    realtimeLayerRef.current.activate();
    const pt = new paper.Point(canvasX, canvasY);

    // Always update or create the red cursor dot (always on top)
    if (!mouseDotRef.current) {
      mouseDotRef.current = new paper.Path.Circle({
        center: pt,
        radius: 6,
        fillColor: currentMouseColor,
        strokeColor: new paper.Color(1, 1, 1, 0.6),
        strokeWidth: 1.5,
      });
    } else {
      mouseDotRef.current.position = pt;
      mouseDotRef.current.fillColor = currentMouseColor;
    }
    mouseDotRef.current.bringToFront();
    paper.view.draw();
  }, [sensorData]);
  
  // --- RED DOT (MOUSE CURSOR) with LERP ---
  const mouseDotLerpRef = useRef(null); // { x, y }
  const mouseDotTargetRef = useRef(null); // { x, y }
  const mouseDotRafRef = useRef(null);

  // Update the target position for the red dot whenever sensorData changes
  useEffect(() => {
    if (!sensorData || sensorData.length === 0) return;
    const s = sensorData[sensorData.length - 1];
    if (!s?.sensor || !s?.screenSize) return;
    const { mouseTargetX, mouseTargetY } = s.sensor;
    const { width: screenW, height: screenH } = s.screenSize;
    if (mouseTargetX == null || mouseTargetY == null || !screenW || !screenH) return;
    const canvasWidth = paper.view.size.width;
    const canvasHeight = paper.view.size.height;
    const canvasX = Math.max(0, Math.min((mouseTargetX / screenW) * canvasWidth, canvasWidth));
    const canvasY = Math.max(0, Math.min((mouseTargetY / screenH) * canvasHeight, canvasHeight));
    mouseDotTargetRef.current = { x: canvasX, y: canvasY, s };
    // If lerp ref is not set, initialize it immediately
    if (!mouseDotLerpRef.current) {
      mouseDotLerpRef.current = { x: canvasX, y: canvasY };
    }
  }, [sensorData]);

  // Persistent rAF loop to lerp the red dot position
  useEffect(() => {
    let running = true;
    function animate() {
      if (!realtimeLayerRef.current) return;
      const target = mouseDotTargetRef.current;
      let lerp = mouseDotLerpRef.current;
      if (target && lerp) {
        // Lerp factor (tweak for smoothness vs. responsiveness)
        const t = 0.22;
        lerp.x = lerp.x + (target.x - lerp.x) * t;
        lerp.y = lerp.y + (target.y - lerp.y) * t;
        mouseDotLerpRef.current = lerp;

        // Color logic (keep as before)
        let color = {
          path: new paper.Color(1, 0, 1, 0.8), // fuchsia
          unCalibratedMouse: new paper.Color(1, 0, 0, 0.8), // red
          calibratedMouse: new paper.Color(1, 1, 0, 0.9), // yellow
        }
        let currentMouseColor = color.unCalibratedMouse;
        if (target.s?.calibrated) {
          currentMouseColor = color.calibratedMouse;
        }

        realtimeLayerRef.current.activate();
        const pt = new paper.Point(lerp.x, lerp.y);

        // Always update or create the red cursor dot (always on top)
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
          mouseDotRef.current.fillColor = currentMouseColor;
        }
        mouseDotRef.current.bringToFront();
        paper.view.draw();
      }
      if (running) mouseDotRafRef.current = requestAnimationFrame(animate);
    }
    mouseDotRafRef.current = requestAnimationFrame(animate);
    return () => {
      running = false;
      if (mouseDotRafRef.current) cancelAnimationFrame(mouseDotRafRef.current);
    };
  }, []);

  // =================================================
  // REALTIME MODE — keep drawStateRef current so the rAF loop can read it
  // =================================================
  // Track previous draw state to detect transitions
  const prevDrawStateRef = useRef(drawState?.draw);
  useEffect(() => {
    drawStateRef.current = drawState;

    // If draw mode transitions from false to true, reset all draw refs (pen up/down)
    if (prevDrawStateRef.current === false && drawState?.draw === true) {
      // Get the current cursor position from the latest sensor data
      if (sensorData && sensorData.length > 0) {
        const s = sensorData[sensorData.length - 1];
        if (s?.sensor && s?.screenSize) {
          const { mouseTargetX, mouseTargetY, mag } = s.sensor;
          const { width: screenW, height: screenH } = s.screenSize;
          if (screenW && screenH && mouseTargetX != null && mouseTargetY != null) {
            const canvasW = paper.view.size.width;
            const canvasH = paper.view.size.height;
            const canvasX = (mouseTargetX / screenW) * canvasW;
            const canvasY = (mouseTargetY / screenH) * canvasH;
            realtimeLastDrawnRef.current = null;
            realtimePrevRef.current = new paper.Point(canvasX, canvasY);
            realtimePrevRef.current.mag = mag ?? 1;
            realtimePosRef.current = new paper.Point(canvasX, canvasY);
          } else {
            realtimeLastDrawnRef.current = null;
            realtimePrevRef.current = null;
            realtimePosRef.current = null;
          }
        } else {
          realtimeLastDrawnRef.current = null;
          realtimePrevRef.current = null;
          realtimePosRef.current = null;
        }
      } else {
        realtimeLastDrawnRef.current = null;
        realtimePrevRef.current = null;
        realtimePosRef.current = null;
      }
    }
    prevDrawStateRef.current = drawState?.draw;
  }, [drawState, sensorData]);

  // Update target whenever new sensor data arrives
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

    // Seed lerp position on very first data point
    if (!realtimeLerpRef.current) {
      realtimeLerpRef.current = { x: canvasX, y: canvasY, mag: mag ?? 1 };
      realtimeLastDrawnRef.current = { x: canvasX, y: canvasY };
      realtimePrevRef.current = new paper.Point(canvasX, canvasY);
      realtimePrevRef.current.mag = mag ?? 1;
      realtimePosRef.current = new paper.Point(canvasX, canvasY);
    }

    // Always update the target — the rAF loop will chase it
    realtimeTargetRef.current = { x: canvasX, y: canvasY, mag: mag ?? 1 };
  }, [sensorData, playbackMode]);

  // Single persistent rAF loop — starts once, runs until playbackMode or unmount
  useEffect(() => {
    if (playbackMode) {
      if (realtimeAnimRef.current) {
        cancelAnimationFrame(realtimeAnimRef.current);
        realtimeAnimRef.current = null;
      }
      return;
    }

    const LERP_FACTOR = 0.18;

    const loop = () => {
      realtimeAnimRef.current = requestAnimationFrame(loop);

      const target = realtimeTargetRef.current;
      const lerp = realtimeLerpRef.current;
      if (!target || !lerp || !realtimeLayerRef.current) return;

      // Exponential lerp toward target — runs every frame ~60fps
      const lx = lerp.x + (target.x - lerp.x) * LERP_FACTOR;
      const ly = lerp.y + (target.y - lerp.y) * LERP_FACTOR;
      const lmag = (lerp.mag ?? 1) + ((target.mag ?? 1) - (lerp.mag ?? 1)) * LERP_FACTOR;

      // Write back lerp position
      realtimeLerpRef.current = { x: lx, y: ly, mag: lmag };

      // Only draw if moved enough and draw mode is on
      if (!drawStateRef.current?.draw) return;
      if (!realtimeLastDrawnRef.current) {
        realtimeLastDrawnRef.current = { x: lx, y: ly };
        return;
      }

      const dx = lx - realtimeLastDrawnRef.current.x;
      const dy = ly - realtimeLastDrawnRef.current.y;
      if (Math.sqrt(dx * dx + dy * dy) < 0.5) return;

      // Ensure paper refs are ready for drawSmoothedLine
      if (!realtimePrevRef.current) {
        realtimePrevRef.current = new paper.Point(lx, ly);
        realtimePrevRef.current.mag = lmag;
        realtimePosRef.current = new paper.Point(lx, ly);
        realtimeLastDrawnRef.current = { x: lx, y: ly };
        return;
      }

      drawSmoothedLine(lx, ly, lmag, realtimeLayerRef.current, realtimePosRef, realtimePrevRef);
      // drawSmoothedLine updates realtimePrevRef internally — sync lastDrawn to match
      realtimeLastDrawnRef.current = { x: lx, y: ly };
    };

    realtimeAnimRef.current = requestAnimationFrame(loop);
    return () => {
      if (realtimeAnimRef.current) {
        cancelAnimationFrame(realtimeAnimRef.current);
        realtimeAnimRef.current = null;
      }
    };
  }, [playbackMode]);

  // =================================================
  // PLAYBACK — reset layer when session changes
  // =================================================
  useEffect(() => {
    if (!playbackLayerRef.current) return;
    if (animFrameRef.current) cancelAnimationFrame(animFrameRef.current);
    animFrameRef.current = null;
    playbackLayerRef.current.removeChildren();
    lastDrawnIdxRef.current = -1;
    playbackPosRef.current = null;
    playbackPrevRef.current = null;
    lerpPosRef.current = null;
    paper.view.draw();
  }, [selectedSession]);

  // =================================================
  // PLAYBACK MODE — incremental lerp-animated draw
  // =================================================
  useEffect(() => {
    if (!playbackMode || !playbackData || !playbackLayerRef.current) return;
    if (playbackData.length === 0) return;

    const width = paper.view.size.width;
    const height = paper.view.size.height;

    const getPoint = (entry) => {
      if (!entry?.sensor || !entry?.screenSize) return null;
      const { mouseTargetX, mouseTargetY, mag } = entry.sensor;
      const { width: screenW, height: screenH } = entry.screenSize;
      if (mouseTargetX == null || !screenW || !screenH) return null;
      const x = Math.max(0, Math.min((mouseTargetX / screenW) * width, width));
      const y = Math.max(0, Math.min((mouseTargetY / screenH) * height, height));
      if (isNaN(x) || isNaN(y)) return null;
      return { x, y, mag: mag ?? 1 };
    };

    const targetIdx = playbackStatus.currentDataIdx ?? (playbackData.length - 1);

    // Helper: batch-draw all points up to idx instantly (no lerp)
    const batchDraw = (upToIdx) => {
      if (animFrameRef.current) { cancelAnimationFrame(animFrameRef.current); animFrameRef.current = null; }
      playbackLayerRef.current.removeChildren();
      lastDrawnIdxRef.current = -1;
      playbackPosRef.current = null;
      playbackPrevRef.current = null;
      lerpPosRef.current = null;

      const allPts = [];
      for (let i = 0; i <= upToIdx; i++) {
        const pt = getPoint(playbackData[i]);
        if (pt) allPts.push(pt);
      }
      if (allPts.length > 0) {
        playbackPosRef.current = new paper.Point(allPts[0].x, allPts[0].y);
        playbackPrevRef.current = new paper.Point(allPts[0].x, allPts[0].y);
        lerpPosRef.current = { x: allPts[0].x, y: allPts[0].y };
        for (let i = 1; i < allPts.length; i++) {
          drawSmoothedLine(allPts[i].x, allPts[i].y, allPts[i].mag, playbackLayerRef.current, playbackPosRef, playbackPrevRef);
        }
        lerpPosRef.current = { x: allPts[allPts.length - 1].x, y: allPts[allPts.length - 1].y };
        lastDrawnIdxRef.current = upToIdx;
      }
      paper.view.draw();
    };

    // Scrubbing backward or first open — instant batch draw
    if (targetIdx < lastDrawnIdxRef.current || lastDrawnIdxRef.current === -1) {
      batchDraw(targetIdx);
      return;
    }

    // Already up-to-date
    if (lastDrawnIdxRef.current >= targetIdx) return;

    // Forward advance — get the single next target point and lerp to it
    const target = getPoint(playbackData[targetIdx]);
    if (!target) { lastDrawnIdxRef.current = targetIdx; return; }

    // Ensure refs are seeded
    if (!playbackPosRef.current) {
      const first = getPoint(playbackData[0]);
      if (!first) return;
      playbackPosRef.current = new paper.Point(first.x, first.y);
      playbackPrevRef.current = new paper.Point(first.x, first.y);
      lerpPosRef.current = { x: first.x, y: first.y };
    }

    if (animFrameRef.current) cancelAnimationFrame(animFrameRef.current);

    const LERP_DURATION = 750;
    const startTime = performance.now();
    const startX = lerpPosRef.current?.x ?? playbackPrevRef.current.x;
    const startY = lerpPosRef.current?.y ?? playbackPrevRef.current.y;

    const animate = (now) => {
      if (!playbackPrevRef.current || !playbackLayerRef.current) {
        animFrameRef.current = null;
        return;
      }
      const t = Math.min((now - startTime) / LERP_DURATION, 1);
      // Ease out cubic
      const ease = 1 - Math.pow(1 - t, 3);

      const x = startX + (target.x - startX) * ease;
      const y = startY + (target.y - startY) * ease;

      lerpPosRef.current = { x, y };

      const dx = x - playbackPrevRef.current.x;
      const dy = y - playbackPrevRef.current.y;
      if (Math.sqrt(dx * dx + dy * dy) > 0.5) {
        drawSmoothedLine(x, y, target.mag, playbackLayerRef.current, playbackPosRef, playbackPrevRef);
      }

      if (t < 1) {
        animFrameRef.current = requestAnimationFrame(animate);
      } else {
        // Snap exactly to target
        drawSmoothedLine(target.x, target.y, target.mag, playbackLayerRef.current, playbackPosRef, playbackPrevRef);
        lerpPosRef.current = { x: target.x, y: target.y };
        lastDrawnIdxRef.current = targetIdx;
        animFrameRef.current = null;
      }
    };

    animFrameRef.current = requestAnimationFrame(animate);
    return () => {
      if (animFrameRef.current) cancelAnimationFrame(animFrameRef.current);
    };
  }, [playbackMode, playbackStatus.currentDataIdx, playbackData]);

  return (
    <div className={`absolute top-0 left-0 w-full h-full ${className}`}>
      <canvas
        ref={canvasRef}
        resize="true"
        className="w-full h-full bg-gray-400"
      />
      {sensorData && sensorData.length > 0 && (
        <div className="flex absolute top-2 left-1/2 -translate-x-1/2 bg-black/60 text-yellow-300 font-mono text-xs px-2 py-1 rounded pointer-events-none flex flex-col gap-0.5 items-center">
          {mousePos && <span>🖱 x: {mousePos.x} y: {mousePos.y}</span>}
          
          {sensorData?.length > 0 && sensorData[sensorData.length - 1]?.sensor?.sensitivity != null && (
            <div className="w-48 flex items-center gap-2">
              <span className="text-cyan-300 text-[10px] whitespace-nowrap">sensitivity</span>
              <div className="flex-1 h-2 bg-black border border-cyan-300 rounded overflow-hidden">
                <div 
                  className="h-full bg-gradient-to-r from-cyan-500 to-cyan-300"
                  style={{ width: `${(sensorData[sensorData.length - 1].sensor.sensitivity / 10) * 100}%` }}
                />
              </div>
              <span className="text-cyan-300 text-[10px] w-6 text-right">{sensorData[sensorData.length - 1].sensor.sensitivity.toFixed(1)}</span>
            </div>
          )}
          
          {sensorData?.length > 0 && sensorData[sensorData.length - 1]?.sensor != null && (
            <span className="text-green-300">
              🎯 x: {sensorData[sensorData.length - 1].sensor.mouseTargetX?.toFixed(2) ?? '—'} y: {sensorData[sensorData.length - 1].sensor.mouseTargetY?.toFixed(2) ?? '—'}
            </span>
          )}
        </div>
      )}

      <CalibrationIndicator />
    </div>
  );
}