import React, {useState, useEffect, useRef} from "react"
import CountUp from "react-countup"
import { useWindowSize } from '../../hooks/resize.hook'

export const CircleStats = (data) => {
    const [fontSize, setFontSize] = useState({'--chart-big-text': 0, '--chart-small-text': 0})
    const [previousValue, setPreviousValue] = useState(0)
    const [width, listWidth, rowHeight, rowHeightExpanded, height, offsetY, boardSize] = useWindowSize(null, true)
    const winRef = useRef(null)
    const drawRef = useRef(null)
    const lossRef = useRef(null)

    const total = data.win + data.draw + data.loss

    function usePreviousTotal (value) {
        const ref = useRef();
        useEffect(() => {
          ref.current = value;
        });
        return ref.current;
      }
    
    function setBigFont (data) {
        if (!data) {return 1}
        const total = data.win + data.draw + data.loss
        if (total <= 99999) {return 1}
        return 1 - (total.toString().length - 5) / 10
    }

    function setSmallFont (data) {
        if (!data) {return 1}
        const length = `${data.win} / ${data.draw} / ${data.loss}`.length
        if (length <= 16) {return 0.4}
        if (length > 21 ) {return 0.285}
        if (length > 20 ) {return 0.3}
        return 0.4
    }

    const perim = width > 500 ? Math.round( Math.min(width, 500) * 0.87292) : Math.round( Math.min(width, 500, height) * 0.87292)

    const params = {
        '--win': (data.win/total)*100,
        '--draw': (data.draw/total)*100,
        '--loss': (data.loss/total)*100,
        '--perimeter': perim + 'px',
    }

    const prevValue = usePreviousTotal(total)
    
    useEffect(() => {
        if (!winRef || !drawRef || !lossRef || prevValue === total) {return}
        setPreviousValue (prevValue)      
        winRef.current.style.animation = 'none'
        drawRef.current.style.animation = 'none'
        lossRef.current.style.animation = 'none'
        requestAnimationFrame(() => {
            winRef.current.style.animation = 'circle-chart-fill 1s linear forwards'
            drawRef.current.style.animation = 'circle-chart-fill 1s linear forwards'
            lossRef.current.style.animation = 'circle-chart-fill 1s linear forwards'
        })
        setFontSize ({'--chart-big-text': setBigFont(data), '--chart-small-text': setSmallFont(data)})
    },[data])

    return (
        <div className = 'stats-wrapper' style = {params}>
            <svg className = "stats" xmlns = "http://www.w3.org/2000/svg">
                <circle className = "circle-background"/>
                <circle ref = {winRef}/>
                <circle ref = {drawRef}/>
                <circle ref = {lossRef}/>
            </svg>
            <div className = "stats-details" style = {fontSize}>
                <div className = "games-count">
                    <CountUp start = {previousValue ? previousValue : 0} end = {total} duration = {1}/>
                </div>
                <div className = "chart-text-small">
                    <span className = "chart-span">
                    <CountUp start = {0} end = {data.win} duration={1}/>
                    </span>
                    <span>/</span>
                    <span><CountUp start = {0} end = {data.draw} duration={1}/></span>
                    <span>/</span>
                    <span><CountUp start = {0} end = {data.loss} duration={1}/></span>
                </div>
            </div>
        </div>
    )
}

