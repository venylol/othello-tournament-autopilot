import {useState} from 'react'

export const useGame = () => {
    const [tableId, setTableId] = useState(false)
    const [opponent, setOpponent] = useState(false)

    return {tableId, setTableId, opponent, setOpponent}
}