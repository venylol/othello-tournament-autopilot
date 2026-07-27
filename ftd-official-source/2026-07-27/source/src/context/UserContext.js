import {createContext} from 'react'

function noop() {}
export const UserContext = createContext({
    nick: null,
    isOnline: false,
    setIsOnline: noop,
    setIsPlaying: noop,
    settings: null,
    setSettings: noop,
    chatOpened: false,
    typing: false,
    setChatOpened: noop,
    setTyping: noop,
    setNotificationsOpen: noop,
    notificationsOpen: false,
    messages: null,
    setMessages: noop,
    isFullScreen: null,
    isFirefox: null,
    isMobile: null,

})

// game: null,
// challenge: null,
// tournament: null,
// color: null,
    