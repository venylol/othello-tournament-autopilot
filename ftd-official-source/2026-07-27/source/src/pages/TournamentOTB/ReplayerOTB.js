import React, {useRef, useEffect, useContext, useState} from "react"
import { Cell } from "../elements/Cell"
import { PlayerInfo } from "../elements/PlayerInfo"
// import { LayoutContext } from '../../context/LayoutContext'
import { AuthContext } from '../../context/AuthContext'
import { clearLegalMoves } from '../functions/getPositions'
import { useNavigate } from 'react-router-dom'
import { BackButtonSVG, ForwardButtonSVG, MaxBackButtonSVG, MaxForwardButtonSVG, CopyButtonSVG, OpenGame } from '../elements/SVG'
import { UserContext } from "../../context/UserContext"

export const Replayer = ({id, round, tournamentID, transcript, comment, positionTable, turn, move, data, setPosition, sizes, isTD, tName, rName, byPlayer, xot}) => {
    // console.log(id, round, tournamentID, transcript, comment, positionTable, turn, move, data, setPosition, sizes, isTD, tName, rName) 
    const currentPosition = positionTable[move]
    const lastMove = move === 0 ? '' : transcript.slice((move - 1) * 2, (move) * 2)
    const [editMode, setEditMode] = useState(isTD && !data[0].score)
    const [board, setBoard] = useState(currentPosition)
    const moveRef = useRef(null)
    const transRef = useRef(null)
    const { socket } = useContext(AuthContext)
    const { isMobile } = useContext(UserContext)
    const history = useNavigate()

    // const allowedToEdit = (isTD || pairings[gameId][0].id === isPlayer || pairings[gameId][1].id === isPlayer) && !finished && !pairings[gameId][0].score
    
    
    const rows = [1,2,3,4,5,6,7,8]
    const cols = ['a','b','c','d','e','f','g','h']

    const blackPlayer = data[0]
    const whitePlayer = data[1] 
    const color = 'black'
    
    const params = { 
        '--board-size' : sizes.boardSize + 'px',
        '--cell-size': sizes.boardSize * 0.114795919 + 'px',
        '--board-margin': sizes.boardSize * 0.040815689 + 'px',
        '--disc-size': 35 + 'px',
        '--board-size-full' : sizes.boardSize + 'px',
        '--cell-size-full': sizes.boardSize * 0.114795919 + 'px',
        '--board-margin-full': sizes.boardSize * 0.040815689 + 'px',
        'maxWidth': '500px',
    }

    const toCapitalized = (str) => {
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

    const score = countDiscs(positionTable[move])

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
        if (currentPosition[cell[0]][cell[1]] === 'b') {
            return 'black'
        }
        if (currentPosition[cell[0]][cell[1]] === 'w') {
            return 'white'
        }
        return
    }

    function isCellEmpty (cell) {  
        if (currentPosition[cell[0]][cell[1]] === 'w' || currentPosition[cell[0]][cell[1]] === 'b') {
            return false
        }
        return true
    }

    function prevMove () {
        if (move === 0) {return}
        setPosition(id, move - 1) 
    }

    function nextMove () {
        if (move === transcript.length / 2) {return}
        setPosition(id, move + 1)
    }

    function toFinalPosition () {
        if (move === transcript.length / 2) {return}
        setPosition(id, transcript.length / 2)
    }

    function toStartPosition () {
        if (move === 0) {return}
        setPosition(id, 0)
    }

    const toSomeMove = (event) => {
        const toMove = event.target.innerText.substring(event.target.innerText.length - 2, event.target.innerText.length)
        const toMoveNumber = parseInt(event.target.innerText.substring(0, event.target.innerText.length - 4))
        // console.log (toMove, toMoveNumber)
        if (toMove === lastMove) {return}
        setPosition(id, toMoveNumber)
    }

    const openFullScreen = () => {
        history(`/live/${tournamentID}/${data[0].gameId}`, {
            state: { 
                positionTable: positionTable,
                turn: turn, 
                move: move,
                data: data,
                round: round,
                tName: tName,
                rName: rName,
                byPlayer: byPlayer,
                canEdit: isTD,
                xot: xot,
                // finished: finished
                // setPosition: setPosition,
            }
        })
    }

    useEffect (() => { // not smooth enough!!
        if (lastMove === '' || moveRef === null || move < 3 || !transRef.current) return
            requestAnimationFrame(() => {
                transRef.current.scrollLeft = (move - 2) * 59
            })        
    },[lastMove, transRef.current])
    
    function isMoveLegal (cell) { 
        // console.log(board)                                                                               // checking if move is legal
        if (board[cell[0]][cell[1]] === 'l') {
            return true
        }
        return false
    }

    const moveHandler = (event) => {
        const cell = event.currentTarget.value.split(',')
        cell[0] = parseInt(cell[0])
        cell[1] = parseInt(cell[1])
        if(!isMoveLegal(cell)) return
        // console.log(transcript)
        if (transcript && transcript?.slice((move) * 2, (move + 1) * 2) === event.currentTarget.id) {
            nextMove()
            return
        }
        setBoard(clearLegalMoves(currentPosition))
        // socket.emit('otb-move-made', tournamentID, data[0].id, data[1].id, event.currentTarget.id, id, move)
        // console.log('tournamentID, round, data[0].id, data[1].id, event.currentTarget.id, id, move')
        // console.log(tournamentID, round, data[0].id, data[1].id, event.currentTarget.id, id, move)
        socket.emit('otb-move-made', tournamentID, data[0].gameId, round, event.currentTarget.id, move)
    }

    return (
        <>
            <div style = {params} className = 'replayer'>
                <div style = {{height: 10}}></div>
                <PlayerInfo 
                    nickName = {comment === 'wrong colors' ? toCapitalized(whitePlayer.surname.toLowerCase()) + ' ' + whitePlayer.name : toCapitalized(blackPlayer.surname.toLowerCase()) + ' ' + blackPlayer.name}
                    color = {color}
                    score = {score[0]}
                    country = {comment === 'wrong colors' ? whitePlayer.country_code : blackPlayer.country_code}
                    hideFooter = {false}
                    avatar = {false}  
                    withTimer = {false} 
                    isStreamer = {editMode}                 
                />
                <div style = {{height: 10}}></div>
                <div className="board-container">
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
                            {!editMode ? <div className="prev-move-big" onClick={prevMove}></div> : <></>}
                            {rows.map((row, i) => cols.map((col, j) => 
                            <Cell 
                                id = {cols[j] + rows[i]} 
                                isEmpty = {isCellEmpty([i, j])}
                                isLastMove = {isLastMove(cols[j] + rows[i])}
                                isLegalMove = {isMoveLegal([i,j])}
                                discColor = {discColors([i, j])}
                                onClick = {moveHandler}
                                value = {`${i},${j}`}
                                settings = {{showLegalMoves: false, markLastMove: true}}
                                turn = {turn}
                                key = {cols[j]+rows[i]}/>
                            ))}   
                            {!editMode ? <div className="next-move-big" onClick={nextMove}></div> : <></>}
                        </div>
                    </div>   
                </div>
                </div>
                <PlayerInfo 
                    nickName = {comment === 'wrong colors' ? toCapitalized(blackPlayer.surname.toLowerCase()) + ' ' + blackPlayer.name : toCapitalized(whitePlayer.surname.toLowerCase()) + ' ' + whitePlayer.name}
                    color = {reverseColor(color)}
                    score = {score[1]}
                    country = {comment === 'wrong colors' ? blackPlayer.country_code : whitePlayer.country_code} 
                    hideFooter = {false}
                    avatar = {false} 
                    withTimer = {false}
                    isStreamer = {editMode}                   
                />
                
                <div className = 'buttons-container' style = {{width: isMobile ? '90%' : '', marginLeft: isMobile ? "5%" : ''}}>
                    <CopyButtonSVG transcript = {transcript}/>
                    <MaxBackButtonSVG onClick = {toStartPosition} move = {move}/>
                    {!isMobile ? <BackButtonSVG onClick = {prevMove} move = {move}/> : <></>}
                    <div className="transcript-container">
                        <div ref = {transRef} className= 'transcript'> 
                            {transcript?.length > 0 ?
                            transcript.match(/.{1,2}/g).map ((m, idx) => 
                                <div ref = {m === lastMove ? moveRef : null} key = {idx + 1 + m} className = {m === lastMove ? "last-move" : "prev-move"} onClick = {toSomeMove}>{`${idx + 1 + '. ' + m}`}</div>
                            ) : 
                            <div className = "comment">{comment} </div>}
                        </div>
                    </div>
                    {!isMobile ? <ForwardButtonSVG onClick = {nextMove} move = {move} transcript = {transcript}/> : <></>}
                    <MaxForwardButtonSVG onClick = {toFinalPosition} move = {move} transcript = {transcript}/>
                    {xot && transcript?.length <= 16 ? <></> :
                        <OpenGame onClick = {openFullScreen}/>
                    }
                </div>
                <div style = {{height: 10}}></div>
            </div>
        </>
    )
}


