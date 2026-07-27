
import React, {useRef, useEffect} from 'react'


export const MatchHistory = ({gameHistory, hideFooter}) => {
    const matchRef = useRef(null)
    

    useEffect(() => {
        if(!matchRef.current) return
        matchRef.current.scrollLeft = matchRef.current.scrollLeft + 5000
        // console.log(gameHistory)
    }, [gameHistory])

    if (hideFooter) {
        return(<></>)
    }
    return (
    <>
    {gameHistory?.length > 0 ?
        
        <div className='game-history'>
            <div className='match-score'>{gameHistory.reduce((acc, val) => acc + val)} : {gameHistory.length - gameHistory.reduce((acc, val) => acc + val)}</div>
            <div className ='history-cont' ref = {matchRef}> 
            {gameHistory.map( (val, idx) => 
                <span key = {idx} className = {val === 0? 'history-loss' : val === 1 ? 'history-win' : 'history-draw'}>
                    {val === 0.5 ? String.fromCodePoint(0x00BD) : val}
                </span>
            )}
            </div> 
        </div>
            
    : <div className='game-history'></div>}
    </>
    )
}

            