import { createContext, useContext, useState, useCallback, useRef, useMemo } from 'react';
import { useEffect } from 'react';
import { io } from 'socket.io-client';
import { REACT_APP_SERVER_URL, SFX } from '../config';
import { playSfx } from '../components/magic-beats/audio';

const IMUContext = createContext(null);

export function IMUProvider({ children }) {
  const [mouseEnabled, setMouseEnabled] = useState(false);
  const [playbackMode, setPlaybackMode] = useState(false); // false = draw, true = playback
  const [playbackStatus, setPlaybackStatus] = useState({ progress: null, clippedTimestamp: null, currentTimestamp: null, currentDataIdx: null, isPlaying: false }); // default to play, false for pause
  const [sensorData, setSensorData] = useState([]); // live entries for current session
  const [sessions, setSessions] = useState([]); // full session history: [{ id, startTimestamp, data[] }]
  const [selectedSession, setSelectedSession] = useState(null); // session chosen in playback UI
  const [enableHelper, setEnableHelper] = useState(false);
  const [showDotmap, setShowDotmap] = useState(false);
  const [mousePos, setMousePos] = useState(null); // { x, y } in screen coords from server
  const mousePosRef = useRef(null); // always-current mousePos for use in socket closures
  const mouseClientPosRef = useRef(null); // { x, y } in viewport coords for DOM hit-testing
  const hoverTargetRef = useRef(null);
  const hoverBuzzTargetRef = useRef(null);
  const lastHoverBuzzAtRef = useRef(0);
  const [clear, setClear] = useState(false);
  const [drawState, setDrawState] = useState({ draw: false, timestamp: null });
  const [powerState, setPowerState] = useState({
    power: false,
    previousPower: null,
    transition: null,
    timestamp: null,
  });
  const powerStateRef = useRef({
    power: false,
    previousPower: null,
    transition: null,
    timestamp: null,
  });
  const [sessionsUpdated, setSessionsUpdated] = useState(null); // timestamp of last session update for animations
  const [click, setClick] = useState(false); // click state for animation
  const [phillips, setPhillips] = useState({
    hue: 0,
    bri: 0
  }); // phillips head animation state

  // useEffect(() => {
  //   console.log('sessions updated, total sessions:', sessions.length, sensorData);
  // }, [sensorData])
  const toClientPoint = useCallback((screenPos) => {
    if (!screenPos) return null;
    const viewW = Math.max(window.innerWidth || 1, 1);
    const viewH = Math.max(window.innerHeight || 1, 1);
    return {
      x: Math.max(0, Math.min(viewW - 1, Number(screenPos.x) || 0)),
      y: Math.max(0, Math.min(viewH - 1, Number(screenPos.y) || 0)),
    };
  }, []);

  const getHoverTarget = useCallback((clientPos) => {
    if (!clientPos) return null;
    const el = document.elementFromPoint(clientPos.x, clientPos.y);
    if (!el) return null;
    return el.closest('button, [role="button"], a[href], .cursor-pointer, [data-clickable="true"]');
  }, []);

  const isClickableTarget = useCallback(
    (el) =>
      Boolean(
        el?.closest('button, [role="button"], a[href], .cursor-pointer, [data-clickable="true"]'),
      ),
    [],
  );

  const setHoverTarget = useCallback((nextTarget) => {
    const prevTarget = hoverTargetRef.current;
    if (prevTarget === nextTarget) return;
    if (prevTarget?.classList) prevTarget.classList.remove('imu-hover-target');
    hoverTargetRef.current = nextTarget;
    if (nextTarget?.classList) nextTarget.classList.add('imu-hover-target');

    if (!nextTarget) {
      hoverBuzzTargetRef.current = null;
      return;
    }

    if (hoverBuzzTargetRef.current === nextTarget) return;
    const now = Date.now();
    if (now - lastHoverBuzzAtRef.current < 140) return;

    hoverBuzzTargetRef.current = nextTarget;
    lastHoverBuzzAtRef.current = now;
    socket.current?.emit('ui-hover', {
      tag: nextTarget.tagName?.toLowerCase?.() ?? null,
      clickable: isClickableTarget(nextTarget),
      timestamp: now,
    });
  }, [isClickableTarget]);

  // Always-fresh data for the selected session — derived by looking up sessions[] by ID
  // (selectedSession itself is a stale snapshot; sessions[] is the live source of truth)
  const selectedSessionData = useMemo(() => {
    if (!selectedSession) return sensorData;
    const live = sessions.find((s) => s && s.id === selectedSession.id);
    return live?.data ?? sensorData;
  }, [selectedSession, sessions, sensorData]);

  const updateSensor = useCallback((newSensor) => {
    setSensorData((s) => [...s.slice(-999), newSensor]);
  }, []);

  const enableMouse = useCallback(() => setMouseEnabled(true), []);
  const disableMouse = useCallback(() => setMouseEnabled(false), []);

  const socket = useRef(null);

  useEffect(() => {
    powerStateRef.current = powerState;
  }, [powerState]);

  useEffect(() => {
    if (typeof window === 'undefined') return;

    const applyPower = (nextPower) => {
      setPowerState((prev) => ({
        power: nextPower === true,
        previousPower: prev?.power === true,
        transition:
          prev?.power === true && nextPower !== true
            ? 'off'
            : prev?.power !== true && nextPower === true
              ? 'on'
              : 'none',
        timestamp: Date.now(),
      }));
    };

    // Dev helper for quick console simulation:
    // window.magicPower.on(); window.magicPower.off(); window.magicPower.toggle();
    window.magicPower = {
      on: () => applyPower(true),
      off: () => applyPower(false),
      toggle: () => setPowerState((prev) => {
        const next = !(prev?.power === true);
        return {
          power: next,
          previousPower: prev?.power === true,
          transition: next ? 'on' : 'off',
          timestamp: Date.now(),
        };
      }),
      state: () => powerStateRef.current,
    };

    return () => {
      if (window.magicPower) delete window.magicPower;
    };
  }, []);

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

    socket.current.on('connect_error', (err) => {
      console.error(
        `Socket connect_error (${REACT_APP_SERVER_URL}):`,
        err?.message || err,
      );
    });

    // Report screen size immediately so server can use it for mouse mapping
    socket.current.emit('screen-size', { width: window.innerWidth, height: window.innerHeight });

    // Report current mouse position (throttled) so server can init cursor state
    let lastMouseReport = 0;
    const onMouseMove = (e) => {
      const now = Date.now();
      if (now - lastMouseReport < 50) return; // max 20/s
      lastMouseReport = now;
      socket.current.emit('mouse-pos-report', { x: e.clientX, y: e.clientY });
    };
    window.addEventListener('mousemove', onMouseMove);

    socket.current.on('sensor-initial-data', (incomingSessions) => {
      let processedIncomingSessions = incomingSessions;
      // Backward compatibility: convert old object format to array
      if (!Array.isArray(incomingSessions) && typeof incomingSessions === 'object') {
        console.log('⚠️ Converting old session format to array');
        processedIncomingSessions = Object.entries(incomingSessions).map(([id, session]) => ({ id, ...session }));
      }

      // Ensure each session's data is an array (Firebase stores as object with numeric keys)
      processedIncomingSessions = processedIncomingSessions
        .filter(session => session != null)
        .map(session => ({
          ...session,
          data: session.data && typeof session.data === 'object' && !Array.isArray(session.data)
            ? Object.values(session.data)
            : (Array.isArray(session.data) ? session.data : [])
        }));

      console.log('📦 Loaded sessions:', processedIncomingSessions.length);

      setSessions(processedIncomingSessions);

      // Seed live sensorData from the most recent session's data
      const last = processedIncomingSessions[processedIncomingSessions.length - 1];
      setSensorData(last?.data ?? []);
      // Auto-select the latest session for playback
      if (last) setSelectedSession(last);
    });
    socket.current.on('sensor-realtime-receive', (entry) => {
      // Only update if drawState.draw is true
      setSensorData((prev) => [...prev, entry].slice(-1000));
      // Append to the last session in sessions[]
      setSessions((prev) => {
        if (prev.length === 0) {
          // If backend did not emit session-started (or initial sessions are empty),
          // still surface realtime packets in the UI as a local live session.
          return [{
            id: `session_live_${Date.now()}`,
            startTimestamp: entry?.timestamp || Date.now(),
            data: [entry],
          }];
        }
        const updated = [...prev];
        const last = { ...updated[updated.length - 1] };
        last.data = [...last.data, entry].slice(-1000);
        updated[updated.length - 1] = last;
        return updated;
      });
    });
    socket.current.on('session-started', (newSession) => {
      console.log('📁 New session started:', newSession);
      // Ensure data is array and prevent duplicates
      setSessions((prev) => {
        // Check if session already exists
        const exists = prev.some(s => s.id === newSession.id);
        if (exists) {
          console.warn('⚠️ Session already exists, skipping duplicate');
          return prev;
        }
        // Ensure data is array
        const sessionWithArrayData = {
          ...newSession,
          data: Array.isArray(newSession.data)
            ? newSession.data
            : (newSession.data && typeof newSession.data === 'object' ? Object.values(newSession.data) : [])
        };
        return [...prev, sessionWithArrayData];
      });
    });

    socket.current.on('sensor-draw', (data) => {
      setDrawState(prev => ({ ...prev, draw: data.draw === 'start', timestamp: data.timestamp }));
      console.log('✍🏻 draw', data.draw, data.timestamp);
    });

    socket.current.on('sensor-power', (data) => {
      setPowerState({
        power: data?.power === true,
        previousPower: data?.previousPower === true,
        transition: data?.transition ?? null,
        timestamp: data?.timestamp ?? Date.now(),
      });
      console.log('🔌 power', data?.power === true ? 'ON' : 'OFF', data?.transition ?? 'sync');
    });

    socket.current.on('sensor-processed-mouse-pos', (pos) => {
      setMousePos(pos);
      mousePosRef.current = pos;
      const clientPos = toClientPoint(pos);
      mouseClientPosRef.current = clientPos;
      setHoverTarget(getHoverTarget(clientPos));
    });

    socket.current.on('sensor-click', () => {
      // 1. update state (for animations)
      setClick(true);
      setTimeout(() => setClick(false), 100);
      console.log('click!');

      // 2. play click sfx
      playSfx(SFX.click, 0.55);

      // 3. trigger browser click at last known mouse position
      const clientPos = mouseClientPosRef.current || toClientPoint(mousePosRef.current);
      const target = getHoverTarget(clientPos) || hoverTargetRef.current;
      const handledByDom = Boolean(target && clientPos);
      if (handledByDom) {
        const pointerEventSupported = typeof PointerEvent !== 'undefined';
        const makeMouseEvent = (type, buttons = 0) =>
          new MouseEvent(type, {
            bubbles: true,
            cancelable: true,
            clientX: clientPos.x,
            clientY: clientPos.y,
            buttons,
          });

        if (pointerEventSupported) {
          target.dispatchEvent(
            new PointerEvent('pointerdown', {
              bubbles: true,
              cancelable: true,
              clientX: clientPos.x,
              clientY: clientPos.y,
              pointerType: 'mouse',
              isPrimary: true,
              buttons: 1,
            }),
          );
        }
        target.dispatchEvent(
          makeMouseEvent('mousedown', 1),
        );
        if (pointerEventSupported) {
          target.dispatchEvent(
            new PointerEvent('pointerup', {
              bubbles: true,
              cancelable: true,
              clientX: clientPos.x,
              clientY: clientPos.y,
              pointerType: 'mouse',
              isPrimary: true,
              buttons: 0,
            }),
          );
        }
        target.dispatchEvent(
          makeMouseEvent('mouseup', 0),
        );
        target.dispatchEvent(
          makeMouseEvent('click', 0),
        );
        if (typeof target.click === 'function') {
          try {
            target.click();
          } catch {}
        }
      } else {
        console.warn('⚠️ imu-click no target', clientPos);
      }

      socket.current?.emit('ui-click', {
        hasTarget: Boolean(target),
        tag: target?.tagName?.toLowerCase?.() ?? null,
        clickable: isClickableTarget(target),
        handledByDom,
        timestamp: Date.now(),
      });

      // Global event for UI feedback and fallback click routing in cursor overlays.
      window.dispatchEvent(
        new CustomEvent('imu-click', {
          detail: {
            handledByDom,
            clientPos: clientPos ? { x: clientPos.x, y: clientPos.y } : null,
          },
        }),
      );
    });

    return () => {
      socket.current.disconnect();
      window.removeEventListener('mousemove', onMouseMove);
      setHoverTarget(null);
    };
  }, [toClientPoint, getHoverTarget, isClickableTarget, setHoverTarget]);

  const value = {
    mouseEnabled,
    sensorData,    // flat array: live entries for the current session
    sessions,      // full history: [{ id, startTimestamp, data[] }]
    enableMouse,
    disableMouse,
    updateSensor,
    playbackMode,
    setPlaybackMode,
    playbackStatus,
    setPlaybackStatus,
    enableHelper,
    setEnableHelper,
    showDotmap,
    setShowDotmap,
    mousePos,
    clear,
    setClear,
    selectedSession,
    setSelectedSession,
    selectedSessionData, // live data for the selected session (always fresh)
    sessionsUpdated, // timestamp for animation/update detection
    drawState,
    powerState,
    phillips,
    setPhillips,
  };

  return <IMUContext.Provider value={value}>{children}</IMUContext.Provider>;
}

export function useIMU() {
  const ctx = useContext(IMUContext);
  if (!ctx) throw new Error('useIMU must be used within an IMUProvider');
  return ctx;
}

export default IMUContext;
