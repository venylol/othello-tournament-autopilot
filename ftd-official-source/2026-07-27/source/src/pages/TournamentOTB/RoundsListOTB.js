import React, {useEffect, useRef, useState, useContext} from "react"
import { VariableSizeList } from "react-window"
import { toast } from 'react-toastify';
import { useWindowSize } from '../../hooks/resize.hook'
import { Replayer } from './ReplayerOTB'
import { ToggleRounds } from "./ToggleRounds";
import { Player } from "./OTBRoundPlayer";
import { InfoToastResult } from "./InfoToastResult";
// import { OTBROundRow } from "./OTBRoundsRow"
import { roundReady, roundEdit, getFullGameName, fakeResults } from "../functions/functions";
import { getPositions } from '../functions/getPositions';
import { SFXContext } from '../../context/SFXContext';
import { AuthContext } from '../../context/AuthContext';
import { UserContext } from '../../context/UserContext';
import { ClearInputSVG }  from '../elements/SVG';
import { CreateGame } from "./CreateGameOTB";
import { useNavigate } from 'react-router-dom';

// add "delete" game for not started round
export const RoundsListOTB = ({id, isTD, isAssistant, setTab, round, setRound, isPlayer, test, tournamentFinished, tName, ifCategories, xot}) => { //isOnline
    // console.log(id, isTD, round, isPlayer, test, tournamentFinished, tName, categories, isAssistant, xot)
    const listRef = useRef ()
    const { playMove } = useContext (SFXContext)
    const { socket } = useContext(AuthContext)
    const { isOnline, isMobile } = useContext(UserContext)
    const [width, listWidth, rowHeight, rowHeightExpanded, height, offsetY, boardSize] = useWindowSize(listRef, true, isMobile)
    const [pressed, setPressed] = useState ()
    // const roundRef = useRef()
    const [readyToFinish, setReadyToFinish] = useState(false)
    const [roundStarted, setRoundStarted] = useState(false)
    const [finished, setFinished] = useState(false)
    const [pairings, setPairings] = useState ([])
    const [startEdit, setStartEdit] = useState (false)
    const [roundsArr, setRoundsArr] = useState ([])
    const [openedGames, setOpenedGames] = useState ([]) //разделить айдишники и сами игры
    const [openedIndex, setOpenedIndex] = useState([])
    const [coordinates, setCoordinates] = useState([])
    const [roundName, setRoundName] = useState('')
    const [standings, setStandings] = useState([])
    // const [categories, setCategories] = useState([])
    const [createGame, setCreateGame] = useState(false)
    const [validSearchInput, setValidSearchInput] = useState(false)
    const [clearFocused, setClearFocused] = useState(false)
    const history = useNavigate()
    const inputRef = useRef()
    const clearInputRef = useRef()
    const categorySize = 30
    
    const pairingRef = useRef (null)

    const forbidLetters = ['e', 'E', '+', '-', '.']

    const getTotalHeight = () => {
        // console.log('hi')
        let categoriesCount = 0
        for (let i = 0; i < pairings.length; i++) {
            if (typeof pairings[i] === 'string') categoriesCount++
        }
        if (isTD && !tournamentFinished) return Math.min((pairings.length - openedIndex.length - categoriesCount) * rowHeight + (openedIndex.length * rowHeightExpanded) + (categoriesCount * categorySize), height - 233)
        return Math.min((pairings.length - openedIndex.length - categoriesCount) * rowHeight + (openedIndex.length * rowHeightExpanded) + (categoriesCount * categorySize), height - 185)
    }

    useEffect(()=> {
        socket.on('otb-get-round', (data) => {
            // console.log('otb-get-round', data)
            setRound(data.round ? data.round : 0)
            setFinished(data.finished)
            setPressed(data.currentRound)
            setPairings(data.pairing)
            setReadyToFinish(roundReady(data.pairing))
            setRoundsArr(data.roundNames?.sort((a,b) => b.round - a.round))
            // console.log(data.roundNames)
            setRoundName(data.roundNames?.filter(round => round.round === data.currentRound)[0]?.round_name)
            setRoundStarted(data.started)
            // setInputValue('')
            if(inputRef.current) inputRef.current.value = ''
            
            if(data.pairing) {
                pairingRef.current = JSON.parse(JSON.stringify(data.pairing))
            }
        })
        socket.on('start-otb', data => {
            // console.log('start-otb', data)
            
            setRound(data.round ? data.round : 0)
            setFinished(data.finished)
            setPressed(data.currentRound)
            setPairings(data.pairing)
            setReadyToFinish(roundReady(data.pairing))
            setRoundsArr(data.roundNames?.sort((a,b) => b.round - a.round))
            setRoundName()
            setOpenedGames([])
            setOpenedIndex([])
            setRoundName(data.roundNames?.filter(round => round.round === data.currentRound)[0]?.round_name)
            setRoundStarted(data.started)

            if(data.pairing) {
                pairingRef.current =  JSON.parse(JSON.stringify(data.pairing))
            }
        })
        socket.on('final-standings', (standings) => {
            // console.log(standings, lastRound, curRound, finished, totalRounds, roundNames, eloFileName, startFinals, tName)
            // console.log(standings)
            setStandings(standings)
            // setCategories(categories)
            setCreateGame(true)
        })
        return () => {
            socket.off('otb-get-round')
            socket.off('start-otb')
            socket.off('final-standings')
            
        }
    },[]) 

    useEffect (() => {
        setOpenedGames([])
        setOpenedIndex([])
        setStartEdit(false)
        socket.on('new-otb-game', data => {
            if(data.currentRound === pressed) {
                if(!inputRef.current || inputRef.current.value.length < 3) setPairings(data.pairing)
                if(data.pairing) {
                    pairingRef.current =  JSON.parse(JSON.stringify(data.pairing))
                }
            }
        })
        return () => {
            socket.off('new-otb-game')
        }
    },[pressed])

    useEffect (() => { //otb-get-new-result
        socket.on('otb-get-new-result', (gameId, score) => { // receive 
            if (pressed === round) {
                setPairings(prev => roundEdit(prev, gameId, score))
                pairingRef.current = roundEdit(JSON.parse(JSON.stringify(pairingRef.current)), gameId, score )
            } 
            else {
                toast.clearWaitingQueue()
                toast.dismiss()
                toast.info(InfoToastResult({round, id, setPressed, socket}))
            }
        })
        return () => {
            socket.off('otb-get-new-result')
        }
    },[pressed, round, isOnline])

    const FilterHandler = (event) => {
        let value = String(event.target.value).trim().toLowerCase()
        let inputScore = null
        let format = /^[0-9]+$/
        if(value.length < 3) {
            setPairings(pairingRef.current)
            return
        }
        const checkVal = value.substring(value.length -2, value.length).trim()
        if (checkVal.length <= 2 && format.test(checkVal) && parseInt(checkVal) >= 0 && parseInt(checkVal) <= 64 && !isNaN(parseInt(checkVal)) && isTD ) {
            value = value.substring(0, value.length - 2).trim()
            inputScore = parseInt(checkVal)
        }
        if (value.length > 2) {
            setOpenedGames([])
            setOpenedIndex([])
            let bufferPairings = [...pairingRef.current]
            // filter 
            bufferPairings = bufferPairings.filter(pair => 
                pair[0].surname?.toLowerCase().startsWith(value) 
                || pair[0].name?.toLowerCase().startsWith(value)
                || pair[0].surname?.toLowerCase().concat(' ', pair[0].name?.toLowerCase()).startsWith(value)
                || pair[0].name?.toLowerCase().concat(' ', pair[0].surname?.toLowerCase()).startsWith(value)
                || pair[1].surname?.toLowerCase().startsWith(value) 
                || pair[1].name?.toLowerCase().startsWith(value)
                || pair[1].surname?.toLowerCase().concat(' ', pair[1].name?.toLowerCase()).startsWith(value)
                || pair[1].name?.toLowerCase().concat(' ', pair[1].surname?.toLowerCase()).startsWith(value)
            )
            // not found
            if (bufferPairings.length === 0) {
                setPairings([])
                setValidSearchInput(false)
                return
            }
            // single pair, score is correct and, is TD and not same name in pair
            if (bufferPairings.length === 1 && inputScore !== null && isTD && bufferPairings[0][0].score === null) {
                const pair = bufferPairings[0]
                if((pair[0].surname?.toLowerCase().startsWith(value) 
                    || pair[0].name?.toLowerCase().startsWith(value)
                    || pair[0].surname?.toLowerCase().concat(' ', pair[0].name?.toLowerCase()).startsWith(value)
                    || pair[0].name?.toLowerCase().concat(' ', pair[0].surname?.toLowerCase()).startsWith(value))
                    &&
                    (pair[1].surname?.toLowerCase().startsWith(value) 
                    || pair[1].name?.toLowerCase().startsWith(value)
                    || pair[1].surname?.toLowerCase().concat(' ', pair[1].name?.toLowerCase()).startsWith(value)
                    || pair[1].name?.toLowerCase().concat(' ', pair[1].surname?.toLowerCase()).startsWith(value))
                ) {
                    setValidSearchInput(false)
                }
                else setValidSearchInput(true)
            } else {
                setValidSearchInput(false)
            }
            setPairings(bufferPairings)
        }
    }

    const FilterEnterHandler = (event) => {
        if (event.key !== 'Enter' || !isTD || pairings.length !== 1 || !validSearchInput) return 
        // console.log(event.target.value, pairings)
        let value = String(event.target.value).trim().toLowerCase()
        const checkVal = value.substring(value.length - 2, value.length).trim()
        let format = /^[0-9]+$/
        if (checkVal.length <= 2 && format.test(checkVal) && parseInt(checkVal) >= 0 && parseInt(checkVal) <= 64 && !isNaN(parseInt(checkVal)) ) {
            value = value.substring(0, value.length - 2).trim()
            let score = parseInt(checkVal)
            const pair = pairings[0]
            // black player
            if (pair[0].surname?.toLowerCase().startsWith(value) 
                || pair[0].name?.toLowerCase().startsWith(value)
                || pair[0].surname?.toLowerCase().concat(' ', pair[0].name?.toLowerCase()).startsWith(value)
                || pair[0].name?.toLowerCase().concat(' ', pair[0].surname?.toLowerCase()).startsWith(value)
            ) {
                // console.log('black', pair[0].surname, pair[0].name, score)

            } else {
                score = 64 - parseInt(checkVal)
                // console.log('white', pair[1].surname, pair[1].name, score)
            }
// inspect !finished
            if(!finished) {
                socket.emit('score-otb', id, pair[0].gameId, score)
                const newPairings = pairingRef.current.map((row) => {
                    if(row[0].id === pair[0].id && row[1].id === pair[1].id) {
                        row[0].score = score
                    }
                    return row 
                })
                pairingRef.current = JSON.parse(JSON.stringify(newPairings))
                setReadyToFinish(roundReady(newPairings))
                clearInputRef.current.focus()
            }
        }

    }

    const ClearInput = (e) => {
        // if(inputRef.current) {
            inputRef.current.value = ''
            inputRef.current.focus()
            setValidSearchInput(false)
            setPairings(pairingRef.current)
        // }
    }

    useEffect (() => {
        // console.log ('useEffect: openedGames', openedGames)
        // setClickedFlag(prev => !prev)
        listRef?.current?.resetAfterIndex(0)
    }, [openedIndex])
// otb_new_move - on reconnect
    useEffect (() => { 
        // console.log('openedGames', openedGames)
        socket.on('otb-new-move', (gameRound, gameId, newTranscript) => {
            // console.log(gameRound, pressed, gameId, newTranscript, openedGames, pairings)
            if (pressed !== gameRound) return
            let gameIndex = -1
            for (let i = 0; i < pairings.length; i++) {
                if(pairings[i]?.[0].gameId === gameId) {
                    gameIndex = i
                    break
                }
            }
            if (gameIndex === -1) return
            if (openedIndex.includes(gameIndex)) playMove()
// inspect           
            setPairings(prev => prev.map(pair => 
                pair[0].gameId === gameId ? [{...pair[0], transcript: newTranscript}, {...pair[1]}] : pair
            ))
            pairingRef.current = pairingRef.current.map(pair => 
                pair[0].gameId === gameId ? [{...pair[0], transcript: newTranscript}, {...pair[1]}] : pair
            )
            const allowedToEdit = (isTD || pairings[gameIndex][0].id === isPlayer || pairings[gameIndex][1].id === isPlayer) && !finished && !pairings[gameIndex][0].score
            setOpenedGames(prev => prev.map(game => game.gameId === gameId ? {...game, transcript: newTranscript, ...getPositions(newTranscript, allowedToEdit), move: newTranscript.length / 2} : game))
        })

        return () => {
            socket.off('otb-new-move')
        }
    },[openedGames, pairings, round, isTD, isPlayer, pressed, isOnline])//

    const getItemSizes = (index => {
        // const categoryText = typeof pairings[index] === 'string' ? pairings[index] : false
        return openedIndex.includes(index) ? rowHeightExpanded : typeof pairings[index] === 'string' ? categorySize : rowHeight
    })

    const testResults = () => {
        const newPairings = fakeResults(pairingRef.current, id, socket)
        setPairings(newPairings)
        pairingRef.current = JSON.parse(JSON.stringify(newPairings))
        setReadyToFinish(roundReady(newPairings))
    }
//!!!!
    const showGame = (event) => {
        const rowId = parseInt(event.currentTarget.id)
        // console.log('showGame', rowId)
        if (!isTD || (finished && !startEdit)) {event.preventDefault()}
        // console.log(isTD, pairings[rowId][0].id, pairings[rowId][1].id, isPlayer, isAssistant)
        const allowedToEdit = isTD || (pairings[rowId][0].id === isPlayer || pairings[rowId][1].id === isPlayer) || isAssistant //is player of that game && !finished && !pairings[gameId][0].score 

        if (((pairings[rowId][0].transcript?.length === 0 || !pairings[rowId][0].transcript) && !pairings[rowId][0].comment) && !allowedToEdit) return
        if (allowedToEdit) { // only for unfinished rounds/tournaments? 
            // console.log(pairings[rowId][0].gameId)
            return history(`/live/${id}/${pairings[rowId][0].gameId}`)
        }
        
        setCoordinates([event.clientX , rowHeight/2])     
        // setClicked(gameId)
        if (openedIndex.includes(rowId)) {
            setOpenedGames (prev => prev.filter(obj => obj.id !== rowId))
            setOpenedIndex (prev => prev.filter(idx => idx !== rowId))
            return
        } 
        
        const currentMove = (allowedToEdit || pairings[rowId][0].transcript) && !pairings[rowId][0].score ? pairings[rowId][0].transcript ? pairings[rowId][0].transcript.length / 2 : 0 : 0
        let game = {id: rowId, round: pressed, tournamentID: parseInt(id), gameId: pairings[rowId][0].gameId, transcript: pairings[rowId][0].transcript, comment: pairings[rowId][0].comment, ...getPositions(pairings[rowId][0].transcript, allowedToEdit), move: currentMove} // isLive!!!
        // console.log('showgame', game)
        if (roundStarted) {
            setOpenedGames ([...openedGames, game]) 
            setOpenedIndex ([...openedIndex, rowId]) 
        }           
    }

    const returnPosition = (id, move) => { // triggered twice. Why?
        // console.log('return position')
        let buffer = []
        openedGames.map((obj, idx) => {
            if (obj.id === id) {
                obj.move = move
                buffer[idx] = JSON.parse(JSON.stringify(obj))
            } else {
                buffer[idx] = JSON.parse(JSON.stringify(obj))
            }
        })
        setOpenedGames(buffer)
    }

    const extractGame = (arr, id) => {
        if(!arr) return
        return arr.filter(obj => (obj.id === id))[0]  
    }

    const finishRound = () => {
        if(roundReady(pairings)) {
            socket.emit('finish-round-otb', id, pressed, pairings)
            setFinished(true)
            if(pressed === 110 || pressed < 100)
            setTab('Standings')
        } 
    }

    const publishRound = () => {
        socket.emit('publish-round', id, pressed)
        setRoundStarted(true)
    }

    const generateXot = () => {
        socket.emit('generate-xot', id, pressed)
    }

    const needsXot = xot && pressed === round && Array.isArray(pairings) && pairings.some(pair =>
        typeof pair !== 'string' && pair?.[0]?.transcript === null && pair?.[0]?.id !== -1 && pair?.[1]?.id !== -1
    )

    const addGame = () => {
        // console.log('add Game')
        socket.emit('get-standings-finals', id)
    }
    
    const editResults = () => {
        // console.log('pairings', pairings)
        // console.log('ref', pairingRef.current)
        // console.log('roundReady',roundReady(pairings))
        if(roundReady(pairings)) {
            const changes = []
            pairings.map((pair, idx) => {
                if(pair[0].score !== pairingRef.current[idx][0].score) changes.push({id: pair[0].gameId, score: pair[0].score})  
            })
        // console.log('changes', id, pressed, changes)
            if (changes.length > 0) {
                socket.emit('change-score', id, pressed, changes)
                pairingRef.current = JSON.parse(JSON.stringify(pairings))
            }
            setStartEdit(false)
        } 
    }

    const Row = ({index, style}) => {
        const [white, setWhite] = useState(pairings[index][0].score !== null && pairings[index][0].comment !== 'mutual loss' ? 64 - pairings[index][0].score : pairings[index][0].score !== null ? 0 : '')
        const [black, setBlack] = useState(pairings[index][0].score !== null && pairings[index][0].comment !== 'mutual loss' ? pairings[index][0].score : pairings[index][0].score !== null ? 0 : '')
        const blackRef = useRef(null)
        const whiteRef = useRef(null)
        const prevVal = useRef({black, white})
        const mouseDownRef = useRef(false)
        const gameId = pairings[index][0].gameId
        const categoryText = typeof pairings[index] === 'string' ? pairings[index] : false 
        const gameNumber = pairings[index][0].gameNumber
        const lastGame = typeof pairings[index + 1] === 'string' ? true : false
        let player1, player2
        if (pairings[index][0].id === -1) {
            player1 = pairings[index][1]
            player2 = pairings[index][0]
        } else if (pairings[index][1].id === -1) {
            player1 = pairings[index][0]
            player2 = pairings[index][1]
        } else {  
            player1 = pairings[index][0]
            player2 = pairings[index][1]
        }
        const checkLetters = e => {
            if (e.key === 'Enter' && e.target.name === 'black') blackRef.current.blur()
            if (e.key === 'Enter' && e.target.name === 'white') whiteRef.current.blur()
            forbidLetters.includes(e.key) && e.preventDefault()
        }

        const RowClickHandler = event => {
            // console.log('rowclick', whiteRef.current?.contains(event.target) || blackRef.current?.contains(event.target))
            if ((whiteRef.current?.contains(event.target) || blackRef.current?.contains(event.target) || mouseDownRef.current) && isTD) return
            if (player2.id === -1) return
            showGame(event)
        }

        const changeScore = (e) => {
            const value = e.target.value
            const score = parseInt(value)
            let format = /^[0-9]+$/
            if ((value.length <= 2 && format.test(value) && parseInt(value) >= 0 && parseInt(value) <= 64 && !isNaN(parseInt(value))) || value.length === 0 ) {
                if (e.target.name === 'black') {
                    value.length > 0 ? setBlack(score) : setBlack('')
                } else {
                    value.length > 0 ? setWhite(score) : setWhite('')
                }                
            }
        }

        const blurHandler = e => {
            const value = e.target.value
            const isBlack = e.target.name === 'black'
            mouseDownRef.current = false
            if ((value === prevVal.current.black.toString() && isBlack) || (value === prevVal.current.white.toString() && !isBlack)) {
                return
            }
            if (value === '') { // delete the score of unfinished round
                isBlack ? setWhite('') : setBlack('')
                if (!finished) {
                    socket.emit('score-otb', id, gameId, null)
                }
                const newPairings = JSON.parse(JSON.stringify(pairings)) // pairingRef.current
                newPairings.map((pair, idx) => {
                    if(pair[0].gameId === player1.gameId) {
                        pair[0].score = null
                    }
                    return pair 
                }) 
                // console.log(newPairings)
                setPairings(newPairings)
                pairingRef.current = JSON.parse(JSON.stringify(newPairings))
                setReadyToFinish(roundReady(newPairings))
                prevVal.current.black = ''
                prevVal.current.white = ''
            } else {

                isBlack ? setWhite(64 - parseInt(value)) : setBlack(64 - parseInt(value))
                const blackScore = isBlack ? parseInt(value) : 64 - parseInt(value)
                if (!finished) {
                    socket.emit('score-otb', id, gameId, blackScore)
                }
                const newPairings = JSON.parse(JSON.stringify(pairings))
                newPairings.map((pair, idx) => {
                    if(pair[0].gameId === player1.gameId) {
                        pair[0].score = blackScore
                    }
                    return pair 
                }) 
                setPairings(newPairings)
                if (!startEdit) {pairingRef.current = JSON.parse(JSON.stringify(newPairings))}
                setReadyToFinish(roundReady(newPairings))
                prevVal.current.black = isBlack ? value.toString() : (64 - parseInt(value)).toString()
                prevVal.current.white = isBlack ? (64 - parseInt(value)).toString() : value.toString() 
            }
            inputRef.current.value = ''
            setValidSearchInput(false)
        }

        const handleMouseDown = e => {
            mouseDownRef.current = true
            e.stopPropagation()
        }

        return (
            <div style = {style}>
                {categoryText ? <div className = 'big-text-category'>{categoryText}</div> :
                <>
                <div className = {openedIndex.includes(index) ? `table-row round extended${gameNumber === 0 && lastGame ? ' first last' 
                : gameNumber === 0? ' first' : lastGame ? ' last' : ''}` 
                : `table-row round${gameNumber === 0 && lastGame ? ' first last' : gameNumber === 0 ? ' first' : lastGame ? ' last' : ''}`}
                    id = {index} 
                    onClick = {RowClickHandler} 
                    key = {player1?.id.toString() + player2?.id.toString()}
                >
                    <div className = 'table-place'>{gameNumber + 1}</div>
                    <Player player = {player1} number = {1} isWinner = {black > 32}/>
                    {player1.id !== -1 && player2.id !== -1 ?
                    <>
                    <div className = {`score-replayer-black`} > 
                        <input 
                            className = {`disc-count-black`}
                            name = 'black' 
                            ref = {blackRef} 
                            type = "number" 
                            max = "64" 
                            min = '0' 
                            readOnly = {!isTD || (finished && !startEdit)}
                            value = {black} 
                            onKeyDown = {checkLetters} 
                            onChange = {changeScore}
                            onBlur = {blurHandler}
                            onWheel = {(e) => e.target.blur()}
                            onMouseDown = {handleMouseDown}
                            >
                            
                        </input>
                    </div>
                    <div style={{color: 'white'}}>-</div>
                    <div className = {`score-replayer-white`}> 
                        <input 
                            className = {`disc-count-white`} 
                            name = 'white'
                            ref = {whiteRef} 
                            type = "number" 
                            max = "64" 
                            min = '0' 
                            readOnly = {!isTD || (finished && !startEdit)}
                            value = {white}
                            onKeyDown = {checkLetters} 
                            onChange = {changeScore}
                            onBlur = {blurHandler}
                            onWheel = {(e) => e.target.blur()}
                            onMouseDown = {handleMouseDown}
                            >
                            
                        </input>
                    </div>
                    </>
                    : 
                    <>
                    <div style = {{width: 'var(--disc-size)'}}/>
                    <div style={{color: 'white'}}>-</div>
                    <div style = {{width: 'var(--disc-size)'}}/>
                    </>}
                    <Player player = {player2} number = {2} isWinner = {black < 32 && black !== null && black !== ''}/>
                    {!finished && pairings[index][0].score === null && (pairings[index][0].transcript && !xot || xot && pairings[index][0].transcript?.length > 16)? <div className='can-edit'/> : 
                    xot && pairings[index][0].transcript?.length === 16 ? <div className='not-started'/> : 
                    pairings[index][0].score !== null && pairings[index][0].transcript ? <div className='finished-game'/> :
                    <></>}
                    
                    {/* value = {rounds} */}
                    {/* <div className="select-text wof-rating" title = 'WOF Rating'>{rating}</div> */}
                    {/* {isTD ? <button className = 'remove-button' id = {id}  onClick = {removePlayer}>-</button> : <></>} */}
                </div>
                {openedIndex.includes(index) ? 
                    <div>
                        <Replayer 
                        {...extractGame(openedGames, index)}
                        setPosition = {returnPosition}
                        data = {pairings[index]}
                        sizes = {{boardSize}}
                        isTD = {(isTD || pairings[index][0].id === isPlayer || pairings[index][1].id === isPlayer || isAssistant) && !finished && !pairings[index][0].score}
                        tName = {tName}
                        rName = {roundName}
                        byPlayer = {false}
                        xot = {xot}
                        />
                    </div> : <div/>
                }
                </>
                }
            </div>
        )
    }
    
    // className = {`search-pair ${validSearchInput ? 'valid' : ''}`}
    return (
        <div> 
            {createGame ? <CreateGame id = {id} standingsRaw = {standings} socket = {socket} setVisible = {setCreateGame} setPressed = {setTab} ifCategories = {ifCategories} categories = {[]}></CreateGame>
            :
            <>
            <ToggleRounds coordinates = {coordinates} pressed = {pressed} roundsArr = {roundsArr} id = {id}/>
            { round > 0 ?
                <div className = {`search-pair ${validSearchInput ? 'valid' : ''}`}>
                    <input className = 'search-pair' ref = {inputRef} placeholder = "Filter..."  onKeyUp={FilterEnterHandler} onChange = {FilterHandler}></input>
                    <button className = 'clear-input' ref = {clearInputRef} onClick = {ClearInput} onFocus = {()=> {setClearFocused(true)}} onBlur = {() => {setClearFocused(false)}}><ClearInputSVG focus = {clearFocused}/></button>
                </div> 
            :<></>}  
            { pairings?.length > 0 ? 
                <div  className = 'table-container' style = {{'--offset': '185px'}} >
                <VariableSizeList 
                    className="list"
                    height = {getTotalHeight()}
                    itemCount = {pairings.length}
                    estimatedItemSize = {rowHeight}
                    itemSize = {getItemSizes}
                    // onItemsRendered = {onItemsRendered}
                    width = {Math.min(width * 0.98, 500 * 0.98)}
                    ref = {listRef}
                >
                    {Row}
                </VariableSizeList>     
                <div style = {{marginTop: '10px', display: 'flex', justifyContent: 'center'}}>
                {isTD && round > 100 && !finished? 
                    <button 
                        className = 'add-button'
                        onClick = {addGame} 
                        style = {{fontSize: '24px'}}>+
                    </button>
                : <></>} 
                </div>
                
                </div>
  
            : 
            round === 0 ? <div className = 'big-text-empty'>No pairings were made</div> : <></>}
        
        { 
        isTD && !roundStarted && pressed !== 110 && pressed < 100 ? <button className = "btn-new-tournament" onClick = {publishRound}>Publish Pairings</button> :
        isTD && needsXot && roundStarted && !finished && pressed !== 110 && pressed < 100 ? <button className = "btn-new-tournament" onClick = {generateXot}>Generate XOT</button> :
        isTD && readyToFinish && !finished && pressed !== 110 && pressed < 100 ? <button className = "btn-new-tournament" onClick = {finishRound}>Confirm Results</button> : 
        isTD && readyToFinish && !finished && pressed !== 110 && pressed > 100 ? <button className = "btn-new-tournament" onClick = {finishRound}>Finish Round</button> :
        isTD && readyToFinish && !finished ?  <button className = "btn-new-tournament" onClick = {finishRound}>Finish Tournament</button> : 
        isTD && finished && !startEdit && !tournamentFinished ? <button className = "btn-new-tournament" onClick = {() => {setStartEdit(true)}}>Edit Results</button> :
        isTD && finished && startEdit && readyToFinish && !tournamentFinished ? <button className = "btn-new-tournament" onClick = {editResults}>Confirm Changes</button> : 
        isTD && !readyToFinish && !finished && test && pairings && roundStarted ? <button className = "btn-new-tournament" onClick = {testResults}>Fake Results</button> : 
        <></>
        } 

        </>}
        </div>
        
    )
}

//isTD && !readyToFinish && !finished && pairings && !roundStarted ? <button className = "btn-new-tournament" onClick = {startRound}>Start Round</button> : <></>
