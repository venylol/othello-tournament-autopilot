import React, {useState, useEffect, useRef, useContext} from 'react'
import { useWindowSize } from '../../hooks/resize.hook'
import { UserContext } from '../../context/UserContext';
import { checkTName } from '../functions/functions'
import { DropDownInput } from '../elements/DropDownStyled'
import { SwitcherOnlineTournaments } from '../elements/SwitcherOnlineTournaments'
import { TournamentTimer } from './TournamentTimer'
import { toast } from 'react-toastify';
import './tournament.css'
import '../elements/dropdown.css'

export const SettingsOnlineNew = ({id, socket, isTD, setTName, round, setRound, currentRound, nextRoundStartTime, setNextRoundStartTime, tournamentInfo: initialTournamentInfo}) => {
    console.log('tournamentInfo', initialTournamentInfo)
    const [btnLabel, setBtnLabel] = useState('Edit Settings')
    const { isOnline, isMobile } = useContext(UserContext)
    const [width, listWidth, rowHeight, rowHeightExpanded, height, offsetY, boardSize] = useWindowSize(null, true, isMobile)
    const [isEditing, setIsEditing] = useState(false)
    const [tournamentInfo, setTournamentInfo] = useState(initialTournamentInfo)
    const [settings, setSettings] = useState(null)
    const [validName, setValidName] = useState(true)
    const [validRounds, setValidRounds] = useState(false)
    const [validStartDate, setValidStartDate] = useState(true)
    const [canEdit, setCanEdit] = useState(false)
    const [timeUntilStart, setTimeUntilStart] = useState(null)
    const roundsRef = useRef(null)
    const startDateRef = useRef()
    const timerVisible = !!nextRoundStartTime

    const forbidLetters = ['e', 'E', '+', '-', '.']
    const minTimeDifference = 15 * 60000
    const systemOptions = ["Swiss System", "Dutch System", "Round Robin", "Double Round Robin"]
    const defaultCategories = ["junior", "female", "senior"]
    const timeControlOptions = {1: [0, 1], 3: [0, 1, 2], 5: [0, 3, 5], 10: [0, 5, 10], 15: [0, 5, 10, 15], 20: [0, 10, 20, 30]}
    const breakDurationOptions = [15, 30, 45, 60, 90, 120, 180, 300]

    const isRoundRobin = settings?.system === "Round Robin" || settings?.system === "Double Round Robin"
    const lateRegOptions = isRoundRobin ? [0] : Array.from({length: Math.max(1, parseInt(settings?.rounds) || 1)}, (_, i) => i)

    const message = (err) => {
        if (!err) return
        toast.clearWaitingQueue();
        toast.error(err, {autoClose: 2000, pauseOnFocusLoss: false, draggable: false})
    }

    const successMessage = (msg) => {
        if (!msg) return
        toast.clearWaitingQueue();
        toast.success(msg, {autoClose: 2000, pauseOnFocusLoss: false, draggable: false})
    }

    // Initialize settings from tournamentInfo prop
    useEffect(() => {
        console.log('initial tournamentInfo:', initialTournamentInfo)
        if (initialTournamentInfo && !settings) {
            const form = initialTournamentInfo
            const breakDurSec = form.break_duration ? form.break_duration : 60
            setSettings({
                name: form.name,
                system: form.pairing_system,
                rounds: form.rounds === 0 ? '' : form.rounds,
                startDate: form.start_date,
                timeControl: form.time_control,
                increment: form.increment,
                lateReg: form.late_reg || 0,
                breakDuration: breakDurSec,
                private: form.private ? true : false,
                finals: form.finals ? true : false,
                xot: form.xot ? true : false,
                withCategories: form.categories ? true : false,
                verifiedOnly: form.verified_only ? true : false,
                minRating: form.min_rating,
                maxRating: form.max_rating
            })

            // Check if editing is allowed (tournament not started and more than 15 min before start)
            const now = new Date()
            const startDate = new Date(form.start_date)
            const timeDiff = startDate.getTime() - now.getTime()
            const notStarted = currentRound === 0
            const moreThan15Min = timeDiff >= minTimeDifference || timeDiff <= 0
            setCanEdit(notStarted && moreThan15Min && isTD)
            setTimeUntilStart(timeDiff)
            form.rounds > 0 && setValidRounds(true)
        }
    }, [initialTournamentInfo, settings, currentRound, isTD])

    useEffect(() => {
        socket.on('tournament-updated', (updatedId) => {
            if (parseInt(id) === updatedId) {
                successMessage('Tournament settings updated successfully')
                setIsEditing(false)
                setBtnLabel('Edit Settings')
                // Request fresh data from parent by triggering is-td-online
                socket.emit('is-td-online', id)
            }
        })

        socket.on('tournament-update-error', (errorMsg) => {
            message(errorMsg)
        })

        socket.on('online-tournament-settings-updated', () => {
            // Request fresh data from parent
            socket.emit('is-td-online', id)
        })

        return () => {
            socket.off('tournament-updated')
            socket.off('tournament-update-error')
            socket.off('online-tournament-settings-updated')
        }
    }, [id, socket])

    // Update local state when parent sends new tournamentInfo
    useEffect(() => {
        console.log('Received new tournamentInfo:', initialTournamentInfo)
        if (initialTournamentInfo) {
            setTournamentInfo(initialTournamentInfo)
            const form = initialTournamentInfo
            const breakDurSec = form.break_duration ? form.break_duration : 60
            setSettings({
                name: form.name,
                system: form.pairing_system,
                rounds: form.rounds === 0 ? '' : form.rounds,
                startDate: form.start_date,
                timeControl: form.time_control,
                increment: form.increment,
                lateReg: form.late_reg || 0,
                breakDuration: breakDurSec,
                private: form.private ? true : false,
                finals: form.finals ? true : false,
                xot: form.xot ? true : false,
                withCategories: form.categories ? true : false,
                verifiedOnly: form.verified_only ? true : false,
                minRating: form.min_rating,
                maxRating: form.max_rating
            })
            
            // Recalculate edit permissions
            const now = new Date()
            const startDate = new Date(form.start_date)
            const timeDiff = startDate.getTime() - now.getTime()
            const notStarted = currentRound === 0
            const moreThan15Min = timeDiff >= minTimeDifference || timeDiff <= 0
            setCanEdit(notStarted && moreThan15Min && isTD)
            setTimeUntilStart(timeDiff)
        }
    }, [initialTournamentInfo, currentRound, isTD])

    const checkLetters = e => {
        if (e.key === 'Enter') roundsRef.current?.blur()
        forbidLetters.includes(e.key) && e.preventDefault()
    }

    const changeRounds = event => {
        const value = event.target.value
        let format = /^[0-9]+$/
        if ((value.length <= 2 && format.test(value) && parseInt(value) > 0 && !isNaN(parseInt(value))) || value.length === 0) {
            setSettings(prev => ({...prev, rounds: value === '' ? '' : parseInt(value)}))
            setValidRounds(value.length > 0)
            // Reset late registration if it exceeds new rounds value
            if (settings?.lateReg >= parseInt(value)) {
                setSettings(prev => ({...prev, lateReg: 0}))
            }
        }
    }

    const changeNameHandler = event => {
        const value = event.target.value
        setSettings(prev => ({...prev, name: value}))
        setValidName(value.length > 2 && checkTName(value))
    }

    const changeStartDateHandler = (event) => {
        const value = event.target.value
        const sDate = new Date(value)
        let minDate = new Date()
        const maxDate = new Date()
        minDate = new Date(minDate.getTime() + minTimeDifference)
        maxDate.setDate(maxDate.getDate() + 771)
        if (sDate >= minDate && sDate < maxDate) {
            setSettings(prev => ({...prev, startDate: sDate}))
            setValidStartDate(true)
        } else {
            setValidStartDate(false)
        }
    }

    const handleSystemChange = (value) => {
        setSettings(prev => ({...prev, system: value}))
        if (value === "Round Robin" || value === "Double Round Robin") {
            setSettings(prev => ({...prev, lateReg: 0, rounds: ''}))
            setValidRounds(false)
        }
    }

    const handleTimeControlChange = (value) => {
        const tc = parseInt(value)
        setSettings(prev => ({...prev, timeControl: tc}))
        const availableIncrements = timeControlOptions[tc] || [0]
        if (!availableIncrements.includes(settings?.increment)) {
            setSettings(prev => ({...prev, increment: 0}))
        }
    }

    const handleIncrementChange = (value) => {
        setSettings(prev => ({...prev, increment: parseInt(value)}))
    }

    const handleLateRegChange = (value) => {
        setSettings(prev => ({...prev, lateReg: parseInt(value)}))
    }

    const handleBreakDurationChange = (value) => {
        setSettings(prev => ({...prev, breakDuration: parseInt(value)}))
    }

    const handleMinRatingChange = (event) => {
        const value = event.target.value
        if (value === '' || (parseInt(value) >= 0 && parseInt(value) <= 3000)) {
            setSettings(prev => ({...prev, minRating: value === '' ? null : parseInt(value)}))
        }
    }

    const handleMaxRatingChange = (event) => {
        const value = event.target.value
        if (value === '' || (parseInt(value) >= 0 && parseInt(value) <= 3000)) {
            setSettings(prev => ({...prev, maxRating: value === '' ? null : parseInt(value)}))
        }
    }

    const toggleEditMode = () => {
        if (!canEdit) {
            if (tournamentInfo?.current_round > 0) {
                message('Cannot edit a tournament that has already started')
            } else if (timeUntilStart < minTimeDifference && timeUntilStart > 0) {
                message('Cannot edit tournament less than 15 minutes before start')
            }
            return
        }

        if (isEditing) {
            // Cancel editing - revert to original values
            socket.emit('get-online-info', id)
            setIsEditing(false)
            setBtnLabel('Edit Settings')
        } else {
            setIsEditing(true)
            setBtnLabel('Cancel')
        }
    }

    const saveSettings = () => {
        if (!validName) return message('Invalid tournament name')
        if (!validRounds && !isRoundRobin) return message('Invalid number of rounds')
        if (!validStartDate) return message('Invalid start date')

        socket.emit('update-online-tournament', id, settings)
    }

    const formatDate = (dateStr) => {
        if (!dateStr) return ''
        const date = new Date(dateStr)
        const optionsDate = {year: 'numeric', month: 'long', day: 'numeric'}
        const optionsTime = {hour: '2-digit', minute: '2-digit'}
        return `${date.toLocaleDateString(undefined, optionsDate)} ${date.toLocaleTimeString(undefined, optionsTime)}`
    }

    const formatDateInput = (dateStr) => {
        if (!dateStr) return ''
        const date = new Date(dateStr)
        const offset = date.getTimezoneOffset()
        const localDate = new Date(date.getTime() - (offset * 60 * 1000))
        return localDate.toISOString().slice(0, 16)
    }

    const formatTimeControl = (tc) => {
        return `${tc} min`
    }

    const formatIncrement = (increment) => {
        return `+ ${increment} sec`
    }

    const formatBreakDuration = (breakDuration) => {
        console.log('breakDuration', breakDuration)
        if (!breakDuration) return 'Not set'
        if (breakDuration < 60) return `${breakDuration}s`
        if (breakDuration === 60) return '1 min'
        if (breakDuration === 90) return '1 min 30s'
        if (breakDuration === 120) return '2 min'
        if (breakDuration === 180) return '3 min'
        if (breakDuration === 300) return '5 min'
        return `${Math.floor(breakDuration / 60)} min`
    }

    if (!tournamentInfo || !settings) {
        return <div className='big-text-empty'>Loading...</div>
    }

    return (
        <div>
            <TournamentTimer
                currentRound={currentRound}
                nextRoundStartTime={nextRoundStartTime}
                setNextRoundStartTime={setNextRoundStartTime}
                playersTab={true}
            />
            <div className="layout-new-tournament" style={{marginTop: timerVisible ? '40px' : '10px', paddingBottom: '100px', maxHeight: `${height - (timerVisible ? 200 : 160)}px`}}>
                <div className="card-content">
                    <input hidden={true} autoComplete='false'></input>
                    
                    <label className='lbl'>Name</label>
                    {isEditing ? (
                        <input 
                            className={`input ${validName ? 'valid' : ''}`}
                            placeholder="Enter tournament name"
                            type="text"
                            autoComplete="new-password"
                            onChange={changeNameHandler}
                            value={settings.name}
                        />
                    ) : (
                        <div className='info-value'>{settings.name}</div>
                    )}

                    <label className='lbl'>Start Date and Time</label>
                    {isEditing ? (
                        <input 
                            className={`input ${validStartDate ? 'valid' : ''}`}
                            type="datetime-local"
                            ref={startDateRef}
                            onChange={changeStartDateHandler}
                            defaultValue={formatDateInput(settings.startDate)}
                        />
                    ) : (
                        <div className='info-value'>{formatDate(settings.startDate)}</div>
                    )}

                    <label className='lbl'>Pairing System</label>
                    {isEditing ? (
                        <DropDownInput
                            options={systemOptions}
                            value={settings.system}
                            onChange={handleSystemChange}
                        />
                    ) : (
                        <div className='info-value'>{settings.system}</div>
                    )}

                    <div className='dates-container'>
                        <label className='lbl'>Time Control</label>
                        <label className='lbl'>Increment</label>
                    </div>
                    {isEditing ? (
                        <div className='dropdown-inline'>
                            <DropDownInput
                                options={Object.keys(timeControlOptions)}
                                value={settings.timeControl}
                                onChange={handleTimeControlChange}
                                formatOption={(opt) => `${opt} min`}
                            />
                            <DropDownInput
                                options={timeControlOptions[settings.timeControl] || [0]}
                                value={settings.increment}
                                onChange={handleIncrementChange}
                                formatOption={(opt) => `${opt} sec`}
                            />
                        </div>
                    ) : (
                        <div className='dates-container'>
                        <div className='info-value'>{formatTimeControl(settings.timeControl)}</div>
                        <div className='info-value'>{formatIncrement(settings.increment)}</div>
                        </div>
                    )}

                    {!isRoundRobin && (
                        <>
                            <label className='lbl'>Total Rounds</label>
                            {isEditing ? (
                                <input
                                    className={`input ${validRounds ? 'valid' : ''}`}
                                    ref={roundsRef}
                                    placeholder="Enter number of rounds"
                                    name='rounds'
                                    type="number"
                                    value={settings.rounds}
                                    max="99"
                                    onKeyDown={checkLetters}
                                    autoComplete="off"
                                    onChange={changeRounds}
                                />
                            ) : (
                                <div className='info-value'>{settings.rounds}</div>
                            )}
                        </>
                    )}

                    <div className='dates-container'>
                        <label className='lbl'>Late Registration</label>
                        <label className='lbl'>Break Duration</label>
                    </div>
                    {isEditing ? (
                        <div className='dropdown-inline'>
                            <DropDownInput
                                options={lateRegOptions}
                                value={settings.lateReg}
                                onChange={handleLateRegChange}
                                formatOption={(opt) => opt === 0 ? 'Disabled' : `Until round ${opt}`}
                                disabled={isRoundRobin}
                            />
                            <DropDownInput
                                options={breakDurationOptions}
                                value={settings.breakDuration}
                                onChange={handleBreakDurationChange}
                                formatOption={(opt) => {
                                    if (opt < 60) return `${opt}s`
                                    if (opt === 60) return '1 min'
                                    if (opt === 90) return '1 min 30s'
                                    if (opt === 120) return '2 min'
                                    if (opt === 180) return '3 min'
                                    if (opt === 300) return '5 min'
                                    return `${Math.floor(opt/60)} min`
                                }}
                            />
                        </div>
                    ) : (
                        <div className='dates-container'>
                            <div className='info-value'>{settings.lateReg === 0 ? 'Disabled' : `Until round ${settings.lateReg}`}</div>
                            <div className='info-value'>{formatBreakDuration(settings.breakDuration)}</div>
                        </div>
                    )}

                    <div className='dates-container'>
                        <label className='lbl'>Min Rating</label>
                        <label className='lbl'>Max Rating</label>
                    </div>
                    {isEditing ? (
                        <div className='dates-container'>
                            <input
                                className='input double'
                                type="number"
                                placeholder="No min"
                                min="0"
                                max="3000"
                                value={settings.minRating || ''}
                                onChange={handleMinRatingChange}
                            />
                            <input
                                className='input double'
                                type="number"
                                placeholder="No max"
                                min="0"
                                max="3000"
                                value={settings.maxRating || ''}
                                onChange={handleMaxRatingChange}
                            />
                        </div>
                    ) : (
                        <div className='dates-container'>
                            <div className='info-value'>
                                {settings.minRating
                                    ? `${settings.minRating}`                                       
                                    : 'No restrictions'}
                            </div>
                            <div className='info-value'>
                                {settings.maxRating
                                    ? `${settings.maxRating}`                                       
                                    : 'No restrictions'}
                            </div>
                        </div>
                    )}

                    {isEditing ? (
                        <SwitcherOnlineTournaments
                            flagTest={settings.private}
                            flagFinals={settings.finals}
                            flagCategories={settings.withCategories}
                            flagXOT={settings.xot}
                            flagVerifiedOnly={settings.verifiedOnly}
                            setSettings={setSettings}
                            defaultCategories={defaultCategories}
                        />
                    ) : (
                        <>
                            <label className='lbl'>Tournament Type</label>
                            <div className='info-value'>{settings.private ? 'Private (Invite Only)' : 'Open'}</div>
                            
                            {settings.verifiedOnly && (
                                <>
                                    <label className='lbl'>Verified Players Only</label>
                                    <div className='info-value'>Yes</div>
                                </>
                            )}
                            
                            {settings.xot && (
                                <>
                                    <label className='lbl'>XOT Tournament</label>
                                    <div className='info-value'>Yes</div>
                                </>
                            )}
                            
                            {settings.finals && (
                                <>
                                    <label className='lbl'>Has Finals</label>
                                    <div className='info-value'>Yes</div>
                                </>
                            )}
                        </>
                    )}
                </div>
            </div>

                <div className="btn-container-settings">
                    {canEdit && (
                        <button className={`btn-new-tournament${isEditing ? '' : ''}`} style={{position: 'relative', bottom: 'auto', backgroundColor: isEditing ? '#8b0100' : undefined}} onClick={toggleEditMode}>
                            {btnLabel}
                        </button>
                    )}
                    {isEditing && (
                        <button className="btn-new-tournament save" style={{position: 'relative', bottom: 'auto'}} onClick={saveSettings}>
                            Confirm Changes
                        </button>
                    )}
                </div>
        </div>
    )
}

export default SettingsOnlineNew
