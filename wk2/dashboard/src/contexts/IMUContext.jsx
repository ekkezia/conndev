import React, { createContext, useContext, useState, useCallback } from 'react';
import { useEffect } from 'react';

const IMUContext = createContext(null);

const SERVER_URL = 'ws://localhost:4000';

export function IMUProvider({ children }) {
  const [connected, setConnected] = useState(false);
  const [playbackMode, setPlaybackMode] = useState(false); // toggle open/close playback display
  const [isPlayingBack, setIsPlayingBack] = useState(false); // play/pause
  const [playbackStatus, setPlaybackStatus] = useState({ progress: null, clippedTimestamp: null });

  const updateSensor = useCallback((newSensor) => {
    setSensorData((s) => ({ ...s, ...newSensor }));
  }, []);

  const connect = useCallback(() => setConnected(true), []);
  const disconnect = useCallback(() => setConnected(false), []);

  const [sensorData, setSensorData] = useState([]);
  // periodically fetch the server for latest sensor data
  useEffect(() => {
    const ws = new WebSocket('ws://localhost:4000');
    ws.onopen = () => {
      console.log('WebSocket connected to server');
    }
    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        if (data && data.sensor !== undefined) {
          setSensorData((s) => [...s, data]);
        }
      } catch (e) {
        console.error('Error parsing WebSocket message:', e);
      }
    }
    ws.onclose = () => {
      console.log('WebSocket disconnected from server');
    }
    ws.onerror = (error) => {
      console.error('WebSocket error:', error);
    }
    return () => {
      ws.close();
    }
  }, []);

  const value = {
    connected,
    sensorData,
    connect,
    disconnect,
    updateSensor,
    playbackMode,
    setPlaybackMode,
    isPlayingBack,
    setIsPlayingBack,
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
