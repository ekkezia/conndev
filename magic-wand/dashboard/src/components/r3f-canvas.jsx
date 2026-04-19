import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { useIMU } from '../contexts/IMUContext';
import * as THREE from 'three';
import { useRef, useEffect, useState } from 'react';
import * as dat from 'dat.gui';

const MAX_ANGLE = Math.PI / 4; // ±45°
// ALPHA is a per-frame blend factor (0..1). We'll convert it to a
// frame-rate independent interpolation factor using delta time.
const ALPHA = 0.08;

// ---------------- LIGHTING ----------------
function Lighting({ lightRef, lightPos, targetRef }) {
  const groupRef = useRef();

  useEffect(() => {
    if (lightRef.current && targetRef.current) {
      lightRef.current.target = targetRef.current;
    }
  }, [lightRef, targetRef]);

  return (
    <group
      ref={groupRef}
      position={[lightPos.x, lightPos.y, lightPos.z]}
      rotation={[Math.PI / 2, 0, 0]}
    >
      <spotLight
        ref={lightRef}
        intensity={40}
        angle={0.8}
        penumbra={0.5}
        distance={50}
        castShadow
      />
      <mesh position={[0, 2, 0]}>
        <sphereGeometry args={[0.12, 12, 12]} />
        <meshBasicMaterial color="#ffff66" />
      </mesh>
    </group>
  );
}

// ---------------- PLANE CONTROLLER ----------------
function PlaneController({
  planeRef,
  rotationDebugRef,
  overrideRotation,
  guiRotation
}) {
  const { sensorData, playbackMode, playbackStatus, setPlaybackStatus } = useIMU();

  const anglesRef = useRef({ x: 0, y: 0, z: 0 });
  const lastTimeRef = useRef(performance.now());
  const playbackIndexRef = useRef(null);
  const playbackAccumRef = useRef(0); // ms accumulator for 20ms steps

  const tempEuler = useRef(new THREE.Euler());
  const tempQuat = useRef(new THREE.Quaternion());

  useFrame((state, delta) => {
    const plane = planeRef.current;
    if (!plane) return;

    let targetQuat;

    if (overrideRotation) {
      tempEuler.current.set(
        guiRotation.x,
        guiRotation.y,
        guiRotation.z,
        'XYZ'
      );
      tempQuat.current.setFromEuler(tempEuler.current);
      targetQuat = tempQuat.current;
    } else if (playbackMode) {
      // Play through filtered samples from the sample at-or-before currentTimestamp
      // up to the end of the filtered range. Advance one sample every 20ms.
      const clipTs = playbackStatus?.clippedTimestamp ?? Infinity;
      const curTs = playbackStatus?.currentTimestamp ?? Infinity;

      const filtered = (sensorData || []).filter(d => d.timestamp <= clipTs);
      if (filtered.length === 0) return;

      // find latest sample <= current timestamp
      let startIdx = -1;
      for (let i = filtered.length - 1; i >= 0; i--) {
        if (filtered[i].timestamp <= curTs) {
          startIdx = i;
          break;
        }
      }
      if (startIdx === -1) return;

      // init playback index
      if (
        playbackIndexRef.current == null ||
        playbackIndexRef.current < startIdx
      ) {
        playbackIndexRef.current = startIdx;
        playbackAccumRef.current = 0;
      }

      // advance every 20ms
      playbackAccumRef.current += delta * 1000;
      while (
        playbackAccumRef.current >= 20 &&
        playbackIndexRef.current < filtered.length - 1
      ) {
        playbackIndexRef.current++;
        playbackAccumRef.current -= 20;
      }

      const sample =
        filtered[Math.min(playbackIndexRef.current, filtered.length - 1)]
          ?.sensor || {};
      // setPlaybackStatus((status) => ({
      //   ...status,
      //   currentTimestamp: playbackIndexRef.current,
      // })); ???
      console.log('playing sample w timestamp:', filtered[playbackIndexRef.current]?.timestamp);

      // ⚠️ DO NOT integrate gyro here
      // assume gx / gy are already angles OR pre-integrated offline

      const alpha = 0.98; // 0.95-0.99 (higher = trust gyro more, less = trust accel more)
      const accelRoll = Math.atan2(sample.ay, Math.sqrt(sample.ax * sample.ax + sample.az * sample.az)) * (180 / Math.PI);
      const accelPitch = Math.atan2(-sample.ax, Math.sqrt(sample.ay * sample.ay + sample.az * sample.az)) * (180 / Math.PI);

      const x = THREE.MathUtils.clamp(sample.gx * alpha + accelRoll * (1 - alpha), -MAX_ANGLE, MAX_ANGLE);
      const y = THREE.MathUtils.clamp(sample.gy * alpha + accelPitch * (1 - alpha), -MAX_ANGLE, MAX_ANGLE);
      const z = sample.heading; // heading from compass/magnetometer calculation

      tempEuler.current.set(
        THREE.MathUtils.degToRad(x || 0),
        THREE.MathUtils.degToRad(y || 0),
        THREE.MathUtils.degToRad(z || 0),
        'XYZ'
      );
      tempQuat.current.setFromEuler(tempEuler.current);
      targetQuat = tempQuat.current;

    } else {
      const latest = sensorData?.at(-1)?.sensor || {};

      // treat raw gx/gy as angles (degrees) — convert to radians
      // Euler expects radians
      const alpha = 0.98; // 0.95-0.99 (higher = trust gyro more, less = trust accel more)
      const accelRoll = Math.atan2(latest.ay, Math.sqrt(latest.ax * latest.ax + latest.az * latest.az)) * (180 / Math.PI);
      const accelPitch = Math.atan2(-latest.ax, Math.sqrt(latest.ay * latest.ay + latest.az * latest.az)) * (180 / Math.PI);

      const x = THREE.MathUtils.clamp(latest.gx * alpha + accelRoll * (1 - alpha), -MAX_ANGLE, MAX_ANGLE);
      const y = THREE.MathUtils.clamp(latest.gy * alpha + accelPitch * (1 - alpha), -MAX_ANGLE, MAX_ANGLE);
      const z = latest.heading; // heading from compass/magnetometer calculation

      tempEuler.current.set(
        THREE.MathUtils.degToRad(x || 0),
        THREE.MathUtils.degToRad(y || 0),
        THREE.MathUtils.degToRad(z || 0),
        'XYZ'
      );

      // quat is unitless
      tempQuat.current.setFromEuler(tempEuler.current);
      targetQuat = tempQuat.current;
    }

    // convert ALPHA (per-frame) to a delta-time-independent factor
    // t = 1 - (1 - ALPHA)^(delta * 60)
    const t = 1 - Math.pow(1 - ALPHA, delta * 60);
    plane.quaternion.slerp(targetQuat, t);

    // -------- DEBUG EXPORT (NO PREPROCESSING) --------
    if (rotationDebugRef.current) {
      rotationDebugRef.current.eulerDeg = {
        x: tempQuat.current.x * (180 / Math.PI),
        y: tempQuat.current.y * (180 / Math.PI),
        z: tempQuat.current.z * (180 / Math.PI),
      };
      rotationDebugRef.current.quat = {
        x: tempQuat.current.x,
        y: tempQuat.current.y,
        z: tempQuat.current.z,
        w: tempQuat.current.w,
      };
    }

  });

  return null;
}

