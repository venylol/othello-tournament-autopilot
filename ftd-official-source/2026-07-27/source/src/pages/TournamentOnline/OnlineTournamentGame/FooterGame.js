import React, {useContext, useEffect, useRef, useState} from "react"
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
import { Settings } from '../../elements/Settings'
// import { useOutsideAlerter } from '../../../hooks/outside.click.hook'

export const FooterGameOTB = ({isLive, isPlayer, isTD, showAnalysis, viewers, setViewers, changeEditMode, transcript, rotateBoard, enterAsTranscript, pasteTranscript, allowedToStream, scoreByTranscript}) => {
    // console.log(isLive, viewers, transcript)
    const {token, userId, login, logout, isAuthenticated, socket} = useContext(AuthContext)
    // const {nick, isOnline, isPlaying, typing} = useContext(UserContext)
    const {isMobile} = useContext(LayoutContext)
    const {chatOpened, setChatOpened, typing, setTyping} = useContext(UserContext)
    const [pressed, setPressed] = useState()
    const {id, gameId} = useParams()
    const hideRef = useRef()
    


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
            <div className="game-footer-container" onClick = {enterAsTranscript} >
                <div className = {`game-footer`} title = 'input as transcript'>
                    <InputTranscript/>
                    <label className = {`game-footer-label`}>Input</label>
                </div>
            </div>
        </div>
    )
}
