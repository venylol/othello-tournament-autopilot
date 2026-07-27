import React, {useRef, useEffect, useContext, useState, useCallback} from "react"
import { useParams, useNavigate, useLocation } from 'react-router-dom'
import { Helmet } from "react-helmet";
import { Cell } from "../../elements/Cell"
import { PlayerInfo } from "../../elements/PlayerInfo"
import { LayoutContext } from '../../../context/LayoutContext'
import { UserContext } from '../../../context/UserContext'
import { useBoardSize } from "../../../hooks/board.size.hook";
import { useSwipe } from '../../../hooks/swipe.hook'
import { AuthContext } from '../../../context/AuthContext'
import { clearLegalMoves, getPositions, getFinalScore, makeNewMove, stringToIndex } from '../../functions/getPositions'
import { NavBar } from '../../elements/navbar/NavBar'
import { EvalBar } from './EvalBar'
import { EvalGraph } from './EvalGraph'
import { getFullRoundName, getFullGameName, rotate, rotateCell, formatTextTranscript, checkTranscript, debounce, toNameCase } from '../../functions/functions'
import { BackButtonSVG, ForwardButtonSVG, MaxBackButtonSVG, MaxForwardButtonSVG, EditButtonSVG, CopyButtonSVG, AnalyzeSVG } from '../../elements/SVG'
import '.././tournament.css'
import { FooterGameOTB } from "./FooterGame"
import { EmptyBoard } from "./EmptyBoard"
import { useSensei } from "../../../hooks/sensei.hook"
import { SFXContext } from '../../../context/SFXContext';
import { ModalLoading } from '../../elements/ModalLoading';
import { toast } from 'react-toastify';
import { TournamentTimer } from '../TournamentTimer';

const formatEvalsForEvalBar = (evals, xotOffset = 0) => {
    if (!evals) return [] 
    const result = []
    const black = evals[0].player_id 
    for (let i = 0; i < evals.length; i++) {
        if (evals[i].player_id === black || evals[i].best_eval === 0) {
            result.push({move_number: evals[i].move_number - 1 + xotOffset, best_eval: evals[i].best_eval})
        } else {
            result.push({move_number: evals[i].move_number - 1 + xotOffset, best_eval: evals[i].best_eval * -1})
        }
    }

    if (evals[evals.length - 1].player_id === black || evals[evals.length - 1].best_eval === 0) {
        result.push({move_number: evals[evals.length - 1].move_number + xotOffset, best_eval: evals[evals.length - 1].best_eval})
    } else {
        result.push({move_number: evals[evals.length - 1].move_number + xotOffset, best_eval: evals[evals.length - 1].best_eval * -1})
    }
    // console.log('formatted evals for bar', result)
    return result
}

// const formatEvalsForPlayer = (evals, player) => {
//     if (!evals || !player?.id) return null
//     let moveCount = 0
//     let discsLost = 0 
//     for (let i = 0; i < evals.length; i++) {
//         if (evals[i].player_id === player.id) {
//             moveCount++
//             discsLost = discsLost + (evals[i].best_eval - evals[i].eval) / 2
//         }
//     }
//     const adl = Math.round(100 * discsLost / moveCount) / 100
//     const average = adl.toLocaleString("en", { minimumFractionDigits: 2 })
//     return {discsLost, average}
// }

const countLegalMoves = (position) => {
    if (!position) {
        console.log('empty position in countLegalMoves')
        return 0
    }
    let result = 0
    for (let i = 0; i < position[0].length; i++) {
        for (let j = 0; j < position.length; j++) {
            if(position[i][j] === 'l') result++
        }
    }
    return result
}

const transcriptToChat = (str) => {
    if (!str || str?.length === 0) return []
    let message = '1. ' + str.substring(0,2)
    for (let i = 2; i < str.length; i+=2) {
        message+= " " + (i/2 + 1) + ". " + str.substring(i,i+2)
    }
    // console.log(message)
    return [{message: message, sender: 'system'}]
}

const startingPosition = [
    ['','','','','','','',''],
    ['','','','','','','',''],
    ['','','','l','','','',''],
    ['','','l','w','b','','',''],
    ['','','','b','w','l','',''],
    ['','','','','l','','',''],
    ['','','','','','','',''],
    ['','','','','','','','']
]

// cases:
// TD/Player/Assistant - allowed to stream
// 1. live game being streamed (player - no chat, no evals, no edit)
// 2. insert transcript
// 3. finished game

const MAX_BOOK_MOVE = 36;
const START_EVALS = [{move: 'd3', score: 0, descendants: 0, is_book: true},
    {move: 'c4', score: 0, descendants: 0, is_book: true},
    {move: 'f5', score: 0, descendants: 0, is_book: true},
    {move: 'e6', score: 0, descendants: 0, is_book: true}
]

