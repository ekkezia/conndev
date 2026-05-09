import { useCallback, useEffect, useRef, useState } from "react";
import { SFX } from "../../../config";
import { playSfx } from "../audio";
import { TRAIL_LIFETIME, TRAIL_PALETTE } from "../constants";

const DESKTOP_MOUSE_TAKEOVER_MS = 220;

export function useWandCursor(cursor, canvasRect) {
  const [mousePos, setMousePos] = useState(null);
  const [clickKey, setClickKey] = useState(0);
  const [trailItems, setTrailItems] = useState([]);
  const trailRef = useRef([]);
  const lastTrailPosRef = useRef(null);
  const trailFrameRef = useRef(0);
  const cursorRef = useRef(null);
  const mouseTakeoverTimeoutRef = useRef(null);
  // Desktop mouse takes priority when it moves; wand is fallback.
  const activeCursor = mousePos ?? cursor;

  useEffect(() => {
    cursorRef.current = activeCursor;
  }, [activeCursor]);

  useEffect(() => {
    return () => {
      if (mouseTakeoverTimeoutRef.current) {
        clearTimeout(mouseTakeoverTimeoutRef.current);
        mouseTakeoverTimeoutRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    const onImuClick = (event) => {
      setClickKey((k) => k + 1);

      // If IMUContext already clicked a valid DOM target, avoid double-clicking.
      if (event?.detail?.handledByDom) return;

      const cur = cursorRef.current;
      if (!cur) return;
      const el = document.elementFromPoint(cur.x, cur.y);
      if (!el) return;
      const target = el.closest(
        "button, [role=\"button\"], a[href], .cursor-pointer, [data-clickable=\"true\"]",
      );
      if (!target) return;
      if (typeof target.click === "function") {
        target.click();
        return;
      }
      target.dispatchEvent(
        new MouseEvent("click", {
          bubbles: true,
          cancelable: true,
          clientX: cur.x,
          clientY: cur.y,
        }),
      );
    };
    window.addEventListener("imu-click", onImuClick);
    return () => window.removeEventListener("imu-click", onImuClick);
  }, []);

  useEffect(() => {
    let rafId;
    function loop(now) {
      rafId = requestAnimationFrame(loop);
      const cur = cursorRef.current;
      if (cur) {
        const last = lastTrailPosRef.current;
        const moved = last ? Math.hypot(cur.x - last.x, cur.y - last.y) : Infinity;
        if (moved > 5) {
          trailFrameRef.current += 1;
          trailRef.current.push({
            id: trailFrameRef.current,
            x: cur.x,
            y: cur.y,
            spawnTime: now,
            color: TRAIL_PALETTE[trailFrameRef.current % TRAIL_PALETTE.length],
            r1: 12 + Math.random() * 10,
            r2: 38 + Math.random() * 22,
            rot: Math.random() * 360,
          });
          lastTrailPosRef.current = { x: cur.x, y: cur.y };
        }
      }
      const alive = trailRef.current.filter((item) => now - item.spawnTime < TRAIL_LIFETIME);
      trailRef.current = alive;
      setTrailItems(alive.map((item) => ({ ...item, age: now - item.spawnTime })));
    }
    rafId = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(rafId);
  }, []);

  const onMouseMove = useCallback(
    (e) => {
      if (!canvasRect) {
        setMousePos({ x: e.clientX, y: e.clientY });
        return;
      }
      const insideCanvas =
        e.clientX >= canvasRect.x &&
        e.clientX <= canvasRect.x + canvasRect.width &&
        e.clientY >= canvasRect.y &&
        e.clientY <= canvasRect.y + canvasRect.height;
      if (!insideCanvas) {
        if (mouseTakeoverTimeoutRef.current) {
          clearTimeout(mouseTakeoverTimeoutRef.current);
          mouseTakeoverTimeoutRef.current = null;
        }
        setMousePos(null);
        return;
      }
      setMousePos({ x: e.clientX, y: e.clientY });
      if (mouseTakeoverTimeoutRef.current) clearTimeout(mouseTakeoverTimeoutRef.current);
      mouseTakeoverTimeoutRef.current = setTimeout(() => {
        setMousePos(null);
        mouseTakeoverTimeoutRef.current = null;
      }, DESKTOP_MOUSE_TAKEOVER_MS);
    },
    [canvasRect],
  );

  const onMouseLeave = useCallback(() => {
    if (mouseTakeoverTimeoutRef.current) {
      clearTimeout(mouseTakeoverTimeoutRef.current);
      mouseTakeoverTimeoutRef.current = null;
    }
    setMousePos(null);
  }, []);

  const triggerClick = useCallback(() => {
    playSfx(SFX.click, 0.5);
    setClickKey((k) => k + 1);
  }, []);

  return { activeCursor, trailItems, onMouseMove, onMouseLeave, clickKey, triggerClick };
}