// ---------------- DEBUG UI ----------------
function RotationDebug({ rotationDebugRef }) {
  const [, force] = useState(0);

  useEffect(() => {
    const id = setInterval(() => force(v => v + 1), 100);
    return () => clearInterval(id);
  }, []);

  const d = rotationDebugRef.current;

  return (
    <div
      style={{
        position: 'fixed',
        bottom: 12,
        left: 12,
        padding: '8px 10px',
        fontFamily: 'monospace',
        fontSize: 12,
        whiteSpace: 'pre',
        background: 'rgba(0,0,0,0.6)',
        color: '#0f0',
        zIndex: 9999,
        pointerEvents: 'none',
      }}
    >
{`Euler (deg)
x: ${d.eulerDeg.x.toFixed(2)}
y: ${d.eulerDeg.y.toFixed(2)}
z: ${d.eulerDeg.z.toFixed(2)}

Quaternion
x: ${d.quat.x.toFixed(3)}
y: ${d.quat.y.toFixed(3)}
z: ${d.quat.z.toFixed(3)}
w: ${d.quat.w.toFixed(3)}`}
    </div>
  );
}

// ---------------- MAIN CANVAS ----------------
export default function R3FCanvas() {
  const planeRef = useRef();
  const lightRef = useRef();

  const rotationDebugRef = useRef({
    eulerDeg: { x: 0, y: 0, z: 0 },
    quat: { x: 0, y: 0, z: 0, w: 1 },
  });

  const [cameraPos, setCameraPos] = useState({ x: 0, y: 0, z: 8 });
  const [lightPos, setLightPos] = useState({ x: 0, y: 10, z: 10 });
  const [overrideRotation, setOverrideRotation] = useState(false);
  const [planeRotation, setPlaneRotation] = useState({ x: 0, y: 0, z: 0 });

  return (
    <div className="absolute inset-0">
      <Canvas
        shadows
        camera={{ position: [cameraPos.x, cameraPos.y, cameraPos.z] }}
      >
        <ambientLight intensity={0.05} />

        <Lighting
          lightRef={lightRef}
          lightPos={lightPos}
          targetRef={planeRef}
        />

        <mesh ref={planeRef} castShadow receiveShadow>
          <planeGeometry args={[120, 96, 64, 64]} />
          <meshStandardMaterial color="white" />
        </mesh>

        <PlaneController
          planeRef={planeRef}
          rotationDebugRef={rotationDebugRef}
          overrideRotation={overrideRotation}
          guiRotation={planeRotation}
        />
      </Canvas>

      <RotationDebug rotationDebugRef={rotationDebugRef} />
    </div>
  );
}
