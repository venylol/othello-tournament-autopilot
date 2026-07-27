import {useState, useRef, useContext, useEffect} from "react"

const TablesSVG = ({opened}) => {
    return(
        <svg xmlns="http://www.w3.org/2000/svg" fill= {!opened ? "#aca9a9" : 'white'} viewBox="0 0 32 28" strokeWidth={0.25} stroke = "#aca9a9">
            <g><g><rect x="7.7" y="10.1" fill= {!opened ? "#aca9a9" : 'white'} width="16.6" height="1.5"/></g>
            <g><rect x="15.3" y="10.9" fill= {!opened ? "#aca9a9" : 'white'} width="1.5" height="13.2"/></g>
            <g><rect x="13" y="23.3" fill= {!opened ? "#aca9a9" : 'white'} width="6" height="1.5"/></g>
            <g><rect x="24.3" y="16.3" fill= {!opened ? "#aca9a9" : 'white'} width="1.5" height="7.7"/></g>
            <g><rect x="22.6" y="23.3" fill= {!opened ? "#aca9a9" : 'white'} width="5" height="1.5"/></g>
            <g><rect x="4.5" y="23.3" fill= {!opened ? "#aca9a9" : 'white'} width="5" height="1.5"/></g>
            <g><polygon fill= {!opened ? "#aca9a9" : 'white'} points="29.3,17.1 20.4,17.1 20.4,15.6 28,15.6 29.8,7.2 31.2,7.5"/></g>
            <g><rect x="6.2" y="16.3" fill= {!opened ? "#aca9a9" : 'white'} width="1.5" height="7.7"/></g>
            <g><polygon fill= {!opened ? "#aca9a9" : 'white'} points="11.6,17.1 2.7,17.1 0.8,7.5 2.2,7.2 4,15.6 11.6,15.6"/>
            </g></g>
        </svg>

    )
}


export const Tables = ({pressed, setPressed, count = 0}) => {
    const buttonRef = useRef(null)
    const [opened, setOpened] = useState(false)

    const clickHandler = () => {
        setPressed('Tables')
    } 

    useEffect (() => {
        if (pressed === 'Tables') {
            setOpened(true)
        } else {
            setOpened(false)
        }
    }, [pressed])

    useEffect (() => {
        if (!buttonRef.current) {return}
            buttonRef.current.style.animation = 'none' 
            buttonRef.current.style.left = '50%'
            buttonRef.current.style.top = '50%'
            requestAnimationFrame(() => {
                buttonRef.current.style.animation = 'ripples-toggle 0.3s ease-in forwards'
            })
    }, [opened])

    return (
        <>
        <div className="game-footer-container"> 
            <div className = {`game-footer tables ${opened? 'active' : ''}`} title = 'tables' onClick= {clickHandler}>
                <TablesSVG opened = {opened}/>
                <span className='tables-counter'>{count}</span>
                <label className = {`game-footer-label ${opened? 'active' : ''}`}>Tables</label>
            </div>
            {pressed === 'Tables' ? 
                <div className="ripple-container toggle-footer">
                    <span ref = {buttonRef} className = 'ripple'></span> 
                </div> : <></>
            }
        </div>
        </>
    )
}

