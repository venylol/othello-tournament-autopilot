import { useEffect, useCallback, useRef } from 'react'
import { useNavigate } from 'react-router-dom'

export const useGameRedirect = (socket) => {
    const rawNavigate = useNavigate()
    const navigateRef = useRef(rawNavigate)
    navigateRef.current = rawNavigate

    const handleMatch = useCallback((tableId) => {
        console.log('match redirect', tableId)
        navigateRef.current(`/game/${tableId}#start`)
    }, [])

    useEffect(() => {
        socket.on('match', handleMatch)
        return () => {
            socket.off('match', handleMatch)
        }
    },[socket, handleMatch])
}