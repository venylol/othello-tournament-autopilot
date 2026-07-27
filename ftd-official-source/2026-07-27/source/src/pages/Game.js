import React, {useEffect, useState, useRef, useContext} from 'react'
import { useParams, useNavigate, useLocation } from 'react-router-dom'
// import { useMessage } from '../hooks/message.hook'
import { Helmet } from "react-helmet";
import { PlayerInfo } from "./elements/PlayerInfo"
import { Board } from "./elements/GameBoard"
import { StartModal } from './elements/StartModal'
import { Modal } from './elements/Modal'
import { ModalTournament } from './elements/ModalTournament'
import { MatchHistory } from './elements/MatchHistory'
import { AuthContext } from '../context/AuthContext'
import { NavBar } from './elements/navbar/NavBar'
import { Footer } from './elements/Footer'
import { UserContext } from '../context/UserContext'
import { LayoutContext } from '../context/LayoutContext'
import { useGame } from '../hooks/game.hook'
import { useBoardSize } from "../hooks/board.size.hook";
import { GameContext } from '../context/GameContext'
import { SFXContext } from '../context/SFXContext'
import { useFullScreen } from '../hooks/fullscreen.hook'
import { BackButtonSVG, ForwardButtonSVG, MaxBackButtonSVG, MaxForwardButtonSVG } from './elements/SVG'
import { clearLegalMoves, getPositions, makeNewMove } from './functions/getPositions'
import { toNameCase } from './functions/functions'
import './TournamentOnline/tournament.css'

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

const sumArray = (arr1,arr2) => arr1.map(function (num, i) {
    return num + arr2[i];
})

