import React, {useState, useEffect, useRef, useContext} from 'react'
import { checkTName } from '../functions/functions'
import { getCode, getNames, getName, search } from 'country-list';
import { useNavigate } from 'react-router-dom'
import { AuthContext } from '../../context/AuthContext'
import { UserContext } from '../../context/UserContext'
import { NavBar } from '../elements/navbar/NavBar'
import { DropDown } from '../elements/DropDown'
import { ScrollDownSVG } from '../elements/SVG'
import { Switcher } from '../elements/Switcher'
import { toast } from 'react-toastify';
import { useWindowSize } from '../../hooks/resize.hook'
// import { useOtbIdb } from '../../hooks/idb.otb.hook'
import { CountryFlags } from '../elements/CountryFlags';
import { ModalLoading } from '../elements/ModalLoading';
import './otb.css'



export const CreateOTB = () => {
    const {token, userId, login, logout, isAuthenticated, socket} = useContext(AuthContext)
    const {isOnline} = useContext (UserContext)
    // const [width, listWidth, rowHeight, rowHeightExpanded, height, offsetY, boardSize] = useWindowSize(listRef, false)
    // const [btnLabel, setBtnLabel] = useState('Create Tournament')
    const [focus, setFocus] = useState (false)
    const [settings, setSettings] = useState({system: 'Swiss System', liveOthello: true, private: false, finals: false, xot: false, withCategories: false, sameCountry: true})
    const [isDisabled, setIsDisabled] = useState(true)
    const [validName, setValidName] = useState(false)
    const [validCountry, setValidCountry] = useState(false)
    const [validCity, setValidCity] = useState(false)
    const [validRounds, setValidRounds] = useState(false)
    const [validStartDate, setValidStartDate] = useState(false)
    const [validEndDate, setValidEndDate] = useState(false)
    const [rounds, setRounds] = useState('')
    const [coef, setCoef] = useState('')
    const [country, setCountry] = useState('')
    const [countries, setCountries] = useState([])
    const [authorized, setAuthorized] = useState (false)
    const [systemFlag, setSystemFlag] = useState (false)
    const [typeFlag, setTypeFlag] = useState (false)
    const [tournamentSystem, setTournamentSystem] = useState ("Swiss System")
    const [tournamentType, setTournamentType] = useState ('')
    const [isLoading, setIsLoading] = useState(true)
    const [showScroll, setShowScroll] = useState(false)
    const roundsRef = useRef (null)
    const startDateRef = useRef()
    const endDateRef = useRef()
    const scrollRef = useRef()

    const [width, listWidth, rowHeight, rowHeightExpanded, height, offsetY, boardSize] = useWindowSize(null, true, false)
     
    // const { updateWOFPlayers, addTournament, getTournaments } = useOtbIdb()
    
    const history = useNavigate()

    const forbidLetters = ['e', 'E', '+', '-', '.']
    const allCountries = getNames()
    const systemOptions = ["Swiss System", "Dutch System", "Round Robin", "Double Round Robin"]
    const typeOptions = ["LOC", "INT", "CI", "CIC", "GM", "GPE", "GPI", "GPIINT", "MSO", "RETRO", "WOC", "NC"]
    const defaultCategories = ["junior", "female", "senior"] 

    const message = (err) => {
        if (!err) return
        toast.clearWaitingQueue();
        toast.error(err, {autoClose: 1000, pauseOnFocusLoss: false, draggable: false})
    }  

    const checkLetters = e => {
        if (e.key === 'Enter') roundsRef.current.blur()
        forbidLetters.includes(e.key) && e.preventDefault()
    }

    const changeRounds = event => {
        const value = event.target.value
        let format = /^[0-9]+$/
        if ((value.length <= 2 && format.test(value) && parseInt(value) > 0  && !isNaN(parseInt(value))) || value.length === 0 ) {
            setRounds(value)
            if(value.length > 0) {
                setValidRounds(true)
            } else {setValidRounds(false)}
            setSettings(prev => ({...prev,['rounds']: parseInt(value)}))
        }
    }

    const changeCoef = (event) => {
        const value = event.target.value
        let format = /^[0-9]+$/
        if ((value.length <= 2 && format.test(value) && parseInt(value) >= 0  && !isNaN(parseInt(value))) || value.length === 0 ) {
            setCoef(value)
            setSettings(prev => ({...prev,['mbq_coef']: parseInt(value)}))
        }
    }

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
            if (value === 'Italy') {
                setTournamentType('LOC')
                setSettings(prev => ({...prev,['country']: getCode(value), ['type']: 'LOC'}))
            } else {
                setTournamentType('')
                setSettings(prev => ({...prev,['country']: getCode(value), ['type']: 'NULL'}))
            }
        }
    }

    const onCountryClick = e => {
        const code = getCode(countries[e.currentTarget.id])
        setCountry(countries[e.currentTarget.id])
        setCountries([])
        setValidCountry(true)
        if (countries[e.currentTarget.id] === 'Italy') {
            setTournamentType('LOC')
            setSettings(prev => ({...prev,['country']: code, ['type']: 'LOC'}))
        } else {
            setTournamentType('')
            setSettings(prev => ({...prev,['country']: code, ['type']: 'NULL'}))
        }
    }

    const changeHandler = event => {
        const name = event.target.name.toString()
        const value = JSON.parse(JSON.stringify(event.target.value))      
        
        if (name === socket.id.substring(1,3)) { // name
            setSettings(prev => ({...prev,['name']: value}))
            value.length > 2 && checkTName(value) ? setValidName(true) : setValidName(false)
            return
        }
        if (name === socket.id.substring(1,4)) { // city
            setSettings(prev => ({...prev,['city']: value}))
            value.length > 2 && checkTName(value)? setValidCity(true) : setValidCity(false)
            return
        }
    }

    const createTournament = () => {
        if (!validName) return message('Invalid name of the tournament')
        if (!validCountry) return message('Invalid country')
        if (!validCity) return message('Invalid city')
        if (!validRounds && tournamentSystem !== "Round Robin" && tournamentSystem !== "Double Round Robin") return message('Invalid number of rounds')
        if (!validStartDate) return message('Invalid start date')
        if (!validEndDate) return message('Invalid end date')
        if (settings.withCategories && (settings.categories?.length === 0 || !settings.categories)) return message('Add categories or disable them')
        socket.emit('create-otb-tournament', settings)
        // console.log(settings)
        setIsDisabled(true)
    }

    const changeStartDateHandler = (event) => {
        const value = JSON.parse(JSON.stringify(event.target.value)) // get midnight of entered date at UTC
        const offset = new Date().getTimezoneOffset()
        const sDate = new Date(value)
        const date = new Date(sDate.getTime() + (offset*60*1000) + 9*60*60*1000)
        const minDate = new Date()
        const maxDate = new Date()
        const end = new Date(endDateRef.current.value)
        minDate.setHours(0,0,0)
        maxDate.setDate(maxDate.getDate() + 771)
        if(date >= minDate && date < maxDate) { 
            setSettings(prev => ({...prev,['startDate']: date}))
            setValidStartDate(true)
            date <= end ? setValidEndDate(true) : setValidEndDate(false)
        } else {
            setSettings(prev => ({...prev,['startDate']: null}))
            setValidStartDate(false)
        }
    }

    const changeEndDateHandler = (event) => {
        const value = JSON.parse(JSON.stringify(event.target.value)) 
        const offset = new Date().getTimezoneOffset()
        const sDate = new Date(value)
        const date = new Date(sDate.getTime() + (offset*60*1000) + 18*60*60*1000)
        const minDate = new Date()
        const maxDate = new Date()
        const start = new Date(startDateRef.current.value)
        minDate.setDate(minDate.getDate() - 1)
        maxDate.setDate(maxDate.getDate() + 775)
        if(date >= minDate && date < maxDate) { 
            setSettings(prev => ({...prev,['endDate']: date}))
            date >= start ? setValidEndDate(true) : setValidEndDate(false)
        } else {
            setSettings(prev => ({...prev,['endDate']: null}))
            setValidEndDate(false)
        }
    }

    const scrollToBottom = () => {
        if(scrollRef.current) {
            scrollRef.current.scrollTo({ top: scrollRef.current.scrollHeight, left: 0, behavior: "smooth" })
        }
    }

    useEffect(() => {
        // console.log('isOnline', isOnline, socket)
        // if (!isOnline) {
        //     async function getFromIdb() {
        //         const tournaments = await getTournaments()
        //         // console.log(tournaments)
        //         setTournamentsList(tournaments)
        //     }
        //     getFromIdb()
        // }
        socket.on('otb-tournament-created', (id) => {
            history(`/live/${id}`)
        })

        socket.emit('otb-authorized')
        socket.on('is-authorized', (isTd, country) => {
            if(!isTd) history('/live')
            setAuthorized(isTd)
            if(country) {
                setCountry(getName(country))
                setValidCountry(true)
                setSettings(prev => ({...prev, ['country']: country}))
            }
            if(country === 'IT') {
                setTournamentType('LOC')
                setTournamentSystem('Dutch System')
                setSettings(prev => ({...prev, ['type']: 'LOC', system: 'Dutch System'}))
            }
            setIsDisabled(false)
            setIsLoading(false)
        })

        return () => {
            socket.off('otb-tournament-created')
            socket.off('is-authorized')
        }
    }, []) //isOnline

    useEffect(() => {
        setShowScroll(scrollRef.current?.scrollHeight > scrollRef.current?.clientHeight)
    }, [height])
