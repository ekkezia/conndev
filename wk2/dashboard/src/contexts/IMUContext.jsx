import { createContext, useContext, useState, useCallback, useRef } from 'react';
import { useEffect } from 'react';
import { io } from 'socket.io-client';
import { SERVER_URL } from '../config';
import { mockSensorData } from '../components/mock-data';

const IMUContext = createContext(null);

export function IMUProvider({ children }) {
  const [connected, setConnected] = useState(false);
  const [playbackMode, setPlaybackMode] = useState(false); // toggle open/close playback display
  const [playbackStatus, setPlaybackStatus] = useState({ progress: null, clippedTimestamp: null, currentTimestamp: null, currentDataIdx: null, isPlaying: false }); // default to play, false for pause
  const [sensorData, setSensorData] = useState(mockSensorData);

  const updateSensor = useCallback((newSensor) => {
    setSensorData((s) => [...s.slice(-999), newSensor]);
  }, []);

  const connect = useCallback(() => setConnected(true), []);
  const disconnect = useCallback(() => setConnected(false), []);
  
  const socket = useRef(null);

  useEffect(() => {
    socket.current = io(SERVER_URL);

    socket.current.on('sensor-initial-data', (data) => setSensorData(data));
    socket.current.on('sensor-realtime-receive', (data) => setSensorData((prev) => [...prev, data].slice(-1000)));

    return () => socket.current.disconnect();
  }, []);

  const value = {
    connected,
    sensorData,
    connect,
    disconnect,
    updateSensor,
    playbackMode,
    setPlaybackMode,
    playbackStatus,
    setPlaybackStatus
  };

  return <IMUContext.Provider value={value}>{children}</IMUContext.Provider>;
}

export function useIMU() {
  const ctx = useContext(IMUContext);
  if (!ctx) throw new Error('useIMU must be used within an IMUProvider');
  return ctx;
}

export default IMUContext;
