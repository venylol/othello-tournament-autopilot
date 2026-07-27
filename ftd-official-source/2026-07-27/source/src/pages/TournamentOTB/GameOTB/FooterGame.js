import React, {useContext, useEffect, useRef, useState} from "react"
import { toast } from 'react-toastify'
import { AuthContext } from '../../../context/AuthContext'
import { UserContext } from '../../../context/UserContext'
import { LayoutContext } from '../../../context/LayoutContext'
import { useNavigate, useParams } from 'react-router-dom'
// import { HamburgerSVG, EditButtonSVG, CopyButtonSVG, AnalyzeSVG } from '../../elements/SVG'
// import { Viewers } from './Viewers'
import { SwapSVG, CopyButtonSVG, PasteSVG, InputTranscript } from '../../elements/SVG'
import { Chat } from './Chat'
import { MoreOptions } from './MoreOptions'
import { Analysis } from './Analysis'
import { EditButton } from './EditButton'
import { Settings } from './../../elements/Settings'
// import { useOutsideAlerter } from '../../../hooks/outside.click.hook'

export const FooterGameOTB = ({isLive, isPlayer, isTD, isXot, gameResult, showAnalysis, viewers, setViewers, changeEditMode, transcript, rotateBoard, enterAsTranscript, pasteTranscript, allowedToStream, scoreByTranscript}) => {
    // console.log(isLive, isTD, isPlayer, isXot, scoreByTranscript)
    const {token, userId, login, logout, isAuthenticated, socket} = useContext(AuthContext)
    // const {nick, isOnline, isPlaying, typing} = useContext(UserContext)
    const {isMobile} = useContext(LayoutContext)
    const {chatOpened, setChatOpened, typing, setTyping} = useContext(UserContext)
    const [pressed, setPressed] = useState()
    const {id, gameId} = useParams()
    const hideRef = useRef()
    
    // For XOT tournaments TD/Assistant can replace the starting position of a single game.
    // Allowed when: no result entered yet (gameResult is null/undefined), or the game is "locked"
    // by transcript (scoreByTranscript > -1) but no result was confirmed yet.
    const noResult = gameResult === null || gameResult === undefined
    const canRegenerateXot = !!(isTD && isXot && noResult && (scoreByTranscript === -1))

    const confirmRegenerateXot = () => {
        toast.dismiss()
        socket.emit('regenerate-xot-game', id, gameId)
    }

    const RegenerateXotToast = () => (
        <div className="notification-nav">
            <span>This will erase the current game transcript and generate a new XOT starting position. Continue?</span>
            <button onClick = {confirmRegenerateXot}>Confirm</button>
        </div>
    )

    const newXotPosition = () => {
        if (!canRegenerateXot) return
        if (transcript && transcript.length > 16) {
            toast.dismiss()
            toast.warn(RegenerateXotToast())
            return
        }
        socket.emit('regenerate-xot-game', id, gameId)
    }


    useEffect(() => {
        hideRef.current.style.height = typing && isMobile ? '0px' : '50px'
    },[typing, isMobile])

    useEffect (() => {
        setPressed(null)
    }, [gameId])
    
    // change the condition for isLive and write logic for 
    if (!isLive || (!isPlayer && !isTD)) return (
        <div className = 'footer' ref = {hideRef}>
            <Settings setPressed = {setPressed} pressed = {pressed} noChat = {true} />            
            <Chat setPressed = {setPressed} pressed = {pressed}/>
            <Analysis showAnalysis = {showAnalysis}/>
            <EditButton changeEditMode = {changeEditMode}/>
            {canRegenerateXot ?
                <div className="game-footer-container" onClick = {newXotPosition} >
                    <div className = {`game-footer`} title = 'generate new XOT starting position'>
                        <InputTranscript/>
                        <label className = {`game-footer-label`}>New Position</label>
                    </div>
                </div>
            : <></>}
            <MoreOptions 
                setPressed = {setPressed} 
                pressed = {pressed} 
                transcript = {transcript} 
                rotateBoard = {rotateBoard}
                allowedToEdit = {allowedToStream}
                enterAsTranscript = {enterAsTranscript}
                pasteTranscript = {pasteTranscript}
                scoreByTranscript = {scoreByTranscript}
                isTD = {isTD}
            />
        </div>
    )
    // if(!isLive || (!isPlayer && !isTD))
    return (
        <div className = 'footer' ref = {hideRef}>
            <div className="game-footer-container" onClick = {rotateBoard} >
                <div className = {`game-footer`} title = 'rotate'>
                    <SwapSVG/>
                    <label className = {`game-footer-label`}>Rotate</label>
                </div>
            </div>
            {!isPlayer ? <Chat setPressed = {setPressed} pressed = {pressed}/> : <></>}
            <div className="game-footer-container" onClick = {pasteTranscript} >
                <div className = {`game-footer more`} title = 'paste text transcript'>
                    <PasteSVG/>
                    <label className = {`game-footer-label`}>Paste</label>
                </div>
            </div>
            {isXot && !isTD ? <></> :
            canRegenerateXot?
                <div className="game-footer-container" onClick = {newXotPosition} >
                    <div className = {`game-footer`} title = 'generate new XOT starting position'>
                        <InputTranscript/>
                        <label className = {`game-footer-label`}>New XOT</label>
                    </div>
                </div>
            :
                <div className="game-footer-container" onClick = {enterAsTranscript} >
                    <div className = {`game-footer`} title = 'input as transcript'>
                        <InputTranscript/>
                        <label className = {`game-footer-label`}>Input</label>
                    </div>
                </div>
            }
        </div>
    )
}
