import './App.css';
import MenuButton from './menu-button';
import DashboardDisplay from './components/dashboard-display';
import R3FCanvas from './components/r3f-canvas';
import PlaybackDisplay from './components/playback/playback-display';
import VisualizationToggle from './components/visualization-toggle';
import { useRef, useEffect, useState } from 'react';
import { io } from 'socket.io-client';
import { REACT_APP_SERVER_URL } from './config';
import DrawingDisplay from './components/drawing-display';
import HuePanel from './components/hue-panel';
import BeatGame from './components/beat-game';

const MODES = ['draw', 'game', 'light'];
const MODE_ICONS = { draw: '✏️', game: '🎮', light: '🔦' };

function App() {
  const [mode, setMode] = useState('draw'); // 'draw' | 'game' | 'light'
  const [showVisualizationToggle, setShowVisualizationToggle] = useState(false);

  const socket = useRef(null);
  const [user, setUser] = useState(null);
  const [status, setStatus] = useState('disconnected');

  useEffect(() => {
    socket.current = io(REACT_APP_SERVER_URL);

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
          {/* Top Left */}
          <div className="relative">
            <MenuButton className="top-4 left-4 items-center justify-center flex relative" onClick={() => setShowVisualizationToggle(!showVisualizationToggle)}>
              <span className="text-xl">👁️</span>
            </MenuButton>
            <VisualizationToggle isOpen={showVisualizationToggle} onClose={() => setShowVisualizationToggle(false)} status={status} />
          </div>

          {/* Top Right */}
          <MenuButton className="top-4 right-4 items-center justify-center flex" onClick={() => setMode(m => MODES[(MODES.indexOf(m) + 1) % MODES.length])}>
            <span className="text-xl">{MODE_ICONS[mode]}</span>
          </MenuButton>

          {/* <UserDisplay user={user} /> */}

          {/* Bottom Left */}
          <DashboardDisplay />
          
          {/* Bottom Right */}
          <div className="fixed bottom-4 right-4 flex flex-col items-end gap-4 pointer-events-none">
            {/* <HuePanel /> */}
            <PlaybackDisplay />
          </div>
        </div>

      {mode === 'light' && <R3FCanvas />}
      {mode === 'draw' && <DrawingDisplay />}
      {mode === 'game' && <BeatGame />}
      </div>

  );
}

export default App;
