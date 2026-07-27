import React, {useRef, useState, useEffect} from "react"
import { findImage } from "../functions/functions"
import Countdown from 'react-countdown';
import CountUp from "react-countup"
import { TimeControl, Close, Share } from "./SVG"
import { useNavigate } from 'react-router-dom'

export const Modal = ({result, setResult, color, modalFlag, isPlayer, socket, isAuthenticated}) => { 

    const modalRef = useRef(null)
    const overlayRef = useRef(null)
    const [active, setActive] = useState('')
    const [rematch, setRematch] = useState(false)
    const [rematchTimer, setRematchTimer] = useState(false)
    const [playerColor, setPlayerColor] = useState(null)
    const [newGame, setNewGame] = useState(false)
    const history = useNavigate()
    

    useEffect (() => {
        if(result?.reason !== 'abandonment' && result?.reason !== 'disconnection') {
            setRematch(false)
            setNewGame(false)
        } else {
            setRematch(true)
        }
        setRematchTimer(false)
        socket.on ('rematch-offered', () => {
            setRematchTimer(true)
        })

        socket.on ('rematch-declined', () => {
            setRematchTimer(false)
            setRematch(true)
            setNewGame(false)
        })
        modalFlag ? setActive(' active') : setActive('')

        return () => {
            socket.off('rematch-offered')
            socket.off('rematch-declined')
        }
    }, [socket, modalFlag])

    useEffect(() => {
        if (active === ' active') {
            setPlayerColor(color)
            return
        }
        setTimeout(() => {
            setResult(null)
        },300)
    },[active])

    const onRematch = () => {
        setRematch(true)
        setRematchTimer(true)
        socket.emit('rematch')
    }

    const onClose = () => {
        setActive('')
        // decline rematch
    }
    const onTimeout = ({completed}) => {
        setRematch(true)
        setRematchTimer(false)
    }

    const findNewGame = () => {
        if(isAuthenticated) {
            setRematch(true)
            setRematchTimer(false)
            setNewGame(true)
            socket.emit('new game')
            history('/lobby')
            return
        }
        history('/login')
    }

    const gameAnalyis = (e) => {
        if (!result?.gameId) return
        history(`/replay/${result.gameId}`, {
            state: { autoAnalyze: false }
        })
    }

    const renderer = ({ seconds, completed }) => {
        if (!completed) {
            return <>{String(" " + seconds)}</>;
        }
    };

    return (  
        <>
        <div className = {`modal-container${active}`} ref = {modalRef}>
            {result ? 
            <>
                <div className= {`modal-result-cont ${result?.result === 0 ? 'res-draw' : (result?.result === 1 && playerColor === 'black' || result?.result === -1 && playerColor === 'white') ? 'res-win' : 'res-loss'}`}>
                    <div className = "modal-result">
                        <div className = "modal-icon" onClick = {onClose}>
                            <Close/>
                        </div>
                        <div>{result?.resultText}</div>
                        <div className = "modal-icon">
                            <Share/>
                        </div>
                    </div>
                    <div className = "modal-reason">{result?.reason}</div>
                </div>

                <div className = 'modal-avatar-container'>
                    <div className = 'avatar-large'>
                        <img className = 'photo' src ={findImage(result?.blackNick)} alt = "avatar"/>
                    </div>
                    
                    <div className = 'avatar-large'>
                        <img className = 'photo' src ={findImage(result?.whiteNick)} alt = "avatar"/>
                    </div>
                </div>

                <div className = 'modal-score-container'>
                    <div className = {`score-replayer-black ${result?.result === -1 ? 'lost' : result?.result === 1 ? 'won' : 'draw'}`}> 
                        <p className = {`disc-count-black`}>{result?.score}</p>
                    </div>
                    
                    <div className = {`score-replayer-white ${result?.result === 1 ? 'lost' : result?.result === -1 ? 'won' : 'draw'}`}> 
                        <p className = {`disc-count-white`}>{64-result?.score}</p>
                    </div>
                </div>

                <div className = 'modal-nick-container'>
                    <div className = 'nick-result'>{result?.blackNick}</div>
                    <div className = 'nick-result'>{result?.whiteNick}</div>
                </div>

                <div className="modal-control">{result?.control} rating</div>

                <div className = 'modal-rating-container'>
                    <div className = 'rating'>
                        <span>
                            <CountUp start = {result?.blackRating - result?.difBlackRating} end = {result?.blackRating} duration = {.5} delay = {.2}/>
                        </span>
                        <span className= {result?.difBlackRating > 0 ? 'plus' : result?.difBlackRating < 0 ? 'minus' : 'equal'}>{`${result?.difBlackRating}`}</span>
                    </div>
                    <TimeControl timeControl = {result?.timeControl} inRow = {false}/>
                    <div className = 'rating'>
                        <span>
                            <CountUp start = {result?.whiteRating - result?.difWhiteRating} end = {result?.whiteRating} duration = {.5} delay = {.2}/>
                        </span>
                        <span className= {result?.difWhiteRating > 0 ? 'plus' : result?.difWhiteRating < 0 ? 'minus' : 'equal'}>{`${result?.difWhiteRating}`}</span>
                    </div>
                </div>
                <div className="modal-buttons-container">
                <div className="modal-rematch-container">
                    <button className = 'modal-rematch-button' onClick = {onRematch} disabled = {rematch || !isPlayer} >Rematch
                        {/* {console.log('timer: ', rematchTimer, 'clicked:', rematch)} */}
                        {rematchTimer ? 
                            <Countdown 
                            date = {Date.now() + 30000}
                            renderer = {renderer}
                            onComplete = {onTimeout}
                            /> : <></>
                        }
                    </button>
                </div>
                    <button className = 'modal-button' onClick = {findNewGame} disabled = {newGame}>New Game</button>
                </div>
                <button className = 'modal-edit-button' onClick = {gameAnalyis} disabled = {!result?.gameId}>Analyze</button>
            </>
        : <></>}
        </div>
        
        <div className = {`${active}`} id='overlay' ref = {overlayRef}></div>
        </>
    )
}
