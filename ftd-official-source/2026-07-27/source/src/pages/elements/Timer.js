import React, {forwardRef, useEffect, useState, useContext, useRef} from 'react'
import Countdown from 'react-countdown';
import { UserContext } from '../../context/UserContext'
import { LayoutContext } from '../../context/LayoutContext'

export const Timer = forwardRef(({timer, color, turn, timerTick, y}, ref) => {
    const TimerRef = useRef()
    const {totalHeight, height} = useContext(LayoutContext)
    const {settings, chatOpened, typing, isMobile, isFullScreen}  = useContext (UserContext)    
    const [dateProp, setDateProp] = useState(timer ? Date.now() + timer : Date.now())
    const [active, setActive] = useState('')
    const [soundPlayed, setSoundPlayed] = useState(false)

    const clockSFX = () => {
        // console.log (turn, color, soundPlayed, timerTick)
        if(turn === color && !soundPlayed && timerTick && settings.sound) {
            return (function() {
                setSoundPlayed(true)
                timerTick()
            })()
        }
    }

    useEffect (() => {
        if(timer === undefined) {
            setDateProp (Date.now())
        } else {
            setDateProp (Date.now() + timer)
        }   
    },[timer])

    useEffect(() => {

        if (!timerTick) return
        const rect = TimerRef.current.getBoundingClientRect()
        if (timerTick && typing && chatOpened && isMobile && !isFullScreen) {
            // console.log('y:', y, 'totalHeight:', height, 'rect.height:',rect.height, 'bottom:', y - height + rect.height + 1.5)
            TimerRef.current.style.bottom = y - height + rect.height + 1.5 + 'px'
            return
        }

        if (timerTick && typing && chatOpened && isMobile && isFullScreen) {
            // console.log('y:', y, 'totalHeight:', height, 'rect.height:',rect.height, 'bottom:', y - height + rect.height + 1.5)
            TimerRef.current.style.bottom = y - height + rect.height + 1.5 + 'px'
            return
        }
        
        if (timerTick && !typing && chatOpened || timerTick && typing && chatOpened && !isMobile) {
            TimerRef.current.style.bottom = y - height + 51.5 + rect.height + 'px' 
            return
        }
        TimerRef.current.style.bottom = '0px'
    },[y, totalHeight, chatOpened, typing, isMobile, isFullScreen])

    const onStop = () => {
        setSoundPlayed(false)
    }

    useEffect(() => {
        color === turn ? setActive('active') : setActive('')
    },[turn, color])

    const Clock = () => {
        return (
            <div className = 'hourglass'>
                <svg viewBox="64 64 896 896" focusable="false" fill = {color === 'black' ? 'white' : 'black'}>
                <path d="M512 64C264.6 64 64 264.6 64 512s200.6 448 448 448 448-200.6 448-448S759.4 64 512 64zm0 820c-205.4 0-372-166.6-372-372s166.6-372 372-372 372 166.6 372 372-166.6 372-372 372z"/>
                <path d="M686.7 638.6L544.1 535.5V288c0-4.4-3.6-8-8-8H488c-4.4 0-8 3.6-8 8v275.4c0 2.6 1.2 5 3.3 6.5l165.4 120.6c3.6 2.6 8.6 1.8 11.2-1.7l28.6-39c2.6-3.7 1.8-8.7-1.8-11.2z"/>
                </svg>
            </div>
        )
    }

    const renderer = ({ minutes, seconds, milliseconds, completed }) => {
        if (completed) {
            setSoundPlayed(false)
            return <span className={`timer-text ${color}`}>00:00.0</span>
        } else if (minutes === 0 && seconds < 10) { 
            clockSFX()
            return (
            <span className={`timer-text ${color}`}>
                <span >00:{String("0" + seconds).slice(-2)}.</span>
                <span className = 'ms'>{String(Math.floor(milliseconds/100)).slice(-2)}</span>
            </span>
            )
        } else {
            return <span className={`timer-text ${color}`}>
                {String("0" + minutes).slice(-2)}:{String("0" + seconds).slice(-2)}
                </span>;
        }
    };

    return (
            <div ref = {TimerRef} className = {`time-container ${color}`}> 
                {color === turn ? <Clock/> : <></>}
                <Countdown
                    date={dateProp}
                    renderer={renderer}
                    ref = {ref}
                    autoStart = {false}
                    intervalDelay={100}
                    precision={1}
                    onStop = {onStop}
                />
                <div className = {`timer-overlay ${active}`}></div>
        </div>
    )
})
