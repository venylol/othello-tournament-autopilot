import React, {useState, useEffect, useRef, useContext} from 'react'
import { DropDown } from '../elements/DropDown'
import { checkTName, debounce } from '../functions/functions';
import { FixedSizeList } from "react-window"
import { getName, getNames, getCode, search } from 'country-list';
import { SwapSVG } from '../elements/SVG'
import { CountryFlags } from '../elements/CountryFlags';

export const CreateGame = ({id, standingsRaw, socket, setVisible, setPressed, ifCategories, categories}) => { 
    
    const standings = standingsRaw.map((player, i) => ({...player, place: i + 1}))
    
    // console.log(standings)
    const [black, setBlack] = useState()
    const [white, setWhite] = useState()
    const [player, setPlayer] = useState (null)
    const [wofPlayers, setWOFPlayers] = useState ([])
    const [validBlackPlayer, setValidBlackPlayer] = useState (false)
    const [validWhitePlayer, setValidWhitePlayer] = useState (false)
    const [nameBlack, setNameBlack] = useState ('')
    const [nameWhite, setNameWhite] = useState ('')
    const [blackWofId, setBlackWofId] = useState(null)
    const [whiteWofId, setWhiteWofId] = useState(null)
    const [roundName, setRoundName] = useState('')
    const [category, setCategory] = useState(ifCategories ? '' : 'open')
    // const [drawValue, setDrawValue] = useState('')
    const [roundNameFlag, setRoundNameFlag] = useState (false)
    const [categoryFlag, setCategoryFlag] = useState (false)
    // const [drawValueFlag, setDrawValueFlag] = useState (false)
    // const [settings, setSettings] = useState({})
    const listRef = useRef ()

    const ROUND_NAMES = ['Finals', 'Match for 3rd Place', 'Semi-Finals', 'Play-Off', 'Quarter-Finals']
    // const DRAW_VALUES = ['draw', 'white wins', 'black wins']
    // const categories = categoriesRaw.length > 0 ? [...categoriesRaw] :

    let cat = ['open']
    if (ifCategories && (categories?.length === 0 || !categories)) {
        for (let i = 0; i < standings.length; i++) {
            cat = [...new Set([...cat, ...standings[i].categories])]
        }
        categories = [...cat]
    }


    const width = window.innerWidth
    // console.log(width)
    const height = window.innerHeight
    const searchListHeight = Math.min(wofPlayers?.length * 45, height - 300)

    const exactMatch = (arr, str) => {
        if(arr.length === 0) return false
        for (let i = 0; i < arr.length; i ++) {
            if (arr[i].surname.toLowerCase() + ' ' + arr[i].name.toLowerCase() === str.toLowerCase()) return arr[i].id
        }
        return false
    }

    const toCapitalized = (str) => {
        return str.charAt(0).toUpperCase() + str.slice(1)
    }

    const focusHandler = (event) => {
        setRoundNameFlag(false)
        setCategoryFlag(false)
        const value = JSON.parse(JSON.stringify(event.target.value))
        event.target.id === 'blackName' ? setPlayer('black') : setPlayer('white')
        if (value.trim().length >= 2) {
            const name = value.trim().toLowerCase().replace(/ /g, "")
            // console.log(name)
            const filtered = event.target.id === 'blackName' ? 
                standings.filter(player => player.surname.toLowerCase().concat(player.name.toLowerCase()).replace(/ /g, "").includes(name) && player.player_id !== whiteWofId &&
                    (player.categories?.includes(category) || category === 'open')) :
                standings.filter(player => player.surname.toLowerCase().concat(player.name.toLowerCase()).replace(/ /g, "").includes(name) && player.player_id !== blackWofId &&
                    (player.categories?.includes(category) || category === 'open'))

            setWOFPlayers(filtered)
            return
        }

        const filtered = event.target.id === 'blackName' ? standings.filter(player => player.player_id !== whiteWofId && (player.categories?.includes(category) || category === 'open')) 
        : standings.filter(player => player.player_id !== blackWofId && (player.categories?.includes(category) || category === 'open'))
        setWOFPlayers(filtered)
    }

    const returnHandler = () => {
        setVisible(false)
        // if (pressed === 'Players') {
        //     socket.emit('get-otb-reg', id)
        //     return
        // }
        // if (pressed === 'Standings') {
        //     socket.emit('get-standings-otb', id)
        //     return
        // }
    }

    useEffect(() => {
        setWOFPlayers([])
        setBlack(null)
        setNameBlack('')
        setBlackWofId(null)
        setValidBlackPlayer(false)
        setWhite(null)
        setNameWhite('')
        setWhiteWofId(null)
        setValidWhitePlayer(false)
    },[category, roundName])

    const changeName = event => {
        const value = JSON.parse(JSON.stringify(event.target.value))
        
        if (checkTName(value) || value.length === 0) {
            event.target.id === 'blackName' ? setNameBlack(value) : setNameWhite(value)
            if (value.trim().length >= 2) {
                const name = value.trim().toLowerCase().replace(/ /g, "")
                const filtered = event.target.id === 'blackName' ? 
                    standings.filter(player => player.surname.toLowerCase().concat(player.name.toLowerCase()).replace(/ /g, "").includes(name) && player.player_id !== whiteWofId) :
                    standings.filter(player => player.surname.toLowerCase().concat(player.name.toLowerCase()).replace(/ /g, "").includes(name) && player.player_id !== blackWofId)
                setWOFPlayers(filtered)
                return
            }
            const filtered = event.target.id === 'blackName' ? standings.filter(player => player.player_id !== whiteWofId) : standings.filter(player => player.player_id !== blackWofId)
            setWOFPlayers(filtered)
            event.target.id === 'blackName' ? setValidBlackPlayer(false) : setValidWhitePlayer(false)
        }
        
        const checkId = exactMatch(wofPlayers, value)
        if (checkId && wofPlayers.length === 1) {
            event.target.id === 'blackName' ? setValidBlackPlayer(true) : setValidWhitePlayer(true)
            event.target.id === 'blackName' ? setBlackWofId(checkId) : setWhiteWofId(checkId)
            event.target.id === 'blackName' ? setBlack(wofPlayers[0]) : setWhite(wofPlayers[0])   
            return
        } 
        event.target.id === 'blackName' ? setValidBlackPlayer(false) : setValidWhitePlayer(false)
        event.target.id === 'blackName' ? setBlackWofId(null) : setWhiteWofId(null)
        event.target.id === 'blackName' ? setBlack(null) : setWhite(null)         
    }

    const swapPlayers = () => {
        if (!black || !white) return
        setBlack(white)
        setBlackWofId(white.player_id)
        setNameBlack(nameWhite)
        setWhite(black)
        setWhiteWofId(black.player_id)
        setNameWhite(nameBlack)
    }

    const onRoundName = () => {
        setRoundNameFlag(prev => !prev)
        setCategoryFlag(false)
        // setDrawValueFlag(false)
        setWOFPlayers([])
    }

    const onCategory = () => {
        setCategoryFlag(prev => !prev)
        setRoundNameFlag(false)
        // setDrawValueFlag(false)
        setWOFPlayers([])
    }

    // const onDraw = () => {
    //     setDrawValueFlag(prev => !prev)
    //     setCategoryFlag(false)
    //     setRoundNameFlag(false)
    //     setWOFPlayers([])
    // }

    const addGame = () => {
        // console.log(blackWofId, roundName, whiteWofId, black, white)
        socket.emit('create-otb-game', id, blackWofId, whiteWofId, roundName, category)
        setPressed('Rounds')
        setVisible(false)
    }


    const Player = ({player, number}) => {
        const id = player.player_id
        const surname = toCapitalized(player.surname.toLowerCase())
        const name = player.name
        const country = player.country_code
        const countryName = getName(country)

        return (
            <div className= {`otb-player${number}`}>
                <div className="flag-container"> 
                    <CountryFlags countryName = {countryName} countryCode = {country}></CountryFlags>
                </div>
                <div className={`split-row ${player.left ? 'left' : ''}`} onClick = {() => number === 1 ? setValidBlackPlayer(false) : setValidWhitePlayer(false)}>
                    <div className="otb-player-lastname">{surname}</div>
                    <div className="otb-player-name">{name}</div>
                </div>
            </div>
        )
    }

    const WOFPlayer = ({index, style}) => {
        // console.log(wofPlayers[index])
        const id = wofPlayers[index].player_id
        const place = wofPlayers[index].place
        const surname = toCapitalized(wofPlayers[index].surname.toLowerCase())
        const name = wofPlayers[index].name
        const score = wofPlayers[index].score
        const mbq = wofPlayers[index].mbq
        const country = wofPlayers[index].country_code
        const leftRound = wofPlayers[index].left_after_round
        const countryName = getName(country)
        const wof_id = wofPlayers[index].wof_id

        const onWOFPlayer = e => {
            e.preventDefault()
            if(wofPlayers.length > 0) {
                if(player === 'black') {
                    setNameBlack(toCapitalized(wofPlayers[e.currentTarget.id].surname.toLowerCase()) + ' ' + wofPlayers[e.currentTarget.id].name) // setWhite?
                    setBlackWofId(wofPlayers[e.currentTarget.id].player_id)
                    setBlack(wofPlayers[e.currentTarget.id])
                } else if (player === 'white') {
                    setNameWhite(toCapitalized(wofPlayers[e.currentTarget.id].surname.toLowerCase()) + ' ' + wofPlayers[e.currentTarget.id].name) // setWhite?
                    setWhiteWofId(wofPlayers[e.currentTarget.id].player_id)
                    setWhite(wofPlayers[e.currentTarget.id])
                }
            }
            setWOFPlayers([])//
            player === 'black' ? setValidBlackPlayer(true) : setValidWhitePlayer(true)
            
        }

        return (
            <div style = {style}>
                <div className = 'table-row reg' id = {index} key = {id} onClick = {onWOFPlayer}>
                    <div className = 'table-place'>{place}</div>
                    <CountryFlags countryName = {countryName} countryCode = {country}></CountryFlags>
                    <div className={`select-text ${leftRound ? 'left' : ''}`} id = {id}>{surname} {name}</div>                       
                    <div className="select-text wof-rating" title = 'score'>{score}</div>
                    <div className="select-text wof-rating" title = 'score'>{mbq}</div>
                </div>
            </div>
        )
    }
//|| !DRAW_VALUES.includes(drawValue)
    return (
        <div >
            <div className = "btn-add-game">
                <button className = "btn-add-game" onClick = {addGame} disabled = {!ROUND_NAMES.includes(roundName) || !validBlackPlayer || !validWhitePlayer || (ifCategories && !categories.includes(category))}>Add Game</button>
                <button className = "cancel-game" onClick = {returnHandler}>Cancel</button>
            </div>
            
            <div className='big-text' style = {{border: 'none'}}> 
                <span>New Game</span>
            </div>
            <div className="table-container" style = {{'--offset': '120px', right: "1%"}}>
                <input hidden = {true} autoComplete='false'></input>
                
                <input 
                    className = {`input wof-players ${ROUND_NAMES.includes(roundName) ? 'valid' : ''}`} 
                    style = {{width: width * 0.98 - 17, marginLeft: 0}} 
                    placeholder = "Choose round name" 
                    onClick = {onRoundName} 
                    value = {roundName} 
                    readOnly = {true}/>
                {roundNameFlag ? <DropDown options = {ROUND_NAMES} setValue = {setRoundName} setFlag = {setRoundNameFlag} setSettings = {null} fieldName = {null}/> : <></>}
                {ifCategories ? 
                    <input 
                        className = {`input wof-players ${categories.includes(category) ? 'valid' : ''}`} 
                        style = {{width: width * 0.98 - 17, marginLeft: 0, marginTop: '10px'}} 
                        placeholder = "Choose category" 
                        onClick = {onCategory} 
                        value = {category} 
                        readOnly = {true} 
                    />  : <></>}
                {categoryFlag ? <DropDown options = {categories} setValue = {setCategory} setFlag = {setCategoryFlag} setSettings = {null} fieldName = {null}/> : <></>}
                {/* <input className = {`input wof-players ${DRAW_VALUES.includes(drawValue) ? 'valid' : ''}`} style = {{width: width * 0.98 - 17, marginLeft: 0, marginTop: '10px'}} placeholder = "In case of draw" onClick = {onDraw} value = {drawValue} readOnly = {true} ></input>
                {drawValueFlag ? <DropDown options = {DRAW_VALUES} setValue = {setDrawValue} setFlag = {setDrawValueFlag} setSettings = {null} fieldName = {null}/> : <></>} */}
                
                <div className='table-row round first last' style = {{backgroundColor: '#1f1e1b', marginTop: '10px'}}>
                    { !validBlackPlayer ?
                        <div className= {`otb-player${1}`}>
                            <input 
                                className = 'input add-game'
                                placeholder = "Black player"
                                name = 'f3' 
                                type = "text" 
                                autoComplete ="off" 
                                id = 'blackName' 
                                onFocus = {focusHandler}  
                                onChange = {changeName} 
                                value = {nameBlack} 
                                disabled = {!ROUND_NAMES.includes(roundName) || (ifCategories && !categories.includes(category))}/>
                        </div> :
                        <Player player = {black} number = {1}/>
                    }
                    <div className = {`score-replayer-black`}/>
                    {/* <div style={{color: 'white'}}>-</div> */}
                    <SwapSVG onClick = {swapPlayers}/>
                    <div className = {`score-replayer-white`}/> 
                    { !validWhitePlayer ?
                    <div className= {`otb-player${2}`}>
                        <input 
                            className = 'input add-game'
                            placeholder = "White player" 
                            name = 'f3' 
                            type = "text" 
                            autoComplete ="off" 
                            id = 'whiteName' 
                            onFocus = {focusHandler}  
                            onChange = {changeName} 
                            value = {nameWhite}
                            disabled = {!ROUND_NAMES.includes(roundName) || (ifCategories && !categories.includes(category))}
                        /> 
                    </div> :
                    <Player player = {white} number = {2}/>
                    }
                </div>

                <FixedSizeList 
                    className="list"
                    height={searchListHeight}
                    itemCount={wofPlayers.length}
                    itemSize = {45}
                    width={Math.min(width * 0.98, 500 * 0.98)}
                    ref = {listRef}
                >
                    {WOFPlayer}
                </FixedSizeList>

            </div>


        </div>

    )

}