import {createContext} from 'react'

function noop() {}
export const GameContext = createContext({
    tableId: null,
    opponent: null,
    round: null, // Tournament round number - used to clear chat on new tournament games
    setTableId: noop,
    setOpponent: noop,
})

// game: null,
// challenge: null,
// tournament: null,
// color: null,