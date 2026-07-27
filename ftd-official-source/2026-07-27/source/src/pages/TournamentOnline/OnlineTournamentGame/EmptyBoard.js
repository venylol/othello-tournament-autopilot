import {useState, useRef, useEffect, useContext} from 'react'
import { Cell } from "../../elements/Cell"

export const EmptyBoard = ({params}) => {
    const rows = [1,2,3,4,5,6,7,8]
    const cols = ['a','b','c','d','e','f','g','h']
    const board = [
        ['','','','','','','',''],
        ['','','','','','','',''],
        ['','','','','','','',''],
        ['','','','w','b','','',''],
        ['','','','b','w','','',''],
        ['','','','','','','',''],
        ['','','','','','','',''],
        ['','','','','','','','']
    ]
    const color = 'black'
    const turn = 'b'
    const lastMove = ''

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

return(
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
                    {rows.map((row, i) => cols.map((col, j) => 
                    <Cell 
                        id = {cols[j] + rows[i]} 
                        isEmpty = {isCellEmpty([i, j])}
                        isLastMove = {isLastMove(cols[j] + rows[i])}
                        isLegalMove = {false}
                        discColor = {discColors([i, j])}
                        onClick = {()=> {}}
                        value = {`${i},${j}`}
                        settings = {{showLegalMoves: false}}
                        turn = {turn === 'b' ? 'black' : 'white'}
                        key = {cols[j]+rows[i]}
                        isNextMove = {false}
                        evaluation = {null}
                        bestEval = {null}
                        gameBoard = {0}
                        />
                    ))}   
                </div>
            </div>   
        </div>
</div>
)}