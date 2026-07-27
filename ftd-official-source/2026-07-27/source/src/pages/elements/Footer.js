import React, {useContext, useEffect, useRef, useState} from "react"
import { UserContext } from '../../context/UserContext'
// import { LayoutContext } from '../../context/LayoutContext'
import { useNavigate } from 'react-router-dom'
import { Settings } from './Settings'
import { Viewers } from './Viewers'
import { Chat } from './Chat'
import { EditButton } from './EditButton'
import  Resign  from "../../assets/grey_flag.png"

export const Footer = ({isGame, resign, viewers, setViewers, isPlayer, changeEditMode, newGameFlag, isTournament}) => {
    const {nick, isOnline, isPlaying, typing, isMobile} = useContext(UserContext)
    // const {isMobile} = useContext(LayoutContext)
    const [pressed, setPressed] = useState()
    const hideRef = useRef()
    const tournamentFlag = isPlayer && isTournament

    useEffect(() => {
        hideRef.current.style.height = typing && isMobile ? '0px' : '50px'
    },[typing, isMobile])

    if (isGame) return (
        <div className = 'footer' ref = {hideRef}>    
            <Settings setPressed = {setPressed} pressed = {pressed}/>
            <Chat setPressed = {setPressed} pressed = {pressed}/>
            <Viewers setPressed = {setPressed} pressed = {pressed} viewers = {viewers} setViewers = {setViewers}/>
            {!tournamentFlag ?
                <div className="game-footer-container">
                    {typing && isMobile ? <></> :
                    <>
                    {isPlayer && !isTournament ?
                        <div className = 'game-footer resign' onClick = {resign}>
                            <img  src = { Resign } alt = 'resign' title = 'resign'/>
                            <label className = 'game-footer-label'>Resign</label>
                        </div>
                    : !isPlayer ?
                        <EditButton changeEditMode = {changeEditMode} newGameFlag = {newGameFlag}/>
                    : <></>}
                    </>
                    }
            </div> : <></>
            }
        </div>
    )
    return (
        <>
        </>
    )
}
