import clsx from "clsx";
import { useIMU } from "../contexts/IMUContext";

export default function GridHelperToggle({ className }) {
  const { enableHelper, setEnableHelper } = useIMU();

  return (
    <button
      type="button"
      onClick={() => setEnableHelper((prev) => !prev)}
      className={clsx(
        "px-2 py-1 rounded border text-xs",
        enableHelper
          ? "bg-white text-black border-white"
          : "bg-black/40 text-white border-white/30",
        className
      )}
    >
      <span className={!enableHelper ? "line-through hover:no-underline" : "no-underline hover:line-through"}>
        GRID
      </span>
    </button>
  );
}
