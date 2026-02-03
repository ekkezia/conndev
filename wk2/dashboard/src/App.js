import './App.css';
import MenuButton from './menu-button';
import DashboardDisplay from './components/dashboard-display';
import IMUContext, { useIMU } from './contexts/IMUContext';
import R3FCanvas from './components/r3f-canvas';
import PlaybackDisplay from './components/playback-display';

function App() {
  const { playbackMode, setPlaybackMode } = useIMU();
  return (
      <div className="bg-black h-screen w-screen">
        <div className="w-full h-full z-10 fixed top-0 left-0">
          <MenuButton className="top-4 left-4" />
          <MenuButton className="top-4 right-4" />
          
          <DashboardDisplay />
          <PlaybackDisplay />
          <MenuButton className="bottom-4 right-4 flex items-center justify-center text-white">
            <button onClick={() => setPlaybackMode(!playbackMode)}>
              {playbackMode ? '🔒' : '▶'}
            </button>
          </MenuButton>
        </div>

        <R3FCanvas />
      </div>
  );
}

export default App;
