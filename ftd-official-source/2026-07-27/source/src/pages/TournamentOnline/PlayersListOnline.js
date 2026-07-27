import React, {useEffect, useRef, useState, useContext, useCallback} from "react"
import { getName, getNames, getCode, search } from 'country-list';
import { FixedSizeList } from "react-window"
import { toast } from 'react-toastify';
import { TournamentTimer } from './TournamentTimer'; 
import { useWindowSize } from '../../hooks/resize.hook'
import { checkTName, debounce, toNameCase } from '../functions/functions';
import { SwitcherCategories } from './SwitcherCategories';
import { UserContext } from '../../context/UserContext';
import { AuthContext } from '../../context/AuthContext'
import { CountryFlags } from "../elements/CountryFlags";
import { useNavigate } from 'react-router-dom'
// import { useOtbIdb } from '../../hooks/idb.otb.hook'
// const image = require(`../../assets/first_time.jpg`)

const exactMatch = (arr, str) => {
    if(arr.length === 0) return false
    for (let i = 0; i < arr.length; i ++) {
        if (arr[i].surname.toLowerCase() + ' ' + arr[i].name.toLowerCase() === str.toLowerCase()) return arr[i].id
    }
    return false
}

const toCapitalized = (str) => {
    return str.charAt(0).toUpperCase() + str.slice(1)
}

