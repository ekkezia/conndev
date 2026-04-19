import clsx from "clsx";

export default function MenuButton({ className, onClick, children }) {
  return (
    <div className={clsx("rounded-full shadow-center bg-cola-brown backdrop-filter-blur-md shadow-cream-soda/50 w-12 h-12 fixed cursor-pointer z-50 pointer-events-auto", className)}
      onClick={onClick}>
      {children}
    </div>
  );
}
