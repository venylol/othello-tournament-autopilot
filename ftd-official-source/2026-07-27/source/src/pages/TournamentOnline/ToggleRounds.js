import React, {useEffect, useRef, useState, useContext} from "react"
import { AuthContext } from '../../context/AuthContext'
import { getFullRoundName } from '../functions/functions'
import { TournamentTimer } from './TournamentTimer'; 

export const ToggleRounds = ({ pressed, roundsArr, id, currentRound, nextRoundStartTime, setNextRoundStartTime }) => {
    // console.log(pressed, roundsArr, id)
    const { socket } = useContext(AuthContext)
    const roundsRef = useRef (null)
    const buttonRef = useRef (null)
    const [coordinates, setCoordinates] = useState([])

    const toggleHandler = (event) => {
        console.log(id, event.target.value)
        socket.emit('get-online-rounds', id, event.target.value)
        roundsRef.current.scrollLeft += event.target.value > roundsArr.length / 2 ? -120 : 120
        setCoordinates([event.clientX - event.target.offsetLeft, '2vh'])   
    }

    useEffect (() => {
        if (!buttonRef.current) {return}
            buttonRef.current.style.animation = 'none' 
            buttonRef.current.style.top = '15px'
            requestAnimationFrame(() => {
                buttonRef.current.style.animation = 'ripples-toggle-rounds 0.5s ease-in forwards'
            })
    }, [coordinates, buttonRef.current])

    return (
        <>
            <div className = 'toggle-round-contaner' ref = {roundsRef}>
                {roundsArr?.map((row, idx) => ( 
                        
                    <button key = {row.round} value = {row.round} className = 'toggle-round' disabled = {pressed === row.round ? true : false } onClick = {toggleHandler}>{row.round_name}
                        {pressed === row.round ? 
                        <div className="ripple-container toggle-animation">
                            <span ref = {buttonRef} className = 'ripple'></span> 
                        </div> : <></>
                        }
                    </button>   
                ))}
            </div>
            {currentRound && nextRoundStartTime? 
               <>
                    <TournamentTimer
                        currentRound = {currentRound} 
                        nextRoundStartTime = {nextRoundStartTime}
                        setNextRoundStartTime = {setNextRoundStartTime}
                        >
                    </TournamentTimer>
                </> :
            pressed && pressed === getFullRoundName(roundsArr, pressed) ? <div className = 'big-text'>{`Pairing of Round ${pressed}`}</div> : 
            pressed ? <div className = 'big-text'>{`${getFullRoundName(roundsArr, pressed)}`}</div> :
            <div className = 'big-text'/>}
        </>

    )
}