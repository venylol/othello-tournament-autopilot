import React, {useContext, useEffect, useState} from "react"
import { Tables } from './Tables'
import { Watch } from './Watch'
import { Players } from './Players'
import { Filter } from './Filter'
import { AuthContext } from '../../../context/AuthContext'

export const FooterLobby = ({pressed, setPressed}) => {
    const {socket} = useContext(AuthContext)
    const [counters, setCounters] = useState({tables: 0, games: 0, players: 0})

    useEffect(() => {
        const onOnlineCount = data => {
            setCounters(prev => ({
                tables: data.tables ?? prev.tables,
                games: data.games ?? prev.games,
                players: data.lobbyCounter ?? prev.players
            }))
        }
        socket.on('online-count', onOnlineCount)
        return () => socket.off('online-count', onOnlineCount)
    }, [socket])

    return (
        <div className = 'footer' >    
            <Players setPressed = {setPressed} pressed = {pressed} count = {counters.players}/>
            <Tables setPressed = {setPressed} pressed = {pressed} count = {counters.tables}/>
            <Watch setPressed = {setPressed} pressed = {pressed} count = {counters.games}/>
            <Filter setPressed = {setPressed} pressed = {pressed}/>
        </div>
    )
}
