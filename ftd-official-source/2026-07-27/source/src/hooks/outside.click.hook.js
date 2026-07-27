import { useEffect } from "react";

export const useOutsideAlerter = (ref, ref2, setLabel = null, setOpened) => {
  useEffect(() => {
    function handleClickOutside(event) {
        // console.log(ref.current.contains(event.target), ref.current.style.bottom)
        if (ref.current && !ref.current.contains(event.target) && !ref2?.current?.contains(event.target) && parseInt(ref.current.style.bottom) > 0 && setLabel) {
          ref.current.style.bottom = '-' + (ref.current.scrollHeight + 10) + 'px'
          setLabel (prev => prev === 'Confirm' ? 'Change Settings' : 'New Game')
          return
        }
        if (ref.current && !setLabel && !ref.current.contains(event.target) && !ref2.current.contains(event.target)) {
          setOpened(false)
        }
    }

    document.addEventListener("mousedown", handleClickOutside);
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
    };
  }, [ref]);
}
