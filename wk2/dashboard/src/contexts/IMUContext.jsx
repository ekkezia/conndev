import { createContext, useContext, useState, useCallback, useRef } from 'react';
import { useEffect } from 'react';
import { io } from 'socket.io-client';
import { SERVER_URL } from '../config';
import { mockSensorData } from '../components/mock-data';

const IMUContext = createContext(null);

export function IMUProvider({ children }) {
  const [mouseEnabled, setMouseEnabled] = useState(false);
  const [playbackMode, setPlaybackMode] = useState(false); // toggle false = drawing real time, / true = playback
  const [playbackStatus, setPlaybackStatus] = useState({ progress: null, clippedTimestamp: null, currentTimestamp: null, currentDataIdx: null, isPlaying: false }); // default to play, false for pause
  const [sensorData, setSensorData] = useState(mockSensorData);
  const [enableHelper, setEnableHelper] = useState(false);
  const [showDotmap, setShowDotmap] = useState(false);
  const [mousePos, setMousePos] = useState(null); // { x, y } in screen coords from server

  const updateSensor = useCallback((newSensor) => {
    setSensorData((s) => [...s.slice(-999), newSensor]);
  }, []);

  const enableMouse = useCallback(() => setMouseEnabled(true), []);
  const disableMouse = useCallback(() => setMouseEnabled(false), []);
  
  const socket = useRef(null);

  useEffect(() => {
    socket.current = io(SERVER_URL);

    socket.current.on('sensor-initial-data', (data) => setSensorData(data));
    socket.current.on('sensor-realtime-receive', (data) => setSensorData((prev) => [...prev, data].slice(-1000)));
    socket.current.on('mouse-pos', (pos) => setMousePos(pos));
    socket.current.on('sensor-power', (data) => setMouseEnabled(data.connected));

    return () => socket.current.disconnect();
  }, []);

  const value = {
    mouseEnabled,
    sensorData,
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
  };

  return <IMUContext.Provider value={value}>{children}</IMUContext.Provider>;
}

export function useIMU() {
  const ctx = useContext(IMUContext);
  if (!ctx) throw new Error('useIMU must be used within an IMUProvider');
  return ctx;
}

export default IMUContext;
