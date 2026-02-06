import './App.css';
import MenuButton from './menu-button';
import DashboardDisplay from './components/dashboard-display';
import IMUContext, { useIMU } from './contexts/IMUContext';
import R3FCanvas from './components/r3f-canvas';
import PlaybackDisplay from './components/playback-display';
import { useRef, useEffect, useState } from 'react';
import { io } from 'socket.io-client';
import { SERVER_URL } from './config';
import UserDisplay from './components/user-display';
import CanvasDisplay from './components/drawing-display';
import DrawingDisplay from './components/drawing-display';

function App() {
  const { playbackMode, setPlaybackMode } = useIMU();
  const [mode, setMode] = useState(false); // false = light, true =  draw

  const socket = useRef(null);
  const [user, setUser] = useState(null);
  const [status, setStatus] = useState('disconnected');

  useEffect(() => {
    socket.current = io(SERVER_URL);

    socket.current.on('connect', () => setStatus('connected'));
    socket.current.on('disconnect', () => setStatus('disconnected'));
    socket.current.on('user', (data) => {
      console.log('User data:', data);
      setUser({id: data.id })
    });

    return () => socket.current.disconnect();
  }, []);

  return (
      <div className="relative bg-black h-screen w-screen ">
        <div className="w-full h-full z-10 fixed top-0 left-0">
          <MenuButton className="top-4 left-4" />
          <MenuButton className="top-4 right-4" onClick={() => setMode(!mode)} />
          <UserDisplay user={user} />

          <DashboardDisplay />
          <PlaybackDisplay />
          <MenuButton className="bottom-4 right-4 flex items-center justify-center text-white">
            <button onClick={() => setPlaybackMode(!playbackMode)}>
              {playbackMode ? '🔒' : '▶'}
            </button>
          </MenuButton>
        </div>

      {!mode && <R3FCanvas />}
      {mode && <DrawingDisplay />}
      </div>
  );
}

export default App;
