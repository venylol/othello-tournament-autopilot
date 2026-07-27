import { useRef, useContext } from "react"
import { Cell } from "./Cell"
import { UserContext } from "../../context/UserContext"

export const Board = ({transcript, move, position, turn, moveHandler, gameBoard, editMode, editMoveHandler, prevMove, nextMove, isPlayer}) => { //transcript, move-number, sizes, setPosition - function
    // console.log(transcript, move, position, turn, editMode) 
    const {settings} = useContext(UserContext)
    const lastMove = move === 0 ? '' : transcript.slice((move - 1) * 2, (move) * 2)
    const rows = [1,2,3,4,5,6,7,8]
    const cols = ['a','b','c','d','e','f','g','h']

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
    
    function isMoveLegal (cell) {                                                                                // checking if move is legal
        if (position[cell[0]][cell[1]] === 'l') {
            return true
        }
        return false
    }

    return (
        <div className = 'replayer'>
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
                        {!editMode && transcript?.length > 0 && !isPlayer ? <div className="prev-move-big" onClick={prevMove}></div> : <></>}   
                        {rows.map((row, i) => cols.map((col, j) => 
                        <Cell 
                            id = {cols[j] + rows[i]} 
                            isEmpty = {isCellEmpty([i, j])}
                            isLastMove = {isLastMove(cols[j] + rows[i])}
                            isLegalMove = {isMoveLegal([i,j])}
                            discColor = {discColors([i, j])}
                            onClick = {editMode ? editMoveHandler : moveHandler}
                            value = {`${i},${j}`}
                            settings = {settings}
                            turn = {turn === 'b' || turn === 'black' ? 'black' : 'white'}
                            key = {cols[j] + rows[i]}
                            // isNextMove = {isNextMove(rotation % 2 > 0 ? rows[i] + cols[j] : cols[j] + rows[i])}
                            // evaluation = {getEval(rotation % 2 > 0 ? rows[i] + cols[j] : cols[j] + rows[i])?.value}
                            // bestEval = {getBestEval(rotation % 2 > 0 ? rows[i] + cols[j] : cols[j] + rows[i])?.value}
                            // evalOpacity = {getEval(rotation % 2 > 0 ? rows[i] + cols[j] : cols[j] + rows[i])?.opacity}
                            gameBoard = {gameBoard}
                            editMode = {editMode}
                            allowedToStream = {true}
                            transcriptMode = {false}
                            />
                        ))}   
                        {!editMode && transcript?.length > 0 && !isPlayer? <div className="next-move-big" onClick={nextMove}></div> : <></>}
                    </div>
                </div>   
            </div>
            </div>
            {/* <div className = 'buttons-container'>
                <button className = 'copy' onClick = {copyTextToClipboard}></button>
                <button className = 'replay tostart' onClick = {toStartPosition} disabled = {move === 0 ? true : false}></button>
                <button className = 'replay back' onClick = {prevMove} disabled = {move === 0 ? true : false}></button>
                <div className="transcript-container">
                    <div ref = {transRef} className= 'transcript'> 
                        {gameData.transcript.length > 0 ?
                        gameData.transcript.match(/.{1,2}/g).map ((m, idx) => 
                            <div ref = {m === lastMove ? moveRef : null} key = {idx + 1 + m} className = {m === lastMove ? "last-move" : "prev-move"} onClick = {toSomeMove}>{`${idx + 1 + '. ' + m}`}</div>
                        ) : <div/>}
                    </div>
                </div>
                <button className = 'replay forward' onClick = {nextMove} disabled = {move === positionTable.length - 1 ? true : false}></button>
                <button className = 'replay fastforward' onClick = {toFinalPosition} disabled = {move === positionTable.length - 1 ? true : false}></button>
                <button className = 'fullscreen'></button>
            </div>
            <div className="time-string">{timeStarted}</div> */}
        </div>
    )
}


