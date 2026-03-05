import { createContext, useContext, useState, useCallback, useRef, useMemo } from 'react';
import { useEffect } from 'react';
import { io } from 'socket.io-client';
import { SERVER_URL } from '../config';

const IMUContext = createContext(null);

export function IMUProvider({ children }) {
  const [mouseEnabled, setMouseEnabled] = useState(false);
  const [playbackMode, setPlaybackMode] = useState(false); // toggle false = drawing real time, / true = playback
  const [playbackStatus, setPlaybackStatus] = useState({ progress: null, clippedTimestamp: null, currentTimestamp: null, currentDataIdx: null, isPlaying: false }); // default to play, false for pause
  const [sensorData, setSensorData] = useState([]); // live entries for current session
  const [sessions, setSessions] = useState([]); // full session history: [{ id, startTimestamp, data[] }]
  const [selectedSession, setSelectedSession] = useState(null); // session chosen in playback UI
  const [enableHelper, setEnableHelper] = useState(false);
  const [showDotmap, setShowDotmap] = useState(false);
  const [mousePos, setMousePos] = useState(null); // { x, y } in screen coords from server
  const [clear, setClear] = useState(false);
  const [calibrationState, setCalibrationState] = useState({ calibrated: false, data: null, timestamp: null });
  const [sessionsUpdated, setSessionsUpdated] = useState(null); // timestamp of last session update for animations

  // Always-fresh data for the selected session — derived by looking up sessions[] by ID
  // (selectedSession itself is a stale snapshot; sessions[] is the live source of truth)
  const selectedSessionData = useMemo(() => {
    if (!selectedSession) return sensorData;
    const live = sessions.find((s) => s.id === selectedSession.id);
    return live?.data ?? sensorData;
  }, [selectedSession, sessions, sensorData]);

  const updateSensor = useCallback((newSensor) => {
    setSensorData((s) => [...s.slice(-999), newSensor]);
    
  }, []);

  const enableMouse = useCallback(() => setMouseEnabled(true), []);
  const disableMouse = useCallback(() => setMouseEnabled(false), []);
  
  const socket = useRef(null);

  useEffect(() => {
    socket.current = io(SERVER_URL);

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
        processedIncomingSessions = Object.entries(incomingSessions).map(([id, session]) => ({  id, ...session }));
      }
      
      // Ensure each session's data is an array (Firebase stores as object with numeric keys)
      processedIncomingSessions = processedIncomingSessions.map(session => ({
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
    socket.current.on('sensor-power', (data) => {
      setMouseEnabled(data.power);
      // When power turns off, we don't clear anything - keep sessions for playback
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
        const sessionWithArrayData = {
          ...newSession,
          data: Array.isArray(newSession.data) ? newSession.data : []
        };
        return [...prev, sessionWithArrayData];
      });
      setSelectedSession({ ...newSession, data: [] });
      setSensorData([]);
      setSessionsUpdated(Date.now()); // Trigger update notification
    });
    socket.current.on('session-ended', async (data) => {
      console.log('📁 Session ended:', data);
      // Fetch fresh session data from server to ensure sync
      try {
        const response = await fetch(`${SERVER_URL}/sensor-data`);
        const freshSessions = await response.json();
        
        // Convert data to arrays if needed
        const processedSessions = freshSessions.map(session => ({
          ...session,
          data: session.data && typeof session.data === 'object' && !Array.isArray(session.data) 
            ? Object.values(session.data) 
            : (Array.isArray(session.data) ? session.data : [])
        }));
        
        setSessions(processedSessions);
        setSessionsUpdated(Date.now()); // Trigger update notification
        console.log('✅ Sessions refreshed after session end');
      } catch (err) {
        console.error('Failed to refresh sessions:', err);
        // Fallback: update by index
        setSessions((prev) => {
          const updated = [...prev];
          if (updated[data.index]) {
            updated[data.index] = { ...updated[data.index], endTimestamp: data.endTimestamp };
          }
          return updated;
        });
      }
    });
    socket.current.on('mouse-pos', (pos) => setMousePos(pos));
    socket.current.on('sensor-calibration', (calibrationData) => {
      setCalibrationState(calibrationData);
    });
    socket.current.on('sensor-clear', () => setClear(true));

    return () => {
      socket.current.disconnect();
      window.removeEventListener('mousemove', onMouseMove);
    };
  }, []);

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
  };

  return <IMUContext.Provider value={value}>{children}</IMUContext.Provider>;
}

export function useIMU() {
  const ctx = useContext(IMUContext);
  if (!ctx) throw new Error('useIMU must be used within an IMUProvider');
  return ctx;
}

export default IMUContext;
