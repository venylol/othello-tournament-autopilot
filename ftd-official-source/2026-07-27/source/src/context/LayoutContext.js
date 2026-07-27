import {createContext} from 'react'

// function noop() {}
export const LayoutContext = createContext({
    // isMobile: null,
    width: null,
    height: null,
    gameBoard: null,
    fullBoard: null,
    totalHeight: null,
    keyboard: null,
    // isFullScreen: null,
    // isFirefox: null,

    // setIsMobile: noop,
    // setIsFullScreen: noop,
    // setSizes: noop
})
