import React, {useRef, useEffect, useContext, useState} from "react"
import { Cell } from "../elements/Cell"
import { PlayerInfo } from "../elements/PlayerInfo"
import { useNavigate } from 'react-router-dom'
import { UserContext } from "../../context/UserContext"
import { AuthContext } from '../../context/AuthContext';
import { clearLegalMoves, getPositions } from '../functions/getPositions'
import { toNameCase } from '../functions/functions'
import { SFXContext } from '../../context/SFXContext';

// Game Over Modal Component
// When reason is not 'score', winner gets 64-0 (black wins) or 0-64 (white wins)
const GameOverModal = ({ score, reason, onClick }) => {
    let blackScore = score[0]
    let whiteScore = score[1]
    
    // For non-score finishes (timeout, resignation, disconnect, abandonment),
    // display 64-0 or 0-64 based on who was winning
    if (reason && reason !== 'score' && reason !== null) {
        if (blackScore > whiteScore) {
            blackScore = 64
            whiteScore = 0
        } else {
            blackScore = 0
            whiteScore = 64
        }
    }
    
    const displayScore = `${blackScore} - ${whiteScore}`
    const showReason = reason && reason !== 'score' && reason !== null
    
    return (
        <div className="game-over-modal" onClick={onClick}>
            <div className="game-over-content">
                <div className="game-over-score">{displayScore}</div>
                {showReason && <div className="game-over-reason">{reason}</div>}
            </div>
        </div>
    )
}

const countDiscs = (currentPosition) => {
    let result = [0,0]
    for (let i = 0; i < currentPosition[0].length; i++ ) {
        for (let j = 0; j < currentPosition.length; j++) {
            if (currentPosition[i][j] === 'b') {
                result[0]++
            }
            if (currentPosition[i][j] === 'w') {
                result[1]++
            }
        }
    }    
    return result
}

// render starting position!

