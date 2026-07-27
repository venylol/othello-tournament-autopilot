
import { useState } from "react";

export const useSwipe = (socket, id, gameId, byPlayer, setNextGameReq) => {
    // console.log(socket, id, gameId)
    const [touchStart, setTouchStart] = useState(null)
    const [touchEnd, setTouchEnd] = useState(null)

    // the required distance between touchStart and touchEnd to be detected as a swipe
    const minSwipeDistance = 100 

    const onTouchStart = (e) => {
        setTouchEnd(null) // otherwise the swipe is fired even with usual touch events
        setTouchStart(e.targetTouches[0].clientX)
    }

    const getNextGame = () => {
        setNextGameReq('left')
        socket.emit('get-next-game', id, gameId, byPlayer)
    }
    const getPrevGame = () => {
        setNextGameReq('right')
        socket.emit('get-prev-game', id, gameId, byPlayer)
    }

    const onTouchMove = (e) => setTouchEnd(e.targetTouches[0].clientX)

    const onTouchEnd = () => {
        if (!touchStart || !touchEnd) return
        const distance = touchStart - touchEnd
        const isLeftSwipe = distance > minSwipeDistance
        const isRightSwipe = distance < -minSwipeDistance
        if(isLeftSwipe) {
            getNextGame()
            return
        }
        if(isRightSwipe) {
            getPrevGame()
        }

    }

    return {
        onTouchStart,
        onTouchMove,
        onTouchEnd
    }
}
