import React, {useEffect, useRef, useState} from "react"



export const EvalGraph = ({ moveNumber, evals, width, retroAnalysis, onMoveClick }) => {
    const ref = useRef(null)
    // console.log('evals', evals)
    const [animationFlag, setAnimationFlag] = useState (false)
    const maxEval = Math.max(...evals.map(move => move.best_eval))
    const minEval = Math.min(...evals.map(move => move.best_eval))
    const rawMax = Math.max(maxEval, minEval * -1)
    const maxValue = Math.max(rawMax, 1)

    const maxHeight = 60
    const pointWidth = width / (evals.length)
    let q = ''

    for (let i = 1; i < evals.length - 2; i++) {
        const x = evals[i]?.move_number * pointWidth
        const y = maxValue > 0 ? maxHeight * ((maxValue + evals[i]?.best_eval) / (maxValue * 2)) : maxHeight * 0.5
        const y1 = maxValue > 0 ? maxHeight * ((maxValue + evals[i + 1]?.best_eval) / (maxValue * 2)) : maxHeight * 0.5
        const xc = (evals[i]?.move_number * pointWidth + evals[i + 1]?.move_number * pointWidth) / 2
        const yc = (y + y1) / 2
        q = q + x + ' ' + y + ' ' + xc + ' ' + yc + ' '
    }
    const y_2 = maxValue > 0 ? maxHeight * ((maxValue + evals[evals.length - 2]?.best_eval) / (maxValue * 2)) : maxHeight * 0.5
    const y_1 = maxValue > 0 ? maxHeight * ((maxValue + evals[evals.length - 1]?.best_eval) / (maxValue * 2)) : maxHeight * 0.5
    q = q + (evals[evals.length - 2]?.move_number + 1) * pointWidth + ' ' + y_2 + ' ' +
        (evals[evals.length - 1]?.move_number + 1) * pointWidth + ' ' +  y_1

    // Compute overlay width for unanalyzed retro moves (analysis goes backwards: last move first)
    let retroOverlayWidth = 0
    if (retroAnalysis && evals.length > 1) {
        let unanalyzedCount = 0
        for (let i = 0; i < evals.length - 1; i++) {
            if (!retroAnalysis[evals[i].move_number]) {
                unanalyzedCount++
            } else {
                break
            }
        }
        retroOverlayWidth = unanalyzedCount > 0 ? (unanalyzedCount + 1) * pointWidth : 0
    }

    const handleGraphClick = (e) => {
        if (!onMoveClick) return
        const rect = e.currentTarget.getBoundingClientRect()
        const x = e.clientX - rect.left
        const clickedMove = Math.round(x / pointWidth)
        const clampedMove = Math.max(0, Math.min(clickedMove, evals.length - 2))
        onMoveClick(clampedMove)
    }

    const GraphSVGCurve = ({width, maxHeight, q}) => {
        
        if(!width || !maxHeight || !q || evals.length === 0) return
        return(
            <div className = 'graph'>
                <svg width = {width} height = {maxHeight}>
                    <path d={`M 0 ${maxHeight / 2} Q ${q} L ${width},${maxHeight} L 0,${maxHeight} Z`} fill="white" stroke="none"/>
                    <path d={`M 0 ${maxHeight / 2} Q ${q}`} fill="none" stroke="black" strokeWidth="1"/>
                    {retroOverlayWidth > 0 && (
                        <rect x={0} y={0} width={retroOverlayWidth} height={maxHeight} fill="rgba(128, 128, 128, 0.5)" />
                    )}
                </svg>
            </div>
        )
    }


    useEffect(() => {
        // console.log('hi', ref.current?.style.width, animationFlag)
        if(ref.current && !animationFlag) {
            setAnimationFlag(true)
            setTimeout(() => ref.current.style.width = 0, 20)
        }
    }, [ref.current, animationFlag])

    return (
        <>
        <div style = {{display: 'flex', height: maxHeight}}>
            <div className = 'evalgraph-container' onClick={handleGraphClick} style={{cursor: onMoveClick ? 'pointer' : undefined}}>
                <div className = 'eval-axis'>
                    {evals?.length > 0 ? 
                    <>
                        <span>{-Math.round(maxValue)}</span>
                        <span>0</span>
                        <span>{Math.round(maxValue)}</span>
                    </>
                    : <></>}
                </div>
                <div ref = {ref} className = 'graph-loading' ></div>
                <GraphSVGCurve width = {width} maxHeight = {maxHeight} q = {q}/>
                <div className = 'evalgraph-split'/>
                {moveNumber > 0 && moveNumber < evals.length -1 ? 
                    <div className = 'evalgraph-move' style ={{width: pointWidth * (moveNumber) }}/>
                : <></>}
            </div>
        </div>
        <div></div>
        </>

    )
}