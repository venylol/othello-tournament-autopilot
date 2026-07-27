import React, {forwardRef, useContext, useEffect, useRef, useState} from 'react'
import { getName } from 'country-list';
import { useNavigate } from 'react-router-dom'
import { findImage } from "../functions/functions"
import { Timer } from "./Timer"
import { UserContext } from '../../context/UserContext'
import { LayoutContext } from '../../context/LayoutContext'
import { CountryFlags } from './CountryFlags';


export const PlayerInfo = forwardRef(({ nickName, rating, timer, color, score, country, clickHandler, timerTick, turn, avatar, withTimer = true, isStreamer = false, evals, isTournament, isDisconnected = false, profileNick = null}, ref) => { //, ticked, setTicked, timerTick
    const playerInfoRef = useRef()
    const infoRef = useRef()
    const [y, setY] = useState()
    const navigate = useNavigate()

    let countryName
    if (country) countryName = getName(country)

    const {chatOpened, typing, isMobile, isFullScreen} = useContext(UserContext)
    const {keyboard, gameBoard, totalHeight } = useContext(LayoutContext)

    useEffect(() => {
        if (!playerInfoRef.current) return
        if(chatOpened && timerTick) {
            playerInfoRef.current.style.opacity = 0.25;
        }
        if(!chatOpened && timerTick) {
            playerInfoRef.current.style.opacity = 1;
        }
    }, [chatOpened])

    useEffect(() => {
        // console.log('hello')
        
        if (!infoRef.current || !isMobile) return
        if(typing && !timerTick) {
            infoRef.current.style.height = '0px';
            infoRef.current.style.visibility = 'hidden';
            return
        }
        if(typing && timerTick) {
            infoRef.current.style.height = '0px';
            playerInfoRef.current.style.visibility = 'hidden';
            return
        }
        
        if(!typing && !timerTick) {
            setTimeout(() => {
                infoRef.current.style.height = '35px';
                infoRef.current.style.visibility = 'visible';
            return
            },50)  
        }

        if(!typing && timerTick) {
            setTimeout(() => {
                infoRef.current.style.height = '35px';
                playerInfoRef.current.style.visibility = 'visible';
            return
            },50)
        }
        
    }, [typing, isMobile])

    useEffect (()=> {
        if (infoRef.current && timerTick) {
            setY(infoRef.current.getBoundingClientRect().y) //we have a problem here on other browsers
        }
        
    },[keyboard, isFullScreen, totalHeight])


    

    // if(chatOpened) {
    //     console.log('chat is opened', ref.current)
    // }
    //${chatOpened && timerTick? 'dim': ''
    return (
        <div ref = {infoRef} className = 'playerinfo-container-bottom'>
            <div  ref = {timerTick? playerInfoRef : null} className = {timer === undefined && !evals? `playerinfo-container no-timer` : 'playerinfo-container'} style = {{'maxWidth': gameBoard + 'px'}}>
                
                <div className = {`score-replayer-${color}`}> 
                    {!isStreamer ? <p className = {`disc-count-${color}`}>{score}</p> : <></>}
                </div>

                {avatar ? 
                <div className = 'avatar-medium'>
                    <img className = 'photo' src ={findImage(nickName)} alt = "avatar"/>
                </div>  
                : <></>}              
                {clickHandler ? <div className = {timer === undefined && !withTimer && !evals? `table-text nick no-timer clickable` : 'table-text nick clickable'} onClick = {clickHandler}>{`${nickName}`}</div> : 
                profileNick ? <div className = {timer === undefined && !withTimer && !evals? `table-text nick no-timer clickable` : 'table-text nick clickable'} onClick = {() => navigate(`/profile/${profileNick}`)}>{`${nickName}`}</div> :
                <div className = {timer === undefined && !withTimer && !evals? `table-text nick no-timer` : 'table-text nick'}>{`${nickName}`}</div>}
                {rating ? <div className = 'game-text rating'>{`(${rating})`}</div> : <></>}
                
                
                <div className = "flag-container" style = {{marginTop: 0}}>
                    <CountryFlags countryName = {countryName} countryCode = {country}></CountryFlags>
                </div>

                {isDisconnected && (
                    <div className = "flag-container" style = {{marginTop: 0}}>
                    <svg className="disconnected-icon" width="16" height="14" viewBox="0 0 20 16" fill="none" xmlns="http://www.w3.org/2000/svg">
                        <rect x="1" y="11" width="4" height="5" rx="1" fill="#ff4444" />
                        <rect x="7" y="7" width="4" height="9" rx="1" fill="#555" />
                        <rect x="13" y="3" width="4" height="13" rx="1" fill="#555" />
                    </svg>
                    </div>
                )}
            </div>
            {withTimer ? 
            <Timer timer = {timer} color = {color} turn = {turn} timerTick= {timerTick} y = {y} ref = {ref}/> 
            : <></>}
            {/* {evals ?
            <div className = {`time-container ${color}`}>
                <span className = {`time-text ${color}`}>{evals.discsLost}</span>
                 {evals.average}
            </div>
            : <></>} */}
        </div>
    )
})

//ticked = {ticked} setTicked = {setTicked} timerTick= {timerTick}