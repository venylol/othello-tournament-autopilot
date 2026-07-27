import {useState} from 'react'

export const useDisconnect = (socket) => {
    const [isOnline, setIsOnline] = useState(true)
    const [disconnectReason, setDisconnectReason] = useState(null)

    socket.on ('connect', () => {
        setIsOnline(true)
        setDisconnectReason(null)
    })

    socket.on ('disconnect', (reason) => {
        setIsOnline(false)
        setDisconnectReason(reason)
    })

    return {isOnline, setIsOnline, disconnectReason}
}

