import React, {useState, useEffect, useRef, useContext, useCallback} from 'react'
import { debounce, onEnter } from '../functions/functions'
import { getName } from 'country-list';
import { useNavigate } from 'react-router-dom'
import { FixedSizeList } from "react-window"
import { useWindowSize } from '../../hooks/resize.hook'
import { AuthContext } from '../../context/AuthContext'
// import { UserContext } from '../../context/UserContext'
import { NavBar } from '../elements/navbar/NavBar'
import { CountryFlags } from '../elements/CountryFlags';
import './otb.css'

export const OTBTournamentList = () => {
    const {socket} = useContext(AuthContext)
    // const {isOnline} = useContext (UserContext)
    const listRef = useRef ()
    const unfilteredDataRef = useRef([])
    const scrollOffset = useRef(0)
    const reachedLimit = useRef(false)
    const requestedMore = useRef(false)
    const activeTabRef = useRef('live')
    const isInitialLoad = useRef(true)
    // const inputValueRef = useRef('')
    const [width, listWidth, rowHeight, rowHeightExpanded, height, offsetY, boardSize] = useWindowSize(listRef, false)
    const [tournamentList, setTournamentsList] = useState([])
    const [authorized, setAuthorized] = useState (false)
    const [inputValue, setInputValue] = useState (null)
    const [activeTab, setActiveTab] = useState('live')
    const [dataLoaded, setDataLoaded] = useState(false)
    const history = useNavigate()
    const offset = 170
    const LIMIT = 25

    const newTournamentHandler = () => {
        history('/live/create')  
    }

    const handleTabSwitch = (tab) => {
        if (tab === activeTabRef.current) return
        activeTabRef.current = tab
        setActiveTab(tab)
        unfilteredDataRef.current = []
        scrollOffset.current = 0
        reachedLimit.current = false
        requestedMore.current = false
        setTournamentsList([])
        setDataLoaded(false)
        socket.emit('get-otb-tournaments', inputValue || '', 0, LIMIT, false, tab)
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
        // console.log('isOnline', isOnline, socket)
        // if (!isOnline) {
        //     async function getFromIdb() {
        //         const tournaments = await getTournaments()
        //         // console.log(tournaments)
        //         setTournamentsList(tournaments)
        //     }
        //     getFromIdb()
        // }
        unfilteredDataRef.current = []
        scrollOffset.current = 0
        reachedLimit.current = false
        socket.emit('get-otb-tournaments', '', 0, LIMIT, true, 'live')
        socket.on('otb-authorized', val => {
            setAuthorized(val)
        })
        socket.on('otb-tournaments-list', (list) => {
            requestedMore.current = false
            unfilteredDataRef.current = scrollOffset.current > 0 ? [...unfilteredDataRef.current, ...list] : [...list]
            setTournamentsList([...unfilteredDataRef.current])
            reachedLimit.current = list.length < LIMIT 
            if (isInitialLoad.current && list.length === 0 && activeTabRef.current === 'live') {
                isInitialLoad.current = false
                activeTabRef.current = 'upcoming'
                setActiveTab('upcoming')
                unfilteredDataRef.current = []
                scrollOffset.current = 0
                reachedLimit.current = false
                socket.emit('get-otb-tournaments', '', 0, LIMIT, false, 'upcoming')
                return
            }
            isInitialLoad.current = false
            setDataLoaded(true)
        })
        socket.on('otb-tournaments-update', (id, fields, values) => {
            updateTournamentList(unfilteredDataRef.current, id, fields, values)
            setTournamentsList([...unfilteredDataRef.current])
        })
        return () => {
            socket.off('otb-tournaments-list')
            socket.off('otb-tournaments-update')
            socket.off('otb-authorized')
        }
    }, []) //isOnline

    useEffect (() => {
        if (inputValue !== null) {
            unfilteredDataRef.current = []
            reachedLimit.current = false
            setDataLoaded(false)
            socket.emit('get-otb-tournaments', inputValue, scrollOffset.current, LIMIT, false, activeTabRef.current)           
        }

        socket.on('updated-list', () => { 
            unfilteredDataRef.current = []
            socket.emit('get-otb-tournaments', inputValue, 0, scrollOffset.current + LIMIT + 1, false, activeTabRef.current)
            
        })
        return () => {
            socket.off('updated-list')
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
            socket.emit('get-otb-tournaments', inputValue, scrollOffset.current, LIMIT, false, activeTabRef.current)
        }
    }

    const Row = ({index, style}) => {
        
        const id = tournamentList[index].id
        const name = tournamentList[index].name
        const country = tournamentList[index].country_code
        const countryName = getName(country)
        const currentRound = tournamentList[index].current_round
        const rounds = tournamentList[index].rounds
        const players = tournamentList[index].players
        const isTd = tournamentList[index].td
        const system = tournamentList[index].pairing_system
        const gamesCount = tournamentList[index].games_count
        let startDate, endDate
        let sameDate
        const options = {year: 'numeric', month: 'long', day: 'numeric'}
        
        if(tournamentList[index].end_date) { // same date should compare the date not time difference!
            const startDateRaw = new Date(tournamentList[index].start_date)
            const endDateRaw = new Date(tournamentList[index].end_date)
            const offset = startDateRaw.getTimezoneOffset()
            const sDate = new Date(startDateRaw.getTime() - (offset*60*1000)).toISOString().split('T')[0]
            const eDate = new Date(endDateRaw.getTime() - (offset*60*1000)).toISOString().split('T')[0]
            // console.log(index, sDate, eDate, sDate === eDate)
            startDate = new Date(tournamentList[index].start_date).toLocaleDateString(undefined, options)
            endDate = new Date(tournamentList[index].end_date).toLocaleDateString(undefined, options)
            sameDate = sDate === eDate
        } else if (tournamentList[index].start_date) {
            const startDateRaw = new Date(tournamentList[index].start_date)
            const endDateRaw = new Date(tournamentList[index].expected_end)
            const offset = startDateRaw.getTimezoneOffset()
            const sDate = new Date(startDateRaw.getTime() - (offset*60*1000)).toISOString().split('T')[0]
            const eDate = new Date(endDateRaw.getTime() - (offset*60*1000)).toISOString().split('T')[0]
            startDate = new Date(tournamentList[index].start_date).toLocaleDateString(undefined, options)
            endDate = new Date(tournamentList[index].expected_end).toLocaleDateString(undefined, options)
            sameDate = sDate === eDate
        } else {
            const startDateRaw = new Date(tournamentList[index].expected_start)
            const endDateRaw = new Date(tournamentList[index].expected_end)
            const offset = startDateRaw.getTimezoneOffset()
            const sDate = new Date(startDateRaw.getTime() - (offset*60*1000)).toISOString().split('T')[0]
            const eDate = new Date(endDateRaw.getTime() - (offset*60*1000)).toISOString().split('T')[0]
            startDate = new Date(tournamentList[index].expected_start).toLocaleDateString(undefined, options)
            endDate = new Date(tournamentList[index].expected_end).toLocaleDateString(undefined, options)
            sameDate = sDate === eDate
        }
        
        return (
            <div style = {style}>
                <div className = 'table-row otb' id = {index} key = {id} onClick={()=> {history(`/live/${id}`)}} >
                    <CountryFlags countryName = {countryName} countryCode = {country} isWOF = {true}></CountryFlags>
                    <div className="otb-info-container">
                        <div className="otb-info-name">{name}</div>
                        <div className="otb-info-text">{`${startDate}${sameDate ? '' : ' - ' + endDate}`}</div>
                        {tournamentList[index].end_date ? 
                            <div className="otb-info-text">{`Finished, ${rounds} rounds, ${players} players${gamesCount > 0 ? ', ' + gamesCount + ' games'  : ''}`}</div> :
                        !tournamentList[index].start_date ?
                            <div className="otb-info-text">{`Not started, ${rounds === 0 ? system : rounds + ' rounds'}, ${players} players`}</div> :
                        currentRound < 100 ?
                            <div className="otb-info-text">{`Round ${currentRound} out of ${rounds}, ${players} players${gamesCount > 0 ? ', ' + gamesCount + ' games'  : ''}`}</div> :
                            <div className="otb-info-text">{`Finals, ${players} players${gamesCount > 0 ? ', ' + gamesCount + ' games' : ''}`}</div>
                        }
                        
                    </div>
                    {isTd && !tournamentList[index].end_date ? <div className='can-edit'/> : <></>}
                    
                </div>
            </div>
        )
    }

    return (
        <div style = {{'--global-width': width + 'px'}}> 
            <NavBar isHome = {false} text = 'Live Events' ></NavBar>
            <div className='otb-tabs' style={{maxWidth: Math.min(490, width * 0.98) + 'px'}}>
                <button className={`otb-tab${activeTab === 'live' ? ' active' : ''}`} onClick={() => handleTabSwitch('live')}>Live</button>
                <button className={`otb-tab${activeTab === 'upcoming' ? ' active' : ''}`} onClick={() => handleTabSwitch('upcoming')}>Upcoming</button>
                <button className={`otb-tab${activeTab === 'finished' ? ' active' : ''}`} onClick={() => handleTabSwitch('finished')}>Finished</button>
            </div>
            <div className = 'search-contaner' style = {{borderRadius: '0 0 0.5rem 0.5rem', justifyContent: 'left', marginLeft: '1%', marginTop: 0, marginBottom: '8px', maxWidth: Math.min(490, width * 0.98) + 'px'}}>
                <input 
                    className = 'search-pair' 
                    type = "text" 
                    maxLength="20" 
                    placeholder = 'Filter by name, country, year or player' 
                    style = {{paddingLeft: '10px'}}
                    onChange = {event => debouncedSearch(event)} 
                    onKeyUp = {event => onEnter(event)}/> 
            </div>      
            {tournamentList.length === 0 && dataLoaded ? 
                <div className='otb-empty-message' style={{maxWidth: Math.min(490, width * 0.98) + 'px'}}>
                    {activeTab === 'live' ? 'No live tournaments right now' :
                     activeTab === 'upcoming' ? 'No upcoming tournaments' :
                     'No finished tournaments found'}
                </div> :
            <div className = 'table-container' style = {{'--offset': '137px'}}>
                <FixedSizeList 
                    className="list otb"
                    height = {authorized ? Math.min(tournamentList.length * 70, height-offset) : Math.min(tournamentList.length * 70, height-offset + 40)}
                    itemCount = {tournamentList.length}
                    itemSize = {70}
                    width = {Math.min(listWidth, 500 * 0.98)}
                    onItemsRendered = {onItemsRendered}
                    ref = {listRef}
                >
                    {Row}
                </FixedSizeList> 
            </div>}   
            {authorized ? <button className = "btn-new-tournament" onClick = {newTournamentHandler}>{'New Tournament'}</button> : <></>} 
        </div>
    )
}

export default OTBTournamentList