export const Replayer = ({round, tournamentId, gameId, tName, rName, byPlayer, byPlayerNick, sizes, finished, result, comment, reason, timeControl, increment, xot, verifiedOnly = false, viewerVerified = false}) => {
    console.log('replayer, tournament id:', tournamentId)
    const { settings } = useContext (UserContext) 
    const { socket } = useContext(AuthContext)
    const { playMove } = useContext (SFXContext)
    const [score, setScore] = useState([null, null])
    const [blackPlayer, setBlackPlayer] = useState(null)
    const [whitePlayer, setWhitePlayer] = useState(null)
    const [blackTimer, setBlackTimer] = useState(null)
    const [whiteTimer, setWhiteTimer] = useState(null)
    const [position, setPosition] = useState(null)
    const [transcript, setTranscript] = useState([])
    const [turn, setTurn] = useState(null)
    const [gameStatus, setGameStatus] = useState(false)
    const [lastMove, setLastMove] = useState(false)
    const [isLoading, setIsLoading] = useState(true)
    const [gameReason, setGameReason] = useState(reason)
    const [isGameOver, setIsGameOver] = useState(finished)
    const history = useNavigate()
    const gameTimeBlack = useRef(null)
    const gameTimeWhite = useRef(null)    
    
    const rows = [1,2,3,4,5,6,7,8]
    const cols = ['a','b','c','d','e','f','g','h']
    const color = 'black'

    // Update game over state when props change (e.g., when reason is set from parent)
    useEffect(() => {
        if (finished) {
            setIsGameOver(true)
        }
        if (reason) {
            setGameReason(reason)
        }
    }, [finished, reason])
    
    useEffect (() => {
        // get game from backend - if finished from DB else from lobby.
        socket.on(`get-tournament-game-${gameId}`, (game) => {
            console.log(game)
            if(game.roundId === gameId && game.round === round) {
                setGameStatus(game.status)
                setTranscript(game.transcript)
                setTurn(game.turn)
                setBlackPlayer(game.black)
                setWhitePlayer(game.white)
                setBlackTimer(game.black.timer)
                setWhiteTimer(game.white.timer)
                if(!game.position) {
                    const pos = getPositions(game.transcript, false)
                    setScore(countDiscs(pos.positionTable[pos.positionTable.length - 1]))  
                    setPosition(pos.positionTable[pos.positionTable.length - 1]) 
                } else {
                    setPosition(clearLegalMoves(game.position))
                    setScore(countDiscs(game.position))
                }
                
                // Check if game is already finished when loaded
                if (game.status === 'finished' || game.finished) {
                    setIsGameOver(true)
                    if (game.reason) setGameReason(game.reason)
                }
                
                setIsLoading(false)     
            }           
        })
        return () => {
            socket.off('get-tournament-game')
        }
    },[round, tournamentId, gameId])

    useEffect(() => {
        console.log(gameId, isLoading)
    },[gameId, isLoading])

    useEffect (() => {
        socket.on('new-move', game => {
            if (game?.roundId !== gameId) return
            if (settings.sound) {
                playMove()
            }
            const moveNumber = game.transcript.length / 2
            setTranscript(game.transcript)
            setPosition(clearLegalMoves(JSON.parse(JSON.stringify(game.position))))
            setLastMove(moveNumber === 0 ? '' : game.transcript.slice((moveNumber - 1) * 2, (moveNumber) * 2))
            setScore(countDiscs(game.position))
            setBlackTimer(game.blackTimer)
            setWhiteTimer(game.whiteTimer)
            
            if (game.status === 'finished') { // handle game over event
                setGameStatus(game.status)
                setIsGameOver(true)
                if (game.reason) setGameReason(game.reason)
                return
            }
            if (game.turn === color) {
                gameTimeWhite.current.pause()
                gameTimeBlack.current.start()
            }
    
            if (game.turn !== color) {
                gameTimeBlack.current.pause()
                gameTimeWhite.current.start()
            }
    
            if (game.turn !== color && game.turn) {
                gameTimeWhite.current.start()
            }
        })
        return () => {
            socket.off('new-move')
        }
    },[round, tournamentId, gameId, settings])
    

    useEffect (() => {
        if (!gameTimeWhite || !gameTimeBlack || isGameOver) return
        if (turn === 'white') {
            gameTimeWhite.current?.start()
        } else {
            gameTimeBlack.current?.start()
        }
    },[gameTimeWhite, gameTimeBlack, turn, isGameOver])

    // Listen for game result event (timeout, resignation, etc.)
    useEffect (() => {
        const handleNewResult = (resultGameId, resultScore, resultReason) => {
            if (resultGameId === gameId) {
                setScore([resultScore, 64 - resultScore])
                setGameReason(resultReason)
                setIsGameOver(true)
                // Stop timers
                gameTimeBlack.current?.pause()
                gameTimeWhite.current?.pause()
            }
        }
        socket.on('online-get-new-result', handleNewResult)
        return () => {
            socket.off('online-get-new-result', handleNewResult)
        }
    },[gameId])

    
    
    const params = { 
        '--board-size' : sizes.boardSize + 'px',
        '--cell-size': sizes.boardSize * 0.114795919 + 'px',
        '--board-margin': sizes.boardSize * 0.040815689 + 'px',
        '--disc-size': 35 + 'px',
        '--board-size-full' : sizes.boardSize + 'px',
        '--cell-size-full': sizes.boardSize * 0.114795919 + 'px',
        '--board-margin-full': sizes.boardSize * 0.040815689 + 'px',
        'maxWidth': '500px',
        'cursor': 'pointer',
    }

    const toCapitalized = (str) => {
        return str.charAt(0).toUpperCase() + str.slice(1)
    }

    const reverseColor = color => {
        return color === 'black' ? 'white' : 'black'
    }

    function isLastMove (cell) {
        if(cell === lastMove) {
            return true
        } 
        return false
    }

    const discColors = (cell) => {              // checking the color of disc in cell
        if (position[cell[0]][cell[1]] === 'b') {
            return 'black'
        }
        if (position[cell[0]][cell[1]] === 'w') {
            return 'white'
        }
        return
    }

    function isCellEmpty (cell) {  
        if (position[cell[0]][cell[1]] === 'w' || position[cell[0]][cell[1]] === 'b') {
            return false
        }
        return true
    }

    const openFullScreen = (e) => {
        // e.preventDefault()
        
        if(isGameOver) {
            const data = [{...blackPlayer, transcript: transcript, score: result, reason: reason, comment: comment, timer: timeControl * 60000}, {...whitePlayer, timer: timeControl * 60000}]
            history(`/tournaments/${tournamentId}/game/${gameId}`, {
                state: { 
                    turn: turn, 
                    move: 0,
                    data: data,
                    round: round,
                    tName: tName,
                    rName: rName,
                    byPlayer: byPlayer,
                    byPlayerNick: byPlayerNick,
                    canEdit: false,
                    timeControl: timeControl,
                    xot: xot
                }
            })
            return
        }
        console.log(`/game/${tournamentId}_${round}_${gameId}`)
        history(`/game/${tournamentId}_${gameId}`)
    }
    

    return (
        <>
            <div style = {params} className = 'replayer' onClick = {openFullScreen} >
                <div style = {{height: 10}}></div>
                {!isLoading ? 
                <>
                <PlayerInfo 
                    nickName = {(verifiedOnly && viewerVerified && blackPlayer?.wof_name) ? toNameCase(blackPlayer.wof_name) : blackPlayer?.nick}
                    color = {color}
                    score = {score[0]}
                    country = {blackPlayer?.country}
                    hideFooter = {false}
                    avatar = {false}  
                    withTimer = {true} 
                    isStreamer = {false}
                    timer = {blackTimer} 
                    ref = {gameTimeBlack}                
                />
                <div style = {{height: 10}}></div>
                <div className="board-container">
                {isGameOver && (
                    <GameOverModal 
                        score={score} 
                        reason={gameReason} 
                        onClick={openFullScreen}
                    />
                )}
                <div className= 'notation'>
                    <div className= 'frame'>
                        <div className= 'x-axis'>
                            <div className= 'cell-letter'>A</div>
                            <div className= 'cell-letter'>B</div>
                            <div className= 'cell-letter'>C</div>
                            <div className= 'cell-letter'>D</div>
                            <div className= 'cell-letter'>E</div>
                            <div className= 'cell-letter'>F</div>
                            <div className= 'cell-letter'>G</div>
                            <div className= 'cell-letter'>H</div>
                        </div>
                        <div className= 'y-axis'>
                            <div className= 'cell-number'>1</div>
                            <div className= 'cell-number'>2</div>
                            <div className= 'cell-number'>3</div>
                            <div className= 'cell-number'>4</div>
                            <div className= 'cell-number'>5</div>
                            <div className= 'cell-number'>6</div>
                            <div className= 'cell-number'>7</div>
                            <div className= 'cell-number'>8</div>
                        </div>
                        <div className = 'board-dots'>
                            <div className = 'board-dot-1'></div>
                            <div className = 'board-dot-2'></div>
                            <div className = 'board-dot-3'></div>
                            <div className = 'board-dot-4'></div>
                        </div>
                        <div className= 'board'>
                            <div className="board-overlay-live" onClick={openFullScreen}></div>
                            {rows.map((row, i) => cols.map((col, j) => 
                            <Cell 
                                id = {cols[j] + rows[i]} 
                                isEmpty = {isCellEmpty([i, j])}
                                isLastMove = {isLastMove(cols[j] + rows[i])}
                                isLegalMove = {false}
                                discColor = {discColors([i, j])}
                                value = {`${i},${j}`}
                                settings = {{showLegalMoves: false, markLastMove: true}}
                                turn = {turn}
                                key = {cols[j]+rows[i]}/>
                            ))}   
                        </div>
                    </div>   
                </div>
                </div>
                <PlayerInfo 
                    nickName = {(verifiedOnly && viewerVerified && whitePlayer?.wof_name) ? toNameCase(whitePlayer.wof_name) : whitePlayer?.nick}
                    color = {reverseColor(color)}
                    score = {score[1]}
                    country = {whitePlayer?.country} 
                    hideFooter = {false}
                    avatar = {false} 
                    withTimer = {true}
                    isStreamer = {false}
                    timer = {whiteTimer}   
                    ref = {gameTimeWhite}                
                />
                </>
                : <></>}
                <div style = {{height: 10}}></div>
            </div>
        </>
    )
}