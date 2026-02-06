import { useEffect, useRef, useState } from 'react';
import { io } from 'socket.io-client';
import { SERVER_URL } from '../config';

export default function Remote() {
  const [status, setStatus] = useState('disconnected');
  const latestRef = useRef({ sensor: { gx: 0, gy: 0, gz: 0, ax: 0, ay: 0, az: 0, direction: 0 }, timestamp: null });
  const socket = useRef(null);
  const [user, setUser] = useState(null);
  const [sensorData, setSensorData] = useState(latestRef.current);
  const [motionEnabled, setMotionEnabled] = useState(false);

  useEffect(() => {
    socket.current = io(SERVER_URL);

    socket.current.on('connect', () => setStatus('connected'));
    socket.current.on('disconnect', () => setStatus('disconnected'));
    socket.current.on('user', (data) => {
      console.log('User data:', data);
      if (data && data.id) setUser({ id: data.id });
    });

    return () => socket.current.disconnect();
  }, []);

  // Device motion listener with permission handling (iOS requires requestPermission)
  useEffect(() => {
    let attached = false;
    function handleMotion(ev) {
      if (!ev) return;
      const r = ev.rotationRate || {};
      const a = ev.acceleration || ev.accelerationIncludingGravity || {};
      const payload = {
        sensor: {
          gx: r.beta || 0,
          gy: r.alpha || 0,
          gz: r.gamma || 0,
          ax: a.x || 0,
          ay: a.y || 0,
          az: a.z || 0,
        },
        timestamp: Date.now(),
      };
      latestRef.current = payload;
      setSensorData(payload);
    }

    // helper to attach listener
    const attach = () => {
      if (!attached) {
        window.addEventListener('devicemotion', handleMotion);
        attached = true;
        setMotionEnabled(true);
      }
    };

    // If iOS-style permission API exists, do not attach automatically — wait for user gesture
    if (typeof DeviceMotionEvent !== 'undefined' && typeof DeviceMotionEvent.requestPermission === 'function') {
      // wait for explicit enable (user gesture) — we leave attaching to `enableMotion` below
    } else {
      // non-iOS: attach immediately
      try { attach(); } catch (e) { /* ignore */ }
    }

    return () => {
      if (attached) window.removeEventListener('devicemotion', handleMotion);
    };
  }, []);

// helper to request motion + orientation permission on iOS devices
async function enableMotion() {
  try {
    // iOS 13+ devices require permission
    if (typeof DeviceMotionEvent !== 'undefined' && typeof DeviceMotionEvent.requestPermission === 'function') {
      const motionRes = await DeviceMotionEvent.requestPermission();
      const orientationRes = typeof DeviceOrientationEvent.requestPermission === 'function'
        ? await DeviceOrientationEvent.requestPermission()
        : 'granted';

      if (motionRes === 'granted' && orientationRes === 'granted') {
        attachListeners();
        setMotionEnabled(true);
      } else {
        console.warn('Device motion/orientation permission not granted:', motionRes, orientationRes);
      }
    } else {
      // non-iOS fallback
      attachListeners();
      setMotionEnabled(true);
    }
  } catch (e) {
    console.error('enableMotion error', e);
  }
}

// attach actual listeners
function attachListeners() {
  // --- DeviceMotion (gyro + accel) ---
  window.addEventListener('devicemotion', (ev) => {
    const r = ev.rotationRate || {};
    const a = ev.acceleration || ev.accelerationIncludingGravity || {};
    latestRef.current = {
      ...latestRef.current,
      sensor: {
        ...latestRef.current?.sensor,
        gx: r.beta || 0,    // x-rotation rate
        gy: r.gamma || 0,   // y-rotation rate
        gz: r.alpha || 0,   // z-rotation rate
        ax: a.x || 0,
        ay: a.y || 0,
        az: a.z || 0,
      },
      timestamp: Date.now(),
    };
    setSensorData(latestRef.current);
  });

  // --- DeviceOrientation (compass / magnetometer) ---
  window.addEventListener('deviceorientation', (ev) => {
    // alpha = compass heading (0 = North)
    // assume ax, ay, az from accelerometer, mx, my, mz from magnetometer
    let ax = latestRef.current.sensor.ax;;
    let ay = latestRef.current.sensor.ay;
    let az = latestRef.current.sensor.az;
    let mx = ev.alpha || 0;
    let my = ev.beta || 0;
    let mz = ev.gamma || 0;
      const roll = Math.atan2(ay, az);            // rotation around X
      const pitch = Math.atan2(-ax, Math.sqrt(ay*ay + az*az)); // rotation around Y

      // tilt-compensated magnetic field
      const Xh = mx * Math.cos(pitch) + mz * Math.sin(pitch);
      const Yh = mx * Math.sin(roll) * Math.sin(pitch) + my * Math.cos(roll) - mz * Math.sin(roll) * Math.cos(pitch);

      // heading (yaw) in radians
      let heading = Math.atan2(Yh, Xh);

      // convert to degrees 0-360
      heading = heading * (180 / Math.PI);
      if (heading < 0) heading += 360;

    latestRef.current = {
      ...latestRef.current,
      sensor: {
        ...latestRef.current?.sensor,
        direction: heading,
      },
      timestamp: Date.now(),
    };
    setSensorData(latestRef.current);
  });
}

  // Send sensor data every second
  useEffect(() => {
    if (status !== 'connected') return;
    const interval = setInterval(() => {
      // send mock sensor data
      const random = {
        sensor: {
          gx: Math.floor(Math.random() * 360) - 180,
          gy: Math.floor(Math.random() * 360) - 180,
          gz: Math.floor(Math.random() * 360) - 180,
          ax: Math.floor(Math.random() * 360) - 180,
          ay: Math.floor(Math.random() * 360) - 180,
          az: Math.floor(Math.random() * 360) - 180,
          direction: Math.floor(Math.random() * 360),
        },
        timestamp: Date.now(),
      }
      latestRef.current = random;
      setSensorData(random);
    
      // send the latest captured sensor payload
      socket.current.emit('sensor-realtime-send', latestRef.current || sensorData);

      // socket.current.emit('sensor-realtime-send', { sensor: latestRef.current, timestamp: Date.now() });
    }, 1000);

    return () => clearInterval(interval);
  }, [status]);
  

  const d = (latestRef.current && latestRef.current.sensor) || sensorData.sensor;
  return (
    <div className="text-white">
      <div>Status: {status} | User: {user?.id ?? '-'}</div>
      <div className="mt-2">Motion: {motionEnabled ? 'enabled' : 'disabled'}{!motionEnabled && typeof DeviceMotionEvent !== 'undefined' && typeof DeviceMotionEvent.requestPermission === 'function' ? ' — tap to enable' : ''}
        {!motionEnabled && typeof DeviceMotionEvent !== 'undefined' && typeof DeviceMotionEvent.requestPermission === 'function' && (
          <button className="ml-2 px-2 py-1 bg-white text-black rounded" onClick={enableMotion}>Enable Motion</button>
        )}
      </div>
      <div className="mt-2">Gyro: gx: {(d?.gx ?? 0).toFixed(2)} | gy: {(d?.gy ?? 0).toFixed(2)} | gz: {(d?.gz ?? 0).toFixed(2)}</div>
      <div>Accel: ax: {(d?.ax ?? 0).toFixed(2)} | ay: {(d?.ay ?? 0).toFixed(2)} | az: {(d?.az ?? 0).toFixed(2)}</div>
    </div>
  );
}
