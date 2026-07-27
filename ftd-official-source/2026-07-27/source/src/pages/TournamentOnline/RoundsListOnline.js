import {useEffect, useRef, useState, useContext} from "react"
import { useWindowSize } from '../../hooks/resize.hook'
import { ToggleRounds } from "./ToggleRounds";
import { SFXContext } from '../../context/SFXContext';
import { AuthContext } from '../../context/AuthContext';
import { UserContext } from '../../context/UserContext';
import { Row } from "./RowRounds";

// add "delete" game for not started round
export const RoundsListOTB = ({id, isTD, isAssistant, setTab, round, setRound, isPlayer, tournamentFinished, tName, ifCategories, xot, nextRoundStartTime, setNextRoundStartTime, showBottomButton = false, verifiedOnly = false, viewerVerified = false}) => { //isOnline
    // console.log(id, isTD, round, isPlayer, test, tournamentFinished, tName, isAssistant, xot)
    const { playMove } = useContext (SFXContext)
    const { socket } = useContext(AuthContext)
    const { isOnline, isMobile } = useContext(UserContext)
    const [width, listWidth, rowHeight, rowHeightExpanded, height, offsetY, boardSize] = useWindowSize(null, true, isMobile)
    const [pressed, setPressed] = useState ()
    const [pairings, setPairings] = useState ([])
    const [roundsArr, setRoundsArr] = useState ([])
    const [openedIndex, setOpenedIndex] = useState([])
    const [coordinates, setCoordinates] = useState([])
    const [roundName, setRoundName] = useState('')
    // const [categories, setCategories] = useState([])
    const [timeControl, setTimecontrol] = useState(null)
    const [increment, setIncrement] = useState(null)
    const inputRef = useRef()
    const categorySize = 30
    const pairingRef = useRef ([])
    const timerVisible = !!nextRoundStartTime && round > 0
    const pairingsOffset = timerVisible ? 155 : 130

    const getTotalMaxHeight = () => {
        let categoriesCount = 0
        for (let i = 0; i < pairings.length; i++) {
            if (typeof pairings[i] === 'string') categoriesCount++
        }
        const buttonOffset = showBottomButton ? 60 : 0 // Account for Register/Unregister/Sign In button
        const footerOffset = 50 // Bottom navigation footer
        return height - pairingsOffset - buttonOffset - footerOffset
    }

    useEffect(()=> {
        socket.on('online-get-round', (data) => {
            console.log(data)
            setRound(data.round ? data.round : 0)
            setPressed(data.currentRound)
            setPairings(data.pairing)
            setRoundsArr(data.roundNames?.sort((a,b) => b.round - a.round))
            setOpenedIndex ([]) 
            setRoundName(data.roundNames?.filter(round => round.round === data.currentRound)[0]?.round_name)
            setTimecontrol(data.timeControl)
            setIncrement(data.increment)
            if (inputRef.current) inputRef.current.value = ''

            if(data.pairing) {
                pairingRef.current = JSON.parse(JSON.stringify(data.pairing))
            }
        })

        return () => {
            socket.off('online-get-round')            
        }
    },[]) 
    
    return (
        <div> 
            <>
            <ToggleRounds 
                coordinates = {coordinates} 
                pressed = {pressed} 
                roundsArr = {roundsArr} 
                id = {id} 
                currentRound = {round} 
                nextRoundStartTime = {nextRoundStartTime}
                setNextRoundStartTime = {setNextRoundStartTime}
            />
            {/* { round > 0 ?
                <div className = {`search-pair ${validSearchInput ? 'valid' : ''}`}>
                    <input className = 'search-pair' ref = {inputRef} placeholder = "Filter..."  onKeyUp={FilterEnterHandler} onChange = {FilterHandler}></input>
                    <button className = 'clear-input' ref = {clearInputRef} onClick = {ClearInput} onFocus = {()=> {setClearFocused(true)}} onBlur = {() => {setClearFocused(false)}}><ClearInputSVG focus = {clearFocused}/></button>
                </div> 
            :<></>}   */}
            { pairings?.length > 0 ? 
                <div className = 'table-container' style = {{'--offset': pairingsOffset + 'px'}} >
                    <div className = "list ot" style = {{width: listWidth + 'px', maxHeight: getTotalMaxHeight() + "px", overflow: 'scroll'}}>
                        {pairings.map((pair, idx) => 
                            <Row    
                                pair = {pair}
                                round = {pressed}
                                row = {idx}
                                isCategory = {typeof pair === 'string'}
                                key = {idx}
                                id = {id}
                                tName = {tName}
                                rName = {roundName}
                                timeControl = {timeControl}
                                increment = {increment}
                                isFirstGame = {idx === 0}
                                xot = {xot}
                                verifiedOnly = {verifiedOnly}
                                viewerVerified = {viewerVerified}
                            />
                        )}
                    </div>     
                <div style = {{marginTop: '10px', display: 'flex', justifyContent: 'center'}}>
                </div>
                
                </div>
  
            : 
            round === 0 ? <div className = 'big-text-empty'>No pairings were made</div> : <></>}

        </>
        </div>
        
    )
}

//isTD && !readyToFinish && !finished && pairings && !roundStarted ? <button className = "btn-new-tournament" onClick = {startRound}>Start Round</button> : <></>
