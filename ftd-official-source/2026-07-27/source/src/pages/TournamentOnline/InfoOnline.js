import React, {useEffect} from 'react'
import { TournamentTimer } from './TournamentTimer'
import './tournament.css'

export const InfoOnline = ({id, socket, showBottomButton = false, currentRound, nextRoundStartTime, setNextRoundStartTime, tournamentStatus = 1, tournamentInfo, setTournamentInfo}) => {
    // Determine if timer is visible (when nextRoundStartTime exists or tournament is cancelled)
    const timerVisible = !!nextRoundStartTime || tournamentStatus === 2
    const height = window.innerHeight
    console.log('tournamentInfo', id, socket, showBottomButton = false, currentRound, nextRoundStartTime, setNextRoundStartTime, tournamentStatus = 1, tournamentInfo)

    useEffect(() => {
        // Listen for settings updates to refresh data from parent
        const handleSettingsUpdate = () => {
            // Re-fetch tournament info when settings change
            socket.emit('is-td-online', id)
        }

        console.log('tournamentInfo', tournamentInfo)
        
        socket.on('online-tournament-settings-updated', handleSettingsUpdate)
        
        return () => {
            socket.off('online-tournament-settings-updated', handleSettingsUpdate)
        }
    }, [id, socket])

    if (!tournamentInfo) {
        return <div className='big-text-empty'>Loading...</div>
    }

    const formatDate = (dateStr) => {
        if (!dateStr) return null
        const date = new Date(dateStr)
        const optionsDate = {year: 'numeric', month: 'long', day: 'numeric'}
        const optionsTime = {hour: '2-digit', minute: '2-digit'}
        return `${date.toLocaleDateString(undefined, optionsDate)} ${date.toLocaleTimeString(undefined, optionsTime)}`
    }

    const formatTimeControl = (tc, increment) => {
        if (increment && increment > 0) {
            return `${tc} + ${increment}`
        }
        return `${tc} min`
    }

    const formatBreakDuration = (breakDuration) => {
        console.log('breakDuration info', breakDuration)
        if (!breakDuration) return null
        const minutes = Math.floor(breakDuration / 60)
        if (minutes < 1) {
            return `${Math.floor(breakDuration)} seconds`
        }
        return `${minutes} minute${minutes > 1 ? 's' : ''}`
    }

    return (
        <div > 
            <TournamentTimer
                currentRound = {currentRound} 
                nextRoundStartTime = {nextRoundStartTime}
                setNextRoundStartTime = {setNextRoundStartTime}
                playersTab = {true}
                tournamentStatus = {tournamentStatus}
            />
            <div className = "layout-new-tournament" style ={{marginTop: timerVisible ? '20px' : '5px', marginBottom: '0', paddingBottom: showBottomButton ? '60px' : '30px', maxHeight: `${height - (timerVisible ? 145 : 130) - (showBottomButton ? 50 : 0)}px`}}>
                <div className="card-content info-view">
                    {tournamentInfo.event_name && (
                        <>
                            <label className='lbl'>Event</label>
                            <div className='info-value'>{tournamentInfo.event_name}</div>
                        </>
                    )}
                    
                    <label className='lbl'>Tournament Name</label>
                    <div className='info-value'>{tournamentInfo.name}</div>
                    
                    <label className='lbl'>Start Date</label>
                    <div className='info-value'>{formatDate(tournamentInfo.start_date)}</div>
                    
                    <label className='lbl'>Pairing System</label>
                    <div className='info-value'>{tournamentInfo.pairing_system}</div>
                    
                    {tournamentInfo.rounds > 0 && (
                        <>
                            <label className='lbl'>Number of Rounds</label>
                            <div className='info-value'>{tournamentInfo.rounds}</div>
                        </>
                    )}
                    
                    {tournamentInfo.break_duration && (
                        <>
                            <label className='lbl'>Break Between Rounds</label>
                            <div className='info-value'>{formatBreakDuration(tournamentInfo.break_duration)}</div>
                        </>
                    )}
                    
                    {tournamentInfo.xot ? (
                        <>
                            <label className='lbl'>XOT</label>
                            <div className='info-value'>Yes</div>
                        </>
                    ) : null}
                    
                    <label className='lbl'>Time Control</label>
                    <div className='info-value'>{formatTimeControl(tournamentInfo.time_control, tournamentInfo.increment)}</div>
                    
                    <label className='lbl'>Tournament Type</label>
                    <div className='info-value'>{tournamentInfo.private ? 'Private (Invite Only)' : 'Open'}</div>
                    
                    {tournamentInfo.verified_only ? (
                        <>
                            <label className='lbl'>Verified Players Only</label>
                            <div className='info-value'>Yes</div>
                        </>
                    ) : null}
                    
                    {(tournamentInfo.min_rating || tournamentInfo.max_rating) && (
                        <>
                            <label className='lbl'>Rating Range</label>
                            <div className='info-value'>
                                {tournamentInfo.min_rating && tournamentInfo.max_rating 
                                    ? `${tournamentInfo.min_rating} - ${tournamentInfo.max_rating}`
                                    : tournamentInfo.min_rating 
                                        ? `${tournamentInfo.min_rating}+`
                                        : `Up to ${tournamentInfo.max_rating}`}
                            </div>
                        </>
                    )}
                    
                    {tournamentInfo.late_reg > 0 && (
                        <>
                            <label className='lbl'>Late Registration</label>
                            <div className='info-value'>Until round {tournamentInfo.late_reg}</div>
                        </>
                    )}
                </div>
            </div>
        </div>
    )
}

export default InfoOnline
