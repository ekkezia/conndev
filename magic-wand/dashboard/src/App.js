import { useState } from 'react';
import './App.css';
import BeatGame from './components/magic-beats/_index';
import MagicCanvas from './components/magic-canvas/_index';
import MagicSuiteLanding from './components/magic-site/_index';

function App() {
  const [isBeatLiveMode, setIsBeatLiveMode] = useState(false);
  const path = (typeof window !== 'undefined' ? window.location.pathname : '/').toLowerCase();

  if (path === '/magicbeats') {
    return (
      <div
        className={`relative h-screen w-screen ${isBeatLiveMode ? 'bg-black' : 'bg-transparent'}`}
      >
        <BeatGame onLiveModeChange={setIsBeatLiveMode} />
      </div>
    );
  }

  if (path === '/magiccanvas' || path === '/magic-canvas') {
    return (
      <MagicCanvas />
    );
  }

  return (
    <MagicSuiteLanding />
  );
}

export default App;
