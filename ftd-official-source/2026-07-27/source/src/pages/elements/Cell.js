import { useContext, useEffect, useState} from "react"

const BookIcon = ({x, y, size}) => (
    <g transform={`translate(${x - size/2}, ${y - size/2})`}>
        <rect x={size*0.08} y={0} width={size*0.84} height={size} rx={size*0.06} fill="#A0522D"/>
        <rect x={0} y={size*0.04} width={size*0.82} height={size*0.92} rx={size*0.05} fill="#D2691E"/>
        <rect x={size*0.06} y={size*0.04} width={size*0.74} height={size*0.92} fill="#DEB887"/>
        <line x1={size*0.12} y1={size*0.25} x2={size*0.7} y2={size*0.25} stroke="#A0522D" strokeWidth={size*0.05} strokeLinecap="round"/>
        <line x1={size*0.12} y1={size*0.42} x2={size*0.55} y2={size*0.42} stroke="#A0522D" strokeWidth={size*0.04} strokeLinecap="round"/>
    </g>
)

export const Cell = ({id, isEmpty, discColor, isLastMove, isLegalMove, onClick, value, turn, settings, isNextMove, evaluation, bestEval, evalOpacity, gameBoard, allowedToStream = true, editMode, certainty, isBook, evalDone}) => {      
    const showLegalMove = allowedToStream || editMode
    const cellSize = gameBoard * 0.114795919 - 1
    const hasEval = (evaluation || evaluation === 0) || (bestEval || bestEval === 0)

    const renderCertaintyOrBook = () => {
        if (!hasEval) return null
        if (isBook) {
            // return <BookIcon x={cellSize * 0.82} y={cellSize * 0.82} size={cellSize * 0.32}/>
            return <text
                x={cellSize * 0.92}
                y={cellSize * 0.92 - 2}
                fill={'black'}
                fontSize={cellSize / 5}
                dominantBaseline="middle"
                textAnchor="end"
            >book</text>
        }
        if (certainty > 0) {
            return <text
                x={cellSize * 0.92}
                y={cellSize * 0.92 - 2}
                fill={(evalDone || certainty === 100) ? 'black' : '#aaa'}
                fontSize={cellSize / 5}
                dominantBaseline="middle"
                textAnchor="end"
            >{certainty}%</text>
        }
        return null
    }
    if(isEmpty) {
        if (isNextMove) {
            return (
                <button
                    className= {`cell ${editMode ? 'edit' : ''}`}
                    id = {id}
                    onClick = {onClick}
                    value = {value}
                >
                    <svg className = 'disc' xmlsn = 'http://www.w3.org/2000/svg'>
                        <circle className = {`disc-next-${turn}`}/>
                        {evaluation || evaluation === 0?
                            <text 
                                className = 'move-eval' 
                                x = {(gameBoard * 0.114795919 - 1) / 2 } 
                                y = {(gameBoard * 0.114795919 - 1) / 2 } 
                                fill = {bestEval=== evaluation ? 'yellow' : turn === 'black' ? 'white' : 'black'}
                                fillOpacity = {evalOpacity ? evalOpacity : 1}
                                fontSize = {(gameBoard * 0.114795919) / 2.5 }
                                dominantBaseline="middle"
                                textAnchor="middle" 
                            >{evaluation}</text> :
                        <></>}
                        {renderCertaintyOrBook()}
                    </svg>
                </button>
            )
        }

        if (bestEval || bestEval === 0) { //is best Move
            return (
                <button
                    className= {`cell ${editMode ? 'edit' : ''}`}
                    id = {id}
                    onClick = {onClick}
                    value = {value}
                >
                    <svg className = 'disc' xmlsn = 'http://www.w3.org/2000/svg'>
                            <text 
                                className = 'move-eval' 
                                x = {(gameBoard * 0.114795919 - 1) / 2 } 
                                y = {(gameBoard * 0.114795919 - 1) / 2 } 
                                fill = 'yellow'
                                fillOpacity = {evalOpacity ? evalOpacity : 1}
                                fontSize = {(gameBoard * 0.114795919) / 2.5 }
                                dominantBaseline="middle"
                                textAnchor="middle" 
                            >{bestEval}</text> 
                            {renderCertaintyOrBook()}
                    </svg>
                </button>
            )
        }

        if(evaluation || evaluation === 0) {
            return (
                <button
                    className= {`cell ${editMode ? 'edit' : ''}`}
                    id = {id}
                    onClick = {onClick}
                    value = {value}
                >
                    <svg className = 'disc' xmlsn = 'http://www.w3.org/2000/svg'>
                            <text 
                                className = 'move-eval' 
                                x = {(gameBoard * 0.114795919 - 1) / 2 } 
                                y = {(gameBoard * 0.114795919 - 1) / 2 } 
                                fill = {evalOpacity === 1 ? turn === 'black' ? 'black' : 'white' : '#aca9a9'}
                                fillOpacity = {evalOpacity ? evalOpacity : 1}
                                fontSize = {(gameBoard * 0.114795919) / 2.5 }
                                dominantBaseline="middle"
                                textAnchor="middle" 
                            >{evaluation}</text> 
                            {renderCertaintyOrBook()}
                    </svg>
                </button>
            )
        }

        if(isLegalMove) {
            // If isLegalMove && moveNumber === 1 then show legal moves anyway!
            return (
                <button
                    className= {`cell ${editMode ? 'edit' : ''}`}
                    id = {id}
                    disabled = {!allowedToStream && !editMode}
                    onClick = {onClick}
                    value = {value}
                >
                    <svg className = 'disc' xmlsn = 'http://www.w3.org/2000/svg'>
                        <circle className = {settings.showLegalMoves ? `disc-legal-${turn} show ${!showLegalMove ? 'no-edit' : ''}` : showLegalMove ? `disc-legal-${turn}` : ''} fillOpacity = {showLegalMove ? 0.75 : 1}/> 
                    </svg>
                </button>
            )
        }
        
        //split disk-legal to disk-legal-black classes
        return (
            <button
                className= {`cell ${editMode ? 'edit' : ''}`}
                id = {id}
                disabled = {!isLegalMove}
                // onClick = {onClick} should it be there???
                value = {value}
            />
        )
    }

    if(!isLastMove) {
    return(
        <button
            className= {`cell ${editMode ? 'edit' : ''}`}
            id = {id}
            disabled = {true}
            value = {value}
        >
            <svg className = 'disc' xmlsn = 'http://www.w3.org/2000/svg'>
                <circle className = {`disc-${discColor}`}/>
            </svg>
        </button>
    )}

    return(
        <button
         className= {`cell ${editMode ? 'edit' : ''}`}
         id = {id}
         disabled = {true}
         value = {value}
        >
            <svg className = 'disc' xmlsn = 'http://www.w3.org/2000/svg'>
                <circle className = {`disc-${discColor}`}/>
                {settings.markLastMove ?
                <>
                    <rect className = {`last-ver-${discColor}`}/>
                    <rect className = {`last-hor-${discColor}`}/>
                </> : <></>}
            </svg>
        </button>
    )
}