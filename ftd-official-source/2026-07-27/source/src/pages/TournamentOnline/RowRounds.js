import React, {useEffect, useRef, useState, useContext} from "react"
import { Player } from "./OnlineRoundPlayer";
import { Replayer } from './ReplayerOnline';
import { roundReady, roundEdit, getFullGameName, fakeResults } from "../functions/functions";
import { SFXContext } from '../../context/SFXContext';
import { AuthContext } from '../../context/AuthContext';
import { UserContext } from '../../context/UserContext';
import { LayoutContext } from '../../context/LayoutContext'
import { useWindowSize } from '../../hooks/resize.hook'

export const Row = ({pair, round, row, isCategory = false, isLastGame = false, isFirstGame = false, tName, rName, id, timeControl, increment, xot, showRoundNumber = false, byPlayerNick = null, verifiedOnly = false, viewerVerified = false}) => {
    // console.log('tournament id:', id, pair, round)
    const { socket } = useContext(AuthContext)
    const { isMobile } = useContext(LayoutContext)
    const [width, listWidth, rowHeight, rowHeightExpanded, height, offsetY, boardSize] = useWindowSize(null, true, isMobile) // listRef
    const [opened, setOpened] = useState(false)
    // const [coordinates, setCoordinates] = useState([])
    const [reason, setReason] = useState(pair[0]?.reason || '')
    const [finished, setFinished] = useState(pair[0]?.result !== null)
    // const [listWidth, setListWidth] = useState(Math.min(width * 0.98, 500 * 0.98))
    
    // Calculate initial score from pair data
    const getInitialBlack = () => {
        if (pair[0]?.result === null) return ''
        return pair[0].score
    }
    const getInitialWhite = () => {
        if (pair[0]?.result === null) return ''
        return 64 - pair[0].score
    }
    
    const [black, setBlack] = useState(getInitialBlack())
    const [white, setWhite] = useState(getInitialWhite())
    const categoryText = isCategory ? pair : false
    const gameNumber = pair[0].gameNumber
    // const categorySize = 30

    // Update score when pair changes (e.g., switching rounds)
    useEffect(() => {
        if (pair[0]?.result !== null) {
            setBlack(pair[0].score)
            setWhite(64 - pair[0].score)
        } else {
            setBlack('')
            setWhite('')
        }
        setFinished(pair[0]?.result !== null)
        setReason(pair[0]?.reason || '')
    }, [pair, pair[0].result])

    let player1, player2
    if (pair[0].id === -1) {
        player1 = pair[1]
        player2 = pair[0]
    } else if (pair[1].id === -1) {
        player1 = pair[0]
        player2 = pair[1]
    } else {  
        player1 = pair[0]
        player2 = pair[1]  
    }

    useEffect(() => {
        setOpened(false)
    },[round, id])

    useEffect (() => { 
        const handleNewResult = (gameId, score, reason) => { // receive 
            console.log(pair[0].gameId, gameId, score, reason)
            if (gameId === pair[0].gameId) {
                setBlack(score)
                setWhite(64 - score)
                setReason(reason)
                setFinished(true)
            } 
        }
        socket.on('online-get-new-result', handleNewResult)
        return () => {
            socket.off('online-get-new-result', handleNewResult)
        }
    },[pair, pair[0].gameId, round])

    const showGame = (event) => {
        if (player2.id === -1) return
        console.log('showGame', pair)
        
        //check if player and !finished. If so - navigate to game to play (no idea why should be there but just in case) 
        
        // setCoordinates([event.clientX , rowHeight/2])     

        if (opened) { 
            setOpened(false)
            return
        } 
        socket.emit('get-tournament-game', id, pair[0].gameId, round)
        setOpened(true)
    }

    return (
        <div >
            {categoryText ? <div className = 'big-text-category'>{categoryText}</div> :
            <>
            <div className = {opened ? `table-row round extended${gameNumber === 0 && isLastGame ? ' first last' 
            : gameNumber === 0? ' first' : isLastGame ? ' last' : ''}` 
            : `table-row round${gameNumber === 0 && isLastGame ? ' first last' : gameNumber === 0 ? ' first' : isLastGame ? ' last' : ''}`}
                id = {row} 
                onClick = {showGame} 
                key = {player1?.id.toString() + player2?.id.toString()}
            >
                <div className = 'table-place'>{showRoundNumber ? `R${pair[0]?.round}` : gameNumber + 1}</div>
                <Player player = {player1} number = {1} isWinner = {black > 32} verifiedOnly = {verifiedOnly} viewerVerified = {viewerVerified}/>
                {player1.id !== -1 && player2.id !== -1 ?
                <>
                <div className = {`score-replayer-black`} > 
                    <input 
                        className = {`disc-count-black`}
                        name = 'black' 
                        type = "number" 
                        max = "64" 
                        min = '0' 
                        readOnly = {true}
                        value = {black} 
                        >
                        
                    </input>
                </div>
                <div style={{color: 'white'}}>-</div>
                <div className = {`score-replayer-white`}> 
                    <input 
                        className = {`disc-count-white`} 
                        name = 'white'
                        type = "number" 
                        max = "64" 
                        min = '0' 
                        readOnly = {true}
                        value = {white}
                        >
                    </input>
                </div>
                </>
                : 
                <>
                <div style = {{width: 'var(--disc-size)'}}/>
                <div style = {{color: 'white'}}>-</div>
                <div style = {{width: 'var(--disc-size)'}}/>
                </>}
                <Player player = {player2} number = {2} isWinner = {black < 32 && black !== null && black !== ''} verifiedOnly = {verifiedOnly} viewerVerified = {viewerVerified}/>
                
            </div>
            {opened ? 
                <div>
                    <Replayer 
                    sizes = {{boardSize}}
                    tName = {tName}
                    rName = {rName}
                    byPlayer = {false}
                    byPlayerNick = {byPlayerNick}
                    reason = {pair[0].reason ? pair[0].reason : reason ? reason : null}
                    result = {pair[0].result}
                    finished = {!!pair[0].reason}
                    comment = {pair[0].comment}
                    timeControl = {timeControl}
                    increment = {increment}
                    tournamentId = {parseInt(id)}
                    round = {round}
                    gameId = {pair[0].gameId}
                    xot = {xot}
                    verifiedOnly = {verifiedOnly}
                    viewerVerified = {viewerVerified}
                    />
                </div> : <div/>
            }
            </>
            }
        </div>
    )
}

