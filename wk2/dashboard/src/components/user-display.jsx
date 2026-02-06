import clsx from "clsx";
import MenuButton from "../menu-button";
import { useState } from "react";

export default function UserDisplay({ user}) {
    const [isOpen, setIsOpen] = useState(false);

  return (
        <MenuButton className={clsx("top-4 left-4", isOpen ? 'w-fit h-fit rounded-xl' : 'w-12 h-12 rounded-full')} onClick={() => setIsOpen(!isOpen)}>
        {
            isOpen &&
            <div className="flex flex-col min-w-[80vw] h-[50vh] max-w-[80vw] text-white">
                {user.id}
            </div>
        }
        </MenuButton>
  );
}