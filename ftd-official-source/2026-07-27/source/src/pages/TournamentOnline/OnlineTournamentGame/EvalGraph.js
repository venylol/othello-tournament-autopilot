import React, {useEffect, useRef, useState} from "react"

const GraphSVGCurve = ({width, maxHeight, q, evalsLength, retroOverlayWidth, xotOverlayWidth}) => {
    if(!width || !maxHeight || !q || evalsLength === 0) return null
    return(
        <div className = 'graph'>
            <svg width = {width} height = {maxHeight}>
                <path d={`M 0 ${maxHeight / 2} Q ${q} L ${width},${maxHeight} L 0,${maxHeight} Z`} fill="white" stroke="none"/>
                <path d={`M 0 ${maxHeight / 2} Q ${q}`} fill="none" stroke="black" strokeWidth="1"/>
                {retroOverlayWidth > 0 && (
                    <rect x={0} y={0} width={retroOverlayWidth} height={maxHeight} fill="rgba(128, 128, 128, 0.5)" />
                )}
                {xotOverlayWidth > 0 && (
                    <rect x={0} y={0} width={xotOverlayWidth} height={maxHeight} fill="rgba(128, 128, 128, 0.4)" />
                )}
            </svg>
        </div>
    )
}

export const EvalGraph = ({ moveNumber, evals, width, retroAnalysis, onMoveClick, xotOffset = 0, evals_raw, blackPlayer }) => {
    const ref = useRef(null)
    // console.log('evals', evals)
    const [animationFlag, setAnimationFlag] = useState (false)
    const maxEval = Math.max(...evals.map(move => move.best_eval))
    const minEval = Math.min(...evals.map(move => move.best_eval))
    const rawMax = Math.max(maxEval, minEval * -1)
    const maxValue = Math.max(rawMax, 1) // minimum ±1 to avoid flat axis when all evals are 0

    const maxHeight = 60
    const pointWidth = width / (evals[evals.length - 1]?.move_number + 1 || evals.length)
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
    // Unanalyzed region is on the LEFT side of the graph
    let retroOverlayWidth = 0
    if (retroAnalysis && evals.length > 1) {
        // Count consecutive unanalyzed moves from the start
        let unanalyzedCount = 0
        for (let i = 0; i < evals.length - 1; i++) {
            if (!retroAnalysis[evals[i].move_number]) {
                unanalyzedCount++
            } else {
                break
            }
        }
        // +1 covers the curve transition zone at the boundary; 0 when fully analyzed
        retroOverlayWidth = unanalyzedCount > 0 ? (unanalyzedCount + 1) * pointWidth : 0
    }

    // XOT setup overlay: gray out first xotOffset moves
    const xotOverlayWidth = xotOffset > 0 ? xotOffset * pointWidth : 0

    const handleGraphClick = (e) => {
        if (!onMoveClick) return
        const rect = e.currentTarget.getBoundingClientRect()
        const x = e.clientX - rect.left
        const clickedMove = Math.round(x / pointWidth)
        const clampedMove = Math.max(0, Math.min(clickedMove, evals[evals.length - 2]?.move_number ?? evals.length - 2))
        onMoveClick(clampedMove)
    }

    useEffect(() => {
        // console.log('hi', ref.current?.style.width, animationFlag)
        if(ref.current && !animationFlag) {
            setAnimationFlag(true)
            setTimeout(() => ref.current.style.width = 0, 20)
        }
    }, [ref.current, animationFlag])

    // Compute disc loss from raw evals data
    const discLoss = React.useMemo(() => {
        if (!evals_raw || evals_raw.length < 2) return null
        const blackId = evals_raw[0].player_id
        let blackLoss = 0, whiteLoss = 0
        for (const e of evals_raw) {
            if (e.best_eval === null || e.eval === null) continue
            const loss = (e.best_eval - e.eval) / 2
            if (e.player_id === blackId) blackLoss += loss
            else whiteLoss += loss
        }
        return {
            black: Math.round(blackLoss * 10) / 10,
            white: Math.round(whiteLoss * 10) / 10
        }
    }, [evals_raw])

    return (
        <>
        {/* {discLoss && (
            <div style={{display: 'flex', justifyContent: 'center', gap: '12px', fontSize: '11px', lineHeight: '16px', color: '#999', padding: '2px 0 3px'}}>
                <div style={{display: 'flex', alignItems: 'center', gap: '4px'}}>
                    <span style={{display: 'inline-block', width: '8px', height: '8px', borderRadius: '50%', background: '#222', border: '1px solid #555'}}/>
                    <span style={{color: discLoss.black > 0 ? '#e57373' : '#999'}}>{discLoss.black > 0 ? `-${discLoss.black}` : '0'}</span>
                </div>
                <div style={{display: 'flex', alignItems: 'center', gap: '4px'}}>
                    <span style={{display: 'inline-block', width: '8px', height: '8px', borderRadius: '50%', background: '#fff', border: '1px solid #888'}}/>
                    <span style={{color: discLoss.white > 0 ? '#e57373' : '#999'}}>{discLoss.white > 0 ? `-${discLoss.white}` : '0'}</span>
                </div>
            </div>
        )} */}
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
                <GraphSVGCurve width = {width} maxHeight = {maxHeight} q = {q} evalsLength = {evals.length} retroOverlayWidth = {retroOverlayWidth} xotOverlayWidth = {xotOverlayWidth}/>
                <div className = 'evalgraph-split'/>
                {moveNumber > 0 && moveNumber < (evals[evals.length - 1]?.move_number ?? evals.length - 1) ? 
                    <div className = 'evalgraph-move' style ={{width: pointWidth * (moveNumber) }}/>
                : <></>}
            </div>
        </div>
        <div></div>
        </>

    )
}