export const OnlineTournamentGame = () => { 
    //get only players, game info, transcript and move number
    //id, round, tournamentID, transcript, comment, positionTable, turn, move, data, setPosition, sizes, isTD
    
    // on swipe - lock UI before we get new game and then start the animation
    const {id, gameId} = useParams() 
    const location = useLocation()
    const isReplay = !id
    const fromProfileRef = useRef(location.state?.fromProfile || null)
    const autoAnalyzeRef = useRef(!!location.state?.autoAnalyze)
    const [tName, setTName] = useState(' ')
    const [rName, setRName] = useState('')
    const [gName, setGName] = useState('')
    const [isTD, setIsTD] = useState(false)
    const [isPlayer, setIsPlayer] = useState(false)
    const [gameResult, setGameResult] = useState(null)
    const [scoreByTranscript, setScoreByTranscript] = useState(-1)
    const [lastMove, setLastMove] = useState('')
    const [transcript, setTranscript] = useState('')
    const [loading, setLoading] = useState(true)
    const [editMode, setEditMode] = useState(false)
    // const [allowedToStream, setAllowedToStream] = useState(false)
    const [board, setBoard] = useState(JSON.parse(JSON.stringify(startingPosition)))
    const [positionTable, setPositionTable] = useState([])
    const [blackPlayer, setBlackPlayer] = useState()
    const [whitePlayer, setWhitePlayer] = useState()
    const [verifiedOnly, setVerifiedOnly] = useState(false)
    const [viewerVerified, setViewerVerified] = useState(false)
    const [round, setRound] = useState()
    const [move, setMove] = useState(0)
    const [turn, setTurn] = useState('b')
    const [timers, setTimers] = useState([])
    const [turns, setTurns] = useState([])
    const [score, setScore] = useState([])
    const [finished, setFinished] = useState(false)
    const [reason, setReason] = useState(null)
    const [next, setNext] = useState(null)
    const [hasNewMove, setHasNewMove] = useState(false)
    const [comment, setComment] = useState()
    const [byPlayer, setByPlayer] = useState(false)
    const [evals, setEvals] = useState([])
    const [evalBarData, setEvalBarData] = useState(0)
    const [evalGraphData, setEvalGraphData] = useState([])
    const [showEvals, setShowEvals] = useState(false)
    const [showSenseiSettings, setShowSenseiSettings] = useState(false)
    const [senseiSecondsPerPos, setSenseiSecondsPerPos] = useState(() => {
        const stored = localStorage.getItem('senseiSecondsPerPos')
        return stored ? Math.min(20, Math.max(1, parseInt(stored))) : 1
    })
    const [senseiSettingsInput, setSenseiSettingsInput] = useState(() => {
        const stored = localStorage.getItem('senseiSecondsPerPos')
        return stored ? String(Math.min(20, Math.max(1, parseInt(stored)))) : '1'
    })
    const [nextGameReq, setNextGameReq] = useState()
    const [rotation, setRotation] = useState(0)
    const [rows, setRows] = useState([1,2,3,4,5,6,7,8])
    const [cols, setCols] = useState(['a','b','c','d','e','f','g','h'])
    const [nextRoundStartTime, setNextRoundStartTime] = useState(null)
    const moveRef = useRef(null)
    const transRef = useRef(null)
    const mainBoardRef = useRef(null)
    const animation = useRef(null)
    const p1Ref = useRef(null)
    const p2Ref = useRef(null)
    const editRef = useRef(null)
    const disconnectRef = useRef(null)
    const positionToAnalyze = useRef(null)
    const isXot = useRef (null)
    const serverAnalysisRef = useRef(false) // true when server already has analysis for this game
    
    const { socket } = useContext(AuthContext)
    const { settings, isOnline, typing, messages, setMessages, isMobile, setIsPlaying, nick: myNick } = useContext (UserContext)
    const { playMove } = useContext (SFXContext)
    const { sensei, status, senseiReady, hintedOnce, hintEvals, edaxBookEmpty, senseiHint, senseiStop, updateHintEvals, setHintEvals, hintEvalsFlag, evalsTable, evalsRef, editModeRef, xotOffsetRef, setHintedOnce, retroAnalysis, retroStatus, retroCurrentIndex, senseiAnalyzeGame, senseiSetGame, senseiStopRetro, resetRetro, modeRef, onRetroCompleteRef } = useSensei('../../../')
   
    const history = useNavigate ()
    
    const {width, height, offsetY, gameBoard, fullBoard, totalHeight, keyboard} = useBoardSize()
    const { onTouchStart, onTouchMove, onTouchEnd } = useSwipe(socket, id, gameId, byPlayer, setNextGameReq)

    const color = 'black' 

    const params = { 
        '--board-size' : gameBoard + 'px',
        '--cell-size': gameBoard * 0.114795919 + 'px',
        '--board-margin': gameBoard * 0.040815689 + 'px',
        '--board-size-full' : fullBoard + 'px',
        '--cell-size-full': fullBoard * 0.114795919 + 'px',
        '--board-margin-full': fullBoard * 0.040815689 + 'px',
        '--global-height': height + 'px',
        'maxWidth': '500px',
    }

// clear everything if it is a new game

    useEffect(() => {
        setHintedOnce(false)
        setHintEvals([])
        setEvals([])
        setShowEvals(false)
        setEditMode(false)
        setHasNewMove(false)
        setMessages([])
        setEvalGraphData([])
        evalsRef.current = []
        edaxBookEmpty.current = MAX_BOOK_MOVE
        evalsTable.current = [START_EVALS]
        disconnectRef.current = null
        editRef.current = null
        editModeRef.current = false
        isXot.current = null
        xotOffsetRef.current = 0
        serverAnalysisRef.current = false
        resetRetro()
    },[id, gameId])

    // Tournament update notifications in game page - join tournament room to receive updates
    useEffect(() => {
        if (isReplay) return
        // Join the tournament room to receive online-update events
        socket.emit('join-online-tournament', id)
        
        const InfoToast = (text) => {
            return (
                <div className="notification-nav" onClick={() => history(`/tournaments/${id}`)}>
                    <span>{text}</span>
                    <span style={{display: 'block', fontSize: '12px', marginTop: '4px', color: '#aaa'}}>Tap to go to tournament</span>
                </div>
            )
        }
        
        socket.on('online-update', (text, reason, nextRoundStarts) => {
            setNextRoundStartTime(nextRoundStarts)
            toast.clearWaitingQueue()
            toast.dismiss()
            toast.info(InfoToast(text))
        })
        
        return () => {
            socket.off('online-update')
        }
    }, [id, history, socket])

    useEffect (() => {
        socket.on('online-game-analysis', data => {
            if(data && data?.length > 0) {
                serverAnalysisRef.current = true
                setEvals(data)
                setEvalGraphData(formatEvalsForEvalBar(data, isXot.current ? 8 : 0))
                evalsRef.current = data
            }
        })
        socket.on('online-game', (data, timers) => { // set all the data 
            if(!data) {
                history(`/tournaments/${id}`)
                return
            }
            setIsTD(data.isTD)
            // if((data.isTD || data.isPlayer) && data.pairing[0].score !== null) setIsPlaying(true)
            setIsPlayer(data.isPlayer)
            setVerifiedOnly(data.verifiedOnly || false)
            setViewerVerified(data.viewerVerified || false)
            setGameResult(data.pairing[0].score)
            setRound(data.round)
            setComment(data.pairing[0]?.comment)
            setFinished(data.finished)
            setReason(data.reason)
            setBlackPlayer(data.pairing[0])
            setWhitePlayer(data.pairing[1])
            isXot.current = data.xot
            xotOffsetRef.current = data.xot ? 8 : 0
            if(data.xot) {
                const arr = []
                for (let i = 0; i < 8; i++) {
                    arr.push(timers[0])
                }
                setTimers(arr.concat(timers))
            } else {
                setTimers(timers)
            }
            
            setTName(data.tName)
            setRName(data.rName)
            setGName(data.pairing[0].gameName)
            const transcript = data.pairing[0]?.transcript
            const pos = getPositions(transcript, true)
            setMessages(transcriptToChat(transcript))
            
            

            // ?? this is wrong actually we should render / change messages only after we receive chat from server
            // if there were no game - set everything as usual
            // if editMode - update editModeRef, leave the rest as is
            // if !editMode (disconnect) - do the same, i'll need transcript, moveNumber and that's it
            const scoreTrans = getFinalScore(pos.positionTable[pos.positionTable.length - 1], !transcript? 'b' : pos.turns[pos.turns.length - 1])
            setScoreByTranscript(scoreTrans)
            // if(scoreTrans === -1 && (data.isTD || data.isPlayer)) setAllowedToStream(true)

// disconnect during editMode
            if(editRef.current !== null) {
                // console.log('editMode')
                editRef.current.positionTable =  JSON.parse(JSON.stringify(pos.positionTable))
                editRef.current.transcript = transcript
                editRef.current.turns = pos.turns
                if (disconnectRef.current !== transcript) {
                    setHasNewMove(true)
                }
            } 
// new game, not a disconnect
            if((!disconnectRef.current || !disconnectRef.current) && editRef.current === null ) { // what did i want here? 
                // console.log('no disconnect')
                setPositionTable(pos.positionTable)
                setTurns([...pos.turns, pos.turn])
                setTranscript(transcript ? transcript : '')
                setTurn(data.finished || !transcript? 'b' : pos.turn)
                if(data.xot) {
                    setMove(8)
                    setNext(transcript ? transcript?.substring(16,18) : null)
                    setScore(countDiscs(pos.positionTable[8]))
                    setBoard(JSON.parse(JSON.stringify(pos.positionTable[8])))
                    setLastMove(transcript?.substring(14,16))
                } else {
                    setMove(data.finished || !transcript ? 0 : transcript?.length / 2)
                    setNext(data.finished && transcript ? transcript?.substring(0,2) : null)
                    setScore(data.finished || !transcript? [2,2] : countDiscs(pos.positionTable[transcript?.length / 2]))
                    setLastMove('')                  
                    setBoard(data.finished || !transcript ? JSON.parse(JSON.stringify(startingPosition)) : pos.positionTable[transcript?.length / 2]) // get position!
                }
                if (mainBoardRef?.current) {
                    // console.log('setting back to default')
                    p1Ref.current.style.transition = 'opacity 0.1s ease-in-out'
                    p2Ref.current.style.transition = 'opacity 0.1s ease-in-out'
                    p1Ref.current.style.opacity = 1
                    p2Ref.current.style.opacity = 1
                    mainBoardRef.current.style.transition = 'none'
                    mainBoardRef.current.style.left = -width * 0.98 - 10 + 'px'
                }
            }
// disconnect, not editMode
            if (disconnectRef.current?.length > 0 && editRef.current === null && disconnectRef.current !== transcript) {
                console.log('disconnect', disconnectRef.current)
                setPositionTable(pos.positionTable)
                setTurns([...pos.turns, pos.turn])
                setTranscript(transcript)
                setHasNewMove(true)
            }
            
            setLoading(false)
        })
        socket.on('game-replay', (g, analysis, rawTimers) => {
            if (!g) {
                history('/')
                return
            }
            const timeMs = (g.time_control || 5) * 60000
            setIsTD(false)
            setIsPlayer(false)
            setGameResult(g.score)
            setRound(null)
            setComment(null)
            setFinished(true)
            setReason(g.reason)
            setBlackPlayer({
                id: null, nick: g.black_nick, name: null, country_code: g.black_country,
                rating: g.black_rating, score: g.score, result: null, left: null,
                comment: null, transcript: g.transcript, gameName: null, gameId: g.id, timer: timeMs
            })
            setWhitePlayer({
                id: null, nick: g.white_nick, name: null, country_code: g.white_country,
                rating: g.white_rating, left: null, timer: timeMs
            })
            isXot.current = g.xot
            xotOffsetRef.current = g.xot ? 8 : 0
            // Format timers
            let fTimers = [[timeMs, timeMs]]
            if (rawTimers && rawTimers.length > 0) {
                for (let i = 0; i < rawTimers.length; i++) {
                    fTimers[i + 1] = []
                    if (rawTimers[i].player_id === rawTimers[0].player_id) {
                        fTimers[i + 1][0] = rawTimers[i].time_left
                        fTimers[i + 1][1] = fTimers[i][1]
                    } else {
                        fTimers[i + 1][1] = rawTimers[i].time_left
                        fTimers[i + 1][0] = fTimers[i][0]
                    }
                }
            }
            if (g.xot) {
                const arr = []
                for (let i = 0; i < 8; i++) arr.push(fTimers[0])
                setTimers(arr.concat(fTimers))
            } else {
                setTimers(fTimers)
            }
            setTName(g.tournament_name || null)
            setRName(null)
            setGName(null)
            const transcript = g.transcript || ''
            const pos = getPositions(transcript, true)
            setMessages(transcriptToChat(transcript))
            const scoreTrans = getFinalScore(pos.positionTable[pos.positionTable.length - 1], !transcript ? 'b' : pos.turns[pos.turns.length - 1])
            setScoreByTranscript(scoreTrans)
            setPositionTable(pos.positionTable)
            setTurns([...pos.turns, pos.turn])
            setTranscript(transcript)
            setTurn('b')
            if (g.xot) {
                setMove(8)
                setNext(transcript ? transcript.substring(16, 18) : null)
                setScore(countDiscs(pos.positionTable[8]))
                setBoard(JSON.parse(JSON.stringify(pos.positionTable[8])))
                setLastMove(transcript.substring(14, 16))
            } else {
                setMove(0)
                setNext(transcript ? transcript.substring(0, 2) : null)
                setScore([2, 2])
                setLastMove('')
                setBoard(JSON.parse(JSON.stringify(startingPosition)))
            }
            // Handle server analysis
            if (analysis && analysis.length > 0) {
                serverAnalysisRef.current = true
                setEvals(analysis)
                setEvalGraphData(formatEvalsForEvalBar(analysis, g.xot ? 8 : 0))
                evalsRef.current = analysis
            }
            setLoading(false)
        })
        socket.on('next-online-game', newId => {
            if (animation?.current) {
                clearTimeout(animation.current)
            }
        
            const direction = nextGameReq === 'left' ? -width * 0.98 - 10 : width * 0.98 + 10
            mainBoardRef.current.style.transition = 'left 0.5s ease-in-out'
            p1Ref.current.style.transition = 'opacity 0.5s ease-in-out'
            p2Ref.current.style.transition = 'opacity 0.5s ease-in-out'
            mainBoardRef.current.style.left = -width * 0.98 - 10 + direction + 'px'
            p1Ref.current.style.opacity = 0
            p2Ref.current.style.opacity = 0
            animation.current = setTimeout(()=> {
                setNextGameReq(null)
                history(`/tournaments/${id}/game/${newId}`)
            }, 500)
        })

        socket.on('ot-timers', (game_id, timers) => {
            console.log(game_id, gameId, parseInt(game_id) === parseInt(gameId))
            console.log(timers)

            if (parseInt(game_id) === parseInt(gameId)) {
                if (isXot.current) {
                        const arr = []
                        for (let i = 0; i < 8; i++) {
                            arr.push(timers[0])
                        }
                        setTimers(arr.concat(timers))
                    } else {
                    setTimers(timers)
                    }
                }
            setLoading(false)
        })

        // socket.on('online-chat', data => {
        //     if(data.length === 0) return 
        //     if(data.filter(msg => msg.sender !== -1).length > 0) {
        //         setMessages(data)
        //     } else {
        //         setMessages(prev => [...prev, ...data])
        //     }
        // })
        
        return () => {
            socket.off('online-game-analysis')
            socket.off('online-game')
            socket.off('game-replay')
            socket.off('next-online-game')
            socket.off('ot-timers')
            // socket.off('online-chat')
        }
        
    },[id, gameId, nextGameReq, isOnline, scoreByTranscript]) //, settings.showEvalBar
    
    useEffect(() => {
        return () => {
            socket.emit('leave-online-game', gameId) // remove from the room leave-otb-game
            // setIsPlaying(false)
        }
    }, [id, gameId, nextGameReq])

    useEffect(()=> { // server book values (higher priority than WASM book)
        socket.on('online-hint', (trans, evals) => {
            if(evals.length === 0 && transcript.slice(0, move * 2) === trans) {
                edaxBookEmpty.current = move
            }
            if(evals.length === 0 || transcript.slice(0, move * 2) !== trans) return
            // Merge server book evals into existing WASM evals (book entries have priority)
            hintEvalsFlag.current = 3
            setHintEvals(prev => {
                if (prev.length === 0) return evals
                const merged = [...prev]
                for (const bookEval of evals) {
                    const idx = merged.findIndex(h => h.move === bookEval.move)
                    if (idx >= 0) {
                        merged[idx] = bookEval // replace WASM eval with book value
                    } else {
                        merged.push(bookEval)
                    }
                }
                return merged
            })
            // Cache in evalsTable for future navigation
            const moveNum = trans.length / 2
            if (evalsTable.current.length <= moveNum) {
                evalsTable.current[moveNum] = evals
            } else if (!evalsTable.current[moveNum] || !evalsTable.current[moveNum][0]?.is_book) {
                evalsTable.current[moveNum] = evals
            }
        })

        return () => {
            socket.off('online-hint')
        }

    },[transcript, move, id, gameId])

    // location.state
    useEffect (()=> {
        // console.log('location.state', )
        if(!isOnline) {
            location.state = null
            return
        }
        if(location.state?.data && isOnline) {
            console.log('location.state')
            console.log(location.state)
            setRound(location.state?.round)
            const transcript = location.state?.data[0]?.transcript ? location.state?.data[0]?.transcript : ''
            const pos = getPositions(transcript, true)
            const move = location.state?.move
            setPositionTable(pos.positionTable)
            setTranscript(transcript)
            setComment(location.state?.data[0]?.comment)
            setGameResult(location.state?.data[0]?.score)
            setBlackPlayer(location.state?.data[0])
            setWhitePlayer(location.state?.data[1])
            isXot.current = location.state?.xot
            xotOffsetRef.current = location.state?.xot ? 8 : 0
            if(location.state?.xot) {
                setMove(8)
                setNext(transcript ? transcript?.substring(16,18) : null)
                setScore(countDiscs(pos.positionTable[8]))
                setBoard(JSON.parse(JSON.stringify(pos.positionTable[8])))
                setLastMove(transcript?.substring(14,16))
            } else {
                setMove(location.state?.move)
                setLastMove(location.state?.move === 0 ? '' : transcript.slice((move - 1) * 2, (move) * 2))
                setNext(location.state?.score !== null ? transcript.slice((move) * 2,(move + 1) * 2) : null)
                setBoard(pos.positionTable[move])
                setScore(countDiscs(pos.positionTable[move]))
            }
            
            setTurn(pos.turns[move])
            setTurns([...pos.turns, pos.turn])
            
            // setTimers(location.state?.timers)
            setTName(location.state?.tName)
            setRName(location.state?.rName)
            setGName(location.state?.data[0].gameName)
            setByPlayer(location.state?.byPlayer)
            setFinished(location.state?.data[0]?.score !== null)
            setReason(location.state?.data[0]?.reason)
            setMessages(transcriptToChat(transcript))
            let scoreTrans = []
            if (transcript.length > 0) scoreTrans = getFinalScore(pos.positionTable[pos.positionTable.length - 1], pos.turns[pos.turns.length - 1])
            setScoreByTranscript(scoreTrans)
            socket.emit('get-timers-online', gameId, location.state?.timeControl) // 
            window.history.replaceState({}, '')
            setLoading(false) // 
        } else {
            if (isReplay) {
                socket.emit('get-game-replay', gameId)
            } else {
                socket.emit('get-online-game', id, gameId)
            }
        } 
    },[location, id, gameId, isOnline]) 

    // Auto-analyze when navigating from profile with autoAnalyze flag
    useEffect(() => {
        if (autoAnalyzeRef.current && !loading && senseiReady && transcript && transcript.length > 0) {
            autoAnalyzeRef.current = false
            // Small delay to ensure all state is settled
            setTimeout(() => handleAnalyzeGame(), 100)
        }
    }, [loading, senseiReady, transcript])

    useEffect (() => { 
        if ( !transRef.current) return 
            requestAnimationFrame(() => {
                transRef.current.scrollLeft = (move - 2) * 59
            })        
    },[lastMove, transRef.current, move, moveRef])

    const rotateBoard = () => {
        if(rotation === 0) {
            setRows(['a','b','c','d','e','f','g','h'])
            setCols([8,7,6,5,4,3,2,1]) 
        } else if (rotation === 1) {
            setRows([8,7,6,5,4,3,2,1])
            setCols(['h','g','f','e','d','c','b','a'])
        } else if (rotation === 2) {
            setRows(['h','g','f','e','d','c','b','a'])
            setCols([1,2,3,4,5,6,7,8]) 
        } else {
            setRows([1,2,3,4,5,6,7,8]) 
            setCols(['a','b','c','d','e','f','g','h'])
        }
        setRotation(prev => prev === 3 ? 0 : prev + 1)
        setBoard(prev => rotate(prev))
    }

    const showAnalysis = () => {
        setShowEvals(prev => !prev)
        if(showEvals && sensei && senseiReady) {
            hintEvalsFlag.current = 0
            senseiStop()
            if (retroStatus === 'running') senseiStopRetro()
            return
        }
        if(showEvals) return
        // if((!evals || evals?.length === 0) && !editMode) socket.emit('get-online-analysis', id, gameId)
        if(sensei && senseiReady && !showEvals) {
            const safeMove = Math.min(move, positionTable.length - 1)
            const str = transcript.slice(0, safeMove * 2)
            senseiHint(str, safeMove, transcript.slice(safeMove * 2, (safeMove + 1) * 2), evalsTable.current, countLegalMoves(positionTable[safeMove]), status)
            if(str.length > 0 && safeMove < edaxBookEmpty.current) socket.emit('online-get-hint', str)
        }
        }

    const makeMove = (moveNumber) => {
        if (retroStatus === 'running') {
            senseiStopRetro()
        }
        // console.log(moveNumber, positionTable[moveNumber], positionTable)
        setMove(moveNumber)
        if(!editMode) setNext(transcript.substring(moveNumber * 2, moveNumber * 2 + 2))
        if(!editMode && moveNumber === transcript.length / 2) setHasNewMove(false) 
        setLastMove(moveNumber === 0 ? '' : transcript.slice((moveNumber - 1) * 2, (moveNumber) * 2))
        let newBoard = JSON.parse(JSON.stringify(positionTable[moveNumber]))
        for (let i = 0; i < rotation; i++) {
            newBoard = rotate(newBoard)
        }
        setBoard(newBoard)
        setScore(countDiscs(positionTable[moveNumber]))
        setTurn(turns[moveNumber])
        if(!editMode) {
            setBlackPlayer(prev => ({
                ...prev,
                timer: timers[moveNumber][0]
            }))
            setWhitePlayer(prev => ({
                ...prev,
                timer: timers[moveNumber][1]
            }))
        }
        
        setHintEvals([])
        // console.log(sensei && senseiReady && (showEvals || settings.showEvalBar)) //
        if(sensei && senseiReady && (showEvals || settings.showEvalBar)) {
            const str = transcript.slice(0, moveNumber * 2)
            const nMove = editMode ? '' : transcript.substring(moveNumber * 2, moveNumber * 2 + 2)
            const legalMoves = countLegalMoves(positionTable[moveNumber])
            senseiHint(str, moveNumber, nMove, evalsTable.current, legalMoves, status)
            if(str.length > 0 && moveNumber < edaxBookEmpty.current) socket.emit('online-get-hint', str)
        }

        // disconnectRef.current.move = moveNumber
        disconnectRef.current = transcript
    }

    // const toCapitalized = (str) => {
    //     if(!str) return ''
    //     return str.charAt(0).toUpperCase() + str.slice(1)
    // }

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

    const reverseColor = color => {
        return color === 'black' ? 'white' : 'black'
    }

    function isLastMove (cell) {
        if(cell === lastMove) {
            return true
        } 
        return false
    }

    const discColors = (cell) => {         
        if (board[cell[0]][cell[1]] === 'b') {
            return 'black'
        }
        if (board[cell[0]][cell[1]] === 'w') {
            return 'white'
        }
        return
    }

    function isCellEmpty (cell) {  
        if (board[cell[0]][cell[1]] === 'w' || board[cell[0]][cell[1]] === 'b') {
            return false
        }
        return true
    }

    function prevMove () {
        if (move === 0) return
        makeMove(move - 1)
    }

    function nextMove () {
        // console.log(move, transcript.length / 2, reason)
        if (move > transcript.length / 2 || (move === transcript.length / 2 && reason === 'score')) {return}
        if (move === transcript.length / 2 && !editMode) {
            setBlackPlayer(prev => ({
                ...prev,
                timer: timers[move + 1][0]
            }))
            setWhitePlayer(prev => ({
                ...prev,
                timer: timers[move + 1][1]
            }))
            setMove(prev => prev + 1)
            return
        }
        makeMove(move + 1)
        
    }

    function toFinalPosition () {
        if (move > transcript.length / 2 || (move === transcript.length / 2 && reason === 'score')) {return}    
        makeMove(transcript.length / 2)     
        if (reason !== 'score' && !editMode) {
            setBlackPlayer(prev => ({
                ...prev,
                timer: timers[transcript.length / 2 + 1][0]
            }))
            setWhitePlayer(prev => ({
                ...prev,
                timer: timers[transcript.length / 2 + 1][1]
            }))
            setMove(transcript.length / 2 + 1)
            return
        }
        
    }

    function toStartPosition () {
        if (editMode && isXot.current) {
            if (move === 0) return
            if (move > editRef.current.move) { makeMove(editRef.current.move); return }
            if (move > 8) { makeMove(8); return }
            makeMove(0)
            return
        }
        if (editMode && move === 0) return
        if (editMode && move === editRef.current.move) {
            makeMove(0)
            return
        }
        if (editMode) { 
            makeMove(editRef.current.move)
            return
        }
        if (isXot.current) {
            if (move > 8) { makeMove(8); return }
            if (move > 0) { makeMove(0); return }
            return
        }
        if (move === 0) {return}
        makeMove(0)
    }

    const toSomeMove = (event) => {
        const toMove = event.target.innerText.substring(event.target.innerText.length - 2, event.target.innerText.length)
        const toMoveNumber = parseInt(event.target.innerText.substring(0, event.target.innerText.length - 4))
        if (toMove === lastMove) {return}
        makeMove(toMoveNumber)
    }
    
    function isMoveLegal (cell) {                                                                              
        if (board[cell[0]][cell[1]] === 'l' && editMode) {
            return true
        }
        return false
    }

    function isNextMove (cellName) {
        if(cellName === next && showEvals && !editMode) return true
        return false
    }

    function getEval (cellName) {
        if(cellName === next && !editMode && showEvals && evals?.length > 0) {
            // If engine has a live eval for this cell, prefer it (more current than stored analysis)
            const hint = hintEvals?.find(h => h.move === cellName)
            if (hint) return getEvalFromHint(hintEvals, cellName)
            const xotOffset = isXot.current ? 8 : 0
            const evalIdx = move - xotOffset
            if (evalIdx < 0 || evalIdx >= evals.length) return null
            const result = {value: evals[evalIdx].eval > 0 ? "+" + evals[evalIdx].eval : evals[evalIdx].eval, opacity: 1, evalDone: true}
            return result
        }
        if(hintEvals?.length > 0 && showEvals) return getEvalFromHint(hintEvals, cellName)
        return null
    }

    function getBestEval (cellName) {
        // 2 options: live game or edit and game finished
        const xotOffset = isXot.current ? 8 : 0
        const evalIdx = move - xotOffset
        if(evals && evalIdx >= 0 && evalIdx < evals.length && cellName === evals[evalIdx]?.best_move 
            && showEvals && move !== transcript.length / 2 && 
            (!editMode || editMode && transcript.slice(0, move * 2) === editRef?.current?.transcript.slice(0, move * 2))) {
            // If engine has a live eval for this cell, prefer it (more current than stored analysis)
            const hint = hintEvals?.find(h => h.move === cellName)
            if (hint) return getBestEvalFromHint(hintEvals, cellName)
            const result = {value: evals[evalIdx].best_eval > 0 ? "+" + evals[evalIdx].best_eval : evals[evalIdx].best_eval, opacity: 1, evalDone: true}
            return result
        }
        if(hintEvals.length > 0 && showEvals) return getBestEvalFromHint(hintEvals, cellName)
        // if(!evals || move === transcript.length / 2 || !showEvals || editMode) return null // || editMode - change that when i get all eval with hint
        return null
    }

    const getBestEvalFromHint = (arr, cellName)  => {
        if (!arr || arr?.length === 0) return null
        let moveIndex = -1
        for (let i = 0; i < arr.length; i ++) {
            if (arr[i].move === cellName) {
                moveIndex = i
                break
            }
        }
        if (moveIndex < 0) return null 
        let bestEvalValue = -64

        for (let i = 0; i < arr.length; i++) { // get 
            if(arr[i].score > bestEvalValue) {
                bestEvalValue = arr[i].score 
            }
        }
        
        if (arr[moveIndex].score === bestEvalValue) {
            const value = arr[moveIndex].score > 0 ? "+" + arr[moveIndex].score : arr[moveIndex].score
            const opacity = hintEvalsFlag.current === 3 ? 1 : arr[moveIndex].is_book ? 1 : Math.min(1, 0.5 + (arr[moveIndex].descendants / 2000000))
            const evalDone = hintEvalsFlag.current === 3 || arr[moveIndex].is_book
            return {value: value, opacity: opacity, certainty: arr[moveIndex].certainty, is_book: arr[moveIndex].is_book, evalDone: evalDone}
        }

        return null
    }

    const getEvalFromHint = (arr, cellName) => {
        if (!arr || arr?.length === 0) return null
        for (let i = 0; i < arr.length; i++) {
            if(arr[i].move === cellName) {
                const value = arr[i].score > 0 ? "+" + arr[i].score : arr[i].score
                const opacity = hintEvalsFlag.current === 3 ? 1 : arr[i].is_book ? 1 : Math.min(1, 0.5 + (arr[i].descendants / 2000000))
                const evalDone = hintEvalsFlag.current === 3 || arr[i].is_book
                return {value: value, opacity: opacity > 0.5 ? opacity : 0.5, certainty: arr[i].certainty, is_book: arr[i].is_book, evalDone: evalDone}
            }
        }
    }

    const changeEditMode = () => {
        // move > positionTable.length...[p/]
        if(!editMode) { // just turning on
            senseiStopRetro()
            const currentMove = move > transcript.length / 2 ? transcript.length / 2 : move
            editRef.current = { 
                positionTable: JSON.parse(JSON.stringify(positionTable)),
                timerMove: move,
                move: currentMove,
                transcript: transcript,
                turns: turns,
                turn: turns[currentMove],
                evalsTable: [...evalsTable.current]
            }
            setTranscript(prev => prev.slice(0, currentMove*2))
            setTurns(prev => prev.slice(0, currentMove + 1))
            setPositionTable(prev => prev.slice(0, currentMove + 1))
            setEditMode(true)
            setMove(currentMove)
            // console.log('turn', turn, 'turns', turns.length, 'this turn', turns[move])
            evalsTable.current = evalsTable.current.slice(0, currentMove + 1)
            edaxBookEmpty.current = MAX_BOOK_MOVE
            editModeRef.current = true
            return
        }
        let newBoard = JSON.parse(JSON.stringify(editRef.current.positionTable[editRef.current.move]))
        for (let i = 0; i < rotation; i++) {
            newBoard = rotate(newBoard)
        }
        setBoard(newBoard)
        setTranscript(editRef.current.transcript)
        setMove(editRef.current.timerMove)
        setTurns(editRef.current.turns)
        setTurn(editRef.current.turn)
        setPositionTable(editRef.current.positionTable)
        setEditMode(false)
        setNext(editRef.current.transcript.slice((editRef.current.move) * 2, (editRef.current.move + 1) * 2))
        setLastMove(editRef.current.move === 0 ? '' : editRef.current.transcript.slice((editRef.current.move - 1) * 2, (editRef.current.move) * 2))
        evalsTable.current = [...editRef.current.evalsTable]
        edaxBookEmpty.current = MAX_BOOK_MOVE
        if(sensei && (showEvals || settings.showEvalBar)) {
            edaxBookEmpty.current = MAX_BOOK_MOVE
            const moveNum = editRef.current.move
            const str = editRef.current.transcript.slice(0, (moveNum) * 2)
            const next = editRef.current.transcript.slice((moveNum) * 2, (moveNum + 1) * 2)
            editModeRef.current = false
            senseiHint(str, moveNum, next, evalsTable.current, countLegalMoves(editRef.current.positionTable[moveNum]), status)
        }
        editRef.current = null
    }

    const editMoveHandler = event => {
        const cell = event.currentTarget.value.split(',').map(Number)
        if(!isMoveLegal(cell)) return
        const newCell = rotateCell(cell, rotation)
        const newMove = event.currentTarget.id
        const buffer = JSON.parse(JSON.stringify(positionTable[move]))
        const data = makeNewMove(newCell, buffer, turn, true)
        if(newMove === transcript.slice((move) * 2, (move + 1) * 2)) {
            makeMove(move + 1)
            return
        }
        editRef.current.move = editRef.current.move > move ? move : editRef.current.move
        setPositionTable(prev => [...prev.slice(0, move + 1), data.buffer])
        setTurns(prev => [...prev.slice(0, move + 1), data.turn])
        setScore(countDiscs(data.buffer))
        let newBoard = JSON.parse(JSON.stringify(data.buffer))
        for (let i = 0; i < rotation; i++) {
            newBoard = rotate(newBoard)
        }
        setBoard(newBoard)
        setMove(prev => prev + 1)
        setTranscript(prev => prev.slice(0, move * 2) + newMove)
        setTurn(data.turn)
        setLastMove(newMove)
        
        if(sensei && (showEvals || settings.showEvalBar)) {
            setHintEvals([])
            const str = transcript.slice(0, move * 2) + newMove
            const moveNum = move + 1
            const next = ''
            const table = JSON.parse(JSON.stringify(evalsTable.current.slice(0, move + 1)))
            senseiHint(str, moveNum, next, table, countLegalMoves(data.buffer), status)
            evalsTable.current = evalsTable.current.slice(0, move + 1)
        }
    }    

// evalbar smooth update
    useEffect(() => {
        // console.log('showEvalBar', scoreByTranscript, settings.showEvalBar, move, transcript.length / 2, turn, hintEvals, editMode)
        if(!settings.showEvalBar || (hintEvals.length === 0 && ((scoreByTranscript === -1 && !editMode) || move < transcript.length / 2))) return
        const handler = setTimeout (() => {
            if(scoreByTranscript >= 0 && move === transcript.length / 2 && !editMode) {
                let evaluation = 2 * scoreByTranscript - 64
                setEvalBarData(evaluation)
            } else {
                let evaluation = Math.max(...hintEvals.map(el => el.score))
                evaluation = evaluation < -64 || evaluation > 64 ? 0 : evaluation 
                evaluation = turn === 'w' ? - evaluation : evaluation
                setEvalBarData(evaluation)
            }
            
        }, 100)

        return () => {
            clearTimeout(handler)
        }
    }, [hintEvals, settings.showEvalBar, turn, move, transcript, editMode, scoreByTranscript])

// Call set_game when game data is available so engine has the full game tree
    useEffect(() => {
        if (!senseiReady || !transcript || transcript.length === 0) return
        senseiSetGame(transcript)
    }, [senseiReady, transcript])

// initiate first hint for EvalBar if was not done yet
    useEffect(() => {
        // console.log('firstHint', senseiReady, settings.showEvalBar, showEvals, hintedOnce)
        if(!senseiReady || !settings.showEvalBar || showEvals || hintedOnce) return
            if(modeRef.current === 'retro') return
            const safeMove = Math.min(move, positionTable.length - 1)
            const str = transcript.slice(0, safeMove * 2)
            const next = transcript.slice((safeMove) * 2, (safeMove + 1) * 2)
            senseiHint(str, safeMove, next, evalsTable.current, countLegalMoves(positionTable[safeMove]), status)
            if(str.length > 0 && safeMove < edaxBookEmpty.current) socket.emit('online-get-hint', str)
    },[settings.showEvalBar, showEvals, move, transcript, positionTable, status, hintedOnce, senseiReady])

    //in case someone pressed analyze before Sensei is ready
    useEffect (()=> {
        if(!senseiReady || !showEvals || hintedOnce) return
        if(modeRef.current === 'retro') return
        const safeMove = Math.min(move, positionTable.length - 1)
        const str = transcript.slice(0, safeMove * 2)
        senseiHint(str, safeMove, transcript.slice(safeMove * 2, (safeMove + 1) * 2), evalsTable.current, countLegalMoves(positionTable[safeMove]), status)
        if(str.length > 0 && safeMove < edaxBookEmpty.current) socket.emit('online-get-hint', str)
    },[senseiReady, transcript, move, positionTable, status, showEvals])

    const formatRetroForGraph = (retro, totalMoves) => {
        const result = []
        for (let i = 0; i < totalMoves; i++) {
            if (retro[i]) {
                const entry = retro[i]
                const evalFromBlack = entry.black_move ? entry.best_move_eval : -entry.best_move_eval
                result.push({move_number: i, best_eval: evalFromBlack})
            } else {
                result.push({move_number: i, best_eval: 0})
            }
        }
        // duplicate last point for graph end
        if (result.length > 0) {
            const last = result[result.length - 1]
            result.push({move_number: last.move_number + 1, best_eval: last.best_eval})
        }
        return result
    }

    const totalMoves = transcript ? transcript.length / 2 : 0
    const retroGraphData = retroAnalysis.some(x => x) ? formatRetroForGraph(retroAnalysis, totalMoves) : []

    // Permanently update evalGraphData when engine finds a deeper/different best eval
    useEffect(() => {
        if (editModeRef.current) return
        if (!evalGraphData || evalGraphData.length === 0) return
        if (!hintEvals || hintEvals.length === 0 || !evals || evals.length === 0) return
        if (hintEvalsFlag.current !== 3) return // only update when eval is finalized

        const sorted = [...hintEvals].sort((a, b) => b.score - a.score)
        const bestScore = sorted[0]?.score
        if (bestScore === undefined) return

        // Normalize to black's perspective (graph always shows from black's viewpoint)
        const xotOffset = isXot.current ? 8 : 0
        const evalIdx = move - xotOffset
        const blackId = evals[0]?.player_id
        const currentPlayerEval = evals[evalIdx]
        if (!currentPlayerEval) return
        const isBlack = currentPlayerEval.player_id === blackId
        const bestEvalFromBlack = (isBlack || bestScore === 0) ? bestScore : -bestScore

        const graphIdx = evalGraphData.findIndex(d => d.move_number === move)
        if (graphIdx < 0 || evalGraphData[graphIdx].best_eval === bestEvalFromBlack) return

        setEvalGraphData(prev => {
            const newData = [...prev]
            newData[graphIdx] = { ...newData[graphIdx], best_eval: bestEvalFromBlack }
            if (graphIdx === newData.length - 2) {
                newData[graphIdx + 1] = { ...newData[graphIdx + 1], best_eval: bestEvalFromBlack }
            }
            return newData
        })
    }, [hintEvals, move, evals])

    // Send deeper evals to server when engine finds a better analysis than what's stored
    useEffect(() => {
        if (editModeRef.current) return
        if (!hintEvals || hintEvals.length === 0 || !evals || evals.length === 0) return
        if (hintEvalsFlag.current !== 3) return
        if (!serverAnalysisRef.current) return

        // Find server entry for current position (move is 0-based, move_number is 1-based in DB)
        const xotOffset = isXot.current ? 8 : 0
        const dbMoveNumber = move - xotOffset + 1
        const serverEntry = evals.find(e => e.move_number === dbMoveNumber)
        if (!serverEntry || !serverEntry.depth || serverEntry.depth <= 0) return

        const totalDesc = hintEvals.reduce((s, m) => s + m.descendants, 0)
        const encodedDepth = Math.round(totalDesc / 1000000)
        if (encodedDepth <= serverEntry.depth) return

        // Engine found deeper eval — send upgrade
        const sorted = [...hintEvals].sort((a, b) => b.score - a.score)
        const nextMove = transcript.substring(move * 2, move * 2 + 2)
        const played = nextMove ? sorted.find(e => e.move === nextMove) : null

        socket.emit('upgrade-move-analysis', {
            roundId: parseInt(gameId),
            tournamentId: parseInt(id),
            moveNumber: dbMoveNumber,
            bestMove: sorted[0]?.move,
            bestEval: sorted[0]?.score,
            moveMade: nextMove,
            moveMadeEval: played?.score ?? serverEntry.eval,
            descendants: totalDesc
        })
    }, [hintEvals, move, evals])

    const navigateToMove = (moveNumber) => {
        if (moveNumber < 0 || moveNumber >= positionTable.length) return
        setMove(moveNumber)
        setNext(transcript.substring(moveNumber * 2, moveNumber * 2 + 2))
        setLastMove(moveNumber === 0 ? '' : transcript.slice((moveNumber - 1) * 2, moveNumber * 2))
        let newBoard = JSON.parse(JSON.stringify(positionTable[moveNumber]))
        for (let i = 0; i < rotation; i++) {
            newBoard = rotate(newBoard)
        }
        setBoard(newBoard)
        setScore(countDiscs(positionTable[moveNumber]))
        setTurn(turns[moveNumber])
    }

    const handleAnalyzeGame = () => {
        if (!senseiReady || !transcript || transcript.length === 0) return
        setShowEvals(true)
        setHintEvals([])
        resetRetro() // clear any previous retro data
        navigateToMove(transcript.length / 2) // show final position
        senseiAnalyzeGame(transcript, senseiSecondsPerPos)
    }

    // When retro completes, switch to regular eval for the starting position
    useEffect(() => {
        onRetroCompleteRef.current = (analysisData) => {
            const safeMove = isXot.current ? 8 : 0
            navigateToMove(safeMove)
            senseiHint(transcript.slice(0, safeMove * 2), safeMove, transcript.slice(safeMove * 2, safeMove * 2 + 2), evalsTable.current, 4, status)
            // Only send analysis data to backend if server doesn't already have it
            if (!serverAnalysisRef.current) {
                if (isReplay && !id) {
                    socket.emit('save-replay-analysis', {
                        gameId: parseInt(gameId),
                        analysis: analysisData
                    })
                } else {
                    socket.emit('save-game-analysis', {
                        roundId: parseInt(gameId),
                        tournamentId: parseInt(id),
                        analysis: analysisData
                    })
                }
            }
        }
        return () => { onRetroCompleteRef.current = null }
    }, [transcript, status])

    // Navigate board during retro analysis and show evals from completed positions
    useEffect(() => {
        if (retroCurrentIndex < 0) return
        if (retroStatus !== 'running') return
        navigateToMove(retroCurrentIndex)

        // Show evals from retro analysis for the displayed position
        const retroEntry = retroAnalysis[retroCurrentIndex]
        if (retroEntry) {
            const evals = [{
                move: retroEntry.best_move,
                score: retroEntry.best_move_eval,
                descendants: retroEntry.descendants,
                is_book: false
            }]
            if (retroEntry.move_made !== retroEntry.best_move) {
                evals.push({
                    move: retroEntry.move_made,
                    score: retroEntry.move_made_eval,
                    descendants: retroEntry.descendants,
                    is_book: false
                })
            }
            hintEvalsFlag.current = 3
            setHintEvals(evals)
        } else {
            setHintEvals([])
        }
    }, [retroCurrentIndex, retroStatus])
   

    //<div className= 'round-name'>{getFullRoundName([{round: round, round_name: rName}], round)} {getFullGameName(gName)}</div> 
    return (
        <>
        <Helmet>
            <meta name="viewport" content="width=device-width, height=device-height, interactive-widget=resizes-content, initial-scale=1.0, maximum-scale=1.0, user-scalable=no" />
        </Helmet>
        <LayoutContext.Provider value = {{ width, height, offsetY, gameBoard, fullBoard, totalHeight, keyboard}}>
        <NavBar isHome = {false} isGame = {false} text = {tName} tournamentId={id} fromProfile={fromProfileRef.current}></NavBar>
        {settings.showEvalBar && senseiReady && !editMode && !(typing && isMobile)? 
            <EvalBar  evaluation = {evalBarData} width = {width}/> :
            !(typing && isMobile) ?
            <div className= 'round-name'>{round != null ? `${getFullRoundName([{round: round, round_name: rName}], round)} ${getFullGameName(gName)}` : ''}</div> 
            : <></>
        }
        {nextRoundStartTime && !(typing && isMobile) ?
            <TournamentTimer
                currentRound = {round}
                nextRoundStartTime = {nextRoundStartTime}
                setNextRoundStartTime = {setNextRoundStartTime}
                playersTab = {true}
            />
        : <></>}
        {loading && isOnline? <ModalLoading/> : <></>}
        <div>
            <div style = {{...params, top: isMobile && typing ? 50 : 80}} className = 'replayer-full' >
                <div ref = {p1Ref} className = 'player-container'>
                <PlayerInfo 
                    nickName = {(verifiedOnly && viewerVerified && blackPlayer?.wof_name) ? toNameCase(blackPlayer.wof_name) : blackPlayer?.nick}
                    color = {color}
                    score = {score[0]}
                    country = {blackPlayer?.country_code}
                    rating = {blackPlayer?.rating}
                    hideFooter = {false}
                    avatar = {true}  
                    withTimer = {true}
                    isStreamer = {false}
                    timer = {blackPlayer?.timer}
                    profileNick = {blackPlayer?.nick && (finished || !isPlayer || blackPlayer.nick !== myNick) ? blackPlayer.nick : null}
                    // turn = {turn}
                    // evals = {showEvalBar ? formatEvalsForPlayer(evals, blackPlayer) : null}                 
                />
                </div>
                <div style = {{height: 10}}></div>
                <div className = 'watch-game' style = {{width: width * 3 * 0.98 + 20, left: -width * 0.98 - 10 + 'px'}}  ref = {mainBoardRef}>
                    <EmptyBoard params= {params}></EmptyBoard>
                    <div className="board-container" onTouchStart = {onTouchStart} onTouchMove = {onTouchMove} onTouchEnd = {onTouchEnd}>
                        <div className= 'notation'>
                            <div className= 'frame'>
                                <div className= 'x-axis'>
                                    {cols.map(val =>  <div className= 'cell-letter' key = {val}>{val}</div>)}
                                </div>
                                <div className= 'y-axis'>
                                    {rows.map(val =>  <div className= 'cell-number' key = {val} >{val}</div>)}
                                </div>
                                {editMode ? 
                                <div className = 'board-dots'>
                                    <div className = 'board-dot-1 edit'></div>
                                    <div className = 'board-dot-2 edit'></div>
                                    <div className = 'board-dot-3 edit'></div>
                                    <div className = 'board-dot-4 edit'></div>
                                </div> 
                                :
                                <div className = 'board-dots'>
                                    <div className = 'board-dot-1'></div>
                                    <div className = 'board-dot-2'></div>
                                    <div className = 'board-dot-3'></div>
                                    <div className = 'board-dot-4'></div>
                                </div>
                                }

                                <div className= {`board ${editMode ? 'edit' : ''}`}>
                                    {!editMode && transcript?.length > 0 ? <div className="prev-move-big" onClick={prevMove}></div> : <></>}

                                    {rows.map((row, i) => cols.map((col, j) => {
                                    const cn = rotation % 2 > 0 ? rows[i] + cols[j] : cols[j] + rows[i]
                                    const evalData = getEval(cn) || getBestEval(cn)
                                    return <Cell 
                                        id = {cn} 
                                        isEmpty = {isCellEmpty([i, j])}
                                        isLastMove = {isLastMove(cn)}
                                        isLegalMove = {isMoveLegal([i,j])}
                                        discColor = {discColors([i, j])}
                                        onClick = {editMode ? editMoveHandler : ()=>{}}
                                        value = {`${i},${j}`}
                                        settings = {settings}
                                        turn = {turn === 'b' ? 'black' : 'white'}
                                        key = {cn}
                                        isNextMove = {isNextMove(cn)}
                                        evaluation = {getEval(cn)?.value}
                                        bestEval = {getBestEval(cn)?.value}
                                        evalOpacity = {getEval(cn)?.opacity}
                                        certainty = {evalData?.certainty}
                                        isBook = {evalData?.is_book}
                                        evalDone = {evalData?.evalDone}
                                        gameBoard = {gameBoard}
                                        editMode = {editMode}
                                        allowedToStream = {false}
                                        transcriptMode = {false}
                                        />
                                    }))}   
                                    {!editMode && transcript?.length > 0? <div className="next-move-big" onClick={nextMove}></div> : <></>}
                                </div>
                            </div>   
                        </div>
                    </div>
                    <EmptyBoard params= {params}></EmptyBoard>
                </div>
                
                    <div ref = {p2Ref} className = 'player-container'>
                    <PlayerInfo 
                        nickName = {(verifiedOnly && viewerVerified && whitePlayer?.wof_name) ? toNameCase(whitePlayer.wof_name) : whitePlayer?.nick}
                        color = {reverseColor(color)}
                        rating = {whitePlayer?.rating}
                        score = {score[1]}
                        country = {whitePlayer?.country_code} 
                        hideFooter = {false}
                        avatar = {true} 
                        withTimer = {true}
                        isStreamer = {false}
                        timer = {whitePlayer?.timer} // change that later
                        profileNick = {whitePlayer?.nick && (finished || !isPlayer || whitePlayer.nick !== myNick) ? whitePlayer.nick : null}
                        // turn = {turn}
                        // evals = {showEvalBar ? formatEvalsForPlayer(evals, whitePlayer) : null}   
                        //<div className = "comment">{comment} </div>                
                    />
                    </div>
                {!typing || !isMobile ?
                <>
                    <div style = {{height: 10}}></div>
                    
                    {transcript?.length > 0 || editMode || reason !== 'score' ? 
                        <div className = 'buttons-container'>
                        <MaxBackButtonSVG onClick = {toStartPosition} move = {move}/>
                        <BackButtonSVG onClick = {prevMove} move = {move}/>
                        <div className = 'transcript-move'>
                            <div className="transcript-container">
                                <div ref = {transRef} className= 'transcript'>                            
                                    {transcript?.length > 0 && move <= transcript?.length / 2  ?
                                    transcript.match(/.{1,2}/g).map ((m, idx) => 
                                        <div 
                                            ref = {m === lastMove ? moveRef : null} 
                                            key = {idx + 1 + m} 
                                            className = {m === lastMove ? "last-move" : "prev-move"} 
                                            onClick = {toSomeMove}>
                                        {`${idx + 1 + '. ' + m}`}
                                        </div>
                                    ) :
                                    !editMode && !loading? 
                                        <div className = "transcript-reason">{`lost by ${reason}`}</div>
                                    : <></>
                                    }
                                    
                                </div>
                            </div>
                            {hasNewMove ? <div className='new-move'/> : <div style = {{width: '10px'}}></div>}
                        </div>
                        <ForwardButtonSVG onClick = {nextMove} move = {move} transcript = {transcript} reason = {!editMode ? reason : null}/>
                        <MaxForwardButtonSVG onClick = {toFinalPosition} move = {move} transcript = {transcript} reason = {!editMode ? reason : null}/>
                    </div> : <></>
                    }
                                        
                    <div style = {{height: 10}}></div> 
                    {showEvals && !editMode && evalGraphData && evals?.length > 0 ?
                        <EvalGraph moveNumber = {move} evals = {evalGraphData} width = {gameBoard * 0.918367352} onMoveClick = {makeMove} xotOffset={isXot.current ? 8 : 0} evals_raw={evals} blackPlayer={blackPlayer}/>
                    : showEvals && !editMode && retroGraphData.length > 2 ? (
                        <EvalGraph moveNumber = {move} evals = {retroGraphData} width = {gameBoard * 0.918367352} retroAnalysis = {retroAnalysis} onMoveClick = {makeMove} xotOffset={isXot.current ? 8 : 0}/>
                    ) : showEvals && !editMode && senseiReady && (!evals || evals.length === 0) && retroStatus !== 'running' && retroStatus !== 'complete' ? (
                        <div style={{textAlign: 'center', padding: '12px 0'}}>
                            <div style={{display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px'}}>
                                <button className='analyze-game-btn' onClick={handleAnalyzeGame}>Analyze Game</button>
                                <button
                                    onClick={() => setShowSenseiSettings(true)}
                                    style={{background: 'transparent', border: 'none', cursor: 'pointer', padding: '4px', fontSize: '18px', color: '#aaa'}}
                                    title="Sensei Settings"
                                >⚙</button>
                            </div>
                            <div style={{fontSize: '10px', color: '#888', marginTop: '4px'}}>Powered by Sensei<br/>developed by Michele Borassi</div>
                        </div>
                    ) : showEvals && !editMode && retroStatus === 'running' && retroGraphData.length === 0 ? (
                        <div style={{textAlign: 'center', padding: '12px 0', color: '#aaa', fontSize: '13px'}}>Analyzing game...</div>
                    ) : showEvals && editMode ? (
                        <div style={{textAlign: 'center', padding: '12px 0'}}>
                            <div style={{fontSize: '10px', color: '#888', marginTop: '4px'}}>Powered by Sensei<br/>developed by Michele Borassi</div>
                        </div>
                    ) : <></>
                    }
                </> : <></>}
                
                <FooterGameOTB 
                    isLive = {false} // round is not finished and and there's no score in game
                    showAnalysis = {showAnalysis} 
                    changeEditMode = {changeEditMode} 
                    transcript = {editMode ? editRef.current?.transcript : transcript} 
                    rotateBoard = {rotateBoard}
                    isPlayer = {isPlayer}
                    isTD = {false}
                    enterAsTranscript = {null}
                    pasteTranscript = {null}
                    allowedToStream = {false}
                    scoreByTranscript = {scoreByTranscript}
                    >
                
                </FooterGameOTB>
            </div>
        </div>
        </LayoutContext.Provider>
        {showSenseiSettings && (
            <div style={{position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, background: 'rgba(0,0,0,0.6)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000}}
                 onClick={() => {
                     setSenseiSettingsInput(String(senseiSecondsPerPos))
                     setShowSenseiSettings(false)
                 }}>
                <div style={{background: '#2d2d2d', borderRadius: '8px', padding: '20px', minWidth: '260px', color: '#e0e0e0'}}
                     onClick={e => e.stopPropagation()}>
                    <div style={{fontSize: '16px', fontWeight: 600, marginBottom: '16px'}}>Sensei Settings</div>
                    <div style={{marginBottom: '12px'}}>
                        <label style={{display: 'block', fontSize: '13px', marginBottom: '6px'}}>Seconds per position (1-20):</label>
                        <input
                            type="text"
                            inputMode="numeric"
                            value={senseiSettingsInput}
                            onFocus={e => e.target.select()}
                            onChange={e => {
                                const raw = e.target.value.replace(/[^0-9]/g, '')
                                setSenseiSettingsInput(raw)
                            }}
                            style={{width: '60px', padding: '4px 8px', fontSize: '14px', borderRadius: '4px', border: '1px solid #555', background: '#1a1a1a', color: '#e0e0e0', textAlign: 'center'}}
                        />
                    </div>
                    <div style={{display: 'flex', gap: '8px', justifyContent: 'flex-end'}}>
                        <button
                            onClick={() => {
                                setSenseiSettingsInput(String(senseiSecondsPerPos))
                                setShowSenseiSettings(false)
                            }}
                            style={{background: '#444', border: 'none', color: '#e0e0e0', padding: '6px 16px', borderRadius: '4px', cursor: 'pointer', fontSize: '13px'}}
                        >Cancel</button>
                        <button
                            onClick={() => {
                                const v = parseInt(senseiSettingsInput)
                                if (!isNaN(v) && v >= 1 && v <= 20) {
                                    setSenseiSecondsPerPos(v)
                                    localStorage.setItem('senseiSecondsPerPos', v)
                                    setShowSenseiSettings(false)
                                }
                            }}
                            style={{background: '#4a7c4a', border: 'none', color: '#e0e0e0', padding: '6px 16px', borderRadius: '4px', cursor: 'pointer', fontSize: '13px'}}
                        >Confirm</button>
                    </div>
                </div>
            </div>
        )}
        </>
    )
}
//to footer:
//game finished according to transcript ? getFinalScore() !== -1
//is there score in DB (rounds) ? Does it match final score transcript ? 
// if there's a score, game is finished, but the score doesn't match check if there's comment.
// if there's a comment, 
export default OnlineTournamentGame


