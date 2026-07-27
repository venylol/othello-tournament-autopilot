import {useState, useRef, useEffect, useContext} from 'react'
import { LayoutContext } from '../../../context/LayoutContext'
import { UserContext } from '../../../context/UserContext'
import { AuthContext } from '../../../context/AuthContext'
import { HamburgerSVG, EditButtonSVG, CopyButtonSVG, AnalyzeSVG } from '../../elements/SVG'
import { useParams } from 'react-router-dom'
// import { useFullScreen } from '../../hooks/fullscreen.hook'

export const Analysis = ({showAnalysis}) => {
    const [opened, setOpened] = useState(null)
    const buttonRef = useRef (null)
    const { typing, isMobile } = useContext(UserContext)
    const { id, gameId } = useParams()


    useEffect (() => {
        setOpened(false)
        return
    }, [gameId, id])

    const clickHandler = () => {
        setOpened(prev => !prev)
        showAnalysis()
    }

    useEffect (() => {
        if (!buttonRef.current) {return}
            buttonRef.current.style.animation = 'none' 
            buttonRef.current.style.left = '50%'
            buttonRef.current.style.top = '50%'
            requestAnimationFrame(() => {
                buttonRef.current.style.animation = 'ripples-toggle 0.3s ease-in forwards'
            })
    }, [opened])

    if(typing && isMobile) return (<></>)

    return(
        <>
            <div className="game-footer-container" onClick = {clickHandler}>
                {typing && isMobile ? <></> :
                    <div className = {`game-footer analyze ${opened? 'active' : ''}`} title = 'analyze'>
                        <AnalyzeSVG opened = {opened} hidden = {typing && isMobile}/>
                        <label className = {`game-footer-label ${opened? 'active' : ''}`}>Analyze</label>
                    </div>
                }
                {opened? 
                <div className="ripple-container toggle-footer">
                    <span ref = {buttonRef} className = 'ripple'></span> 
                </div> : <></>}
            </div>
        </>
    )
}
