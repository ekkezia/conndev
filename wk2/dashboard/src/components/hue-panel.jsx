import { useState, useEffect, useRef } from 'react';
import { io } from 'socket.io-client';
import { REACT_APP_SERVER_URL } from '../config';

export default function HuePanel() {
  const [lights, setLights] = useState({});
  const socket = useRef(null);
  
  // Standard Phillips Hue properties from tutorial
  const properties = ['on', 'bri', 'hue', 'sat', 'ct', 'colormode', 'reachable'];

  useEffect(() => {
    socket.current = io(REACT_APP_SERVER_URL);
    
    // In a real app we'd fetch current states, for now it's a controller
    return () => socket.current.disconnect();
  }, []);

  const setLight = (lightNum, change) => {
    console.log(`Setting light ${lightNum}:`, change);
    socket.current.emit('hue-control', { lightNum, change });
  };

  // createControl equivalent in React
  const Control = ({ lightNum, property, value }) => {
    const handleChange = (e) => {
      let newValue;
      if (property === 'on') {
        newValue = e.target.checked;
      } else {
        newValue = parseInt(e.target.value);
      }
      setLight(lightNum, { [property]: newValue });
    };

    if (property === 'reachable' || property === 'colormode') {
      return <div className="text-xs text-white/40">{property}: {String(value)}</div>;
    }

    if (property === 'on') {
      return (
        <label className="flex items-center gap-2 cursor-pointer">
          <span className="text-xs uppercase w-8">Power</span>
          <input type="checkbox" checked={value} onChange={handleChange} className="w-4 h-4" />
        </label>
      );
    }

    // bri (0-254), hue (0-65535), sat (0-254), ct (153-500)
    let min = 0, max = 254;
    if (property === 'hue') max = 65535;
    if (property === 'ct') { min = 153; max = 500; }

    return (
      <div className="flex flex-col gap-1">
        <div className="flex justify-between text-[10px] uppercase text-white/60">
          <span>{property}</span>
          <span>{value}</span>
        </div>
        <input 
          type="range" 
          min={min} 
          max={max} 
          value={value ?? min} 
          onChange={handleChange}
          className="w-full h-1 bg-white/20 rounded-lg appearance-none cursor-pointer accent-blue-500"
        />
      </div>
    );
  };

  // For demo, we'll just show light 2 (as requested)
  const [testLightState, setTestLightState] = useState({
    on: true,
    bri: 127,
    hue: 30181,
    sat: 254,
    ct: 300,
    colormode: 'xy',
    reachable: true
  });

  return (
    <div className="p-4 bg-black/80 border border-white/10 rounded-2xl backdrop-blur-md shadow-2xl flex flex-col gap-4 w-64 pointer-events-auto">
      <div className="flex items-center justify-between">
        <h3 className="text-white font-bold text-sm tracking-widest flex items-center gap-2">
          <span className="text-xl">💡</span> PHILLIPS HUE #2
        </h3>
        <div className={`w-2 h-2 rounded-full ${testLightState.reachable ? 'bg-green-500' : 'bg-red-500'} shadow-[0_0_8px_rgba(34,197,94,0.6)]`} />
      </div>

      <div className="flex flex-col gap-3">
        <Control lightNum={2} property="on" value={testLightState.on} />
        {properties.filter(p => !['on', 'reachable', 'colormode'].includes(p)).map(prop => (
          <Control 
            key={prop} 
            lightNum={2} 
            property={prop} 
            value={testLightState[prop]} 
          />
        ))}
        <div className="flex gap-4 mt-2">
           <Control lightNum={2} property="colormode" value={testLightState.colormode} />
           <Control lightNum={2} property="reachable" value={testLightState.reachable} />
        </div>
      </div>
    </div>
  );
}
