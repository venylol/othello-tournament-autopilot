import React, {useEffect, useRef, useState, useContext} from "react"
import { useParams, useNavigate } from 'react-router-dom'
import { useWindowSize } from '../../hooks/resize.hook'
import { AuthContext } from '../../context/AuthContext'
import { UserContext } from '../../context/UserContext'
import { LayoutContext } from '../../context/LayoutContext'
import { Row } from "./RowRounds"
import { TournamentTimer } from './TournamentTimer'

/**
 * RoundsByPlayerOnline - displays all games of a single player in an online tournament.
 * Accessible via /tournaments/:id/player/:nick
 * 
 * Behaves like the Rounds tab but only shows games for one player (R1 to current round).
 * Supports real-time updates: new moves, new rounds, finished games.
 */
export const RoundsByPlayerOnline = ({ id, tName, xot, nextRoundStartTime, setNextRoundStartTime, tournamentStatus, currentRound, verifiedOnly = false, viewerVerified = false }) => {
    const { nick } = useParams()
    const history = useNavigate()
    const { socket } = useContext(AuthContext)
    const { isOnline, isMobile } = useContext(UserContext)
    const [width, listWidth, rowHeight, rowHeightExpanded, height, offsetY, boardSize] = useWindowSize(null, true, isMobile)
    const [pairings, setPairings] = useState([])
    const [playerNick, setPlayerNick] = useState(nick || '')
    const [timeControl, setTimeControl] = useState(null)
    const [increment, setIncrement] = useState(null)
    const [isLoading, setIsLoading] = useState(true)

    const timerVisible = !!nextRoundStartTime || tournamentStatus === 2

    const getTotalMaxHeight = () => {
        const timerOffset = timerVisible ? 50 : 0
        return height - 85 - timerOffset
    }

    // Fetch player's rounds on mount / when nick changes
    useEffect(() => {
        socket.emit('get-rounds-by-player-online', id, nick)

        socket.on('online-rounds-by-player', (data) => {
            // console.log('online-rounds-by-player', data)
            if (!data.playerId) {
                history('/tournaments/' + id)
                return
            }
            setPairings(data.pairing || [])
            setPlayerNick(data.playerNick || nick)
            setTimeControl(data.timeControl)
            setIncrement(data.increment)
            setIsLoading(false)
        })

        return () => {
            socket.off('online-rounds-by-player')
        }
    }, [socket, id, nick])

    // Listen for new rounds being added (re-fetch player data)
    useEffect(() => {
        const handleUpdate = (text, reason) => {
            if (reason === 'rounds' || reason === 'new-round' || reason === 'tournament-started') {
                socket.emit('get-rounds-by-player-online', id, nick)
            }
        }
        socket.on('online-update', handleUpdate)
        return () => {
            socket.off('online-update', handleUpdate)
        }
    }, [socket, id, nick])

    if (isLoading) {
        return <div className='big-text-empty'>Loading...</div>
    }

    if (pairings.length === 0) {
        return (
            <div>
                <TournamentTimer currentRound={currentRound} nextRoundStartTime={nextRoundStartTime} setNextRoundStartTime={setNextRoundStartTime} tournamentStatus={tournamentStatus} />
                <div className='big-text player' style={{marginTop: '50px'}}>{`Games of ${playerNick}`}</div>
                <div className='big-text-empty'>No games were played</div>
            </div>
        )
    }

    return (
        <div>
            <TournamentTimer currentRound={currentRound} nextRoundStartTime={nextRoundStartTime} setNextRoundStartTime={setNextRoundStartTime} tournamentStatus={tournamentStatus} />
            <div className='big-text player' style={{marginTop: '50px'}}>{`Games of ${playerNick}`}</div>
            <div className='table-container' style={{'--offset': '85px'}}>
                <div className="list ot" style={{width: listWidth + 'px', maxHeight: getTotalMaxHeight() + "px", overflow: 'scroll'}}>
                    {pairings.map((pair, idx) =>
                        <Row    
                            pair={pair}
                            round={pair[0]?.round}
                            row={idx}
                            isCategory={typeof pair === 'string'}
                            key={idx}
                            id={id}
                            tName={tName}
                            rName={null}
                            timeControl={timeControl}
                            increment={increment}
                            isFirstGame={idx === 0}
                            xot={xot}
                            showRoundNumber={true}
                            byPlayerNick={nick}
                            verifiedOnly={verifiedOnly}
                            viewerVerified={viewerVerified}
                        />
                    )}
                </div>
            </div>
        </div>
    )
}

export default RoundsByPlayerOnline
