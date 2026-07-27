import React, {useEffect, useRef, useState, useCallback, useContext} from "react"
import { getName, getNames, getCode, search } from 'country-list';
import { FixedSizeList } from "react-window"
import { toast } from 'react-toastify';
import { useWindowSize } from '../../hooks/resize.hook'
import { checkTName, debounce } from '../functions/functions';
import { SwitcherCategories } from './SwitcherCategories';
import { UserContext } from '../../context/UserContext';
import { CountryFlags } from "../elements/CountryFlags";
// import { useOtbIdb } from '../../hooks/idb.otb.hook'
// const image = require(`../../assets/first_time.jpg`)

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

export const PlayersListOTB = ({id, socket, isTD, setTab, pairingSystem, isOnline, hasCategories, setRoundsByPlayerID, tName, currentRound, tournamentCountry}) => {
    // console.log(tournamentCountry)
    const [validPlayer, setValidPlayer] = useState (false)
    const [name, setName] = useState ('')
    const [wofId, setWofId] = useState(null)
    const [wofPlayers, setWOFPlayers] = useState ([])
    const [newPlayer, setNewPlayer] = useState(false)
    const [register, setRegister] = useState(false)
    const [data, setData] = useState([])
    const [isLoading, setIsloading] = useState(true)
    const [started, setStarted] = useState(false)
    const [lasroundStarted, setLastRoundStarted] = useState(false)
    const [team, setTeam] = useState('')
    const [family, setFamily] = useState('')
    const [categories, setCategories] = useState([])
    const [filterCategories, setFilterCategories] = useState([])
    const [playerCategories, setPlayerCategories] = useState([])
    const [filterCategory, setFilterCategory] = useState(0)
    const [filteredData, setFilteredData] = useState([])
    const { isMobile } = useContext(UserContext)
    const [width, listWidth, rowHeight, rowHeightExpanded, height, offsetY, boardSize] = useWindowSize(null, true, isMobile)
    // const { getTournamentById, getWOFPlayersList, registerWOFPlayer, removeRegisteredPlayer, registerNewPlayer, getOtbReg, startSwissTournament } = useOtbIdb()
    
    const listRef = useRef ()
    const nameRef = useRef ()


    const searchListHeight = Math.min(wofPlayers?.length * 45, height - 238)
    // started
    const getTotalHeight = () => {
        const canAdd = isTD && currentRound < 100 && ((pairingSystem !== 'Round Robin' && pairingSystem !== 'Double Round Robin') || !started) && !lasroundStarted
        if (canAdd && hasCategories && started) return Math.min(filteredData.length * 45, height - 198)
        if (canAdd && hasCategories && !started) return Math.min(filteredData.length * 45, height - 238)
        if (canAdd && !hasCategories && started) return Math.min(filteredData.length * 45, height - 158)
        if (canAdd && !hasCategories && !started) return Math.min(filteredData.length * 45, height - 198)
        if (!canAdd && hasCategories) return Math.min(filteredData.length * 45, height - 130)
        if (!canAdd && !hasCategories) return Math.min(filteredData.length * 45, height - 80)
    }

    const getOffset = () => {
        const canAdd = isTD && currentRound < 100 && ((pairingSystem !== 'Round Robin' && pairingSystem !== 'Double Round Robin') || !started) && !lasroundStarted
        if (canAdd && hasCategories) return '190px'
        if (!canAdd && hasCategories) return '130px'
        if (canAdd && !hasCategories) return '150px'
        return '80px'
    }
    
    useEffect(() => {
        // if(!isOnline) {
        //     async function getFromIdb() {
        //         const players = await getOtbReg(id)
        //         // console.log(players)
        //         setData(players)
        //         const tournament = await getTournamentById(id)
        //         const started = tournament.current_round === 0 ? false : true
        //         setStarted(started)
        //         // const lastRound = rounds //- get from otb rounds
        //         setLastRoundStarted(false) // change here
        //     }
        //     getFromIdb()
        // }

        socket.on('updated-players-list', () => {
            socket.emit('get-otb-reg', id)
        })
        socket.on('otb-players-list', (players, started, lastRound, categories) => {
            setData(players)
            setFilteredData(players)
            setCategories(categories)
            setStarted(started)
            setLastRoundStarted(lastRound)
            setIsloading(false)
            setWOFPlayers([])
            let cat = ['all']
            
            if (hasCategories) {
                for (let i = 0; i < categories.length; i++) {
                    cat = [...new Set([...cat, categories[i].category_name])]
                }
                setFilterCategories(cat)
                setFilterCategory(0)
            } else {
                setFilterCategories([])
                setFilterCategories(null)
            }
        })
        
        return () => {
            socket.off('updated-players-list')
            socket.off('otb-players-list')
            // socket.off('wof-players-list')
        }
    },[isOnline])

    useEffect (() => {
        socket.on('wof-players-list', (list) => {
            // console.log(list)
            if(!validPlayer) { 
                setWOFPlayers(list)
                setNewPlayer(true) 
            }
        })
        return (() => {
            socket.off('wof-players-list')
        })
    },[isOnline, validPlayer])

    const startTournament = async () => {
        socket.emit('start-otb', id) //
        // if(isOnline) {
        //     socket.emit('start-otb', id)
        // } else {
        //     await startSwissTournament(id)
        // }
        setTab('Rounds')
    }

    const message = (err) => {
        if (!err) return
        toast.clearWaitingQueue();
        toast.error(err, {autoClose: 1000, pauseOnFocusLoss: false, draggable: false})
    } 

    const getPlayersGames = (e) => {
        // e.preventDefault()
        socket.emit("get-rounds-by-player", id, e.target.id)
    }

    const WarningToast = (wof_id, id, name) => {
        return (
            <div className="notification-nav">
                <span>{`Are you sure you want to remove ${name} from tounament?`}</span>
                <button onClick = {()=>{
                    socket.emit('delete-player-otb', wof_id, id)
                    toast.dismiss()
                    }}>Confirm</button>
            </div>
        )
    }

    const addPlayer = async (event) => {
        if(nameRef.current.value.length === 0) {
            nameRef.current.focus()
        }
        if(event && validPlayer && wofPlayers.length === 0) {
            // await registerWOFPlayer(wofId, id)
            // if(!isOnline) {
            //     const players = await getOtbReg(id)
            //     setData(players)
            // }
            socket.emit('add-player-otb', wofId, playerCategories, getCode(team), family, id)
            setName('')
            setValidPlayer(false)
            setPlayerCategories([])
        }
        if(event && wofPlayers.length === 1 && !hasCategories && tournamentCountry != 'NL') {
            // await registerWOFPlayer(wofPlayers[0].id, id)
            // if(!isOnline) {
            //     const players = await getOtbReg(id)
            //     setData(players)
            // }
            // console.log(wofPlayers[0])
            socket.emit('add-player-otb', wofPlayers[0].id, [], wofPlayers[0].country_code, family, id)
            setWOFPlayers([])
            setNewPlayer(false)
            setName('')
            setValidPlayer(false)
        }
    }

    const removePlayer = async (event) => {
        if(event && started) {
            toast.dismiss()
            // toast.warn(WarningToast()) 
            toast.warn(WarningToast(event.target.id, id, event.target.name)) 
        } else {
            // await removeRegisteredPlayer(event.target.id, id)
            // if(!isOnline) {
            //     const players = await getOtbReg(id)
            //     setData(players)
            // }
            socket.emit('delete-player-otb', event.target.id, id)
        }
    }

    const changeName = event => {
        const value = JSON.parse(JSON.stringify(event.target.value))
        
        if ((checkTName(value) || value.length === 0) && !validPlayer) {
            // console.log
            setName(value)
            debouncedSearch(socket, value.trim())
        }
        
        const checkId = exactMatch(wofPlayers, value)
        if (checkId && wofPlayers.length === 1) {
            setWOFPlayers([])
            setValidPlayer(true)
            setWofId(checkId)
            return
        } 
        setValidPlayer(false)
        setWofId(null)        
    }

    const categoryHandler = (e) => {
        if(filterCategory === filterCategories.length - 1) {
            setFilterCategory(0)
            setFilteredData(data)
            return
        } 

        setFilterCategory(prev => prev + 1)
        const filtered = data.filter(player => 
            (player.categories.includes(filterCategories[filterCategory + 1])) || 
            filterCategories[filterCategory + 1] === 'open')
        setFilteredData(filtered)
        // if(categories[filterCategory + 1] !== 'team') {
        //     setFilteredData(filtered)
        // } else {
        //     setFilteredData(teamsStandings.current)
        // }
    }

    const debouncedSearch = useCallback(debounce(async (socket, value) => { //
        if (value.length >= 2) {
            socket.emit('get-wof-players', value, id) //
            // const list = await getWOFPlayersList(value, id)
            // setWOFPlayers(list)
            setNewPlayer(true)
            return
        }
        setWOFPlayers([])
        setValidPlayer(false)
        setNewPlayer(false)
        
    }),[])

    const RegisterForm = () => {
        const [validName, setValidName] = useState(name.trim().split(' ')[1]?.length > 0 ? true : false)
        const [validSurname, setValidSurname] = useState(true)
        const [validCountry, setValidCountry] = useState(true)
        const [validFamily, setValidFamily] = useState(true)
        const [family, setFamily] = useState(tournamentCountry === 'NL' ? name.trim().split(' ')[0] : null)
        const [country, setCountry] = useState(getName(tournamentCountry))
        const [countries, setCountries] = useState([])
        const [playerCategories, setPlayerCategories] = useState([])
        const allCountries = getNames()
        const [form, setForm] = useState({
            surname: name.trim().split(' ')[0], 
            name: name.indexOf(' ') > 0 ? name.trim().substring(name.indexOf(' '), name.length).trim() : '',
            country: tournamentCountry,
            family: tournamentCountry === 'NL' ? name.trim().split(' ')[0] : null
        })

        const changeCountry = event => {
            const value = JSON.parse(JSON.stringify(event.target.value))
            if(value.length > 2) {
                setCountries(search(value))
            } else {
                setCountries([])
            }
            if (allCountries.includes(value)) {
                setValidCountry(true)
                setCountries([])
            }
            else {setValidCountry(false)}
            if (checkTName(value) || value.length === 0) {
                setCountry(value)
                setForm(prev => ({...prev,['country']: getCode(value)}))
            }
        }
    
        const onCountryClick = e => {
            const code = getCode(countries[e.currentTarget.id])
            setCountry(countries[e.currentTarget.id])
            setForm(prev => ({...prev,['country']: code}))
            setCountries([])
            setValidCountry(true)
        }

        const changeHandler = event => {
            const name = event.target.name.toString()
            const value = JSON.parse(JSON.stringify(event.target.value))      
            
            if (name === 'f1') { // surname
                setForm(prev => ({...prev,['surname']: value}))
                value.length > 0 && checkTName(value) ? setValidSurname(true) : setValidSurname(false)
                return
            }
            if (name === 'f2') { // name
                setForm(prev => ({...prev,['name']: value}))
                value.length > 0 && checkTName(value) ? setValidName(true) : setValidName(false)
                return
            }
            if (name === 'f5') { // family
                setForm(prev => ({...prev,['family']: value}))
                setFamily(value)
                value.length > 0 && checkTName(value) ? setValidFamily(true) : setValidFamily(false)
                return
            }
        }

        const createNewPlayer = async (event) => {
            if(!validSurname) return message("Enter Player's Surname")
            if(!validName) return message("Enter Player's Name")
            if(!validCountry) return message("Choose Player's Current Federation")
            if(!validFamily) return message("Enter Player's Family")
            // await registerNewPlayer(form, id)
            // if(!isOnline) {
            //     const players = await getOtbReg(id)
            //     setData(players)
            // }
            setPlayerCategories([])
            socket.emit('register-new-wof', form, playerCategories, id)
            setRegister(false)
            setName('')
        }

        return (
            <div className="register-form">
                <div className="card-content">
                    <label className='lbl'>Surname</label>
                    <input className = {`input ${validSurname ? 'valid' : ''}`} placeholder = "Surname" name = 'f1' type = "text" autoComplete ="off" value = {form.surname} onChange = {changeHandler}/>
                    <label className='lbl'>Name</label>
                    <input className = {`input ${validName ? 'valid' : ''}`} placeholder = "Name" name = 'f2' type = "text" autoComplete ="off" value = {form.name} onChange = {changeHandler}/>
                    <label className='lbl'>Current Federation</label>
                    <input className = {`input ${validCountry ? 'valid' : ''}`} placeholder = "Current Federation" name = 'f3' type = "text" autoComplete ="off" value = {country} onChange = {changeCountry}/>
                    
                    <div className='countries-list'>
                        {countries ?                               
                            countries.map( (country, idx) => 
                                <div className = 'country-select' onClick = {onCountryClick} name = {country} key = {country} id = {idx}> 
                                    <div className="flag-container"> 
                                        <CountryFlags countryName = {country}></CountryFlags>                                        
                                    </div>
                                    <div className = 'select-text'>{country}</div>
                                </div>
                        ) : <></>}
                    </div>
                    <SwitcherCategories 
                        hasCategories={hasCategories}
                        categories = {categories}
                        playerCategories = {playerCategories} 
                        setPlayerCategories = {setPlayerCategories}
                    />

                    {tournamentCountry === 'NL' ? 
                    <>
                        <label className='lbl' style = {{display: 'block'}}>family</label>
                        <input className = {`input ${validFamily ? 'valid' : ''}`} placeholder = "Family" name = 'f5' type = "text" autoComplete ="off" value = {family} onChange = {changeHandler}/>
                    </>:<></>}
    
                    <div className = "confirm-new-player">
                        <button className = "cancel-new-player" onClick = {() => setRegister(false)}>Cancel</button>
                        <button className = "confirm-new-player" onClick = {createNewPlayer}>Confirm</button>
                    </div>
                </div>
            </div>
        )
    }

    const WOFPlayer = ({index, style}) => {
        // console.log(wofPlayers[index])
        const id = wofPlayers[index].id
        const wof_id = wofPlayers[index].wof_id
        const surname = wofPlayers[index].surname.toLowerCase() 
        const name = wofPlayers[index].name
        const rating = wofPlayers[index].rating ? wofPlayers[index].rating : '-'
        const country = wofPlayers[index].country_code
        const countryName = getName(country)
        // console.log(id, surname, name, country, countryName)

        const onWOFPlayer = e => {
            e.preventDefault()
            if(wofPlayers.length > 0) {
                setName(toCapitalized(wofPlayers[e.currentTarget.id].surname.toLowerCase()) + ' ' + wofPlayers[e.currentTarget.id].name)
                setWofId(wofPlayers[e.currentTarget.id].id)
                setTeam(countryName)
                setFamily(wofPlayers[e.currentTarget.id].surname)
            }
            setWOFPlayers([])
            setValidPlayer(true)
            setNewPlayer(false)
        }

        return (
            <div style = {style}>
                <div className = 'player-select' key = {wofPlayers[index].id} id = {index} onClick = {onWOFPlayer}>
                    <CountryFlags countryName = {countryName} countryCode = {country}></CountryFlags>
                    <div className="select-text">{surname} {name}</div>
                    <div className="select-text wof-rating" title = 'WOF Rating'>{`${rating}`}</div>
                    <div className="select-text wof-id" title = 'WOF ID'>{`${!wof_id ? ' - ' : '(' + wof_id + ')'}`}</div>
                </div>
            </div>
        )
    }

    const Row = ({index, style}) => {
        const id = filteredData[index].id
        const wof_id = filteredData[index].wof_id
        const surname = toCapitalized(filteredData[index].surname.toLowerCase())
        const name = filteredData[index].name
        const rating = filteredData[index].rating ? filteredData[index].rating : '-'
        const country = filteredData[index].country_code
        const countryName = getName(country)
        const leftRound = filteredData[index].left_after_round
        
        return (
            <div style = {style}>
                <div className = 'table-row reg' id = {index} key = {id}>
                    <div className = 'table-place'>{index + 1}</div>
                    <CountryFlags countryName = {countryName} countryCode = {country}></CountryFlags>
                    <div className={`select-text ${leftRound ? 'left' : ''}`} onClick = {getPlayersGames} id = {id}>{surname} {name}</div>                       
                    <div className="select-text wof-rating" title = 'WOF Rating'>{rating}</div>
                    {isTD && !leftRound && !lasroundStarted? <button className = 'remove-button' id = {id} name = {surname + ' ' + name} onClick = {removePlayer}>-</button> : 
                    <div className = 'remove-button'></div>}
                </div>
            </div>
        )
    }

    return (
        <div>
            {register ? 
            <RegisterForm key = 'somekey'/>
            :
            <>
                <div className = "layout new-player" style ={{'--global-height': height + 'px'}}>
                    {isTD && ((pairingSystem !== 'Round Robin' && pairingSystem !== 'Double Round Robin') || !started) && !lasroundStarted ? 
                    <div className = 'add-player'>
                        <input className = {`input wof-players ${validPlayer ? 'valid' : ''}`} placeholder = "Enter player name" name = 'f3' type = "text" autoComplete ="off"  onChange = {changeName} value = {name} ref = {nameRef}/>
                        <button 
                            className = {`add-button ${validPlayer || (name.length === 0 && data.length === 0 && !isLoading) || (wofPlayers.length === 1 && !hasCategories && tournamentCountry != 'NL')? 'valid' : ''}`} 
                            onClick = {addPlayer} 
                            style = {{fontSize: validPlayer || data.length === 0 ? '24px' : '14px'}}>
                                {validPlayer || data.length === 0 || wofPlayers.length === 1 ? '+' : data.length}
                        </button>
                    </div> : <></>}
                    {hasCategories && name?.length < 1 && data?.length > 0? 
                    <div className = 'filter-standings'>
                        <div>Filter by Category</div>
                        <button onClick = {categoryHandler} val = {filterCategory} >{filterCategories[filterCategory]}</button>
                    </div> : <></>}
                    <div className='players-list'>
                        <FixedSizeList 
                            className="list"
                            height={searchListHeight}
                            itemCount={wofPlayers.length}
                            itemSize = {45}
                            width={Math.min(width * 0.9, 500 * 0.9)}
                            ref = {listRef}
                        >
                            {WOFPlayer}
                        </FixedSizeList>
                    </div>
                    {(hasCategories || tournamentCountry === 'NL') && validPlayer? // choose category and team and family
                        <SwitcherCategories 
                            hasCategories={hasCategories}
                            categories = {categories}
                            team = {team}
                            playerCategories = {playerCategories}
                            setPlayerCategories = {setPlayerCategories}
                            setTeam = {setTeam}
                            family = {tournamentCountry === 'NL' ? family : null}
                            setFamily = {tournamentCountry === 'NL' ? setFamily : null}
                        />
                    : 
            
                    newPlayer ? 
                    <div className = "create-new-player">
                        <span>New Player?</span>
                        <button className = "create-new-player" onClick = {() => setRegister(true)}>Register New Player</button>
                    </div>
                    : <></>}
                </div> 
                
                {name.length === 0 && wofPlayers.length === 0 ? 
                <div className = 'table-container' style = {{'--offset': getOffset()}}>
                    <FixedSizeList 
                        className="list"
                        height={getTotalHeight()}
                        itemCount={filteredData.length}
                        itemSize = {45}
                        width={Math.min(width * 0.98, 500 * 0.98)}
                        ref = {listRef}
                    >
                        {Row}
                    </FixedSizeList>              
                </div>
                : <></>}             
                {!isTD || data.length <= 1 || started ? <></> : <button className = "btn-new-tournament" onClick = {startTournament}>Start Tournament</button>} 
            </>}
        </div>
        
    )
}

//style = {{'--offset': `${isTD && currentRound < 100 && ((pairingSystem !== 'Round Robin' && pairingSystem !== 'Double Round Robin') || !started)? '150px' : '80px'}`}}
