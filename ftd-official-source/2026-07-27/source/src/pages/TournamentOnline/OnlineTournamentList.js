import React, {useState, useEffect, useRef, useContext, useCallback} from 'react'
import { debounce, onEnter, getControlName} from '../functions/functions'
import { getName } from 'country-list';
import  Countdown from 'react-countdown'
import { useNavigate } from 'react-router-dom'
import { FixedSizeList } from "react-window"
import { useWindowSize } from '../../hooks/resize.hook'
import { AuthContext } from '../../context/AuthContext'
// import { UserContext } from '../../context/UserContext'
import { NavBar } from '../elements/navbar/NavBar'
import { CountryFlags } from '../elements/CountryFlags';
import { TimeControlTournament } from "../elements/SVG"
import { LockSVG, WOFSVG } from "../elements/SVG"
import './tournament.css'

// replace flags with XOT and time control
// add "starts in ..." 
// add time of start
export const OnlineTournamentList = () => {
    const {socket} = useContext(AuthContext)
    // const {isOnline} = useContext (UserContext)
    const listRef = useRef ()
    const unfilteredDataRef = useRef([])
    const scrollOffset = useRef(0)
    const reachedLimit = useRef(false)
    const requestedMore = useRef(false)
    const inputValueRef = useRef('')
    const [width, listWidth, rowHeight, rowHeightExpanded, height, offsetY, boardSize] = useWindowSize(listRef, false)
    const [tournamentList, setTournamentsList] = useState([])
    const [authorized, setAuthorized] = useState (false)
    const [inputValue, setInputValue] = useState (null)
    const history = useNavigate()
    const offset = 130
    const LIMIT = 25

    const newTournamentHandler = () => {
        history('/tournaments/create')  
    }

    const updateTournamentList = (list, id, fields, values) => {
        for (let i = 0; i < list.length; i++) {
            if(list[i].id === id) {
                for(let j = 0; j < fields.length; j++) {
                    list[i][fields[j]] = values[j]
                }
                return
            }
        }
    }

    useEffect(() => {
        unfilteredDataRef.current = []
        scrollOffset.current = 0
        reachedLimit.current = false
        socket.emit('get-online-tournaments', '', 0, LIMIT, true)
        socket.on('online-authorized', val => {
            setAuthorized(val)
        })
        socket.on('online-tournaments-list', (list) => {
            requestedMore.current = false
            unfilteredDataRef.current = scrollOffset.current > 0 ? [...unfilteredDataRef.current, ...list] : [...list]
            setTournamentsList([...unfilteredDataRef.current])
            reachedLimit.current = list.length < LIMIT 
        })
        socket.on('online-tournaments-update', (id, fields, values) => {
            updateTournamentList(unfilteredDataRef.current, id, fields, values)
            setTournamentsList([...unfilteredDataRef.current])
        })
        socket.on('online-tournament-added', (tournament) => {
            const exists = unfilteredDataRef.current.some(t => t.id === tournament.id)
            if (!exists) {
                unfilteredDataRef.current = [tournament, ...unfilteredDataRef.current]
                setTournamentsList([...unfilteredDataRef.current])
            }
        })
        return () => {
            socket.off('online-tournaments-list')
            socket.off('online-tournaments-update')
            socket.off('online-tournament-added')
            socket.off('online-authorized')
        }
    }, []) //isOnline

    useEffect (() => {
        if (inputValue !== null) {
            unfilteredDataRef.current = []
            reachedLimit.current = false
            scrollOffset.current = 0
            socket.emit('get-online-tournaments', inputValue, 0, LIMIT)
        }
    },[inputValue]) 

    const handleSearch = (event) => { 
        let value = event.target.value.toLowerCase().toString()
        if (value !== null) { 
            setInputValue(value)
            scrollOffset.current = 0
            return
        }      
    }

    function onItemsRendered ({visibleStartIndex, visibleStopIndex}) {
        if(visibleStopIndex === unfilteredDataRef.current.length - 1) {
            if (unfilteredDataRef.current.length >= LIMIT && !requestedMore.current) { 
                handleScroll(unfilteredDataRef.current.length)
                requestedMore.current = true
            }
        }
        
    }
    
    const debouncedSearch = useCallback(debounce(handleSearch),[])
    
    const handleScroll = (length) => {
        if(!reachedLimit.current) {
            scrollOffset.current = length
            socket.emit('get-online-tournaments', inputValue, scrollOffset.current, LIMIT)
        }
    }

    const renderer = ({ days, hours, minutes, seconds, completed }) => {
        if (completed) {
          // Render a completed state
            return <></>;
        } else {
            const hh = (hours < 10) ? "0" + hours : hours;
            const mm = (minutes < 10) ? "0" + minutes : minutes;
            const ss = (seconds < 10) ? "0" + seconds : seconds;
            if (days > 0) return <span>{` (in ${days}d ${hh}h:${mm}m)`}</span>;
            if (hours > 0) return <span>{` (in ${hh}h:${mm}m)`}</span>;
            return <span>{` (in ${mm}m:${ss}s)`}</span>;
        }
    };

    const Row = ({index, style}) => {
        
        const id = tournamentList[index].id
        const currentRound = tournamentList[index].current_round
        const rounds = tournamentList[index].rounds
        const players = tournamentList[index].players
        const isTd = tournamentList[index].td
        const system = tournamentList[index].pairing_system
        const xot = tournamentList[index].xot
        const lateReg = tournamentList[index].late_reg
        const status = tournamentList[index].status // 1=created, 2=cancelled, 3=started, 4=finished
        const isPrivate = tournamentList[index].is_private
        const isVerified = tournamentList[index].is_verified
        
        // Check if late registration is available
        const isRR = system === 'Round Robin' || system === 'Double Round Robin'
        const lateRegAvailable = !isRR && currentRound > 0 && !!lateReg && currentRound <= lateReg && status !== 4 && status !== 2
        
        let startDate, endDate, startTime, endTime
        const fullName = tournamentList[index].name
        const timeInfo = `${tournamentList[index].time_control} | ${tournamentList[index].increment} ${xot? 'XOT' : ''}`
        const tdNick = tournamentList[index].td_nick
        const optionsDate = {year: 'numeric', month: 'long', day: 'numeric'}
        const optionsTime = {hour: '2-digit', minute: '2-digit'}
        const beforeStart = new Date(tournamentList[index].start_date) - new Date()
        
        if(tournamentList[index].end_date) { // same date should compare the date not time difference!
            startDate = new Date(tournamentList[index].start_date).toLocaleDateString(undefined, optionsDate)
            startTime = new Date(tournamentList[index].start_date).toLocaleTimeString(undefined, optionsTime)
            endDate = new Date(tournamentList[index].end_date).toLocaleDateString(undefined, optionsDate)
            endTime = new Date(tournamentList[index].end_date).toLocaleTimeString(undefined, optionsTime)
        } else {
            // console.log('date:', new Date(tournamentList[index].start_date))
            // console.log('now:', new Date())
            startDate = new Date(tournamentList[index].start_date).toLocaleDateString(undefined, optionsDate)
            startTime = new Date(tournamentList[index].start_date).toLocaleTimeString(undefined, optionsTime)
        } 
        
        return (
            <div style = {style}>
                <div className = 'table-row otb' id = {index} key = {id} onClick={()=> {history(`/tournaments/${id}`)}} >
                    <div className='tc-icon-container' style={{height: '75px', maxHeight: '75px', width: '80px', borderBottomLeftRadius: '0.5rem', borderTopLeftRadius: '0.5rem', backgroundColor:'#1f1e1b', display: 'flex', flexDirection: 'column', alignItems: 'center', padding: '0 0 0 0' }}>
                        <div style={{flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center'}}>
                            <TimeControlTournament timeControl = {tournamentList[index].time_control}/>
                        </div>
                        <div style={{fontSize: '11px', color: '#aca9a9', whiteSpace: 'nowrap', lineHeight: 1, marginBottom: '5px'}}>{timeInfo}</div>
                    </div>
                    
                    <div className="otb-info-container">
                        <div className="otb-info-name">{fullName}</div>
                        <div className="otb-info-text">
                            <span>{`${startDate} ${startTime}`}</span>
                            {beforeStart > 0 ?
                                <Countdown
                                    date = {new Date(tournamentList[index].start_date)}
                                    renderer = {renderer}
                                />  
                            : <></> }
                            </div>
                        {status === 2 ?
                            <div className="otb-info-text" style={{color: '#ff6b6b'}}>{`Cancelled, ${players} players registered`}</div> :
                        status === 4 || tournamentList[index].end_date ? 
                            <div className="otb-info-text">{`Finished, ${rounds} rounds, ${players} players`}</div> :
                        beforeStart > 0 && currentRound == 0 ?
                            <div className="otb-info-text">
                                {`Not started, ${rounds === 0 ? system : rounds + ' rounds'}, ${players} players`}
                                <span style={{color: '#86a94b', fontWeight: 500}}>{' • Registration'}</span>
                            </div> :
                        currentRound < 100 ?
                            <div className="otb-info-text">
                                {`Round ${currentRound} out of ${rounds}, ${players} players`}
                                {lateRegAvailable && <span style={{color: '#86a94b', fontWeight: 500}}>{' • Late Registration'}</span>}
                            </div> :
                            <div className="otb-info-text">{`Finals, ${players} players`}</div>
                        }
                        {tdNick && <div className="otb-info-text" style={{color: '#7a7774', fontSize: '11px'}}>{`Created by ${tdNick}`}</div>}
                        
                    </div>
                    {isTd && !tournamentList[index].end_date ? <div className='can-edit'/> : <></>}
                    {isVerified && <div className='private-lock-icon' title='WOF Verified tournament' style={isPrivate ? {right: '22px'} : {}}><WOFSVG active={true} size={16}/></div>}
                    {isPrivate ? <div className='private-lock-icon' title='Private tournament'><LockSVG size={14} color='#7a7774'/></div> : <></>}
                    
                </div>
            </div>
        )
    }

    return (
        <div style = {{'--global-width': width + 'px'}}> 
            <NavBar isHome = {false} text = 'Tournaments' ></NavBar>
            <div className = 'search-contaner' style = {{marginTop: '55px', borderRadius: '0.5rem', justifyContent: 'left', marginLeft: '1%', maxWidth: Math.min(490, width * 0.98) + 'px' }}>
                <input 
                    className = 'search-pair' 
                    type = "text" 
                    maxLength="100" 
                    placeholder = 'Filter by name, player or creator' 
                    style = {{paddingLeft: '10px'}}
                    onChange = {event => debouncedSearch(event)} 
                    onKeyUp = {event => onEnter(event)}/> 
            </div>      
            <div className = 'table-container' style = {{'--offset': '90px', 'WebkitOverflowScrolling': 'touch'}}>
                <FixedSizeList 
                    className="list otb"
                    height = {Math.max(0, authorized ? Math.min(tournamentList.length * 85, height-offset) : Math.min(tournamentList.length * 85, height-offset + 40))}
                    itemCount = {tournamentList.length}
                    itemSize = {85}
                    width = {Math.min(listWidth, 500 * 0.98)}
                    onItemsRendered = {onItemsRendered}
                    ref = {listRef}
                >
                    {Row}
                </FixedSizeList> 
            </div>   
            {authorized ? <button className = "btn-new-tournament" onClick = {newTournamentHandler}>{'New Tournament'}</button> : <></>} 
        </div>
    )
}

export default OnlineTournamentList
