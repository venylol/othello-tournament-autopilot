import React, {useState, useEffect, useRef, useContext, useCallback} from 'react'
import { debounce, onEnter } from '../functions/functions'
import { getName } from 'country-list';
import { useNavigate } from 'react-router-dom'
import { FixedSizeList } from "react-window"
import { useWindowSize } from '../../hooks/resize.hook'
import { AuthContext } from '../../context/AuthContext'
import { NavBar } from '../elements/navbar/NavBar'
import { useGameRedirect } from '../../hooks/game.redirect.hook'
import { CountryFlags } from '../elements/CountryFlags';
import { StatsSVG, PlayersSVG, WOFSVG, TrophySVG, Close } from '../elements/SVG';
import { AdminStats } from './AdminStats';
import './users.css'

const STATUS_LABELS = { '-1': 'Banned', '0': 'Not verified', '1': 'Verified', '2': 'TD' }
const STATUS_COLORS = { '-1': '#e7361f', '0': '#aca9a9', '1': '#86a94b', '2': '#f7cf52' }

const UserDetail = ({ user, socket, onClose, onUpdate }) => {
    const [statusVal, setStatusVal] = useState(user.status)
    const [countryVal, setCountryVal] = useState(user.country || '')
    const [wofSearch, setWofSearch] = useState('')
    const [wofResults, setWofResults] = useState([])
    const [showWofSearch, setShowWofSearch] = useState(false)
    const [confirmWof, setConfirmWof] = useState(null)
    const [gameStats, setGameStats] = useState(null)
    const [queueMsg, setQueueMsg] = useState(null)

    useEffect(() => {
        socket.on('admin-status-changed', (userId, newStatus) => {
            if (userId === user.id) {
                setStatusVal(newStatus)
                onUpdate(userId, 'status', newStatus)
            }
        })
        socket.on('admin-country-changed', (userId, newCountry) => {
            if (userId === user.id) {
                setCountryVal(newCountry)
                onUpdate(userId, 'country', newCountry)
            }
        })
        socket.on('admin-wof-verified', (userId, wofId, wofName) => {
            if (userId === user.id) {
                onUpdate(userId, 'wof', { wofId, wofName })
                setShowWofSearch(false)
                setConfirmWof(null)
            }
        })
        socket.on('admin-wof-unlinked', (userId) => {
            if (userId === user.id) {
                onUpdate(userId, 'wof-unlink', null)
            }
        })
        socket.on('admin-wof-results', (results) => {
            setWofResults(results)
        })
        socket.on('admin-user-game-stats', (data) => {
            if (data && data.userId === user.id) setGameStats(data)
        })
        socket.on('admin-queue-user-retro-result', (res) => {
            if (!res) return
            if (res.ok) {
                setQueueMsg(`Queued ${res.queued} of ${res.requested} game(s) for analysis.`)
                socket.emit('admin-get-user-game-stats', user.id)
            } else {
                setQueueMsg(`Failed to queue: ${res.reason || 'unknown'}`)
            }
            setTimeout(() => setQueueMsg(null), 5000)
        })
        socket.emit('admin-get-user-game-stats', user.id)
        return () => {
            socket.off('admin-status-changed')
            socket.off('admin-country-changed')
            socket.off('admin-wof-verified')
            socket.off('admin-wof-unlinked')
            socket.off('admin-wof-results')
            socket.off('admin-user-game-stats')
            socket.off('admin-queue-user-retro-result')
        }
    }, [user.id])

    const handleStatusChange = (newStatus) => {
        socket.emit('admin-change-status', user.id, newStatus)
    }

    const handleCountryChange = () => {
        if (countryVal && countryVal.length === 2) {
            socket.emit('admin-change-country', user.id, countryVal)
        }
    }

    const handleWofSearch = (e) => {
        const val = e.target.value
        setWofSearch(val)
        if (val.length >= 2) {
            socket.emit('admin-search-wof', val)
        } else {
            setWofResults([])
        }
    }

    const handleWofSelect = (wofPlayer) => {
        setConfirmWof(wofPlayer)
    }

    const handleWofConfirm = () => {
        if (confirmWof) {
            socket.emit('admin-verify-wof', user.id, confirmWof.id, `${confirmWof.name} ${confirmWof.surname}`)
        }
    }

    const formatDate = (dateStr) => {
        if (!dateStr) return 'N/A'
        const d = new Date(dateStr)
        return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })
    }

    return (
        <div className='admin-user-detail-overlay' onClick={onClose}>
            <div className='admin-user-detail' onClick={e => e.stopPropagation()}>
                <div className='admin-detail-header'>
                    <span className='admin-detail-nick'>{user.nick}</span>
                    <span className='admin-detail-close' onClick={onClose}>✕</span>
                </div>

                <div className='admin-detail-row'>
                    <span className='admin-detail-label'>Email:</span>
                    <span className='admin-detail-value'>{user.email || 'N/A'}</span>
                </div>
                <div className='admin-detail-row'>
                    <span className='admin-detail-label'>Registered:</span>
                    <span className='admin-detail-value'>{formatDate(user.registration_date)}</span>
                </div>
                <div className='admin-detail-row'>
                    <span className='admin-detail-label'>Last online:</span>
                    <span className='admin-detail-value'>{formatDate(user.last_online_date)}</span>
                </div>
                <div className='admin-detail-row'>
                    <span className='admin-detail-label'>WOF:</span>
                    <span className='admin-detail-value'>{user.verified ? `${user.name} (${user.wof_id})` : 'Not verified'}</span>
                </div>

                {/* Status change */}
                <div className='admin-detail-section'>
                    <span className='admin-detail-label'>Status:</span>
                    <div className='admin-status-buttons'>
                        {[-1, 0, 1, 2].map(s => (
                            <button key={s}
                                className={`admin-status-btn ${statusVal === s ? 'active' : ''}`}
                                style={{ borderColor: STATUS_COLORS[s], color: statusVal === s ? 'white' : STATUS_COLORS[s], backgroundColor: statusVal === s ? STATUS_COLORS[s] : 'transparent' }}
                                onClick={() => handleStatusChange(s)}>
                                {STATUS_LABELS[s]}
                            </button>
                        ))}
                    </div>
                </div>

                {/* Country change */}
                <div className='admin-detail-section'>
                    <span className='admin-detail-label'>Country (ISO2):</span>
                    <div className='admin-country-edit'>
                        <input type="text" maxLength="2" value={countryVal} onChange={e => setCountryVal(e.target.value.toUpperCase())} className='admin-input-small' />
                        <button className='admin-btn-save' onClick={handleCountryChange}>Save</button>
                    </div>
                </div>

                {/* WOF Verification */}
                <div className='admin-detail-section'>
                    {user.verified ? (
                        <button className='admin-btn-wof unlink' onClick={() => {
                            socket.emit('admin-unlink-wof', user.id)
                        }}>
                            Unlink WOF
                        </button>
                    ) : (
                        <button className='admin-btn-wof' onClick={() => setShowWofSearch(!showWofSearch)}>
                            {showWofSearch ? 'Cancel WOF search' : 'Verify WOF'}
                        </button>
                    )}
                    {showWofSearch && (
                        <div className='admin-wof-search'>
                            <input type="text" placeholder="Search WOF player..." value={wofSearch} onChange={handleWofSearch} className='admin-input-wof' />
                            <div className='admin-wof-list'>
                                {wofResults.map(p => (
                                    <div key={p.id} className={`admin-wof-item ${confirmWof?.id === p.id ? 'selected' : ''}`} onClick={() => handleWofSelect(p)}>
                                        <span>{p.name} {p.surname}</span>
                                        <span className='admin-wof-meta'>{p.wof_id} | {p.country_code} | {p.rating}</span>
                                    </div>
                                ))}
                            </div>
                            {confirmWof && (
                                <div className='admin-wof-confirm'>
                                    <span>Set WOF to: <b>{confirmWof.name} {confirmWof.surname}</b> ({confirmWof.wof_id})?</span>
                                    <button className='admin-btn-save' onClick={handleWofConfirm}>Confirm</button>
                                </div>
                            )}
                        </div>
                    )}
                </div>

                {/* Game analysis */}
                <div className='admin-detail-section'>
                    <span className='admin-detail-label'>Games:</span>
                    <div className='admin-detail-value' style={{marginBottom: '6px'}}>
                        {gameStats ? (
                            <>Total: <b>{gameStats.total}</b> · Analyzed: <b>{gameStats.analyzed}</b> · Not analyzed: <b>{gameStats.notAnalyzed}</b></>
                        ) : 'Loading...'}
                    </div>
                    <div className='admin-status-buttons'>
                        {[10, 20, 50].map(n => (
                            <button key={n}
                                className='admin-status-btn'
                                style={{ borderColor: '#5b9bd5', color: '#5b9bd5', backgroundColor: 'transparent' }}
                                disabled={!gameStats || gameStats.notAnalyzed === 0}
                                onClick={() => {
                                    setQueueMsg(null)
                                    socket.emit('admin-queue-user-retro', user.id, n)
                                }}>
                                Analyze {n}
                            </button>
                        ))}
                    </div>
                    {queueMsg && <div className='admin-detail-value' style={{marginTop: '6px', fontSize: '12px'}}>{queueMsg}</div>}
                </div>
            </div>
        </div>
    )
}

