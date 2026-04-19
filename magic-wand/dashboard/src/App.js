import './App.css';
import { useRef, useEffect, useState } from 'react';
import { io } from 'socket.io-client';
import { REACT_APP_SERVER_URL } from './config';
import BeatGame from './components/beat-game';

function App() {
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
      <div className="relative h-screen w-screen ">
        <BeatGame />
      </div>

  );
}

export default App;
