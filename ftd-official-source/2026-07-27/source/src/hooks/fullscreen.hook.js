import {useState, useEffect} from 'react'

export const useFullScreen = () => {
    const [isFullscreen, setIsFullscreen] = useState(false);
    // Watch for fullscreenchange
    useEffect(() => {
    function onFullscreenChange() {
        setIsFullscreen(Boolean(document.fullscreenElement));
    }
            
    document.addEventListener('fullscreenchange', onFullscreenChange);

    return () => document.removeEventListener('fullscreenchange', onFullscreenChange);
    }, []);

    return isFullscreen
}