import React, {useEffect, useContext} from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { AuthContext } from '../context/AuthContext'

export const Invitation = () => {
    const {socket, userId} = useContext(AuthContext) //socket,
    const tableId = useParams().id // parseInt
    const history = useNavigate()

    useEffect(() => {
        if (!userId || !socket) return
        socket.emit('matched', tableId)
        const handleInviteMatch = (tableId) => {
            history(`/game/${tableId}#start`)
        }
        socket.on ('match', handleInviteMatch)
        socket.on('navigate', (url) => {
            history(url)
        })
        return () => {
            socket.off('match', handleInviteMatch)
            socket.off('navigate')     
        }
        
    },[socket, userId])

}

export default Invitation