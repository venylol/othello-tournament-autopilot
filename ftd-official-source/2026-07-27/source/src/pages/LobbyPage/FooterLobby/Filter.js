import {useState, useRef, useContext, useEffect} from "react"
// import { UserContext } from '../../context/UserContext'


const FilterSVG = ({opened}) => {
    return(
        <svg viewBox="64 64 896 896" focusable="false" fill= {!opened ? "#aca9a9" : 'white'}>
            <path d="M880.1 154H143.9c-24.5 0-39.8 26.7-27.5 48L349 597.4V838c0 17.7 14.2 32 31.8 32h262.4c17.6 0 31.8-14.3 31.8-32V597.4L907.7 202c12.2-21.3-3.1-48-27.6-48zM603.4 798H420.6V642h182.9v156zm9.6-236.6l-9.5 16.6h-183l-9.5-16.6L212.7 226h598.6L613 561.4z">
            </path>
        </svg>
    )
}

export const Filter = ({setPressed, pressed}) => {
    // const {settings, setSettings} = useContext (UserContext)     // hook???
    const [opened, setOpened] = useState(false)
    const [clicked, setClicked] = useState(false)
    const buttonRef = useRef (null)

    const settingsHandler = () => {
        setOpened(prev => !prev)
        setClicked(prev => !prev)     
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

    return (
        <>
        <div className="game-footer-container" onClick= {settingsHandler}>
        <div className="ripple-container toggle-footer">
            <div className = {`game-footer ${opened? 'active' : ''}`} title = 'filter' >
                <FilterSVG opened = {opened}/>
                <label className = {`game-footer-label ${opened? 'active' : ''}`}>Filter</label>
            </div>
            {clicked ? <span ref = {buttonRef} className = 'ripple'></span> : <></>}
            </div>
        </div>
        </>
    )
}