export const Game = () => {
    const {isAuthenticated, socket, userId} = useContext(AuthContext) //socket,
    const {settings, isPlaying, setIsPlaying, isOnline, typing, isMobile, isFirefox, chatOpened} = useContext (UserContext)
    const {playGong, playMove, playTick, playScream} = useContext (SFXContext)
    const {width, height, offsetY, gameBoard, fullBoard, totalHeight, keyboard} = useBoardSize()
    const {opponent, setOpponent} = useGame()
    const isFullScreen = useFullScreen()
    
    // const message = useMessage()
    const tableId = useParams().id 
    const [player, setPlayer] = useState(null)
    const [playerTimer, setPlayerTimer] = useState(null)
    const [opponentTimer, setOpponentTimer] = useState(null)
    const [playerScore, setPlayerScore] = useState(null)
    const [opponentScore, setOpponentScore] = useState(null)
    const [position, setPosition] = useState(null)
    const [moveNum, setMoveNum] = useState(0)
    const [transcript, setTranscript] = useState([])
    const [turn, setTurn] = useState(null)
    const [turns, setTurns] = useState([])
    const [color, setColor] = useState(null)
    const [viewers, setViewers] = useState([])
    const [isPlayer, setIsPlayer] = useState(null)
    const [modalFlag, setModalFlag] = useState(false)
    const [startModalFlag, setStartModalFlag] = useState(false)
    const [gameSettings, setGameSettings] = useState(null)
    const [gameStatus, setGameStatus] = useState(false)
    const [gameHistory, setGameHistory] = useState([])
    const [tournamentId, setTournamentId] = useState(null)
    const [round, setRound] = useState(null)
    const [hasNewMove, setHasNewMove] = useState(false)
    const [next, setNext] = useState(null)
    const [lastMove, setLastMove] = useState('')
    const [positionTable, setPositionTable] = useState([])
    const [editMode, setEditMode] = useState(false)
    const [newGameFlag, setNewGameFlag] = useState(false)
    const [isDisconnected, setIsDisconnected] = useState(false)
    const [verifiedOnly, setVerifiedOnly] = useState(false)
    const [viewerVerified, setViewerVerified] = useState(false)
    
    const [result, setResult] = useState(null)
    const rawNavigate = useNavigate()
    const location = useLocation()

    // Stable ref for navigate — useNavigate() returns a new function when
    // locationPathname changes (React Router v6 behaviour). Putting it directly
    // in a useEffect dependency array causes spurious re-runs that emit
    // left-table for the *current* table, triggering instant abandonment.
    const navigateRef = useRef(rawNavigate)
    navigateRef.current = rawNavigate
    const history = useRef((...args) => navigateRef.current(...args)).current

    const gameTimePlayer = useRef()
    const gameTimeOpp = useRef()
    const gameRef = useRef()
    const editRef = useRef(null)
    const transRef = useRef(null)
    const moveRef = useRef(null)

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

    const reverseColor = color => {
        return color === 'black' ? 'white' : 'black'
    }

    const checkTimers = (turn, color) => {
        gameTimeOpp.current?.stop()
        gameTimePlayer.current?.stop()

        if(turn === color) {
            gameTimeOpp.current?.pause()
            gameTimePlayer.current?.start()
        }

        if (turn !== color && turn) {
            gameTimeOpp.current?.start()
        }
    }

    const moveHandler = event => { 
        if (!socket || !socket.connected) return 
        let cell = event.currentTarget.value.split(',').map(Number)
        let color = turn[0]
        let buffer = [...position]
        for (let i = Math.max(cell[0] - 1, 0); i <= Math.min(cell[0] + 1,buffer.length - 1); i++ ) { 
            for (let j = Math.max(cell[1] - 1, 0); j <= Math.min(cell[1] + 1,buffer.length - 1); j++) {         // проверяем все клетки в пределах доски по периметру от той, куда ходим
                if (buffer[i][j] !== color && buffer[i][j] !== '' && buffer[i][j] !== 'l') {                    // если нашли клетку другого цвета                    
                    let step = [i - cell[0], j - cell[1]]                                                       // задаем шаг, где [i,j] - координаты ближайшей фишки другого цвета от той, что поставили
                    let curIndex = [i,j]                                                                        // фиксируем координаты ближайшей фишки противоложного цвета                      
                    do {
                        if (sumArray(curIndex, step)[0] < 0 || sumArray(curIndex, step)[1] < 0 || sumArray(curIndex, step)[0] > buffer.length -1 || sumArray(curIndex, step)[1] > buffer.length -1) { // проверяем в пределах ли доски следующий шаг
                            break
                        }
                        curIndex = sumArray(curIndex, step)                                                     // меняем индекс на следующую по прямой
                        if (buffer[curIndex[0]][curIndex[1]] === color) {                                       // добрались до черной с координатами curIndex?
                                let startIndex = [i,j]                                                          // вспоминаем координаты ближайшей фишки соперника, с которой надо все перевернуть                              
                                do {                        
                                    buffer[startIndex[0]][startIndex[1]] = color                                // переворачиваем фишку
                                    startIndex = sumArray(startIndex, step)                                     // шагаем в сторону curIndex, меняя значение startIndex                                        
                                } while (startIndex[0]!==curIndex[0] || startIndex[1]!==curIndex[1])            // пока обе координаты не сравняются
                                buffer[startIndex[0]][startIndex[1]] = color                                    // и когда сравнялись - еще разок, так как условие не сработало
                                break
                        }                                                    
                    } while ( curIndex[0] >= 0 && curIndex[1] >= 0 && curIndex[0] < buffer.length && curIndex[1] < buffer.length && buffer[curIndex[0]][curIndex[1]] !== '' && buffer[curIndex[0]][curIndex[1]] !== 'l') 
                }
            }
        }
        buffer[cell[0]][cell[1]] = color
        const discCount = countDiscs(buffer)
        if (player.color === 'black') {
            setPlayerScore(discCount[0])
            setOpponentScore(discCount[1])
        } else {
            setPlayerScore(discCount[1])
            setOpponentScore(discCount[0])
        }
        gameTimePlayer.current.pause()
        setPosition(clearLegalMoves(buffer))
        let newTranscript = [...transcript, event.currentTarget.id]
        socket.emit ('move-made', cell)// передаем позицию board, turn, socketOpp, transcript, gameId, player_id, cell
        setTranscript(newTranscript)
    }

    const resign = () => {
        setPosition(prev => clearLegalMoves(prev))
        socket.emit('resign')
    }

    const gameOver = (result) => {
        setPosition(prev => clearLegalMoves(prev))
        gameTimeOpp.current?.pause()
        gameTimePlayer.current?.pause()
        setIsPlaying(false)
        if(!result) return
        const gameResult = {}

        gameResult.resultText = result.result === -1 ? 'white won' : result.result === 1 ? 'black won' : 'draw'
        gameResult.result = result.result
        gameResult.score = result.score
        gameResult.reason = result.reason === 'score' ? '' : result.reason
        const blackObj = color === 'black' ? player : opponent
        const whiteObj = color === 'white' ? player : opponent
        gameResult.blackNick = (verifiedOnly && viewerVerified && blackObj.wof_name) ? toNameCase(blackObj.wof_name) : blackObj.nick
        gameResult.whiteNick = (verifiedOnly && viewerVerified && whiteObj.wof_name) ? toNameCase(whiteObj.wof_name) : whiteObj.nick
        gameResult.blackRating = result.blackRating
        gameResult.whiteRating = result.whiteRating
        gameResult.difBlackRating = color === 'black' ? result.blackRating - player.rating : result.blackRating - opponent.rating
        gameResult.difWhiteRating = color === 'white' ? result.whiteRating - player.rating : result.whiteRating - opponent.rating
        gameResult.control = result.control
        gameResult.timeControl = result.timeControl
        gameResult.gameId = result.gameId
        setResult(gameResult)
        setModalFlag(true)
        

        let res = color === 'black' ? result.result : -1 * result.result
        res = res === -1 ? 0 : res === 0 ? 0.5 : 1

        setGameHistory([...gameHistory, res])
        if (color === 'black') {
            setPlayer(prev => ({
                ...prev,
                rating: result.blackRating
            }))
            setOpponent(prev => ({
                ...prev,
                rating: result.whiteRating
            }))
        } else {
            setPlayer(prev => ({
                ...prev,
                rating: result.whiteRating
            }))
            setOpponent(prev => ({
                ...prev,
                rating: result.blackRating
            }))
        }
    }

    function isMoveLegal (cell) {                                                                              
        if (position[cell[0]][cell[1]] === 'l') {
            return true
        }
        return false
    }

    function prevMove () {
        if (moveNum === 0) return
        makeMove(moveNum - 1)
    }

    function nextMove () {
        if (moveNum === transcript.length / 2) {return}
        makeMove(moveNum + 1)
    }

    function toFinalPosition () {
        if (moveNum === transcript.length / 2) {return}
        makeMove(transcript.length / 2) 
    }

    function toStartPosition () {
        if (editMode && moveNum === 0) return
        if (moveNum === 0) {return}
        makeMove(0)
    }

    const toSomeMove = (event) => {
        const toMove = event.target.innerText.substring(event.target.innerText.length - 2, event.target.innerText.length)
        const toMoveNumber = parseInt(event.target.innerText.substring(0, event.target.innerText.length - 4))
        if (toMove === lastMove) {return}
        makeMove(toMoveNumber)
    }

    const makeMove = (moveNumber) => {
        setMoveNum(moveNumber)
        setNext(transcript.substring(moveNumber * 2, moveNumber * 2 + 2))
        if(moveNumber === transcript.length / 2) setHasNewMove(false) 
        setLastMove(moveNumber === 0 ? '' : transcript.slice((moveNumber - 1) * 2, (moveNumber) * 2))
        let newBoard = JSON.parse(JSON.stringify(positionTable[moveNumber]))
        if (!editMode) newBoard = clearLegalMoves(newBoard)
        // for (let i = 0; i < rotation; i++) {
        //     newBoard = rotate(newBoard)
        // }
        setPosition(newBoard)
        setTurn(turns[moveNumber])
        const discCount = countDiscs(newBoard)
        if (player.color === 'black') {
            setPlayerScore(discCount[0])
            setOpponentScore(discCount[1])
        } else {
            setPlayerScore(discCount[1])
            setOpponentScore(discCount[0])
        }
        // disconnectRef.current = transcript
    }

    const changeEditMode = () => {
        if(!editMode) { // just turning on
            editRef.current = { 
                positionTable: JSON.parse(JSON.stringify(positionTable)),
                moveNum: moveNum,
                transcript: transcript,
                turns: turns,
                turn: turns[moveNum],
            }
            setTranscript(prev => prev.slice(0, moveNum * 2))
            setTurns(prev => prev.slice(0, moveNum + 1))
            setPositionTable(prev => prev.slice(0, moveNum + 1))
            setEditMode(true)
            setPosition(positionTable[moveNum])
            return
        }
        let newBoard = clearLegalMoves(JSON.parse(JSON.stringify(editRef.current.positionTable[editRef.current.moveNum])))
        // for (let i = 0; i < rotation; i++) {
        //     newBoard = rotate(newBoard)
        // }
        setPosition(newBoard)
        setTranscript(editRef.current.transcript)
        setMoveNum(editRef.current.moveNum)
        setTurns(editRef.current.turns)
        setTurn(editRef.current.turn)
        setPositionTable(editRef.current.positionTable)
        setEditMode(false)
        // setNext(editRef.current.transcript.slice((editRef.current.moveNum) * 2, (editRef.current.moveNum + 1) * 2))
        setLastMove(editRef.current.move === 0 ? '' : editRef.current.transcript.slice((editRef.current.moveNum - 1) * 2, (editRef.current.moveNum) * 2))
        editRef.current = null
    }

    const editMoveHandler = event => {
        const cell = event.currentTarget.value.split(',').map(Number)
        if(!isMoveLegal(cell)) return
        // const newCell = rotateCell(cell, rotation)
        const newMove = event.currentTarget.id
        const buffer = JSON.parse(JSON.stringify(positionTable[moveNum]))
        const newTurn = turn === "black" || turn === "b" ? 'b' : 'w'
        const data = makeNewMove(cell, buffer, newTurn, true)
        if(newMove === transcript.slice((moveNum) * 2, (moveNum + 1) * 2)) {
            makeMove(moveNum + 1)
            return
        }
        editRef.current.moveNum = editRef.current.moveNum > moveNum ? moveNum : editRef.current.moveNum
        setPositionTable(prev => [...prev.slice(0, moveNum + 1), data.buffer])
        setTurns(prev => [...prev.slice(0, moveNum + 1), data.turn])
        // setScore(countDiscs(data.buffer)) // change
        let newBoard = JSON.parse(JSON.stringify(data.buffer))
        const discCount = countDiscs(newBoard)
        if (player.color === 'black') {
            setPlayerScore(discCount[0])
            setOpponentScore(discCount[1])
        } else {
            setPlayerScore(discCount[1])
            setOpponentScore(discCount[0])
        }
        
        // for (let i = 0; i < rotation; i++) {
        //     newBoard = rotate(newBoard)
        // }
        setPosition(newBoard)
        setMoveNum(prev => prev + 1)
        setTranscript(prev => prev.slice(0, moveNum * 2) + newMove)
        setTurn(data.turn)
        setLastMove(newMove)
        
    } 

    useEffect(() => {
        if (!userId || gameStatus === 'finished') return
        if (!startModalFlag) { //  && isPlayer
            checkTimers(turn, color)
            return
        }
        if (startModalFlag) { //  && isPlayer
            setTimeout(() => {
                setStartModalFlag(false)
            }, 2000)
        }
        
    },[startModalFlag, isPlayer, userId, gameStatus]) //tableId
    
    useEffect(() => {
        
        if (!isFullScreen && isMobile && !isFirefox ) { // 
            const elem = document.getElementById('root')
            try {
                if (elem.requestFullscreen) { elem.requestFullscreen({navigationUI: 'show'}) } 
                //# for Safari (older versions)
                else if (elem.webkitRequestFullscreen) { elem.webkitRequestFullscreen({navigationUI: 'show'}) }
                //# for Safari (newer versions)
                else if (elem.webkitEnterFullscreen) { elem.webkitEnterFullscreen({navigationUI: 'show'}) }

                else if (elem.mozRequestFullScreen) { elem.mozRequestFullScreen({navigationUI: 'show'}) }
                // window.scrollTo(0,0)

            } catch (e) {console.log(e)}
        }
        
        return () => {
            try {
                if (document.exitFullscreen) {
                    document.exitFullscreen();
                  } else if (document.webkitExitFullscreen) {
                    document.webkitExitFullscreen();
                  } else if (document.mozCancelFullScreen) {
                    document.mozCancelFullScreen();
                  }
                window.scrollTo(0,0)
            } catch (e) {console.log(e)}
        }
    },[]) //isMobile,

    //pause timers, change gamestatus, show modal with result, changed rating, countup animation for new rating, show rematch button, edit button

    useEffect(() => {  //on mount
        socket.sendBuffer = []
        if (!userId)
            return () => {
                socket.off('ping')
                socket.off('ping1')
                socket.off('navigate')
            }
        socket.on('navigate', (url) => {
            history(url)
        })
        socket.on('ping', () => {
            socket.emit('pong')
        })
        socket.on('ping1', () => {
            socket.emit('pong1', tableId)
        })

        // match handler removed — GlobalGameRedirect (App level) already
        // navigates to /game/:id on 'match'. Having a second handler here
        // caused duplicate navigate() calls which could trigger spurious
        // useEffect re-runs leading to instant tournament abandonment.

        socket.on('player-disconnected', nick => {
            setIsDisconnected(nick)
        })

        socket.on('reconnected', () => {
            setIsDisconnected(false)
        })

        socket.emit('join-table', tableId)

        // Re-join table on reconnect so we get the latest game state
        // (e.g. opponent's move made while we were disconnected)
        const handleReconnect = () => {
            socket.emit('join-table', tableId)
        }
        socket.on('connect', handleReconnect)

        return () => {
            socket.off('ping')
            socket.off('ping1')
            socket.off('navigate')
            socket.off('reconnected')
            socket.off('player-disconnected')
            socket.off('connect', handleReconnect)
            socket.emit('left-table', tableId)
        }
    }, [socket, userId, tableId]) // history removed — using stable ref instead

    // Screen Wake Lock: keeps the screen on during active games so the OS
    // doesn't suspend the browser and kill the WebSocket connection.
    // The lock is automatically released when the tab goes to background;
    // we re-acquire it on visibilitychange → visible.
    useEffect(() => {
        if (!isPlayer || gameStatus === 'finished') return
        if (!('wakeLock' in navigator)) return

        let wakeLock = null
        let released = false

        const acquire = async () => {
            try {
                wakeLock = await navigator.wakeLock.request('screen')
                wakeLock.addEventListener('release', () => { wakeLock = null })
            } catch (e) { /* user denied or not supported */ }
        }

        const handleVisibility = () => {
            if (document.visibilityState === 'visible' && !released) acquire()
        }

        acquire()
        document.addEventListener('visibilitychange', handleVisibility)

        return () => {
            released = true
            document.removeEventListener('visibilitychange', handleVisibility)
            wakeLock?.release().catch(() => {})
        }
    }, [isPlayer, gameStatus])

    // Game-level heartbeat: only players send heartbeat, not viewers
    // Detects connection issues faster than Socket.IO ping/pong (~6-9s vs ~25s)
    const [connectionUnstable, setConnectionUnstable] = useState(false)
    
    useEffect(() => {
        if (!isPlayer || !isOnline || gameStatus === 'finished') return

        let missedBeats = 0
        const HEARTBEAT_INTERVAL = 3000 // 3 seconds
        const MAX_MISSED = 3            // warn after 3 misses (~9s)

        const heartbeatInterval = setInterval(() => {
            const timeout = setTimeout(() => {
                missedBeats++
                if (missedBeats >= MAX_MISSED) {
                    setConnectionUnstable(true)
                }
            }, 2000) // allow 2s for ack response

            socket.volatile.emit('game-heartbeat', (response) => {
                clearTimeout(timeout)
                if (response?.ok) {
                    missedBeats = 0
                    setConnectionUnstable(false)
                }
            })
        }, HEARTBEAT_INTERVAL)

        return () => {
            clearInterval(heartbeatInterval)
            setConnectionUnstable(false)
        }
    }, [socket, isPlayer, isOnline, gameStatus])

    useEffect(() => { // start game, 
        if(!userId) return        
        socket.on('start-game', (game,  viewers) => { //user,
            
            setTournamentId(game.tournamentId)
            setRound(game.round)
            setViewers(viewers)
            setGameStatus(game.status)
            const discCount = countDiscs(game.position)
            setTranscript(game.transcript)
            setMoveNum(game.transcript.length / 2)
            setTurn(game.turn)
            setModalFlag(false)
            const isWof = !!game.verifiedOnly
            const isViewerWof = !!game.viewerVerified
            setVerifiedOnly(isWof)
            setViewerVerified(isViewerWof)
            const blackWofName = (isWof && isViewerWof && game.black.wof_name) ? toNameCase(game.black.wof_name) : null
            const whiteWofName = (isWof && isViewerWof && game.white.wof_name) ? toNameCase(game.white.wof_name) : null
            setGameSettings({
                blackNick: blackWofName || game.black.nick,
                whiteNick: whiteWofName || game.white.nick,
                blackRating: game.black.rating,
                whiteRating: game.white.rating,
                timeControl: game.white.timer/60000,
                increment: game.increment/1000,
                control: game.control
            })
            if (game.moves.length === 0 && game.black.timer >= game.white.timer - 2000 &&
                (userId === game.black.id || userId === game.white.id || game.white.id === socket.id.substring(1,5).concat(tableId) || game.black.id === socket.id.substring(1,5).concat(tableId))) {
                setStartModalFlag(true) // gameHistory is empty. Don't forget remove buffer on back end
            }
            
            if (userId === game.black.id || game.black.id === socket.id.substring(1,5).concat(tableId)) { // если играем черными
                if(settings.sound) {playGong()} // or other sound
                setIsPlayer(true) //
                setIsPlaying(true)
                setPlayer(game.black)
                setOpponent(game.white)
                setPlayerTimer(game.black.timer)
                setOpponentTimer(game.white.timer)
                setPlayerScore(discCount[0])
                setOpponentScore(discCount[1])
                // checkTimers(game.turn, 'black')
                if (game.turn === 'black') {
                    setPosition(game.position)
                } else {
                    setPosition(clearLegalMoves(JSON.parse(JSON.stringify(game.position))))
                }               
                setColor('black')
            } else if (userId === game.white.id || game.white.id === socket.id.substring(1,5).concat(tableId)) { // если играем белыми
                if(settings.sound) {playGong()} // or other sound
                setIsPlayer(true)
                setIsPlaying(true)
                setPlayer(game.white)
                setOpponent(game.black)
                setPlayerTimer(game.white.timer)
                setOpponentTimer(game.black.timer)
                setPlayerScore(discCount[1])
                setOpponentScore(discCount[0])
                if (game.turn === 'black') {
                    setPosition(clearLegalMoves(JSON.parse(JSON.stringify(game.position))))
                } else {
                    setPosition(game.position)
                }
                setColor('white')
            } else { // если зритель
                setIsPlayer(false)
                setIsPlaying(false)
                setEditMode(false)
                editRef.current = null
                setNewGameFlag(prev => !prev)
                setHasNewMove(false)
                if(game.black.nick > game.white.nick) {
                    setPlayer(game.black)
                    setOpponent(game.white)
                    setPlayerTimer(game.black.timer)
                    setOpponentTimer(game.white.timer)
                    setPlayerScore(discCount[0])
                    setOpponentScore(discCount[1])                              
                    setColor('black')
                } else {
                    setPlayer(game.white)
                    setOpponent(game.black)
                    setPlayerTimer(game.white.timer)
                    setOpponentTimer(game.black.timer)
                    setPlayerScore(discCount[1])
                    setOpponentScore(discCount[0])          
                    setColor('white')
                }
                setPosition(clearLegalMoves(JSON.parse(JSON.stringify(game.position)))) 
                const pos = getPositions(game.transcript, true)
                setPositionTable(pos.positionTable)
                setTurns([...pos.turns, pos.turn])
            }
            
            if(game.status === 'finished') { // reconnected after loss on disconnection
                gameOver(result)
            }
        })

        return () => {
            socket.off('start-game')
        }
    },[socket, userId, tableId]) // history removed — using stable ref instead
    
    useEffect(()=> { // new-move, game-over
        socket.on('new-move', game => {
            if (!player) {return}
            if (settings.sound) {
                playMove()
            }
            const moveNumber = game.transcript.length / 2
            if (!isPlayer && editMode) {
                const pos = getPositions(game.transcript, true)
                editRef.current.positionTable = JSON.parse(JSON.stringify(pos.positionTable))
                editRef.current.transcript = game.transcript
                editRef.current.turns = [...pos.turns, pos.turn]
                setHasNewMove(true)
            }

            if (!isPlayer && !editMode) {
                setPositionTable(prev => [...prev, game.position])
                setTurns(prev => [...prev, game.turn])
                setTranscript(game.transcript)
            }
            if (isPlayer || (!editMode && moveNum >= moveNumber - 1)) {
                if (!isPlayer || game.turn !== color) {  // не твой ход
                    setPosition(clearLegalMoves(JSON.parse(JSON.stringify(game.position))))
                } else {
                    setPosition(game.position)
                }
                setTurn(game.turn)
                setTranscript(game.transcript)
                setMoveNum(game.transcript.length / 2)
                setLastMove(moveNumber === 0 ? '' : game.transcript.slice((moveNumber - 1) * 2, (moveNumber) * 2))
                const discCount = countDiscs(game.position)
                if (color === 'black') {
                    setPlayerScore(discCount[0])
                    setOpponentScore(discCount[1])
                    setPlayerTimer(game.blackTimer)
                    setOpponentTimer(game.whiteTimer)
                } else {
                    setPlayerScore(discCount[1])
                    setOpponentScore(discCount[0])
                    setPlayerTimer(game.whiteTimer)
                    setOpponentTimer(game.blackTimer)
                }
            } else {
                setHasNewMove(true)
            }
            
            if (game.status === 'finished') { // handle game over event
                setGameStatus(game.status)
                return
            }
            if (game.turn === color) {
                gameTimeOpp.current.pause()
                gameTimePlayer.current.start()
            }

            if (game.turn !== color && !isPlayer) {
                gameTimePlayer.current.pause()
                gameTimeOpp.current.start()
            }

            if (game.turn !== color && game.turn) {
                gameTimeOpp.current.start()
            }
        })

        socket.on('game-over', (result) => {
            console.log(result)
            setGameStatus('finished')
            if (result.reason === 'timeout') {
                if (color === 'black') {
                    result.score === 0 ? setPlayerTimer(0) : setOpponentTimer(0)
                    if(isPlayer && settings.sound && result.score === 0) playScream() // or other sound{  }
                } else {
                    result.score === 0 ? setOpponentTimer(0) : setPlayerTimer(0)
                    if(isPlayer && settings.sound && result.score === 64) playScream()
                }
            }
            gameOver(result)

        })

        return () => {
            socket.off('new-move')
            socket.off('game-over')
        }
        
    },[player, settings, editMode, moveNum, color, isPlayer]) //tableId

    useEffect (() => { 
        if ( !transRef.current) return //lastMove === '' || moveRef === null || move < 3 || 
            requestAnimationFrame(() => {
                transRef.current.scrollLeft = (moveNum - 2) * 59
            })        
    },[lastMove, transRef.current, moveNum, moveRef])
    
    if (!opponent || !player) return
    return (
        <>
        
        <LayoutContext.Provider value = {{ width, height, offsetY, gameBoard, fullBoard, totalHeight, keyboard}}>
        <GameContext.Provider value = {{opponent, setOpponent, round}}>
        <Helmet>
            <meta name="viewport" content="width=device-width, height=device-height, interactive-widget=resizes-content, initial-scale=1.0, maximum-scale=1.0, user-scalable=no" />
        </Helmet>
        
        <div style ={params} ref = {gameRef}>
            <NavBar isHome = {false} isGame = {true} tournamentId = {tournamentId}></NavBar>

            { round ? 
            <div className= 'round-name'>{`Round ${round}`}</div>  
            : <MatchHistory gameHistory = {gameHistory} hideFooter = {typing}/>}
            <main className = 'game-layout' >  
                <PlayerInfo 
                    nickName = {(verifiedOnly && viewerVerified && opponent.wof_name) ? toNameCase(opponent.wof_name) : opponent.nick}
                    rating = {opponent.rating}
                    timer = {opponentTimer}
                    color = {reverseColor(color)}
                    score = {opponentScore}
                    country = {opponent.country}
                    ref = {gameTimeOpp}
                    turn = {turn} 
                    // hideFooter = {typing && isMobile} 
                    avatar = {true}
                    isDisconnected = {!!isDisconnected}
                    profileNick = {(!isPlayer || gameStatus === 'finished') ? opponent.nick : null}
                />
                <div style = {{height: 10}}></div>
                <Board
                    transcript = {transcript}
                    move = {moveNum}
                    position =  {position}
                    turn = {turn}
                    moveHandler = {moveHandler}
                    gameBoard = {gameBoard}
                    editMode = {editMode}
                    editMoveHandler = {editMoveHandler}
                    prevMove = {prevMove}
                    nextMove = {nextMove}
                    isPlayer = {isPlayer}
                />
                <PlayerInfo 
                    nickName = {(verifiedOnly && viewerVerified && player.wof_name) ? toNameCase(player.wof_name) : player.nick}
                    rating = {player.rating}
                    timer = {playerTimer}
                    color = {color}
                    score = {playerScore}
                    country = {player.country}
                    ref = {gameTimePlayer}
                    turn = {turn}
                    timerTick = {playTick}
                    // hideFooter = {typing && isMobile} 
                    avatar = {true}   
                    profileNick = {(!isPlayer || gameStatus === 'finished') ? player.nick : null}
                />
                {/* <div style = {{height: 10}}></div> */}

            </main>

            {!isPlayer && !chatOpened ? 
            <div className = 'buttons-container game'>
                <MaxBackButtonSVG onClick = {toStartPosition} move = {moveNum}/>
                <BackButtonSVG onClick = {prevMove} move = {moveNum}/>
                <div className = 'transcript-move'>
                    <div className="transcript-container">
                        <div ref = {transRef} className= 'transcript'>                            
                            {transcript?.length > 0 ?
                            transcript.match(/.{1,2}/g).map ((m, idx) => 
                                <div 
                                    ref = {m === lastMove ? moveRef : null} 
                                    key = {idx + 1 + m} 
                                    className = {m === lastMove ? "last-move" : "prev-move"} 
                                    onClick = {toSomeMove}>
                                {`${idx + 1 + '. ' + m}`}
                                </div>
                            ) : <></>
                            }
                            
                        </div>
                    </div>
                    {hasNewMove ? <div className='new-move'/> : <div style = {{width: '10px'}}></div>}
                </div>
                <ForwardButtonSVG onClick = {nextMove} move = {moveNum} transcript = {transcript}/>
                <MaxForwardButtonSVG onClick = {toFinalPosition} move = {moveNum} transcript = {transcript}/>
            </div>
            : <></>}

            <StartModal settings = {gameSettings}  modalFlag = {startModalFlag}/> 
            {/* start modal only if game history is empty */}
            { round ? 
                <ModalTournament result = {result} setResult = {setResult} color = {color} socket = {socket} modalFlag = {modalFlag} tournamentId = {tournamentId} tableId = {tableId}/>
            :
                <Modal result = {result} setResult = {setResult} color = {color} socket = {socket} modalFlag = {modalFlag} isPlayer = {isPlayer} isAuthenticated = {isAuthenticated} />
            }
            <Footer 
                isGame = {true} 
                resign = {resign} 
                viewers = {viewers} 
                setViewers = {setViewers} 
                isPlayer = {isPlayer} 
                changeEditMode = {changeEditMode}
                newGameFlag = {newGameFlag}
                isTournament = {!!tournamentId}
            />
        </div>
        </GameContext.Provider>
        </LayoutContext.Provider>
        
        </>
    )
}
//viewers = {viewers}
//setSettings = {setGameSettings}
export default Game