export const PlayersListOnline = ({id, isTD, setTab, pairingSystem, isOnline, hasCategories, setRoundsByPlayerID, tName, currentRound, nextRoundStartTime, setNextRoundStartTime, showBottomButton = false, tournamentStatus = 1, isPrivate = false, lateRegAvailable = false, tournamentFinished = false, verifiedOnly = false, viewerVerified = false}) => {
    const history = useNavigate()
    // Determine if timer is visible (when nextRoundStartTime exists or tournament is cancelled)
    const timerVisible = !!nextRoundStartTime || tournamentStatus === 2
    const [name, setName] = useState ('')
    const [wofId, setWofId] = useState(null)
    const [wofPlayers, setWOFPlayers] = useState ([])
    const [newPlayer, setNewPlayer] = useState(false)
    const [registered, setRegistered] = useState(false)
    const [data, setData] = useState([])
    const [isLoading, setIsloading] = useState(true)
    const [started, setStarted] = useState(false)
    const [lasroundStarted, setLastRoundStarted] = useState(false)
    const [team, setTeam] = useState('')
    const [categories, setCategories] = useState([])
    const [filterCategories, setFilterCategories] = useState([])
    const [playerCategories, setPlayerCategories] = useState([])
    const [filterCategory, setFilterCategory] = useState(0)
    const [filteredData, setFilteredData] = useState([])
    // Private tournament whitelist state
    const [whitelist, setWhitelist] = useState([])
    const [searchQuery, setSearchQuery] = useState('')
    const [searchResults, setSearchResults] = useState([])
    const [searchHasMore, setSearchHasMore] = useState(false)
    const [searchLoading, setSearchLoading] = useState(false)
    const searchQueryRef = useRef('')
    const { isMobile } = useContext(UserContext)
    const { socket, isAuthenticated, userId} = useContext(AuthContext)
    const [width, listWidth, rowHeight, rowHeightExpanded, height, offsetY, boardSize] = useWindowSize(null, true, isMobile)
    // const { getTournamentById, getWOFPlayersList, registerWOFPlayer, removeRegisteredPlayer, registerNewPlayer, getOtbReg, startSwissTournament } = useOtbIdb()
    
    const listRef = useRef ()
    const nameRef = useRef ()


    const searchListHeight = Math.min(wofPlayers?.length * 45, height - 238)
    // started
    const getTotalHeight = () => {
        const topSpace = timerVisible ? 90 : 60
        const bottomSpace = 50 + (showBottomButton ? 50 : 0) // footer + optional button
        let uiChrome = hasCategories ? 40 : 0
        return Math.min(filteredData.length * 45, height - topSpace - bottomSpace - uiChrome)
    }

    // const getOffset = () => {
    //     const canAdd = isTD && currentRound < 100 && ((pairingSystem !== 'Round Robin' && pairingSystem !== 'Double Round Robin') || !started) && !lasroundStarted
    //     if (canAdd && hasCategories) return '190px'
    //     if (!canAdd && hasCategories) return '130px'
    //     if (canAdd && !hasCategories) return '150px'
    //     return '80px'
    // }

    const getOffset = () => {
        return timerVisible ? '90px' : '60px'
    }
    
    useEffect(() => {
        socket.on('updated-online-players-list', () => {
            socket.emit('get-online-reg', id)
        })
        socket.on('online-players-list', (players, started, lastRound, categories, whitelistData) => {
            setData(players)
            setFilteredData(players)
            setCategories(categories)
            setStarted(started)
            setLastRoundStarted(lastRound)
            setIsloading(false)
            setWOFPlayers([])
            if (whitelistData) setWhitelist(whitelistData)
            let cat = ['all']
            
            if (hasCategories) {
                for (let i = 0; i < categories.length; i++) {
                    cat = [...new Set([...cat, categories[i].category_name])]
                }
                setFilterCategories(cat)
                setFilterCategory(0)
            } else {
                setFilterCategories([])
                setFilterCategories(null)
            }
        })
        // Whitelist updates for private tournaments
        socket.on('whitelist-updated', (whitelistData) => {
            setWhitelist(whitelistData)
        })
        // Search results for adding players to whitelist
        socket.on('online-players-search-results', (players, offset, hasMore) => {
            if (offset > 0) {
                setSearchResults(prev => [...prev, ...players])
            } else {
                setSearchResults(players)
            }
            setSearchHasMore(hasMore)
            setSearchLoading(false)
        })
        return () => {
            socket.off('updated-online-players-list')
            socket.off('online-players-list')
            socket.off('whitelist-updated')
            socket.off('online-players-search-results')
        }
    },[isOnline])

    const getPlayersGames = (e) => {
        const playerNick = e.target.textContent
        history(`/tournaments/${id}/player/${encodeURIComponent(playerNick)}`)
    }

    // Debounced search for private tournament whitelist player search
    const debouncedWhitelistSearch = useCallback(debounce((socket, value) => {
        if (value.length >= 2) {
            setSearchLoading(true)
            socket.emit('search-online-players', value, id, 0)
        } else {
            setSearchResults([])
            setSearchHasMore(false)
        }
    }), [])

    const onSearchChange = (e) => {
        const val = e.target.value
        setSearchQuery(val)
        searchQueryRef.current = val
        debouncedWhitelistSearch(socket, val)
    }

    const loadMoreResults = useCallback(() => {
        if (searchLoading || !searchHasMore) return
        setSearchLoading(true)
        socket.emit('search-online-players', searchQueryRef.current, id, searchResults.length)
    }, [searchLoading, searchHasMore, searchResults.length, socket, id])

    const addToWhitelist = (playerId) => {
        socket.emit('add-whitelist-player', id, playerId)
        setSearchQuery('')
        searchQueryRef.current = ''
        setSearchResults([])
        setSearchHasMore(false)
    }

    const addAllToWhitelist = () => {
        if (searchQuery.length < 2) return
        socket.emit('add-all-whitelist-players', id, searchQuery)
        setSearchQuery('')
        searchQueryRef.current = ''
        setSearchResults([])
        setSearchHasMore(false)
    }

    const removeFromWhitelist = (playerId) => {
        socket.emit('remove-whitelist-player', id, playerId)
    }

    const removeAllFromWhitelist = () => {
        if (whitelist.length === 0) return
        socket.emit('remove-all-whitelist-players', id)
    }

    // Search result row for adding players to whitelist
    const SearchResultRow = ({index, style}) => {
        const player = searchResults[index]
        const countryName = getName(player.country)
        const alreadyAdded = player.whitelisted
        const realName = (verifiedOnly && viewerVerified && player.wof_name) ? toNameCase(player.wof_name) : null
        
        return (
            <div style={style}>
                <div className='table-row reg' style={{opacity: alreadyAdded ? 0.5 : 1}}>
                    <CountryFlags countryName={countryName} countryCode={player.country}></CountryFlags>
                    <div className='select-text' style={{textTransform: 'none', flex: 1}}>
                        {player.nick}{realName && <span style={{color: '#aaa', fontSize: '12px', marginLeft: '6px'}}>({realName})</span>}
                    </div>
                    {!alreadyAdded ? 
                        <button className='add-button valid' onClick={() => addToWhitelist(player.id)} style={{fontSize: '24px', minWidth: '35px', width: '35px', height: '30px'}}>+</button>
                        : <span style={{color: '#86a94b', marginRight: '10px', fontSize: '14px'}}>&#10003;</span>
                    }
                </div>
            </div>
        )
    }

    // Whitelist row showing invited players with registration visual cue
    const WhitelistRow = ({index, style}) => {
        const player = whitelist[index]
        const countryName = getName(player.country)
        const isRegistered = player.registered
        
        return (
            <div style={style}>
                <div className='table-row reg'>
                    <div className='table-place'>{index + 1}</div>
                    {isRegistered ? <span style={{color: '#86a94b', fontSize: '14px', marginRight: '2px', minWidth: '14px'}} title='Registered'>&#10003;</span> : <div style={{minWidth: '14px', marginRight: '2px'}}></div>}
                    <CountryFlags countryName={countryName} countryCode={player.country}></CountryFlags>
                    <div className='select-text' style={{textTransform: 'none', flex: 1}} onClick={getPlayersGames}>{player.nick}</div>
                    <button className='remove-whitelist-btn' onClick={() => removeFromWhitelist(player.player_id)} title='Remove from list'>&times;</button>
                </div>
            </div>
        )
    }

    const Row = ({index, style}) => {
        const id = filteredData[index].id
        const nick = filteredData[index].nick
        const displayName = (verifiedOnly && viewerVerified && filteredData[index].wof_name) ? toNameCase(filteredData[index].wof_name) : nick
        const rating = filteredData[index].rating ? filteredData[index].rating : '-'
        const country = filteredData[index].country_code
        const countryName = getName(country)
        const leftRound = filteredData[index].left_after_round
        
        return (
            <div style = {style}>
                <div className = 'table-row reg' id = {index} key = {id}>
                    <div className = 'table-place'>{index + 1}</div>
                    <CountryFlags countryName = {countryName} countryCode = {country}></CountryFlags>
                    <div className={`select-text ${leftRound ? 'left' : ''}`} onClick = {getPlayersGames} id = {id} style = {{textTransform: 'none'}}>{displayName}</div>                       
                    <div className="select-text wof-rating" title = 'WOF Rating'>{rating}</div>
                </div>
            </div>
        )
    }

    const showPrivateWhitelistUI = isPrivate && isTD
    // Determine if registration is still open (search should be hidden for finished/cancelled/no-late-reg tournaments)
    const registrationOpen = tournamentStatus !== 2 && !tournamentFinished && (currentRound === 0 || lateRegAvailable)
    const canManageWhitelist = showPrivateWhitelistUI && registrationOpen
    const bottomSpace = 50 + (showBottomButton ? 50 : 0)
    const topSpace = timerVisible ? 90 : 60
    const searchBarHeight = canManageWhitelist ? 50 : 0
    const searchResultsVisible = searchQuery.length >= 2 && searchResults.length > 0
    const hasNewResults = searchResults.some(p => !p.whitelisted)

    return (
        <div>
            <TournamentTimer
                currentRound = {currentRound} 
                nextRoundStartTime = {nextRoundStartTime}
                setNextRoundStartTime = {setNextRoundStartTime}
                playersTab = {true}
                tournamentStatus = {tournamentStatus}
                >
            </TournamentTimer>

            {/* Private tournament: search bar + whitelist for TD */}
            {showPrivateWhitelistUI ? 
            <>
                {canManageWhitelist && <div className='add-player' style={{position: 'absolute', top: timerVisible ? '90px' : '60px', left: '50%', transform: 'translateX(-50%)', width: '98%', maxWidth: '98%', zIndex: 2, gap: '6px'}}>
                    <input 
                        className='input wof-players' 
                        placeholder='Search by nick or country' 
                        type='text' 
                        autoComplete='off'
                        maxLength={50}
                        value={searchQuery}
                        onChange={onSearchChange}
                        style={{flex: 1, minWidth: 0, marginLeft: 0}}
                    />
                    <button 
                        className='add-button' 
                        onClick={addAllToWhitelist}
                        disabled={!hasNewResults}
                        style={{
                            minWidth: '70px', height: '30px', fontSize: '13px', fontWeight: 700,
                            backgroundColor: hasNewResults ? '#86a94b' : '#3a3835',
                            color: hasNewResults ? '#fff' : '#7a7774',
                            cursor: hasNewResults ? 'pointer' : 'default',
                            border: 'none', borderRadius: '0.25rem',
                            opacity: hasNewResults ? 1 : 0.6
                        }}
                    >Add all</button>
                    {!started && whitelist.length > 0 && <button 
                        onClick={removeAllFromWhitelist}
                        style={{
                            minWidth: '80px', height: '30px', fontSize: '13px', fontWeight: 700,
                            backgroundColor: '#d32f2f',
                            color: '#fff',
                            cursor: 'pointer',
                            border: 'none', borderRadius: '0.25rem'
                        }}
                    >Remove all</button>}
                </div>}

                {/* Search results OR whitelist - mutually exclusive */}
                {canManageWhitelist && searchResultsVisible ?
                    <div style={{position: 'absolute', top: `${(timerVisible ? 90 : 60) + 50}px`, left: '50%', transform: 'translateX(-50%)', width: '96%', maxWidth: '490px', zIndex: 1, backgroundColor: '#1f1e1b'}}>
                        <FixedSizeList
                            className="list"
                            height={Math.min(searchResults.length * 45, height - topSpace - searchBarHeight - bottomSpace - 10)}
                            itemCount={searchResults.length}
                            itemSize={45}
                            width={Math.min(width * 0.98, 500 * 0.98)}
                            onItemsRendered={({visibleStopIndex}) => {
                                if (visibleStopIndex >= searchResults.length - 3 && searchHasMore && !searchLoading) {
                                    loadMoreResults()
                                }
                            }}
                        >
                            {SearchResultRow}
                        </FixedSizeList>
                    </div>
                : canManageWhitelist && searchQuery.length >= 2 && searchResults.length === 0 ?
                    <div style={{position: 'absolute', top: `${(timerVisible ? 90 : 60) + 45}px`, left: '50%', transform: 'translateX(-50%)', color: '#7a7774', textAlign: 'center', padding: '10px', fontSize: '14px', zIndex: 3}}>No users found</div>
                :
                    <div className='table-container' style={{'--offset': `${(timerVisible ? 90 : 60) + (canManageWhitelist ? 50 : 0)}px`}}>
                        <FixedSizeList
                            className="list"
                            height={Math.min(whitelist.length * 45, height - topSpace - searchBarHeight - bottomSpace - 10)}
                            itemCount={whitelist.length}
                            itemSize={45}
                            width={Math.min(width * 0.98, 500 * 0.98)}
                            ref={listRef}
                        >
                            {WhitelistRow}
                        </FixedSizeList>
                    </div>
                }
            </>
            :
            /* Non-private or non-TD: show regular player list */
            name.length === 0 && wofPlayers.length === 0 ? 
            <div className = 'table-container' style = {{'--offset': getOffset()}}>
                <FixedSizeList 
                    className="list"
                    height={getTotalHeight()}
                    itemCount={filteredData.length}
                    itemSize = {45}
                    width={Math.min(width * 0.98, 500 * 0.98)}
                    ref = {listRef}
                >
                    {Row}
                </FixedSizeList>              
            </div>
            : <></>}             
        </div>
        
    )
}

