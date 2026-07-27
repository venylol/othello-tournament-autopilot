import React from "react"

export const EvalBar = ({ evaluation, width }) => {

    const widthBlack = width * Math.abs(( - 64 - evaluation)) / 128
    const params = { 
        '--black-eval' : widthBlack + 'px',
    }
    const blackEval = evaluation >= 0 ? "+" + evaluation : ''
    const whiteEval = evaluation < 0 ? evaluation : ''

    return (
        <>
            <div className = 'evalbar-container' style = {params} >
                <div className = 'eval-black'>
                    <span style ={{paddingLeft: 10}}>{blackEval}</span>
                </div>
                <div className = 'eval-white'>
                    <span style ={{paddingRight: 10}}>{whiteEval}</span>
                </div>
            </div>
        </>

    )
}