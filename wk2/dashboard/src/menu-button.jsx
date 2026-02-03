import clsx from "clsx";

export default function MenuButton({ className, onClick, children }) {
  return (
    <div className={clsx("rounded-full shadow-xl bg-black/80 backdrop-filter-blur-md shadow-gray-100/50 w-12 h-12 fixed cursor-pointer z-1", className)} 
      onClick={onClick}>
      {children}
    </div>
  );
}