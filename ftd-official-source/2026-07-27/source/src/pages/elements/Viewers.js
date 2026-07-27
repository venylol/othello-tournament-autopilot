import {useState, useRef, useEffect, useContext} from "react"
import { AuthContext } from '../../context/AuthContext'
import { UserContext } from '../../context/UserContext'
import { CountryFlags } from "./CountryFlags"
import { findImage } from "../functions/functions"

const ViewersSVG = ({opened, hidden}) => {
    if (hidden) return (<></>)
    return(
        <svg viewBox="64 64 896 896" focusable="false" fill= {!opened ? "#aca9a9" : 'white'}>
            <path d="M858.5 763.6a374 374 0 00-80.6-119.5 375.63 375.63 0 00-119.5-80.6c-.4-.2-.8-.3-1.2-.5C719.5 518 760 444.7 760 362c0-137-111-248-248-248S264 225 264 362c0 82.7 40.5 156 102.8 201.1-.4.2-.8.3-1.2.5-44.8 18.9-85 46-119.5 80.6a375.63 375.63 0 00-80.6 119.5A371.7 371.7 0 00136 901.8a8 8 0 008 8.2h60c4.4 0 7.9-3.5 8-7.8 2-77.2 33-149.5 87.8-204.3 56.7-56.7 132-87.9 212.2-87.9s155.5 31.2 212.2 87.9C779 752.7 810 825 812 902.2c.1 4.4 3.6 7.8 8 7.8h60a8 8 0 008-8.2c-1-47.8-10.9-94.3-29.5-138.2zM512 534c-45.9 0-89.1-17.9-121.6-50.4S340 407.9 340 362c0-45.9 17.9-89.1 50.4-121.6S466.1 190 512 190s89.1 17.9 121.6 50.4S684 316.1 684 362c0 45.9-17.9 89.1-50.4 121.6S557.9 534 512 534z"/>
        </svg>
    )
}

export const Viewers = ({setPressed, pressed, viewers, setViewers}) => { 
    const [opened, setOpened] = useState(false)
    // const [viewers, setViewers] = useState([])
    // const [viewersCount, setViewersCount] = useState(0)
    const viewersRef = useRef(null)
    const {socket, isMobile} = useContext(AuthContext)
    const {typing} = useContext (UserContext)

    const Viewer = ({nick, country, rating, dan}) => {

        return (
            <div className="viewer" key = {nick}>
                    <div className = 'viewer-container'>
                        <div className = 'avatar-small'>
                            <img className = 'photo' src ={findImage(nick)} alt = "avatar"/>
                        </div>
                        <div className="flag-container"> 
                            <CountryFlags countryCode = {country}></CountryFlags>
                        </div>
                        <div className="table-text split-row">{nick}</div>
                        <div className="table-text split-row rating">{`${rating} ${dan}`}</div>
                    </div>                        
                        
                
                </div>
        )
    }

    const viewersHandler = () => {
        setOpened(prev => !prev)
    }

    useEffect (() => {
        if (pressed !== 'viewers') {
            setOpened(false)
        }
    }, [pressed])

    useEffect (()=> {
        // console.log('useEffect on viewers')
        socket.on('viewer', nicks => {
            setViewers(nicks)
        })
        return () => {socket.off('viewer')}
    },[socket]) //could be that info sent to client earlier than it was mounted? :(



    // useEffect (()=> {
    //     // console.log('hi vis', viewersRef.current.style.visibility, viewersRef.current.style.bottom)
    //     if(opened) {
            
    //         viewersRef.current.style.display = 'block'          
    //         return
    //     } else {
    //         viewersRef.current.style.display = 'none'
    //     }     
    // },[opened])

    useEffect (() => {
        if(opened) {
            setPressed('viewers')
            viewersRef.current.style.bottom = '50px'
            viewersRef.current.style.height = '143px'
            viewersRef.current.style.borderBottomWidth = '1px'
        } else {
            viewersRef.current.style.bottom = '0px'
            viewersRef.current.style.height = '0px'
            viewersRef.current.style.borderBottomWidth = '0px'
        }
    },[viewersRef.current?.style, opened])

    // if (typing && isMobile) return (<></>)

    return (
        <>
        <div className="game-footer-container">
                <div className = {`game-footer viewers ${typing && isMobile ? 'hidden' : ''}`} title = 'viewers' onClick= {viewersHandler}>
                    {/* {typing && isMobile ? <></> : <>  */}
                    <ViewersSVG opened = {opened} hidden = {typing && isMobile}/>
                    {viewers?.length > 0 ? <span className='viewers-counter'>{viewers?.length}</span> : <></>}
                    <label className = {`${typing && isMobile ? 'hidden' : 'game-footer-label'} ${opened? 'active' : ''}`}>Viewers</label>
                    {/* </>} */}
                </div>
            </div>
        <div className = 'viewers-extended' ref = {viewersRef}>
            {viewers? viewers.map(viewer => (
                <Viewer key = {viewer.nick} nick = {viewer.nick} country = {viewer.country} rating = {viewer.rating} dan = {viewer.dan >= 0 ? `${viewer.dan + 1}D` : `${- viewer.dan}K`}></Viewer>
            )) : <></>
        }
        </div>

        </>
    )
}

