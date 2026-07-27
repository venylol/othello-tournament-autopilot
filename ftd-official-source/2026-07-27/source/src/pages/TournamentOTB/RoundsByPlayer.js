import React, {useEffect, useRef, useState, useContext} from "react"
import { VariableSizeList } from "react-window"
import { toast } from 'react-toastify';
import { useWindowSize } from '../../hooks/resize.hook'
import { Replayer } from './ReplayerOTB'
import { Player } from "./OTBRoundPlayer";
import { InfoToastResult } from "./InfoToastResult";
import { roundReady, roundEdit, getFullGameName, fakeResults } from "../functions/functions";
import { getPositions } from '../functions/getPositions';
import { AuthContext } from '../../context/AuthContext';
import { UserContext } from '../../context/UserContext';

// here we get from tournament page:
// 1. make sure notifications come through
// 2. push new games after they are known

export const RoundsByPlayer = ({id, setTab, pairings, playerId, pressed, setRoundsByPlayer, tName, xot}) => { //isOnline
    // console.log(pairings, playerId)
    const listRef = useRef ()
    const { socket } = useContext(AuthContext)
    const { isOnline } = useContext(UserContext)
    const [width, listWidth, rowHeight, rowHeightExpanded, height, offsetY, boardSize] = useWindowSize(listRef, true, true)
    // const [pairings, setPairings] = useState ([])
    const [roundsArr, setRoundsArr] = useState ([])
    const [openedGames, setOpenedGames] = useState ([]) //разделить айдишники и сами игры
    const [openedIndex, setOpenedIndex] = useState([])
    const [coordinates, setCoordinates] = useState([])
    const player = pairings[0][0].id === playerId ? pairings[0][0] : pairings[0][1]

    const getTotalHeight = () => {
        return Math.min((pairings.length - openedIndex.length) * rowHeight + (openedIndex.length * rowHeightExpanded), height - 152)
    }

    useEffect (() => {
        listRef?.current?.resetAfterIndex(0)
    }, [openedIndex])

    const getItemSizes = (index => {
        return openedIndex.includes(index) ? rowHeightExpanded : rowHeight
    })

    const showGame = (event) => {
        const gameId = parseInt(event.currentTarget.id)
        event.preventDefault()
        const allowedToEdit = false
        if (((pairings[gameId][0].transcript?.length === 0 || !pairings[gameId][0].transcript) && !pairings[gameId][0].comment) && !allowedToEdit) return
        setCoordinates([event.clientX , rowHeight/2])     
        if (openedIndex.includes(gameId)) {
            setOpenedGames (prev => prev.filter(obj => obj.id !== gameId))
            setOpenedIndex (prev => prev.filter(idx => idx !== gameId))
            return
        } 
        
        const currentMove = (allowedToEdit || pairings[gameId][0].transcript) && !pairings[gameId][0].score ? pairings[gameId][0].transcript ? pairings[gameId][0].transcript.length / 2 : 0 : 0
        let game = {id: gameId, round: pairings[gameId][0].round, tournamentID: parseInt(id), transcript: pairings[gameId][0].transcript, comment: pairings[gameId][0].comment, ...getPositions(pairings[gameId][0].transcript, allowedToEdit), move: currentMove} // isLive!!!
        // console.log('showgame')
        setOpenedGames ([...openedGames, game]) 
        setOpenedIndex ([...openedIndex, gameId])     
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

    const returnHandler = () => {
        setRoundsByPlayer(null)
        if (pressed === 'Players') {
            socket.emit('get-otb-reg', id)
            return
        }
        if (pressed === 'Standings') {
            socket.emit('get-standings-otb', id)
            return
        }
    }

    const Row = ({index, style}) => {
        const [white, setWhite] = useState(pairings[index][0].score !== null && pairings[index][0].comment !== 'mutual loss' ? 64 - pairings[index][0].score : pairings[index][0].score !== null ? 0 : '')
        const [black, setBlack] = useState(pairings[index][0].score !== null && pairings[index][0].comment !== 'mutual loss' ? pairings[index][0].score : pairings[index][0].score !== null ? 0 : '')
        const blackRef = useRef(null)
        const whiteRef = useRef(null)
        const finished = pairings[index][0].score !== null ? true : false
        const prevVal = useRef({black, white})
        const gameId = pairings[index][0].gameId
        const round = pairings[index][0].round
        const roundName = pairings[index][0].roundName
        const lastGame = typeof pairings[index + 1] === 'string' ? true : false
        const gameName = pairings[index][0].gameName
        const name = gameName ? gameName : roundName ? roundName : round
        // console.log(categoryText, index)
        // const allowedToEdit = 
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

        const RowClickHandler = event => {
            if (whiteRef.current?.contains(event.target) || blackRef.current?.contains(event.target)) return
            if (player2.id === -1) return
            showGame(event)
        }

        return (
            <div style = {style}>
                <>
                <div className = {openedIndex.includes(index) ? `table-row round extended${round === 0 && lastGame ? ' first last' 
                : round === 0 ? ' first' : lastGame ? ' last' : ''}` 
                : `table-row round${round === 0 && lastGame ? ' first last' : round === 0 ? ' first' : lastGame ? ' last' : ''}`} id = {index} onClick = {RowClickHandler} key = {player1?.id.toString() + player2?.id.toString()}>
                    <div className = 'table-place'>{name}</div>
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
                            readOnly = {true}
                            value = {black} >
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
                            readOnly = {true}
                            value = {white}>
                        </input>
                    </div>
                    </>
                    : 
                    <>
                    <div style = {{width: 'var(--disc-size)'}}/>
                    <div style={{color: 'white'}}>-</div>
                    <div style = {{width: 'var(--disc-size)'}}/>
                    </>}
                    <Player player = {player2} number = {2} isWinner = {black < 32}/>
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
                        isTD = {false}
                        tName = {tName}
                        rName = {roundName}
                        byPlayer = {playerId}
                        />
                    </div> : <div/>
                }
                </>

            </div>
        )
    }
    
    return (
        <div>
            <button className = "btn-new-tournament" onClick = {returnHandler}>Return</button>
            <div className = 'big-text player'>{`Results of ${player.name.toLowerCase()} ${player.surname.toLowerCase()}`}</div>
            { pairings?.length > 0 ? 
                <div className = 'table-container' style = {{'--offset': '112px'}}>
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
                </div> 
            : 
            <div className = 'big-text-empty'>No games were played</div>}
        </div>
        
    )
}
