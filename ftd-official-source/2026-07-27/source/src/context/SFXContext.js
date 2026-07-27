import {createContext} from 'react'

function noop() {}
export const SFXContext = createContext({
    playBullet: noop,
    playMove: noop,
    playTick: noop,
    playScream: noop,
    playGong: noop,
    playDavid: noop,
    playTournamentFinish: noop,
    playWithdraw: noop
})