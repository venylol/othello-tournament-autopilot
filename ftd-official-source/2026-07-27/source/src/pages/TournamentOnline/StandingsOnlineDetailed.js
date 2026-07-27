/**
 * StandingsOnlineDetailed.js
 * 
 * New detailed standings page for online tournaments.
 * Displays standings with round-by-round results in a single view.
 * 
 * Features:
 * - Player place, flag, nickname, rating
 * - Round results as colored discs (scrollable horizontally)
 * - Disc color = player's color in that round
 * - Disc outline = win (green) / draw (grey) / loss (red)
 * - Shows opponent's place or disc count inside the disc
 * - Cumulative score and MBQ tie-breaker
 * - BYE shown as "BYE", missed rounds as "-"
 * - In-progress games shown with "*" and pulsing animation
 * - Real-time updates when games finish
 * 
 * RESTRUCTURED: Uses single scroll container to prevent shaky scroll on mobile
 */

import React, { useContext, useEffect, useRef, useState } from "react"
import { getName } from 'country-list'
import { useWindowSize } from '../../hooks/resize.hook'
import { CountryFlags } from "../elements/CountryFlags"
import { useNavigate } from 'react-router-dom'
import { TournamentTimer } from './TournamentTimer'
import { AuthContext } from '../../context/AuthContext'
import { toNameCase } from '../functions/functions'
import './tournament.css'

// Round disc component - displays a single round result
const RoundDisc = ({ tournamentId, roundData, roundNum, standings, onHoverOpponent, isDragging, shouldPreventClick, verifiedOnly, viewerVerified }) => {
    const history = useNavigate()
    
    // Highlight opponent row on hover - but not while dragging
    const handleMouseEnter = () => {
        if (roundData.opponentPlayerId && !isDragging) {
            onHoverOpponent(roundData.opponentPlayerId)
        }
    }
    
    const handleMouseLeave = () => {
        onHoverOpponent(null)
    }
    
    // Handle click - prevent if user was dragging
    const handleClick = (navigateTo) => {
        if (shouldPreventClick.current) return
        history(navigateTo)
    }
    
    if (!roundData.played) {
        return <div className="round-disc not-played">-</div>
    }
    
    if (roundData.bye) {
        return <div className="round-disc bye">BYE</div>
    }
    
    // In-progress game
    if (roundData.inProgress) {
        const colorClass = roundData.color === 'black' ? 'disc-black' : 'disc-white'
        const opp = standings.find(p => p.player_id === roundData.opponentPlayerId)
        const oppName = (verifiedOnly && viewerVerified && opp?.wof_name) ? toNameCase(opp.wof_name) : (opp?.nick || '')
        
        return (
            <div 
                className={`round-disc ${colorClass} in-progress`} 
                title={`R${roundNum}: In progress vs ${oppName}`}
                onClick={() => handleClick(`/game/${tournamentId}_${roundData.game_id}`)}
                onMouseEnter={handleMouseEnter}
                onMouseLeave={handleMouseLeave}
            >
                <span className="disc-content">
                    <span className="disc-discs">*</span>
                    <span className="disc-place">{roundData.opponentPlace}</span>
                </span>
            </div>
        )
    }
    
    // Finished game
    const resultClass = roundData.result === 2 ? 'win' : roundData.result === 1 ? 'draw' : 'loss'
    const colorClass = roundData.color === 'black' ? 'disc-black' : 'disc-white'
    const opp = standings.find(p => p.player_id === roundData.opponentPlayerId)
    const oppName = (verifiedOnly && viewerVerified && opp?.wof_name) ? toNameCase(opp.wof_name) : (opp?.nick || '')
    
    return (
        <div 
            className={`round-disc ${colorClass} ${resultClass}`} 
            title={`R${roundNum}: ${roundData.discs} discs vs ${oppName}`}
            onClick={() => handleClick(`/tournaments/${tournamentId}/game/${roundData.game_id}`)}
            onMouseEnter={handleMouseEnter}
            onMouseLeave={handleMouseLeave}
        >
            <span className="disc-content">
                <span className="disc-discs">{roundData.discs}</span>
                <span className="disc-place">{roundData.opponentPlace}</span>
            </span>
        </div>
    )
}

