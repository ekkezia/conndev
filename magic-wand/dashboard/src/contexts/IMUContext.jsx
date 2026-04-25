import { createContext, useContext, useState, useCallback, useRef, useMemo } from 'react';
import { useEffect } from 'react';
import { io } from 'socket.io-client';
import { REACT_APP_SERVER_URL } from '../config';

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
  const [sessionsUpdated, setSessionsUpdated] = useState(null); // timestamp of last session update for animations
  const [click, setClick] = useState(false); // click state for animation
  const [phillips, setPhillips] = useState({
    hue: 0,
    bri: 0
  }); // phillips head animation state

  // Optional click tone to debug
  const playClickTone = useCallback(() => {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();

    const oscillator = ctx.createOscillator();
    const gain = ctx.createGain();

    oscillator.type = 'sine';
    oscillator.frequency.setValueAtTime(1000, ctx.currentTime); // pitch

    gain.gain.setValueAtTime(0.2, ctx.currentTime); // volume
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.1);

    oscillator.connect(gain);
    gain.connect(ctx.destination);

    oscillator.start();
    oscillator.stop(ctx.currentTime + 0.1);
  }, []);

  const toClientPoint = useCallback((screenPos) => {
    if (!screenPos) return null;
    const screenW = Math.max(window.screen.width || window.innerWidth || 1, 1);
    const screenH = Math.max(window.screen.height || window.innerHeight || 1, 1);
    return {
      x: Math.max(
        0,
        Math.min(window.innerWidth - 1, (screenPos.x / screenW) * window.innerWidth),
      ),
      y: Math.max(
        0,
        Math.min(window.innerHeight - 1, (screenPos.y / screenH) * window.innerHeight),
      ),
    };
  }, []);

  const getHoverTarget = useCallback((clientPos) => {
    if (!clientPos) return null;
    const el = document.elementFromPoint(clientPos.x, clientPos.y);
    if (!el) return null;
    return el.closest('button, [role="button"], a[href], .cursor-pointer, [data-clickable="true"]');
  }, []);

  const getClickTarget = useCallback((clientPos) => {
    if (!clientPos) return null;
    const el = document.elementFromPoint(clientPos.x, clientPos.y);
    if (!el) return null;
    return (
      el.closest('button, [role="button"], a[href], .cursor-pointer, [data-clickable="true"]') ||
      el
    );
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
    socket.current = io(REACT_APP_SERVER_URL);

    // Report screen size immediately so server can use it for mouse mapping
    socket.current.emit('screen-size', { width: window.screen.width, height: window.screen.height });

    // Report current mouse position (throttled) so server can init cursor state
    let lastMouseReport = 0;
    const onMouseMove = (e) => {
      const now = Date.now();
      if (now - lastMouseReport < 50) return; // max 20/s
      lastMouseReport = now;
      socket.current.emit('mouse-pos-report', { x: e.screenX, y: e.screenY });
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
        if (prev.length === 0) return prev;
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

      // 2. play tone
      playClickTone();

      // 3. trigger browser click at last known mouse position
      const clientPos = mouseClientPosRef.current || toClientPoint(mousePosRef.current);
      const target = getClickTarget(clientPos);
      if (target && clientPos) {
        target.dispatchEvent(
          new MouseEvent('mousedown', {
            bubbles: true,
            cancelable: true,
            clientX: clientPos.x,
            clientY: clientPos.y,
          })
        );
        target.dispatchEvent(
          new MouseEvent('mouseup', {
            bubbles: true,
            cancelable: true,
            clientX: clientPos.x,
            clientY: clientPos.y,
          })
        );
        target.dispatchEvent(
          new MouseEvent('click', {
            bubbles: true,
            cancelable: true,
            clientX: clientPos.x,
            clientY: clientPos.y,
          })
        );
      }

      socket.current?.emit('ui-click', {
        hasTarget: Boolean(target),
        tag: target?.tagName?.toLowerCase?.() ?? null,
        clickable: isClickableTarget(target),
        timestamp: Date.now(),
      });

      // Optional: also emit a global custom event
      window.dispatchEvent(new Event('imu-click'));
    });

    return () => {
      socket.current.disconnect();
      window.removeEventListener('mousemove', onMouseMove);
      setHoverTarget(null);
    };
  }, [playClickTone, toClientPoint, getHoverTarget, getClickTarget, isClickableTarget, setHoverTarget]);

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
