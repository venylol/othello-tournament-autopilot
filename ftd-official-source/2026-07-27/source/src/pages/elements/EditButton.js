import {useState, useRef, useEffect, useContext} from 'react'
import { UserContext } from '../../context/UserContext'
import { EditButtonSVG } from './SVG'
// import { useParams } from 'react-router-dom'
// import { useFullScreen } from '../../hooks/fullscreen.hook'

export const EditButton = ({changeEditMode, newGameFlag}) => {
    const [opened, setOpened] = useState(false)
    const buttonRef = useRef (null)
    const {chatOpened, setChatOpened, typing, setTyping, isMobile} = useContext(UserContext)
    // const {socket, isAuthenticated} = useContext(AuthContext)
    // const { id, gameId } = useParams()

    const clickHandler = () => {
        setOpened(prev => !prev)
        changeEditMode()
    }

    useEffect (() => {
        // if(newGameFlag)
        setOpened(false)
        return
    }, [newGameFlag])

    useEffect (() => {
        if (!buttonRef.current) {return}
            buttonRef.current.style.animation = 'none' 
            buttonRef.current.style.left = '50%'
            buttonRef.current.style.top = '50%'
            requestAnimationFrame(() => {
                if (!buttonRef.current) return
                buttonRef.current.style.animation = 'ripples-toggle 0.3s ease-in forwards'
            })
    }, [opened])

    if(typing && isMobile) return (<></>)

    return(
        <>
            <div className="game-footer-container" onClick = {clickHandler}>
                {typing && isMobile ? <></> :
                    <div className = {`game-footer edit ${opened? 'active' : ''}`} title = 'edit'>
                        <EditButtonSVG opened = {opened} hidden = {typing && isMobile}/>
                        <label className = {`game-footer-label ${opened? 'active' : ''}`}>Edit</label>
                    </div>
                }
                {opened ? 
                <div className="ripple-container toggle-footer">
                    <span ref = {buttonRef} className = 'ripple'></span> 
                </div> : <></>
                }
            </div>
        </>
    )
}