const WofPendingDetail = ({ user, socket, onClose }) => {
    const [wofSearch, setWofSearch] = useState('')
    const [wofResults, setWofResults] = useState([])
    const [selectedWof, setSelectedWof] = useState(null)
    const [showChangeWof, setShowChangeWof] = useState(false)

    useEffect(() => {
        socket.on('admin-wof-results', (results) => {
            setWofResults(results)
        })
        return () => {
            socket.off('admin-wof-results')
        }
    }, [socket])

    const formatDate = (dateStr) => {
        if (!dateStr) return 'N/A'
        const d = new Date(dateStr)
        return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })
    }

    const handleWofSearch = (e) => {
        const val = e.target.value
        setWofSearch(val)
        setSelectedWof(null)
        if (val.length >= 2) {
            socket.emit('admin-search-wof', val)
        } else {
            setWofResults([])
        }
    }

    const handleConfirm = () => {
        socket.emit('admin-wof-confirm', user.id, selectedWof ? selectedWof.id : null)
    }

    const handleDeny = () => {
        socket.emit('admin-wof-deny', user.id)
    }

    return (
        <div className='admin-user-detail-overlay' onClick={onClose}>
            <div className='admin-user-detail' onClick={e => e.stopPropagation()}>
                <div className='admin-detail-header'>
                    <span className='admin-detail-nick'>{user.nick}</span>
                    <span className='admin-detail-close' onClick={onClose}>✕</span>
                </div>

                <div className='admin-detail-row'>
                    <span className='admin-detail-label'>Email:</span>
                    <span className='admin-detail-value'>{user.email || 'N/A'}</span>
                </div>
                <div className='admin-detail-row'>
                    <span className='admin-detail-label'>Registered:</span>
                    <span className='admin-detail-value'>{formatDate(user.registration_date)}</span>
                </div>
                <div className='admin-detail-row'>
                    <span className='admin-detail-label'>Country:</span>
                    <span className='admin-detail-value'>
                        <CountryFlags countryCode={user.country} isWOF={true} />
                        {' '}{getName(user.country) || user.country}
                    </span>
                </div>

                <div className='admin-detail-section'>
                    <span className='admin-detail-label'>Requested WOF Player:</span>
                    <div className='admin-wof-requested'>
                        <CountryFlags countryCode={user.wof_country} isWOF={true} />
                        <span>
                            {user.wof_name} {user.wof_surname}
                            {user.wof_number ? ` (WOF: ${user.wof_number}) ` : ' (new player) '}
                            {user.wof_rating ? `Rating: ${user.wof_rating}` : ''}
                        </span>
                    </div>
                </div>

                {!showChangeWof ? (
                    <div className='admin-wof-actions'>
                        <button className='admin-btn-save' onClick={handleConfirm}>Confirm</button>
                        <button className='admin-btn-wof unlink' onClick={handleDeny}>Deny</button>
                        <button className='admin-btn-wof' onClick={() => setShowChangeWof(true)}>Change WOF Player</button>
                    </div>
                ) : (
                    <div className='admin-detail-section'>
                        <span className='admin-detail-label'>Change WOF Player:</span>
                        <input type="text" placeholder="Search WOF player..." value={wofSearch} onChange={handleWofSearch} className='admin-input-wof' />
                        {!selectedWof && (
                            <div className='admin-wof-list'>
                                {wofResults.map(p => (
                                    <div key={p.id} className='admin-wof-item' onClick={() => { setSelectedWof(p); setWofSearch(`${p.name} ${p.surname}`); setWofResults([]) }}>
                                        <span>{p.name} {p.surname}</span>
                                        <span className='admin-wof-meta'>{p.wof_id} | {p.country_code} | {p.rating}</span>
                                    </div>
                                ))}
                            </div>
                        )}
                        {selectedWof && (
                            <div className='admin-wof-confirm'>
                                <span>Change to: <b>{selectedWof.name} {selectedWof.surname}</b> ({selectedWof.wof_id})</span>
                                <button className='admin-btn-save' onClick={handleConfirm}>Confirm</button>
                            </div>
                        )}
                        <button className='admin-btn-wof' style={{marginTop: '8px'}} onClick={() => { setShowChangeWof(false); setSelectedWof(null); setWofSearch(''); setWofResults([]) }}>Cancel</button>
                    </div>
                )}
            </div>
        </div>
    )
}

