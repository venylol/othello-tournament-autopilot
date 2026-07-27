import {useState, useRef, useEffect, useContext} from 'react'
// import { LayoutContext } from '../../../context/LayoutContext'
import { UserContext } from '../../../context/UserContext'
import { AuthContext } from '../../../context/AuthContext'
import { useOutsideAlerter } from '../../../hooks/outside.click.hook'
import { HamburgerSVG, SwapSVG, CopyButtonSVG, Share, PasteSVG, InputTranscript, Unlock } from '../../elements/SVG'
import { useParams } from 'react-router-dom'
// import { useFullScreen } from '../../hooks/fullscreen.hook'

export const MoreOptions = ({setPressed, pressed, transcript, rotateBoard, allowedToEdit, enterAsTranscript, pasteTranscript, scoreByTranscript, isTD}) => {
    // console.log(allowedToEdit, scoreByTranscript, isTD)
    // count number of options adjust total height
    // allowed to Edit - enter transcript / transcript mode
    // 

    const [opened, setOpened] = useState(false)
    const {id, gameId} = useParams() 
    const buttonRef = useRef (null)
    const optionsRef = useRef(null)
    const iconRef = useRef(null)
    const {chatOpened, setChatOpened, typing, setTyping, isMobile} = useContext(UserContext)
    const {socket} = useContext(AuthContext)
    useOutsideAlerter(optionsRef, iconRef, null, setOpened)

    const optionsNumber = allowedToEdit && transcript && isMobile ? 4 :
        allowedToEdit && transcript && !isMobile ? 5 :
        allowedToEdit && !transcript && isMobile ? 2 :
        (allowedToEdit && !transcript && !isMobile) || (!allowedToEdit && transcript) ? 3 : 4

    useEffect (() => {
        if (pressed !== 'more') {
            setOpened(false)
            return
        }
    }, [pressed])

    const clickHandler = () => {
        setOpened(prev => !prev)
        setPressed('more')
    }

    const pasteHandler = () => {
        pasteTranscript()
        setOpened(false)
    }

    const inputHandler = () => {
        enterAsTranscript()
        setOpened(false)
    }

    useEffect (() => {
        if(opened) {
            optionsRef.current.style.bottom = '50px'
            optionsRef.current.style.height = optionsNumber * 40 - 1 + 'px'
        } else if (optionsRef.current) {
            optionsRef.current.style.bottom = '0px'
            optionsRef.current.style.height = '0px'
        }
        if (!buttonRef.current || !opened) {return}
            buttonRef.current.style.animation = 'none' 
            buttonRef.current.style.left = '50%'
            buttonRef.current.style.top = '50%'
            requestAnimationFrame(() => {
                buttonRef.current.style.animation = 'ripples-toggle 0.3s ease-in forwards'
            })
    }, [opened, pasteTranscript, enterAsTranscript])

    const length = transcript ? transcript.length : 0

    function copyTextToClipboard () {
        if(navigator.clipboard) { 
            navigator.clipboard.writeText(transcript)
        }
    }

    function copyURL () {
        if(navigator.clipboard) { 
            navigator.clipboard.writeText(`https://www.flipthedisc.com/live/${id}/${gameId}`)
        }
    }

    const unlockGame = () => {
        socket.emit('unlock-game', id, gameId, transcript)
    }

    if (typing && isMobile) return (<></>)

    return(
        <>
            <div className="game-footer-container" onClick = {clickHandler} ref = {iconRef}>
                <div className = {`game-footer more ${opened? 'active' : ''}`} title = 'more'>
                    <HamburgerSVG opened = {opened} hidden = {typing && isMobile}/>
                    <label className = {`game-footer-label ${opened? 'active' : ''}`}>More</label>
                </div>
                {pressed === 'more' ? 
                <div className="ripple-container toggle-footer">
                    <span ref = {buttonRef} className = 'ripple'></span> 
                </div> : <></>
                }
            </div>

            <div className = 'options-extended' ref = {optionsRef}>
                {opened ?
                    <>
                    {transcript?.length > 0 ? 
                    <>
                        <button className = 'option' onClick = {copyTextToClipboard} disabled = {!length}>
                            <CopyButtonSVG transcript = {transcript}/>Copy Transcript</button>

                        <button className = 'option' onClick = {copyURL}>
                            <Share/>Share</button>
                    </> : <></>
                    }
                    {isTD && scoreByTranscript > -1 ?
                    <button className = 'option' style = {{gap: 5}} onClick= { unlockGame }>
                        <Unlock />Change Transcript</button>
                    : <></>
                    }
                    <button className = 'option' onClick= { rotateBoard }>
                        <SwapSVG />Rotate 90°</button>
                    
                    { allowedToEdit && !isMobile?
                        <>
                        <button className = 'option' onClick= { pasteHandler }>
                            <PasteSVG/>Paste text transcript</button>

                        <button className = 'option' onClick= { inputHandler }>
                            <InputTranscript />Input as transcript</button>
                        </> : <></>
                    }

                    { allowedToEdit && isMobile?
                        <>
                        <button className = 'option' onClick= { pasteHandler }>
                        <CopyButtonSVG />Paste text transcript</button>
                        </> : <></>
                    }

                    </> : <></>
                }   
            </div>
        </>
    )
}
