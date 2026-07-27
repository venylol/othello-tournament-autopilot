import React, {useRef, useContext, useEffect, useState} from "react"
import { getName } from 'country-list';
import { FixedSizeList } from "react-window"
import { useWindowSize } from '../../hooks/resize.hook'
// import { UserContext } from '../../context/UserContext'
import { AuthContext } from '../../context/AuthContext'
import { TimeControl, MessageSVG } from "../elements/SVG"
import { PlayerButton } from "./PlayerButton"
import { CountryFlags } from "../elements/CountryFlags";
import { findImage } from "../functions/functions";


// Добавить логику приглашения
// playing: invite/watch/ do not disturb
// DM
// notifications
// realign controls with rating
export const PlayersList = ({data, control, isXot, setBtnLabel, setInvitation, invited, setInvited}) => {
    // console.log ('PlayersList', data, control, isXot)
    const listRef = useRef ()
    const {userId, socket, isAuthenticated} = useContext(AuthContext)
    // const {isPlaying, setIsPlaying, isOnline} = useContext (UserContext)
    const [timeControl, setTimeControl] = useState (control)
    const [controlName, setControlName] = useState (getControlName(control, isXot))
    const [xot, setXot] = useState (isXot)
    const [playersList, setPlayersList] = useState (data)
    const [width, listWidth, rowHeight, rowHeightExpanded, height, offsetY, boardSize] = useWindowSize(listRef, false)
    const offset = 175
    const listHeight = Math.min(data.length * rowHeight, height-offset)

    function controlType (timeControl) {
        if (timeControl === 1) return 'bullet'
        if (timeControl === 3 || timeControl === 5) return 'blitz'
        if (timeControl === 10 || timeControl === 15) return 'rapid'
        if (timeControl === 20) return 'classic'
    }

    function getControlName (timeControl, xot) {
        if (!xot) {
            if (timeControl === 1) return 'bullet'
            if (timeControl === 3 || timeControl === 5) return 'blitz'
            if (timeControl === 10 || timeControl === 15) return 'rapid'
            if (timeControl === 20) return 'classic'
        }
        if (timeControl === 1) return 'bullet_xot'
        if (timeControl === 3 || timeControl === 5) return 'blitz_xot'
        if (timeControl === 10 || timeControl === 15) return 'rapid_xot'
        if (timeControl === 20) return 'classic_xot'
        
    }

    function gameType (xot) {
        return xot ? 'XOT' : 'Classic'
    }

    useEffect (() => {
        setControlName(getControlName(timeControl, xot))
    }, [xot, timeControl])

    useEffect (() => {
        sortPlayers(timeControl, xot, data)
    },[xot, timeControl, data, userId])

    const changeControl = (e) => {
        setTimeControl (prev => 
            prev === 20 ? 1 :
            prev === 1 ? 5 :
            prev === 3 || prev === 5 ? 10 : 
            prev === 10 || 15 ? 20 
            : 1
        )
        
    }

    const changeGameType = (e) => {
        setXot (prev => prev === 0 ? 1 : 0)
    }

    const sortPlayers = (timeControl, xot, data) => {
        const controlName = getControlName(timeControl, xot)
        if(!data) {
            setPlayersList(data)
            return
        }
        const sortedPlayers = data.sort((a, b) => 
            a.id === userId ? -1 : b.id === userId ? 1
            : a['rating_' + controlName] > b['rating_' + controlName] ? -1 : 1)
        setPlayersList(sortedPlayers)
    }

    const watchHandler = (index) => {
        console.log ('watch', playersList[index].playing)
        socket.emit('watch', playersList[index].playing)
    }

    const showSettings = (index) => {
        // console.log ('invite', playersList[index])
        setInvitation(playersList[index].nick)
        setBtnLabel('Invite')
    }

    const cancelInvitation = (index) => {
        setInvited(null)
        socket.emit('cancel-invite')
    }
    
    const Row = ({index, style}) => {
        const key = playersList[index][0]
        const dan = playersList[index]['dan_' + controlName] >= 0 ? `${playersList[index]['dan_' + controlName] + 1}D` : `${- playersList[index]['dan_' + controlName]}K`
        const rating = playersList[index][['rating_' + controlName]]
        const country = playersList[index].country
        const countryName = getName(country)
        const playing = playersList[index].playing
        // const verified = data[index].verified
        const isInvited = playersList[index].nick === invited
        
        return (
            <div style = {style}>
                <div className = 'table-row' id = {index} key = {key} >
                    <div className = 'pictures-container'>
                        <div className = 'avatar-medium'>
                            <img className = 'photo' src ={findImage(playersList[index].nick)} alt = "avatar"/>
                        </div>
                        {/* <div className = "small-text ping">ping</div> */}
                        <div className="flag-container"> 
                            <CountryFlags countryName = {countryName} countryCode = {country}></CountryFlags>
                        </div>
                        <div className="table-text">{playersList[index].nick}</div>
                    </div>                        
                        <div className="table-text rating" title = {controlName}>{`${rating} ${dan}`}</div>
                    {playersList[index].id !== userId && userId ? 
                    <div className = 'players-button-container'>
                        <PlayerButton 
                            watchHandler = {watchHandler}
                            showSettings = {showSettings}
                            cancelInvitation = {cancelInvitation}
                            index = {index}
                            playing = {playing}
                            isInvited = {isInvited}
                            isAuthenticated = {isAuthenticated}
                        />
                        {/* <button onClick = {playing ? () => watchHandler(index) : () => showSettings (index)} 
                        style = {isInvited ? {{backgroundColor: '#8b0100'}} : {{}}}>{playing ? 'Watch' : 'Invite'}</button> */}
                        <MessageSVG/>
                    </div>
                    : <div className = 'players-button-container'/>}
                    <div className = 'players-button-container'/>
                </div>
            </div>
        )
    }
    
    if (!playersList) {return}
    return (
        <>
            <div className = 'filters-container' >
                <div className="text-filters">Displayed Rating:</div>
                <div className = 'filters' onClick = {changeControl}>
                    <div className="control-container" >
                        <TimeControl timeControl = {timeControl} inRow = {false}/>
                        <div className = 'small-text'>{controlType(timeControl)}</div>
                    </div>
                </div> 
                <div className = 'filters xot'>
                    <div className = 'xot-button'>
                        <button onClick = {changeGameType} >{gameType(xot)}</button>
                    </div>
                </div> 
                
                
            </div> 
            <div className = 'table-container' style = {{'--offset': '120px'}}>
                <FixedSizeList 
                    className="list"
                    height={listHeight}
                    itemCount={playersList.length}
                    itemSize = {rowHeight}
                    width={Math.min(listWidth, 500 * 0.98)}
                    ref = {listRef}
                >
                    {Row}
                </FixedSizeList>              
            </div>
        </>
    )
}