//style = {{'--global-width': width + 'px'}}
    return (
        <div > 
            <NavBar isHome = {false} text = 'Live Events'></NavBar> 
            {isLoading && isOnline? <ModalLoading/> : <></>}          
            <div className = "layout-new-tournament" ref = {scrollRef}>
                <div className='card-title'> 
                    <span>New Tournament</span>
                </div>
                <div className="card-content">
                    <input hidden = {true} autoComplete='false'></input>
                    <label className='lbl'>Name</label>
                    <input className = {`input ${validName ? 'valid' : ''}`} placeholder = "Enter tournament name" name = {socket.id.substring(1,3)} type = "text" autoComplete ="new-password"  onChange = {changeHandler} onFocus = {() => {setFocus(true)}} onBlur = {() => {setFocus(false)}}/>
                    <div className='dates-container'>
                        <label className='lbl'>Start Date</label>
                        <label className='lbl'>End Date</label>
                    </div>
                    <div className='dates-container'> 
                        <input className = {`input date ${validStartDate ? 'valid' : ''}`} placeholder = 'Enter start date' type = "date" ref = {startDateRef}  onChange = {changeStartDateHandler} ></input> 
                        <input className = {`input date ${validEndDate ? 'valid' : ''}`} placeholder = 'Enter end date' type = "date" ref = {endDateRef}  onChange = {changeEndDateHandler} ></input>
                    </div>

                    <label className='lbl'>Pairing System</label>
                    <input className = {`tournament-type`} onClick = {() => setSystemFlag(prev => !prev)} value = {tournamentSystem} readOnly = {true}></input>
                    {systemFlag ? <DropDown options = {systemOptions} setValue = {setTournamentSystem} setFlag = {setSystemFlag} setSettings = {setSettings} fieldName = 'system'/> : <></>}
                    <label className='lbl'>Country</label>
                    <input className = {`input ${validCountry ? 'valid' : ''}`} placeholder = "Enter country" type = "text" autoComplete ="new-password"  onChange = {changeCountry} value = {country} onFocus = {() => {setFocus(true)}} onBlur = {() => {setFocus(false)}}/>
                    <div className='countries-list'>
                        {countries ?                               
                            countries.map( (country, idx) => 
                            <div className = 'country-select' onClick = {onCountryClick} name = {country} key = {country} id = {idx}> 
                                <div className="flag-container">
                                    <CountryFlags countryName = {country}></CountryFlags> 
                                </div>
                                <div className = 'select-text' style = {{maxWidth: "100%"}}>{country}</div>
                            </div>  
                        ) : <></>}
                    </div>
                    {country === 'Italy' ?
                        <>
                        <label className='lbl'>Tournament Type</label>
                        <input className = {`tournament-type`} onClick = {() => setTypeFlag(prev => !prev)} value = {tournamentType} readOnly = {true}></input>
                        {typeFlag ? <DropDown options = {typeOptions} setValue = {setTournamentType} setFlag = {setTypeFlag} setSettings = {setSettings} fieldName = 'type'/> : <></>}
                        </> : <></>
                    }
                    <label className='lbl'>City</label>
                    <input className = {`input ${validCity ? 'valid' : ''}`} placeholder = "Enter city" name = {socket.id.substring(1,4)} type = "text" autoComplete ="new-password"  onChange = {changeHandler} onFocus = {() => {setFocus(true)}} onBlur = {() => {setFocus(false)}}/>
                    {tournamentSystem === "Round Robin" || tournamentSystem === "Double Round Robin" ? <></> :
                    <>
                        <label className='lbl'>Total Rounds</label>
                        <input className = {`input ${validRounds ? 'valid' : ''}`} ref = {roundsRef} placeholder = "Enter number of rounds" name = 'rounds' type = "number" value = {rounds} max = "99" onKeyDown = {checkLetters} autoComplete ="off" onChange = {changeRounds} onFocus = {() => {setFocus(true)}} onBlur = {() => {setFocus(false)}} />
                    </>
                    }
                    <label className='lbl'>Coefficient for MBQ</label>
                    <input className = {`input valid`} placeholder = "Auto" type = "number" autoComplete ="new-password"  onChange = {changeCoef} value = {coef} onFocus = {() => {setFocus(true)}} onBlur = {() => {setFocus(false)}}/>
                    <Switcher flagLO = {settings.liveOthello} flagTest = {settings.private}  flagFinals = {settings.finals} flagCategories = {settings.withCategories} flagXOT = {settings.xot} setSettings = {setSettings} defaultCategories = {defaultCategories} flagCountry = {settings.sameCountry}/>
                </div>
            </div>
            
            {showScroll ?
                <ScrollDownSVG onClick = {scrollToBottom}/> : <></>}
            {authorized ? <button className = "btn-new-tournament"  disabled = {isDisabled} onClick = {createTournament}>Create Tournament</button> : <></>} 
        </div>
    )
}

export default CreateOTB