export const StandingsOnlineDetailed = ({ id, socket, setTab, setRoundsByPlayerID, showBottomButton = false, tournamentStatus = 1, currentRound: parentCurrentRound, nextRoundStartTime, setNextRoundStartTime, verifiedOnly = false, viewerVerified = false }) => {
    const history = useNavigate()
    const { userId } = useContext(AuthContext)
    const [standings, setStandings] = useState([])
    const [lastRound, setLastRound] = useState(0)
    const [totalRounds, setTotalRounds] = useState(0)
    const [displayCurrentRound, setDisplayCurrentRound] = useState(0)
    const [isLoading, setIsLoading] = useState(true)
    const [highlightedPlayerId, setHighlightedPlayerId] = useState(null)
    const [isDragging, setIsDragging] = useState(false)
    const dragStartX = useRef(0)
    const scrollStartX = useRef(0)
    const shouldPreventClick = useRef(false)  // Prevent click if dragged more than threshold
    const containerRef = useRef(null)
    const bodyScrollRef = useRef(null)       // Single scroll container for entire table (both directions)
    const [width, listWidth, rowHeight, rowHeightExpanded, height] = useWindowSize(null, true, false)
    const timerVisible = !!nextRoundStartTime || tournamentStatus === 2
    // Fetch initial data
    useEffect(() => {
        socket.emit('get-detailed-standings-online', id)
        
        socket.on('detailed-standings-online', (data, lastRnd, totalRnds, currRnd) => {
            // Enrich round data with opponent's player_id
            const enrichedData = data.map(player => {
                const enrichedRounds = player.rounds.map(round => {
                    if (!round.played || round.bye) return round
                    
                    // Find opponent by place (opponentPlace is 1-indexed)
                    const opponentPlayer = data[round.opponentPlace - 1]
                    return { 
                        ...round, 
                        opponentPlayerId: opponentPlayer?.player_id 
                    }
                })
                return { ...player, rounds: enrichedRounds }
            })
            
            setStandings(enrichedData)
            setLastRound(lastRnd)
            setTotalRounds(totalRnds)
            setDisplayCurrentRound(currRnd || 0)
            setIsLoading(false)
        })
        
        return () => {
            socket.off('detailed-standings-online')
        }
    }, [socket, id])
    
    // Listen for real-time online/offline status changes (pre-start tournaments)
    useEffect(() => {
        socket.on('player-online-status', (playerId, isOnline) => {
            setStandings(prev => prev.map(p =>
                p.player_id === playerId ? { ...p, isOnline } : p
            ))
        })
        return () => {
            socket.off('player-online-status')
        }
    }, [socket])
    
    // No scrolling useEffect needed - RTL CSS direction handles showing latest rounds by default

    const getPlayersGames = (e) => {
        const playerNick = e.target.textContent
        history(`/tournaments/${id}/player/${encodeURIComponent(playerNick)}`)
    }

    const getTotalHeight = () => {
        const buttonOffset = showBottomButton ? 40 : 0
        const footerOffset = 50 // Bottom navigation footer
        // const headerOffset = timerVisible ? 130 : 100 // Navbar + standings header row (less when no timer)
        const headerOffset = 50 // Navbar + standings header row (less when no timer)
        const nextRoundOffset = timerVisible ? 50 : 0 // Space for timer if visible
        // console.log('standings height')
        console.log(height, headerOffset, buttonOffset, nextRoundOffset, standings.length * 45, Math.min((standings.length) * 45, height - headerOffset - buttonOffset - nextRoundOffset - footerOffset))
        return Math.min((standings.length) * 45 + 35, height - headerOffset - buttonOffset - nextRoundOffset - footerOffset)
    }

    const handleHoverOpponent = (playerId) => {
        setHighlightedPlayerId(playerId)
    }

    // Drag-to-scroll handlers
    const handleMouseDown = (e) => {
        // Only initiate drag on primary mouse button
        if (e.button !== 0) return
        setIsDragging(true)
        dragStartX.current = e.clientX
        scrollStartX.current = bodyScrollRef.current?.scrollLeft || 0
        shouldPreventClick.current = false  // Reset on new drag
        // Clear any highlighted opponent when starting drag
        setHighlightedPlayerId(null)
    }

    const handleMouseMove = (e) => {
        if (!isDragging || !bodyScrollRef.current) return
        e.preventDefault()
        const deltaX = e.clientX - dragStartX.current
        // If moved more than 20px, prevent click on mouse up
        if (Math.abs(deltaX) > 20) {
            shouldPreventClick.current = true
        }
        // RTL direction: positive deltaX should scroll left (decrease scrollLeft)
        bodyScrollRef.current.scrollLeft = scrollStartX.current - deltaX
    }

    const handleMouseUp = () => {
        setIsDragging(false)
        // Reset shouldPreventClick after a short delay to allow click event to check it
        setTimeout(() => {
            shouldPreventClick.current = false
        }, 50)
    }

    const handleMouseLeave = () => {
        setIsDragging(false)
    }

    if (isLoading) {
        return <div className='big-text-empty'>Loading standings...</div>
    }

    if (standings.length === 0) {
        return <div className='big-text-empty'>No standings available</div>
    }

    return (
        <>
            <TournamentTimer 
                currentRound={parentCurrentRound} 
                nextRoundStartTime={nextRoundStartTime} 
                setNextRoundStartTime={setNextRoundStartTime}
                tournamentStatus={tournamentStatus}
                playersTab={true}
            />
            <div 
                className="detailed-standings-container"
                ref={containerRef}
            >
                {/* Table with sticky columns and unified scroll */}
                <div 
                    className="standings-scroll-container" 
                    ref={bodyScrollRef}
                    style={{ maxHeight: (getTotalHeight()) + 'px' }}
                >
                    <div className="standings-table-inner">
                        {/* Header row */}
                        <div className="standings-row standings-header-row">
                            <div className="standings-col-left sticky-left">
                                <div className="standings-col place">#</div>
                                <div className="standings-col flag">{standings.length}</div>
                                <div className="standings-col name">Player</div>
                                <div className="standings-col rating">Rtg</div>
                            </div>
                            <div 
                                className={`standings-rounds-cols ${isDragging ? 'dragging' : ''}`}
                                onMouseDown={handleMouseDown}
                                onMouseMove={handleMouseMove}
                                onMouseUp={handleMouseUp}
                                onMouseLeave={handleMouseLeave}
                            >
                                {Array.from({ length: lastRound }, (_, i) => (
                                    <div key={i + 1} className="round-header">R{i + 1}</div>
                                ))}
                            </div>
                            <div className="standings-col-right sticky-right">
                                <div className="standings-col score">Pts</div>
                                <div className="standings-col mbq">MBQ</div>
                            </div>
                        </div>
                        
                        {/* Body rows */}
                        {standings.map((player, index) => {
                            const countryName = getName(player.country_code)
                            const isWithdrawn = player.left_after_round && player.left_after_round <= lastRound
                            const isHighlighted = highlightedPlayerId === player.player_id
                            
                            const isCurrentUser = player.player_id === userId
                            const isOffline = tournamentStatus === 1 && player.isOnline === false
                            
                            return (
                                <div 
                                    key={player.player_id} 
                                    data-player-id={player.player_id} 
                                    className={`standings-row standings-body-row ${isWithdrawn ? 'left' : ''} ${isHighlighted ? 'opponent-highlight' : ''} ${index % 2 === 1 ? 'odd' : ''}`}
                                >
                                    <div className={`standings-col-left sticky-left`}> 
                                        <div className="standings-col place">{index + 1}</div>
                                        <div className="standings-col flag">
                                            <CountryFlags countryName={countryName} countryCode={player.country_code} />
                                        </div>
                                        <div 
                                            className={`standings-col name clickable ${isCurrentUser ? 'my-nick' : ''} ${isOffline ? 'offline' : ''}`}
                                            onClick={getPlayersGames} 
                                            id={player.player_id}
                                        >
                                            {(verifiedOnly && viewerVerified && player.wof_name) ? toNameCase(player.wof_name) : player.nick}
                                        </div>
                                        <div className="standings-col rating">{player.rating || '-'}</div>
                                    </div>
                                    <div 
                                        className={`standings-rounds-cols ${isDragging ? 'dragging' : ''}`}
                                        onMouseDown={handleMouseDown}
                                        onMouseMove={handleMouseMove}
                                        onMouseUp={handleMouseUp}
                                        onMouseLeave={handleMouseLeave}
                                    >
                                        {player.rounds.map((roundData, rIdx) => (
                                            <RoundDisc 
                                                key={rIdx + 1} 
                                                tournamentId={id}
                                                roundData={roundData} 
                                                roundNum={rIdx + 1}
                                                standings={standings}
                                                onHoverOpponent={handleHoverOpponent}
                                                isDragging={isDragging}
                                                shouldPreventClick={shouldPreventClick}
                                                verifiedOnly={verifiedOnly}
                                                viewerVerified={viewerVerified}
                                            />
                                        ))}
                                    </div>
                                    <div className="standings-col-right sticky-right">
                                        <div className="standings-col score">{player.score ?? '-'}</div>
                                        <div className="standings-col mbq">{player.mbq ?? '-'}</div>
                                    </div>
                                </div>
                            )
                        })}
                    </div>
                </div>
            </div>
        </>
    )
}

export default StandingsOnlineDetailed
