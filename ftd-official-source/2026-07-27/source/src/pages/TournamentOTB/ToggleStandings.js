import React, {useEffect, useRef, useState, useContext} from "react"
import { AuthContext } from '../../context/AuthContext'

export const ToggleStandings = ({ pressed, roundsArr, totalRounds, id }) => {
    // console.log(pressed, roundsArr, totalRounds, id)
    const { socket } = useContext(AuthContext)
    const roundsRef = useRef (null)
    const buttonRef = useRef (null)
    const [coordinates, setCoordinates] = useState([])

    const toggleHandler = (event) => {
        socket.emit('get-standings-otb', id, event.target.value)
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
            {pressed && pressed < totalRounds? <div className = 'big-text'>{`After Round ${pressed}`}</div> : 
            pressed ? <div className = 'big-text'>{`${totalRounds === pressed ? 'Final Standings' : 'Results'}`}</div> :
            <div className = 'big-text'/>}
        </>

    )
}