export const UsersList = () => {
    const {socket, token} = useContext(AuthContext)
    const listRef = useRef ()
    const unfilteredDataRef = useRef([])
    const scrollOffset = useRef(0)
    const reachedLimit = useRef(false)
    const requestedMore = useRef(false)
    const inputValueRef = useRef('')
    const [width, listWidth, rowHeight, rowHeightExpanded, height, offsetY, boardSize] = useWindowSize(listRef, false)
    const [usersList, setUsersList] = useState([])
    const [authorized, setAuthorized] = useState (false)
    const [inputValue, setInputValue] = useState (null)
    const [pressed, setPressed] = useState('Stats')
    const [selectedUser, setSelectedUser] = useState(null)
    const [statusFilter, setStatusFilter] = useState(null)
    const [wofFilter, setWofFilter] = useState(false)
    const [appFilter, setAppFilter] = useState(false)
    const [totalCount, setTotalCount] = useState(0)
    const [wofPending, setWofPending] = useState([])
    const [selectedWofUser, setSelectedWofUser] = useState(null)
    const [avatarPending, setAvatarPending] = useState([])
    const [avatarPreview, setAvatarPreview] = useState(null)
    const [senseiQueue, setSenseiQueue] = useState(null)
    const history = useNavigate()
    const offset = 130
    const LIMIT = 25
    useGameRedirect(socket) 

    useEffect(() => {
        unfilteredDataRef.current = []
        scrollOffset.current = 0
        reachedLimit.current = false
        socket.emit('get-users', '', 0, LIMIT, true, null, false, false)
        socket.on('users-authorized', val => {
            if(!val) history(`/`)
            setAuthorized(val)
        })
        socket.on('users-list', (list, total) => {
            requestedMore.current = false
            unfilteredDataRef.current = scrollOffset.current > 0 ? [...unfilteredDataRef.current, ...list] : [...list]
            setUsersList([...unfilteredDataRef.current])
            if (total !== undefined) setTotalCount(total)
            reachedLimit.current = list.length < LIMIT 
        })
        socket.on('admin-wof-pending', (list) => {
            setWofPending(list)
        })
        socket.on('admin-wof-confirm-result', (userId) => {
            setWofPending(prev => prev.filter(u => u.id !== userId))
            setSelectedWofUser(null)
        })
        socket.on('admin-wof-deny-result', (userId) => {
            setWofPending(prev => prev.filter(u => u.id !== userId))
            setSelectedWofUser(null)
        })
        socket.on('admin-pending-avatars', (list) => {
            setAvatarPending(list)
        })
        socket.on('admin-avatar-approve-result', (userId) => {
            setAvatarPending(prev => prev.filter(u => u.id !== userId))
        })
        socket.on('admin-avatar-deny-result', (userId) => {
            setAvatarPending(prev => prev.filter(u => u.id !== userId))
        })
        socket.on('admin-sensei-queue', (q) => {
            setSenseiQueue(q)
        })
        socket.emit('admin-join-room')
        socket.emit('admin-get-sensei-queue')
        return () => {
            socket.off('users-list')
            socket.off('users-authorized')
            socket.off('admin-wof-pending')
            socket.off('admin-wof-confirm-result')
            socket.off('admin-wof-deny-result')
            socket.off('admin-pending-avatars')
            socket.off('admin-avatar-approve-result')
            socket.off('admin-avatar-deny-result')
            socket.off('admin-sensei-queue')
            socket.emit('admin-leave-room')
        }
    }, [])

    useEffect (() => {
        if (inputValue !== null) {
            unfilteredDataRef.current = []
            reachedLimit.current = false
            socket.emit('get-users', inputValue, scrollOffset.current, LIMIT, false, statusFilter, wofFilter, appFilter)           
        }
    },[inputValue, statusFilter, wofFilter, appFilter]) 

    const handleSearch = (event) => { 
        let value = event.target.value.toLowerCase().toString()
        if (value !== null) { 
            setInputValue(value)
            scrollOffset.current = 0
            return
        }      
    }

    const handleStatusFilter = (status) => {
        const newStatus = statusFilter === status ? null : status
        setStatusFilter(newStatus)
        scrollOffset.current = 0
        unfilteredDataRef.current = []
        reachedLimit.current = false
        socket.emit('get-users', inputValue || '', 0, LIMIT, false, newStatus, wofFilter, appFilter)
    }

    const handleWofFilter = () => {
        const newWof = !wofFilter
        setWofFilter(newWof)
        scrollOffset.current = 0
        unfilteredDataRef.current = []
        reachedLimit.current = false
        socket.emit('get-users', inputValue || '', 0, LIMIT, false, statusFilter, newWof, appFilter)
    }

    const handleAppFilter = () => {
        const newApp = !appFilter
        setAppFilter(newApp)
        scrollOffset.current = 0
        unfilteredDataRef.current = []
        reachedLimit.current = false
        socket.emit('get-users', inputValue || '', 0, LIMIT, false, statusFilter, wofFilter, newApp)
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
            socket.emit('get-users', inputValue, scrollOffset.current, LIMIT, false, statusFilter, wofFilter, appFilter)
        }
    }

    const handleUserUpdate = (userId, field, value) => {
        const updated = unfilteredDataRef.current.map(u => {
            if (u.id === userId) {
                if (field === 'status') return { ...u, status: value }
                if (field === 'country') return { ...u, country: value }
                if (field === 'wof') return { ...u, verified: 1, wof_id: value.wofId, name: value.wofName }
                if (field === 'wof-unlink') return { ...u, verified: 0, wof_id: null, name: null }
            }
            return u
        })
        unfilteredDataRef.current = updated
        setUsersList([...updated])
        setSelectedUser(prev => {
            if (prev && prev.id === userId) {
                if (field === 'status') return { ...prev, status: value }
                if (field === 'country') return { ...prev, country: value }
                if (field === 'wof') return { ...prev, verified: 1, wof_id: value.wofId, name: value.wofName }
                if (field === 'wof-unlink') return { ...prev, verified: 0, wof_id: null, name: null }
            }
            return prev
        })
    }

    const footerHandler = (tab) => {
        setPressed(tab)
        if (tab === 'WOF') {
            socket.emit('admin-get-wof-pending')
            socket.emit('admin-get-pending-avatars')
        }
    }

    const formatDate = (dateStr) => {
        if (!dateStr) return ''
        const d = new Date(dateStr)
        return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })
    }

    const Row = ({index, style}) => {
        const u = usersList[index]
        const nick = u.nick
        const wof_id = u.wof_id
        const name = u.name
        const country = u.country
        const countryName = getName(country)
        const verified = u.verified
        const status = u.status
        const regDate = formatDate(u.registration_date)
        const lastOnline = formatDate(u.last_online_date)
        
        return (
            <div style = {style}>
                <div className = 'table-row otb' id = {index} key = {nick} onClick={() => setSelectedUser(u)} >
                    <CountryFlags countryName = {countryName} countryCode = {country} isWOF = {true}></CountryFlags>
                    <div className="otb-info-container">
                        <div className="otb-info-name">
                            {nick}
                            <span className='admin-status-badge' style={{ backgroundColor: STATUS_COLORS[status] }}>
                                {STATUS_LABELS[status]}
                            </span>
                        </div>
                        <div className="otb-info-text">{`${regDate} / ${lastOnline}`}</div>
                        {verified ? 
                            <div className="otb-info-text">{`${name}, ${wof_id}`}</div> :
                            <></>
                        }
                    </div>
                    {status > 1 ? <></> : <></>}
                </div>
            </div>
        )
    }

    return (
        <div style = {{'--global-width': width + 'px'}}> 
            <NavBar isHome = {false} text = 'Admin' ></NavBar>

            {/* Stats tab */}
            {pressed === 'Stats' && authorized ? 
                <div className='admin-tab-content' style={{marginTop: '55px'}}>
                    <AdminStats width={width} />
                </div>
            : <></>}

            {/* Users tab */}
            {pressed === 'Users' && authorized ? 
                <>
                    <div className = 'search-contaner' style = {{marginTop: '55px', borderRadius: '0.5rem', justifyContent: 'left', marginLeft: '1%', maxWidth: Math.min(490, width * 0.98) + 'px' }}>
                        <input 
                            className = 'search-pair' 
                            type = "text" 
                            maxLength="20" 
                            placeholder = 'Filter by name, nick or country' 
                            style = {{paddingLeft: '10px'}}
                            onChange = {event => debouncedSearch(event)} 
                            onKeyUp = {event => onEnter(event)}/> 
                    </div>
                    <div className='admin-status-filter'>
                        {[-1, 0, 1, 2].map(s => (
                            <button key={s}
                                className={`admin-filter-btn ${statusFilter === s ? 'active' : ''}`}
                                style={{ borderColor: STATUS_COLORS[s], color: statusFilter === s ? 'white' : STATUS_COLORS[s], backgroundColor: statusFilter === s ? STATUS_COLORS[s] : 'transparent' }}
                                onClick={() => handleStatusFilter(s)}>
                                {STATUS_LABELS[s]}
                            </button>
                        ))}
                        <button
                            className={`admin-filter-btn ${wofFilter ? 'active' : ''}`}
                            style={{ borderColor: '#5b9bd5', color: wofFilter ? 'white' : '#5b9bd5', backgroundColor: wofFilter ? '#5b9bd5' : 'transparent' }}
                            onClick={handleWofFilter}>
                            WOF
                        </button>
                        <button
                            className={`admin-filter-btn ${appFilter ? 'active' : ''}`}
                            style={{ borderColor: '#9b59b6', color: appFilter ? 'white' : '#9b59b6', backgroundColor: appFilter ? '#9b59b6' : 'transparent' }}
                            onClick={handleAppFilter}>
                            App
                        </button>
                        <span className='admin-filter-count'>{totalCount} found</span>
                        <span className='admin-filter-count' title='Sensei retro analysis queue' style={{cursor: 'pointer'}} onClick={() => socket.emit('admin-get-sensei-queue')}>
                            · queue: {senseiQueue ? (senseiQueue.items?.length || 0) : '—'}{senseiQueue && !senseiQueue.ready ? ' (engine off)' : ''}
                        </span>
                    </div>
                    <div className = 'table-container' style = {{'--offset': '130px'}}>
                        <FixedSizeList 
                            className="list otb"
                            height = {Math.min(usersList.length * 70, height - 190)}
                            itemCount = {usersList.length}
                            itemSize = {70}
                            width = {Math.min(listWidth, 500 * 0.98)}
                            onItemsRendered = {onItemsRendered}
                            ref = {listRef}
                        >
                            {Row}
                        </FixedSizeList> 
                    </div>
                </>
            : <></>}

            {/* WOF tab */}
            {pressed === 'WOF' && authorized ? 
                <div className='admin-tab-content' style={{marginTop: '55px'}}>
                    {/* Pending Avatars Section */}
                    {avatarPending.length > 0 && (
                        <>
                            <div className='admin-section-title'>Pending Avatars</div>
                            <div className='admin-wof-list-container'>
                                {avatarPending.map(u => (
                                    <div key={u.id} className='admin-wof-row admin-avatar-row'>
                                        <img
                                            className='admin-avatar-preview'
                                            src={`/api/avatar/pending/${u.pending_avatar}?token=${encodeURIComponent(token)}`}
                                            alt={u.nick}
                                            onClick={() => setAvatarPreview(`/api/avatar/pending/${u.pending_avatar}?token=${encodeURIComponent(token)}`)}
                                            style={{cursor: 'pointer'}}
                                        />
                                        <div className='admin-wof-row-info'>
                                            <div className='admin-wof-row-nick'>{u.nick}</div>
                                            <div className='admin-wof-row-details'>
                                                Submitted {u.pending_avatar_date ? new Date(u.pending_avatar_date).toLocaleDateString('en-GB', {day: '2-digit', month: 'short', year: 'numeric'}) : ''}
                                            </div>
                                        </div>
                                        <div className='admin-avatar-actions'>
                                            <button className='admin-btn-save' onClick={() => socket.emit('admin-approve-avatar', u.id)}>✓</button>
                                            <button className='admin-btn-wof unlink' onClick={() => socket.emit('admin-deny-avatar', u.id)}>✕</button>
                                        </div>
                                    </div>
                                ))}
                            </div>
                        </>
                    )}

                    {/* WOF Pending Section */}
                    {wofPending.length === 0 && avatarPending.length === 0 ? (
                        <div className='big-text-empty'>No pending requests</div>
                    ) : wofPending.length === 0 ? (
                        <></>
                    ) : (
                        <>
                            {avatarPending.length > 0 && <div className='admin-section-title' style={{marginTop: '16px'}}>WOF Verifications</div>}
                            <div className='admin-wof-list-container'>
                            {wofPending.map(u => (
                                <div key={u.id} className='admin-wof-row' onClick={() => setSelectedWofUser(u)}>
                                    <CountryFlags countryCode={u.country} isWOF={true} />
                                    <div className='admin-wof-row-info'>
                                        <div className='admin-wof-row-nick'>
                                            {u.nick}
                                            <span className='admin-status-badge' style={{ backgroundColor: STATUS_COLORS[u.status] }}>
                                                {STATUS_LABELS[u.status]}
                                            </span>
                                        </div>
                                        <div className='admin-wof-row-details'>
                                            {u.wof_name} {u.wof_surname} {u.wof_number ? `(WOF: ${u.wof_number})` : '(new player)'} {u.wof_rating ? `- ${u.wof_rating}` : ''}
                                        </div>
                                    </div>
                                </div>
                            ))}
                            </div>
                        </>
                    )}
                </div>
            : <></>}

            {/* WOF detail modal */}
            {selectedWofUser && (
                <WofPendingDetail user={selectedWofUser} socket={socket} onClose={() => setSelectedWofUser(null)} />
            )}

            {/* Avatar fullscreen preview */}
            {avatarPreview && (
                <div className='admin-user-detail-overlay' onClick={() => setAvatarPreview(null)}>
                    <img
                        className='admin-avatar-fullscreen'
                        src={avatarPreview}
                        alt='Avatar preview'
                        onClick={e => e.stopPropagation()}
                    />
                </div>
            )}

            {/* OTB tab - inactive */}
            {pressed === 'OTB' && authorized ? 
                <div className='admin-tab-content' style={{marginTop: '55px'}}>
                    <div className='big-text-empty'>Coming soon</div>
                </div>
            : <></>}

            {/* User detail modal */}
            {selectedUser && (
                <UserDetail user={selectedUser} socket={socket} onClose={() => setSelectedUser(null)} onUpdate={handleUserUpdate} />
            )}

            {/* Footer */}
            {authorized ? 
            <div className='footer'>
                <div className="game-footer-container" onClick={() => footerHandler('Stats')}>
                    <div className={`game-footer ${pressed === 'Stats' ? 'active' : ''}`}>
                        <StatsSVG active={pressed === 'Stats'}/>
                        <label className={`game-footer-label ${pressed === 'Stats' ? 'active' : ''}`}>Stats</label>
                    </div>
                </div>
                <div className="game-footer-container" onClick={() => footerHandler('Users')}>
                    <div className={`game-footer ${pressed === 'Users' ? 'active' : ''}`}>
                        <PlayersSVG active={pressed === 'Users'}/>
                        <label className={`game-footer-label ${pressed === 'Users' ? 'active' : ''}`}>Users</label>
                    </div>
                </div>
                <div className="game-footer-container" onClick={() => footerHandler('WOF')}>
                    <div className={`game-footer ${pressed === 'WOF' ? 'active' : ''}`}>
                        <WOFSVG active={pressed === 'WOF'}/>
                        <label className={`game-footer-label ${pressed === 'WOF' ? 'active' : ''}`}>WOF</label>
                    </div>
                </div>
                <div className="game-footer-container" onClick={() => footerHandler('OTB')}>
                    <div className={`game-footer ${pressed === 'OTB' ? 'active' : ''}`} style={{opacity: 0.4}}>
                        <TrophySVG active={pressed === 'OTB'}/>
                        <label className={`game-footer-label ${pressed === 'OTB' ? 'active' : ''}`}>OTB</label>
                    </div>
                </div>
            </div>
            : <></>}
        </div>
    )
}

export default UsersList
