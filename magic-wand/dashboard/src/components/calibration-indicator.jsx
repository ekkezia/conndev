import { useIMU } from "../contexts/IMUContext";
import { useEffect, useState } from "react";

export default function CalibrationIndicator() {
  const { calibrationState } = useIMU();
  const { calibrated, data } = calibrationState || {};

  const hasTL =
    data?.topLeftPitch != null &&
    data?.topLeftRoll != null;

  const hasBR =
    data?.bottomRightPitch != null &&
    data?.bottomRightRoll != null;

  const [showFinal, setShowFinal] = useState(false);

  // When fully calibrated → show green for 2s
  useEffect(() => {
    if (hasTL && hasBR) {
      setShowFinal(true);
      const timer = setTimeout(() => {
        setShowFinal(false);
      }, 2000);
      return () => clearTimeout(timer);
    }
  }, [hasTL, hasBR]);

  // Nothing yet → TL pulsing red
  if (!hasTL) {
    return (
      <CornerDot position="tl" color="red" pulse />
    );
  }

  // TL done → TL green, BR pulsing red
  if (hasTL && !hasBR) {
    return (
      <>
        <CornerDot position="tl" color="green" />
        <CornerDot position="br" color="red" pulse />
      </>
    );
  }

  // Both calibrated → show both green for 2s
  if (hasTL && hasBR && showFinal) {
    return (
      <>
        <CornerDot position="tl" color="green" />
        <CornerDot position="br" color="green" />
      </>
    );
  }

  return null;
}

function CornerDot({ position, color, pulse = false }) {
  const base =
    "absolute w-4 h-4 rounded-full pointer-events-none";

  const colorClass =
    color === "green"
      ? "bg-orange-mango-shine"
      : "bg-pink-rose-punch";

  const pulseClass = pulse ? "animate-pulse" : "";

  const style =
    position === "tl"
      ? { top: 20, left: 20 }
      : { bottom: 20, right: 20 };

  return (
    <div
      style={style}
      className={`${base} ${colorClass} ${pulseClass}`}
    />
  );
}