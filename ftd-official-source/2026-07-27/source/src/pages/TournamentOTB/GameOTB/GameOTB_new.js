import React, {useRef, useEffect, useContext, useState, useCallback} from "react"
import { useParams, useNavigate, useLocation } from 'react-router-dom'
import { toast } from 'react-toastify';
import { Helmet } from "react-helmet";
import { Cell } from "../../elements/Cell"
import { TranscriptCell } from "./TranscriptCell";
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
import { getFullRoundName, getFullGameName, rotate, rotateCell, formatTextTranscript, checkTranscript, debounce } from '../../functions/functions'
import { BackButtonSVG, ForwardButtonSVG, MaxBackButtonSVG, MaxForwardButtonSVG, EditButtonSVG, CopyButtonSVG, AnalyzeSVG } from '../../elements/SVG'
import '.././otb.css'
import { FooterGameOTB } from "./FooterGame"
import { EmptyBoard } from "./EmptyBoard"
import { useSensei } from "../../../hooks/sensei.hook"
import { SFXContext } from '../../../context/SFXContext';
import { ModalLoading } from '../../elements/ModalLoading';

const formatEvalsForEvalBar = (evals) => {
    if (!evals) return [] 
    const result = []
    const black = evals[0].player_id 
    for (let i = 0; i < evals.length; i++) {
        if (evals[i].player_id === black || evals[i].best_eval === 0) {
            result.push({move_number: evals[i].move_number - 1 , best_eval: evals[i].best_eval})
        } else {
            result.push({move_number: evals[i].move_number - 1, best_eval: evals[i].best_eval * -1})
        }
    }

    if (evals[evals.length - 1].player_id === black || evals[evals.length - 1].best_eval === 0) {
        result.push({move_number: evals[evals.length - 1].move_number, best_eval: evals[evals.length - 1].best_eval})
    } else {
        result.push({move_number: evals[evals.length - 1].move_number, best_eval: evals[evals.length - 1].best_eval * -1})
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

export const GameOTB = () => { 
    //get only players, game info, transcript and move number
    //id, round, tournamentID, transcript, comment, positionTable, turn, move, data, setPosition, sizes, isTD
    
    // on swipe - lock UI before we get new game and then start the animation
    const {id, gameId} = useParams() 
    const location = useLocation()
    const [tName, setTName] = useState(' ')
    const [rName, setRName] = useState('')
    const [gName, setGName] = useState('')
    const [isTD, setIsTD] = useState(false)
    const [isXot, setIsXot] = useState(false)
    // const [isAssistant, setIsAssistant] = useState(false)
    const [isPlayer, setIsPlayer] = useState(false)
    const [gameResult, setGameResult] = useState(null)
    const [scoreByTranscript, setScoreByTranscript] = useState(-1)
    const [lastMove, setLastMove] = useState('')
    const [transcript, setTranscript] = useState('')
    const [trasncriptToInsert, setTrasncriptToInsert] = useState('')
    const [validTranscript, setValidTranscript] = useState(false)
    const [transcriptMode, setTranscriptMode] = useState(false)
    const [transcriptArray, setTranscriptArray] = useState([])
    const [loading, setLoading] = useState(true)
    const [editMode, setEditMode] = useState(false)
    const [allowedToStream, setAllowedToStream] = useState(false)
    // const [streamMode, setStreamMode] = useState(false)
    const [board, setBoard] = useState(JSON.parse(JSON.stringify(startingPosition)))
    const [positionTable, setPositionTable] = useState([])
    const [blackPlayer, setBlackPlayer] = useState()
    const [whitePlayer, setWhitePlayer] = useState()
    const [round, setRound] = useState()
    const [move, setMove] = useState(0)
    const [turn, setTurn] = useState('b')
    const [turns, setTurns] = useState([])
    const [score, setScore] = useState([])
    const [finished, setFinished] = useState(false)
    const [next, setNext] = useState(null)
    const [hasNewMove, setHasNewMove] = useState(false)
    const [comment, setComment] = useState()
    const [byPlayer, setByPlayer] = useState(false)
    const [evals, setEvals] = useState([])
    const [evalBarData, setEvalBarData] = useState(0)
    const [evalGraphData, setEvalGraphData] = useState([])
    const [showEvals, setShowEvals] = useState(false)
    const [nextGameReq, setNextGameReq] = useState()
    const [rotation, setRotation] = useState(0)
    const [rows, setRows] = useState([1,2,3,4,5,6,7,8])
    const [cols, setCols] = useState(['a','b','c','d','e','f','g','h'])
    const moveRef = useRef(null)
    const transRef = useRef(null)
    const mainBoardRef = useRef(null)
    const animation = useRef(null)
    const p1Ref = useRef(null)
    const p2Ref = useRef(null)
    const editRef = useRef(null)
    const newTransRef = useRef(null)
    const inputRefs = useRef([])
    const disconnectRef = useRef(null)
    const positionToAnalyze = useRef(null)

    // const debugRef = useRef(null)
    // const scoreByTranscript = useRef(-1)
    
    const { socket } = useContext(AuthContext)
    const { settings, isOnline, typing, messages, setMessages, isMobile, setIsPlaying } = useContext (UserContext)
    const { playMove } = useContext (SFXContext)
    const { sensei, status, senseiReady, hintedOnce, hintEvals, edaxBookEmpty, senseiHint, senseiStop, updateHintEvals, setHintEvals, hintEvalsFlag, evalsTable, evalsRef, editModeRef, setHintedOnce, resetRetro } = useSensei()
   
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
        resetRetro()
    },[id, gameId])

    useEffect (() => {
        socket.on('otb-game-analysis', data => {
            if(data && data?.length > 0) {
                setEvals(data)
                setEvalGraphData(formatEvalsForEvalBar(data))
                evalsRef.current = data
            }
        })
        socket.on('otb-game', data => { // set all the data 
            // console.log('otb-game data', data)
            if(!data) {
                history(`/live/${id}`)
                return
            }
            setIsTD(data.isTD)
            setIsXot(!!data.xot)
            if((data.isTD || data.isPlayer) && data.pairing[0].score !== null) setIsPlaying(true)
            setIsPlayer(data.isPlayer)
            setGameResult(data.pairing[0].score)
            setRound(data.round)
            setComment(data.pairing[0]?.comment)
            setFinished(data.finished)
            setBlackPlayer(data.pairing[0])
            setWhitePlayer(data.pairing[1])
            setTName(data.tName)
            setRName(data.rName)
            setGName(data.pairing[0].gameName)
            const transcript = data.pairing[0]?.transcript
            const pos = getPositions(transcript, true)
            setMessages(transcriptToChat(transcript))// ?? this is wrong actually we should render / change messages only after we receive chat from server
            // if there were no game - set everything as usual
            // if editMode - update editModeRef, leave the rest as is
            // if !editMode (disconnect) - do the same, i'll need transcript, moveNumber and that's it
            const scoreTrans = getFinalScore(pos.positionTable[pos.positionTable.length - 1], !transcript? 'b' : pos.turns[pos.turns.length - 1])
            setScoreByTranscript(scoreTrans)
            if(scoreTrans === -1 && (data.isTD || data.isPlayer)) setAllowedToStream(true)

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
                setMove(data.finished || !transcript ? 0 : transcript?.length / 2)
                setNext(data.finished && transcript ? transcript?.substring(0,2) : null)
                setTurn(data.finished || !transcript? 'b' : pos.turn) // here insert "getTurn function" for liveGames
                setScore(data.finished || !transcript? [2,2] : countDiscs(pos.positionTable[transcript?.length / 2])) // think through XOT! countDiscs(location.state?.positionTable[location.state?.move])
                setLastMove(transcript?.slice((transcript?.length - 2), (transcript?.length)))
                setBoard(data.finished || !transcript ? JSON.parse(JSON.stringify(startingPosition)) : pos.positionTable[transcript?.length / 2]) // get position!
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
            
            
            

            // console.log(data.isTD, data.isPlayer, !data.pairing[0].score, data.pairing[0].score !== 0, scoreTrans, !data.pairing[0]?.comment)
            // if(
            //     (data.isTD || data.isPlayer) && (
            //         !data.pairing[0]?.transcript || (
            //             !data.pairing[0].score && data.pairing[0].score !== 0
            //         ) || (
            //             scoreTrans !== data.pairing[0].score && !data.pairing[0]?.comment
            //         ))) {
            //             console.log('hi')
            //     setAllowedToStream(true)
            // }

            setLoading(false)

            // console.log('score according to transcript', scoreTrans, 'vs', data.pairing[0].score)
        })
        socket.on('next-game', newId => {
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
                history(`/live/${id}/${newId}`)
            }, 500)
        })
        socket.on('otb-chat', data => {
            if(data.length === 0) return 
            if(data.filter(msg => msg.sender !== -1).length > 0) {
                setMessages(data)
            } else {
                setMessages(prev => [...prev, ...data])
            }
        })
        socket.on('score', score => {
            setGameResult(score)
            if (score === scoreByTranscript) {
                // console.log(scoreByTranscript, score)
                setAllowedToStream(false)
            }
        })

        return () => {
            socket.off('otb-game-analysis')
            socket.off('otb-game')
            socket.off('next-game')
            socket.off('otb-chat')
            socket.off('score')
            // socket.emit('leave-otb-game', gameId) // remove from the room leave-otb-game
            // setIsPlaying(false)
        }
        
    },[id, gameId, nextGameReq, isOnline, scoreByTranscript]) //, settings.showEvalBar
    
    useEffect(() => {
        return () => {
            socket.emit('leave-otb-game', gameId) // remove from the room leave-otb-game
            setIsPlaying(false)
        }
    }, [id, gameId, nextGameReq])

    useEffect(()=> { // edax book values
        socket.on('otb-hint', (trans, evals) => {
            if(evals.length === 0 && transcript.slice(0, move * 2) === trans) {
                // setEdaxBookEmpty(move)
                edaxBookEmpty.current = move
            }
            if(evals.length === 0 || transcript.slice(0, move * 2) !== trans) return
            updateHintEvals(evals)
        })

        return () => {
            socket.off('otb-hint')
        }

    },[transcript, move, id, gameId])

    useEffect (()=> {
        console.log('location.state', location.state)
        if(!isOnline) {
            location.state = null
            return
        }
        if(location.state && isOnline) {
        // setHasNewMove(false)
        // setHintEvals([])
        // setHintedOnce(false)
        // setEditMode(false)
        // editRef.current = null
        setIsTD(location.state?.canEdit)
        setIsXot(!!location.state?.xot)
        // setIsAssistant(data.isAssistant)
        // if((data.isTD || data.isPlayer) && data.pairing[0].score !== null) setIsPlaying(true)
        // setIsPlayer(data.isPlayer)

        setRound(location.state?.round)
        const transcript = location.state?.data[0]?.transcript
        const pos = getPositions(transcript, true)
        const move = location.state?.move
        setPositionTable(pos.positionTable)
        setTranscript(transcript)
        setComment(location.state?.data[0]?.comment)
        setGameResult(location.state?.data[0]?.score)
        setBlackPlayer(location.state?.data[0])
        setWhitePlayer(location.state?.data[1])
        setMove(location.state?.move)
        setTurn(pos.turns[move])
        // console.log('pos', pos)
        setTurns([...pos.turns, pos.turn])
        setScore(countDiscs(pos.positionTable[move]))
        setLastMove(location.state?.move === 0 ? '' : transcript.slice((move - 1) * 2, (move) * 2))
        setNext(location.state?.score !== null ? transcript.slice((move) * 2,(move + 1) * 2) : null)
        setBoard(pos.positionTable[move])
        setTName(location.state?.tName)
        setRName(location.state?.rName)
        setGName(location.state?.data[0].gameName)
        setByPlayer(location.state?.byPlayer)
        setFinished(location.state?.data[0]?.score !== null)
        // setEvals(null)
        setMessages(transcriptToChat(transcript))
        // evalsRef.current = []
        const scoreTrans = getFinalScore(pos.positionTable[pos.positionTable.length - 1], pos.turns[pos.turns.length - 1])
        setScoreByTranscript(scoreTrans)
        // scoreByTranscript.current = getFinalScore(pos.positionTable[pos.positionTable.length - 1], pos.turns[pos.turns.length - 1])
        // console.log('loc score according to transcript', scoreTrans, 'vs', location.state?.data[0].score)
        socket.emit('join-otb-game', id, gameId)
        window.history.replaceState({}, '')
        setLoading(false)
        } else {
            // setShowEvalBar(false)
            // setShowEvals(false)
            socket.emit('get-otb-game', id, gameId) //- in case of direct link - same as 'location'
        } 
    },[location, id, gameId, isOnline]) //, settings.showEvalBar

    useEffect (() => { 
        if ( !transRef.current) return //lastMove === '' || moveRef === null || move < 3 || 
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
            // set player1 = player2
        } else if (rotation === 2) {
            setRows(['h','g','f','e','d','c','b','a'])
            setCols([1,2,3,4,5,6,7,8]) 
        } else {
            setRows([1,2,3,4,5,6,7,8]) 
            setCols(['a','b','c','d','e','f','g','h'])
            // set player1 = player2
        }
        setRotation(prev => prev === 3 ? 0 : prev + 1)
        setBoard(prev => rotate(prev))
    }

    const showAnalysis = () => {
        setShowEvals(prev => !prev)
        if(showEvals && sensei && senseiReady) {
            hintEvalsFlag.current = 0
            senseiStop()
            return
        }
        if(showEvals) return
        if((!evals || evals?.length === 0) && !editMode) socket.emit('get-otb-analysis', id, gameId)
        if(sensei && senseiReady && !showEvals) senseiHint(transcript.slice(0, move * 2), move, transcript.slice(move * 2, (move + 1) * 2), evalsTable.current, countLegalMoves(positionTable[move]), status)
    }


    const makeMove = (moveNumber) => {
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
        setHintEvals([])
        // console.log(edax && edaxReady && (showEvals || settings.showEvalBar)) //
        if(sensei && senseiReady && (showEvals || settings.showEvalBar)) {
            const str = transcript.slice(0, moveNumber * 2)
            const nMove = editMode ? '' : transcript.substring(moveNumber * 2, moveNumber * 2 + 2)
            const legalMoves = countLegalMoves(positionTable[moveNumber])
            senseiHint(str, moveNumber, nMove, evalsTable.current, legalMoves, status)
        }

        // disconnectRef.current.move = moveNumber
        disconnectRef.current = transcript
    }

    const toCapitalized = (str) => {
        if(!str) return ''
        return str.charAt(0).toUpperCase() + str.slice(1)
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
        if (move === transcript.length / 2) {return}
        makeMove(move + 1)
    }

    function toFinalPosition () {
        if (move === transcript.length / 2) {return}
        makeMove(transcript.length / 2) 
    }

    function toStartPosition () {
        if (editMode && move === 0) return
        if (editMode && move === editRef.current.move) {
            makeMove(0)
            return
        }
        if (editMode) { 
            makeMove(editRef.current.move)
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
        if (board[cell[0]][cell[1]] === 'l') {
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
            const result = {value: evals[move].eval > 0 ? "+" + evals[move].eval : evals[move].eval, opacity: 1, evalDone: true}
            const hint = hintEvals?.find(h => h.move === cellName)
            if (hint) { result.certainty = hint.certainty; result.is_book = hint.is_book }
            return result
        }
        if(hintEvals?.length > 0 && showEvals) return getEvalFromHint(hintEvals, cellName)
        return null
    }

    function getBestEval (cellName) {
        // 2 options: live game or edit and game finished
        if(evals && cellName === evals[move]?.best_move 
            && showEvals && move !== transcript.length / 2 && 
            (!editMode || editMode && transcript.slice(0, move * 2) === editRef?.current?.transcript.slice(0, move * 2))) {
            const result = {value: evals[move].best_eval > 0 ? "+" + evals[move].best_eval : evals[move].best_eval, opacity: 1, evalDone: true}
            const hint = hintEvals?.find(h => h.move === cellName)
            if (hint) { result.certainty = hint.certainty; result.is_book = hint.is_book }
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
            const opacity = hintEvalsFlag.current === 3 || arr[moveIndex].is_book ? 1 : Math.min(1, 0.5 + (arr[moveIndex].descendants / 2000000))
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
                const opacity = hintEvalsFlag.current === 3 || arr[i].is_book ? 1 : Math.min(1, 0.5 + (arr[i].descendants / 2000000))
                const evalDone = hintEvalsFlag.current === 3 || arr[i].is_book
                return {value: value, opacity: opacity > 0.5 ? opacity : 0.5, certainty: arr[i].certainty, is_book: arr[i].is_book, evalDone: evalDone}
            }
        }
    }

    const changeEditMode = () => {
        if(!editMode) { // just turning on
            editRef.current = { 
                positionTable: JSON.parse(JSON.stringify(positionTable)),
                move: move,
                transcript: transcript,
                turns: turns,
                turn: turns[move],
                evalsTable: [...evalsTable.current]
            }
            setTranscript(prev => prev.slice(0, move*2))
            setTurns(prev => prev.slice(0, move + 1))
            setPositionTable(prev => prev.slice(0, move + 1))
            setEditMode(true)
            // console.log('turn', turn, 'turns', turns.length, 'this turn', turns[move])
            evalsTable.current = evalsTable.current.slice(0, move + 1)
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
        setMove(editRef.current.move)
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

    const TranscriptChange = (trans) => {
        toast.dismiss()
        // console.log(trans)
        if(!trans || trans?.length === 0) {
            setValidTranscript(false)
            return
        }
        
        const valid = checkTranscript(trans)

        if (!valid) {
            toast.dismiss()
            toast.error("Entered text doesn't represent valid transcript", {autoClose: 3000})
            setValidTranscript(false)
            //close button glows green on click - wtf...
            return
        }
        if (trans.length % 2 !== 0) {
            setValidTranscript(false)
            return
        }
        //check that transcript leads to reals game
        const pos = getPositions(trans, true)
        setTrasncriptToInsert(trans)
        if (pos.err) {
            // console.log(pos.err)
            toast.dismiss()
            toast.error(pos.err, {autoClose: 3000})
            setValidTranscript(false)
            return
        }
        if(!newTransRef?.current) {
            newTransRef.current = {
                positionTable: JSON.parse(JSON.stringify(positionTable)),
                move: move,
                transcript: transcript,
                turns: turns,
            }
        }
        
        setValidTranscript(true)
        const moveNumber = trans.length / 2
        setTranscript(trans)
        setPositionTable(pos.positionTable)
        setMove(moveNumber)
        setTurn(pos.turn)
        setTurns([...pos.turns, pos.turn])
        setScore(countDiscs(pos.positionTable[moveNumber]))
        setLastMove(trans.slice((moveNumber - 1) * 2, (moveNumber) * 2))
        setNext(null)
        setBoard(pos.positionTable[moveNumber])
        setTranscriptMode(false)
    }

    const pasteTranscript = async () => {
        const text = await navigator.clipboard.readText();
        const trans = formatTextTranscript(text)
        if(trans.length === 0) {
            toast.dismiss()
            toast.error("Clipboard is empty", {autoClose: 3000})
            setValidTranscript(false)
            return
        }
        TranscriptChange(trans)
    }

    const confirmInsertTranscript = () => {
        // console.log(trasncriptToInsert)
        socket.emit('otb-paste-transcript', id, gameId, trasncriptToInsert)
        newTransRef.current = null
        setTranscriptArray([])
        setTranscriptMode(false)
        setTrasncriptToInsert('')
        setValidTranscript(false)
        toast.dismiss()
        // const pos = getPositions(trasncriptToInsert, true)
        const scoreTrans = getFinalScore(positionTable[positionTable.length - 1], turns[turns.length - 1])
        setScoreByTranscript(scoreTrans)
        if(scoreTrans === -1 && (isTD || isPlayer)) {
            setAllowedToStream(true)
        } else {
            setAllowedToStream(false)
        }
        toast.success("Game was successfully added", {autoClose: 3000})
    }

    const cancelInsertTranscript = () => {
        setTranscriptArray([])
        setTranscriptMode(false)
        if(!newTransRef?.current) {
            setTrasncriptToInsert('')
            setValidTranscript(false)
            return
        }
        let newBoard = JSON.parse(JSON.stringify(newTransRef.current.positionTable[newTransRef.current.move]))
        for (let i = 0; i < rotation; i++) {
            newBoard = rotate(newBoard)
        }
        // console.log(newTransRef.current)
        setValidTranscript(false)
        setBoard(newBoard)
        setTranscript(newTransRef.current.transcript)
        setMove(newTransRef.current.move)
        setTurns(newTransRef.current.turns)
        setTurn(newTransRef.current.turns[newTransRef.current.move])
        setPositionTable(newTransRef.current.positionTable)
        setLastMove(newTransRef.current.move === 0 ? '' : newTransRef.current.transcript.slice((newTransRef.current.move - 1) * 2, (newTransRef.current.move) * 2))
        setTrasncriptToInsert('')
        newTransRef.current = null
        
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

    const focusNext = (index) => {
        if(index < 63) {
            inputRefs.current[index + 1].focus()
        }
        
    }

    const enterAsTranscript = () => {
        // console.log(!transcriptMode)
        setRotation(0)
        setTranscriptMode(prev => !prev)
        if(!transcriptMode && trasncriptToInsert) {
            const buffer = []
            for (let i = 0; i < trasncriptToInsert.length; i += 2) {
                const m = trasncriptToInsert.slice(i, i + 2)
                const indexes = stringToIndex(m)
                const idx = indexes[0] * 8 + indexes[1]
                buffer[idx] = i / 2 + 1
            }
            // console.log(buffer)
            setTranscriptArray(buffer)
        }
    }

    const verifyTranscript = () => {
        let hasDuplicates = false
        const hash = Object.create(null)
        for (let i = 0; i < transcriptArray.length; i++) {
            if(!transcriptArray[i]) continue
            if (transcriptArray[i] in hash) hasDuplicates = true
            const col = i % 8
            const row = Math.floor(i / 8)
            hash[transcriptArray[i]] = cols[col] + rows[row]
        }
        if(hasDuplicates) {
            toast.error('Transcript contains duplicates', {autoClose: 3000})
            return
        }
        const moveNums = Object.keys(hash)
        let trans = ''
        for (let i = 0; i < moveNums.length; i ++) {
            trans = trans + hash[moveNums[i]]
        }
        // console.log(trans)
        TranscriptChange(trans)
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

// initiate first hint for EvalBar if was not done yet
    useEffect(() => {
        // console.log('firstHint', senseiReady, settings.showEvalBar, showEvals, hintedOnce)
        if(!senseiReady || !settings.showEvalBar || showEvals || hintedOnce || allowedToStream) return
            const str = transcript.slice(0, move * 2)
            const next = transcript.slice((move) * 2, (move + 1) * 2)
            senseiHint(str, move, next, evalsTable.current, countLegalMoves(positionTable[move]), status)
    },[settings.showEvalBar, showEvals, move, transcript, positionTable, status, hintedOnce, allowedToStream, senseiReady])

    //in case someone pressed analyze before Sensei is ready
    useEffect (()=> {
        if(!senseiReady || !showEvals || hintedOnce) return
        senseiHint(transcript.slice(0, move * 2), move, transcript.slice(move * 2, (move + 1) * 2), evalsTable.current, countLegalMoves(positionTable[move]), status)
    },[senseiReady, transcript, move, positionTable, status, showEvals])
// streamers   
    const moveHandler = (event) => {
        // should i add additional check ?
        // debugRef.current = new Date()

        const cell = event.currentTarget.value.split(',')
        cell[0] = parseInt(cell[0])
        cell[1] = parseInt(cell[1])
        if(!isMoveLegal(cell)) return
        if (transcript && transcript?.slice((move) * 2, (move + 1) * 2) === event.currentTarget.id) {
            nextMove()
            return
        }
        setBoard(prev => clearLegalMoves(prev))
        // console.log('sending Move', new Date() - debugRef.current)
        socket.emit('otb-move-made', id, gameId, round, event.currentTarget.id, move)
    }

    

// otb-move made
    useEffect (() => { // otb_new_move - on reconnect - moves are received but not displayed!
        socket.on('otb-new-move', (game_id, newTranscript) => {
            // console.log('received move', new Date() - debugRef.current)
            if (game_id !== parseInt(gameId)) return
            if (settings.sound && !allowedToStream) playMove()
            // setTranscriptArray([])
            const pos = getPositions(newTranscript, true)
            const moveNumber = newTranscript.length / 2
            disconnectRef.current = newTranscript
            if(!editMode) {
                setPositionTable(pos.positionTable)
                setTurns([...pos.turns, pos.turn])
                // setTurn(pos.turn)
                setTranscript(newTranscript)
                const scoreTrans = getFinalScore(pos.positionTable[pos.positionTable.length - 1], pos.turn)
                setScoreByTranscript(scoreTrans)
                
            } else {
                editRef.current.positionTable = JSON.parse(JSON.stringify(pos.positionTable))
                editRef.current.transcript = newTranscript
                editRef.current.turns = [...pos.turns, pos.turn]
                // editRef.current.turn = pos.turn
            }
            
            // add message to chat
            const message = moveNumber + '. ' + newTranscript.slice((moveNumber - 1) * 2, moveNumber * 2)
            setMessages(prev=> {
                const buffer = [...prev]
                if (buffer.length > 0 && buffer[buffer.length - 1]?.sender === 'system') {
                    buffer[buffer.length - 1].message =  buffer[buffer.length - 1].message + ' ' +  message
                    return buffer
                }
                buffer.push({message: message, sender: 'system'})
                return buffer
            })
            // auto move to new position
            if (move >= moveNumber - 1 && !editMode) {
                setMove(moveNumber)
                setNext(null) //if(!editMode) 
                setLastMove(moveNumber === 0 ? '' : newTranscript.slice((moveNumber - 1) * 2, (moveNumber) * 2))
                let newBoard = JSON.parse(JSON.stringify(pos.positionTable[moveNumber]))
                for (let i = 0; i < rotation; i++) {
                    newBoard = rotate(newBoard)
                }
                setBoard(newBoard)
                setScore(countDiscs(pos.positionTable[moveNumber]))
                // console.log('new move turn', pos.turn)
                setTurn(pos.turn)
                setHintEvals([])
                // disconnectRef.current.move = moveNumber
                
                if(senseiReady && (showEvals || settings.showEvalBar)) {
                    evalsTable.current = evalsTable.current.slice(0, moveNumber)
                    const str = newTranscript
                    const next = ''
                    const table = JSON.parse(JSON.stringify(evalsTable.current.slice(0, moveNumber)))
                    senseiHint(str, moveNumber, next, table, countLegalMoves(pos.positionTable[moveNumber]), status)
                }
                // console.log('played out new move', new Date() - debugRef.current)
                return
            } else {
                setHasNewMove(true)
            }

            // if ()
            // else (editmode or we are replaying previous moves) - mark that there's new move, update transcript etc green circle in transcript
        })

        return () => {
            socket.off('otb-new-move')
        }
    },[allowedToStream, isOnline, id, gameId, move, editMode, settings.sound, settings.showEvalBar, showEvals, status, rotation])



    // debug

    // useEffect(() => {
    //     const isLive = (!gameResult && gameResult !== 0) && scoreByTranscript === -1
    //     console.log('isPlayer:', isPlayer, 'allowedToStream', allowedToStream, 'isLive:', isLive, 'gameResult:', gameResult, 'scoreByTranscript:', scoreByTranscript, board)
    // }, [isPlayer, allowedToStream, gameResult, scoreByTranscript, board])

    // useEffect(()=>{
    //     console.log(showEvals, evalGraphData, allowedToStream,  evals)
    // },[showEvals, evalGraphData, allowedToStream,  evals])

    // useEffect(()=>{
    //     console.log(loading)
    // },[loading])

    //turn = {evalsTurn}


    return (
        <>
        <Helmet>
            <meta name="viewport" content="width=device-width, height=device-height, interactive-widget=resizes-content, initial-scale=1.0, maximum-scale=1.0, user-scalable=no" />
        </Helmet>
        <LayoutContext.Provider value = {{ width, height, offsetY, gameBoard, fullBoard, totalHeight, keyboard}}>
        <NavBar isHome = {false} isGame = {false} text = {tName} ></NavBar>
        {settings.showEvalBar && senseiReady && !allowedToStream && !(typing && isMobile)? 
            <EvalBar  evaluation = {evalBarData} width = {width}/> :
            !(typing && isMobile) ?
            <div className= 'round-name'>{getFullRoundName([{round: round, round_name: rName}], round)} {getFullGameName(gName)}</div> 
            : <></>
        }
        {loading && isOnline? <ModalLoading/> : <></>}
        <div>
            <div style = {{...params, top: isMobile && typing ? 50 : 80}} className = 'replayer-full' >
                <div ref = {p1Ref} className = 'player-container'>
                <PlayerInfo 
                    nickName = {comment === 'wrong colors' ? toCapitalized(whitePlayer?.surname.toLowerCase()) + ' ' + whitePlayer?.name : toCapitalized(blackPlayer?.surname.toLowerCase()) + ' ' + blackPlayer?.name}
                    color = {color}
                    score = {score[0]}
                    country = {comment === 'wrong colors' ? whitePlayer?.country_code : blackPlayer?.country_code}
                    hideFooter = {false}
                    avatar = {false}  
                    withTimer = {true}
                    isStreamer = {(isPlayer || isTD) && scoreByTranscript === -1}
                    timer = {25 * 60000 + 1} // change that later
                    // turn = {turn}
                    // evals = {showEvalBar ? formatEvalsForPlayer(evals, blackPlayer) : null}                 
                />
                </div>
                <div style = {{height: 10}}></div>
                <div className = 'watch-game' style = {{width: width * 3 * 0.98 + 20, left: -width * 0.98 - 10 + 'px'}}  ref = {mainBoardRef}>
                    <EmptyBoard params= {params}></EmptyBoard>
                    <div className="board-container" onTouchStart = {!allowedToStream ? onTouchStart : () => {}} onTouchMove = {!allowedToStream ? onTouchMove : () => {}} onTouchEnd = {!allowedToStream ? onTouchEnd : () => {}}>
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
                                    {!editMode && transcript?.length > 0 && !transcriptMode && !(allowedToStream && scoreByTranscript === -1)? <div className="prev-move-big" onClick={prevMove}></div> : <></>}

                                    {!transcriptMode ? rows.map((row, i) => cols.map((col, j) => {
                                    const cn = rotation % 2 > 0 ? rows[i] + cols[j] : cols[j] + rows[i]
                                    const evalData = getEval(cn) || getBestEval(cn)
                                    return <Cell 
                                        id = {cn} 
                                        isEmpty = {isCellEmpty([i, j])}
                                        isLastMove = {isLastMove(cn)}
                                        isLegalMove = {isMoveLegal([i,j])}
                                        discColor = {discColors([i, j])}
                                        onClick = {editMode ? editMoveHandler : moveHandler}
                                        value = {`${i},${j}`}
                                        settings = {allowedToStream ? {showLegalMoves: false, markLastMove: true} : settings }
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
                                        allowedToStream = {allowedToStream && scoreByTranscript === -1}
                                        transcriptMode = {transcriptMode}
                                        />
                                    })) : rows.map((row, i) => cols.map((col, j) =>
                                    <TranscriptCell 
                                        id = {rotation % 2 > 0 ? rows[i] + cols[j] : cols[j] + rows[i]} 
                                        name = {8*i+j}
                                        key = {rotation % 2 > 0 ? rows[i] + cols[j] : cols[j] + rows[i]}
                                        focusNext = {focusNext}
                                        setTranscriptArray = {setTranscriptArray}
                                        transcriptArray = {transcriptArray}
                                        ref = {(el) => (inputRefs.current[8*i+j] = el)}
                                        isDuplicate = {transcriptArray.toSpliced(8*i+j, 1).includes(transcriptArray[8*i+j]) && transcriptArray[8*i+j]}
                                    />
                                    ))}   
                                    {!editMode && transcript?.length > 0 && !transcriptMode && !(allowedToStream && scoreByTranscript === -1)? <div className="next-move-big" onClick={nextMove}></div> : <></>}
                                </div>
                            </div>   
                        </div>
                    </div>
                    <EmptyBoard params= {params}></EmptyBoard>
                </div>
                
                    <div ref = {p2Ref} className = 'player-container'>
                    <PlayerInfo 
                        nickName = {comment === 'wrong colors' ? toCapitalized(blackPlayer?.surname.toLowerCase()) + ' ' + blackPlayer?.name : toCapitalized(whitePlayer?.surname.toLowerCase()) + ' ' + whitePlayer?.name}
                        color = {reverseColor(color)}
                        score = {score[1]}
                        country = {comment === 'wrong colors' ? blackPlayer?.country_code : whitePlayer?.country_code} 
                        hideFooter = {false}
                        avatar = {false} 
                        withTimer = {true}
                        isStreamer = {(isPlayer || isTD)  && scoreByTranscript === -1}
                        timer = {25 * 60000 + 1} // change that later
                        // turn = {turn}
                        // evals = {showEvalBar ? formatEvalsForPlayer(evals, whitePlayer) : null}   
                        //#86a94b 
                        //<div className = "comment">{comment} </div>                
                    />
                    </div>
                {!typing || !isMobile ?
                <>
                    <div style = {{height: 10}}></div>
                    
                    {transcript?.length > 0 || editMode ? 
                        <div className = 'buttons-container'>
                        <MaxBackButtonSVG onClick = {toStartPosition} move = {move}/>
                        <BackButtonSVG onClick = {prevMove} move = {move}/>
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
                        <ForwardButtonSVG onClick = {nextMove} move = {move} transcript = {transcript}/>
                        <MaxForwardButtonSVG onClick = {toFinalPosition} move = {move} transcript = {transcript}/>
                    </div> : <></>
                    }
    {/* && (gameResult || gameResult === 0) */}
                    {(isTD || isPlayer)  && (trasncriptToInsert.length > 0 || transcriptMode) ?
                    <div className = 'transcript-buttons'>
                        <button className = 'transcript-button' onClick = {cancelInsertTranscript}>Cancel</button>

                    
                    { transcriptMode && transcriptArray.length > 0 ? 
                        <button className = 'transcript-button' onClick = {verifyTranscript} >Verify</button>
                    : <></>
                    }
                    { trasncriptToInsert.length > 0 ?
                        <button className = 'transcript-button' onClick = {confirmInsertTranscript} disabled = {!validTranscript}>Confirm</button>
                    : <></>
                    }               
                    
                    </div> : <></>
                    }
                    
                    <div style = {{height: 10}}></div> 
                    {showEvals && !editMode && evalGraphData && !allowedToStream && evals?.length > 0? // finished replace with score on board is not null
                        <EvalGraph moveNumber = {move} evals = {evalGraphData} width = {gameBoard * 0.918367352} onMoveClick = {makeMove}/>
                        : showEvals && editMode ? (
                        <div style={{textAlign: 'center', padding: '12px 0'}}>
                            <div style={{fontSize: '10px', color: '#888', marginTop: '4px'}}>Powered by Sensei<br/>developed by Michele Borassi</div>
                        </div>
                        ) : <></>
                    }
                </> : <></>}
                
                <FooterGameOTB 
                    isLive = {(!gameResult && gameResult !== 0) && scoreByTranscript === -1} // round is not finished and and there's no score in game
                    showAnalysis = {showAnalysis} 
                    changeEditMode = {changeEditMode} 
                    transcript = {editMode ? editRef.current?.transcript : transcript} 
                    rotateBoard = {rotateBoard}
                    isPlayer = {isPlayer}
                    isTD = {isTD}
                    isXot = {isXot}
                    gameResult = {gameResult}
                    enterAsTranscript = {enterAsTranscript}
                    pasteTranscript = {pasteTranscript}
                    allowedToStream = {allowedToStream}
                    scoreByTranscript = {scoreByTranscript}
                    >
                
                </FooterGameOTB>
            </div>
        </div>
        </LayoutContext.Provider>
        </>
    )
}
//to footer:
//game finished according to transcript ? getFinalScore() !== -1
//is there score in DB (rounds) ? Does it match final score transcript ? 
// if there's a score, game is finished, but the score doesn't match check if there's comment.
// if there's a comment, 
export default GameOTB


