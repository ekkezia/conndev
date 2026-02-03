import { Canvas, useFrame, } from '@react-three/fiber';
import { useIMU } from '../contexts/IMUContext';
import * as THREE from 'three';
import { useRef } from 'react';

const SMOOTH_SPEED = 8;

function SceneGrid({ size = 20, divisions = 20 }) {
    const { sensorData, playbackMode, isPlayingBack, playbackStatus } = useIMU();
    const groupRef = useRef();
    const tempEuler = useRef(new THREE.Euler());
    const tempQuat = useRef(new THREE.Quaternion());

    // for lerping
  useFrame((_, delta) => {
    const g = groupRef.current;
    if (!g) return;

    let latest, targetQuat;
    if (playbackMode) {
      // playback: use clippedTimestamp (persisted click) or fallback to currentTimestamp
      const ts = playbackStatus?.clippedTimestamp ?? playbackStatus?.currentTimestamp ?? 0;
      latest = sensorData || [];
      let latestSensor = {};
      for (let i = latest.length - 1; i >= 0; --i) {
        const entry = latest[i];
        if (!entry) continue;
        if ((entry.timestamp ?? 0) <= ts) { latestSensor = entry.sensor || {}; break; }
      }

      const tx = (latestSensor.gx ?? 0) * Math.PI / 180;
      const ty = (latestSensor.gy ?? 0) * Math.PI / 180;
      const tz = (latestSensor.gz ?? 0) * Math.PI / 180;

      tempEuler.current.set(tx, ty, tz, 'XYZ');
      tempQuat.current.setFromEuler(tempEuler.current);
      targetQuat = tempQuat.current;
    } else {
      // derive target Euler from sensor (degrees → radians)
      latest = sensorData?.at(-1)?.sensor || {};
      const tx = (latest.gx ?? 0) * Math.PI / 180; // todo: why?
      const ty = (latest.gy ?? 0) * Math.PI / 180;
      const tz = (latest.gz ?? 0) * Math.PI / 180;

      targetQuat = new THREE.Quaternion().setFromEuler(
        new THREE.Euler(tx, ty, tz, 'XYZ')
      );

    }

    // frame-rate independent interpolation factor
    const alpha = 1 - Math.exp(-SMOOTH_SPEED * delta);

    // slerp current quaternion toward target
    g.quaternion.slerp(targetQuat, alpha);
  });

  return (
    <group ref={groupRef}>
      <spotLight position={[0, 0, 0]} intensity={1.2} angle={0.4} penumbra={0.5} castShadow />
      <gridHelper args={[size, divisions, '#FFF', '#FFF']} rotation={[0, 0, 0]} />
      <axesHelper args={[Math.min(size, 10)]} />
    </group>
  );
}

export default function R3FCanvas() {
  return (
    <div className="fixed top-0 left-0 w-full h-full z-0 pointer-events-none">
      <Canvas shadows camera={{ position: [0, 0, 12], fov: 50 }}>
        <ambientLight intensity={0.6} />
        <directionalLight position={[5, 10, 5]} intensity={1} />
        <SceneGrid size={10} divisions={10} />
        
        <mesh position={[0, 0, 0]} castShadow receiveShadow>
          <sphereGeometry args={[4, 64, 64]} />
          <meshStandardMaterial color="#ffffff" metalness={0.2} roughness={0.6} />
        </mesh>
      </Canvas>
    </div>
  );
}