import React, {useState, useEffect, useRef} from 'react'
import { checkTName } from '../functions/functions'
import { getCode, getNames, getName } from 'country-list';
import { DropDown } from '../elements/DropDown'
import { toast } from 'react-toastify';
import { getFullRoundName } from '../functions/functions'
import { Switcher } from '../elements/SwitcherChangeSettings';
import { CountryFlags } from '../elements/CountryFlags';

export const SettingsOTB = ({id, socket, isTD, setTName, round, setRound}) => {
    const [btnLabel, setBtnLabel] = useState('Change Settings')
    const [validName, setValidName] = useState(false)
    const [tournamentName, setTournamentName] = useState('')
    const [validCountry, setValidCountry] = useState(false)
    const [validCity, setValidCity] = useState(false)
    const [city, setCity] = useState('')
    const [validRounds, setValidRounds] = useState(false)
    const [currentRound, setCurrentRound] = useState()
    const [rounds, setRounds] = useState('')
    const [country, setCountry] = useState('')
    const [countries, setCountries] = useState([])
    const [newStartDate, setNewStartDate] = useState('')
    const [newEndDate, setNewEndDate] = useState('')
    const [startDate, setStartDate] = useState('')
    const [endDate, setEndDate] = useState('')
    const [validStartDate, setValidStartDate] = useState(false)
    const [validEndDate, setValidEndDate] = useState(false)
    const [flag, setFlag] = useState(false)
    const [systemFlag, setSystemFlag] = useState (false)
    const [finished, setFinished] = useState (false)
    const [started, setStarted] = useState (false)
    const [tournamentSystem, setTournamentSystem] = useState ('')
    const [roundsArr, setRoundsArr] = useState([])
    const [withFinals, setWithFinals] = useState(false)
    const roundsRef = useRef (null)

    const startDateRef = useRef()
    const endDateRef = useRef()

    const forbidLetters = ['e', 'E', '+', '-', '.']
    const allCountries = getNames()
    const systemOptions = ["Swiss System", "Dutch System", "Round Robin", "Double Round Robin"]

    useEffect(() => {
        socket.emit('get-otb-info', id)
        socket.on('otb-info', form => {
            // console.log(form, form.finals)
            setCountry(getName(form.country_code))
            setRounds(form.rounds)
            setTournamentName(form.name)
            setCity(form.city)
            const startDateRaw = form.start_date ? new Date(form.start_date) : new Date(form.expected_start)
            const endDateRaw = form.end_date ? new Date(form.end_date) : new Date(form.expected_end)
            setNewStartDate(startDateRaw)
            setNewEndDate(endDateRaw)
            startDateRef.current = startDateRaw 
            endDateRef.current = endDateRaw
            const offset = new Date().getTimezoneOffset()
            const sDate = new Date(startDateRaw.getTime() - (offset*60*1000)).toISOString().split('T')[0]
            const eDate = new Date(endDateRaw.getTime() - (offset*60*1000)).toISOString().split('T')[0]
            setStartDate(sDate)
            setEndDate(eDate)
            setCurrentRound(form.current_round)
            setTournamentSystem(form.pairing_system)
            setValidCity(true)
            setValidCountry(true)
            setValidName(true)
            setValidRounds(true)
            setValidStartDate(true)
            setValidEndDate(true)
            setFinished(form.end_date ? true : false)
            setStarted(form.start_date ? true : false)
            setRoundsArr(form.roundNames)
            setWithFinals(form.finals ? true : false)
        })
        return () => {
            socket.off('otb-info')
        }
    }, [])

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
        if ((value.length <= 2 && format.test(value) && parseInt(value) > 0  && !isNaN(parseInt(value)) && value >= currentRound) || value.length === 0 ) {
            setRounds(value)
            if(value.length > 0) {
                setValidRounds(true)
            } else {setValidRounds(false)}
        }
    }

    const changeCountry = event => {
        const value = JSON.parse(JSON.stringify(event.target.value))
        if(value.length > 2) {
            setCountries([...allCountries.filter(country => country.toLowerCase().includes(value.toLowerCase()))])
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
        }
    }

    const onCountryClick = e => {
        setCountry(countries[e.currentTarget.id])
        setCountries([])
        setValidCountry(true)
    }

    const changeHandler = event => {
        const name = event.target.name.toString()
        const value = JSON.parse(JSON.stringify(event.target.value))      
        
        if (name === 'f1') { // name
            setTournamentName(value)
            value.length > 2 && checkTName(value) ? setValidName(true) : setValidName(false)
            return
        }
        if (name === 'f4') { // city
            setCity(value)
            value.length > 2 && checkTName(value)? setValidCity(true) : setValidCity(false)
            return
        }
    }

    const changeStartDateHandler = (event) => {
        const value = JSON.parse(JSON.stringify(event.target.value)) 
        // console.log('settings start input', event.target.value)
        const offset = new Date().getTimezoneOffset()
        const sDate = new Date(value)
        const date = new Date(sDate.getTime() + (offset*60*1000) + 9*60*60*1000)
        // console.log('start date', date)
        // console.log('start date UTC', date.toISOString())
        const minDate = new Date()
        const maxDate = new Date()
        const end = new Date(new Date(endDate).getTime() + (offset*60*1000) + 18*60*60*1000)
        // console.log('end Date', end)
        minDate.setHours(0,0,0)
        // console.log('start minDate UTC', minDate.toISOString())
        // console.log('start minDate', minDate)
        maxDate.setDate(maxDate.getDate() + 771)
        const newDate = new Date(date.getTime() - (offset*60*1000)).toISOString().split('T')[0]
        setStartDate(newDate)
        if(date >= minDate && date < maxDate) {     
            setValidStartDate(true)
            setNewStartDate(date)
            date <= end ? setValidEndDate(true) : setValidEndDate(false)
        } else {
            setValidStartDate(false)
        }
    }

    const changeEndDateHandler = (event) => {
        const value = JSON.parse(JSON.stringify(event.target.value)) 
        // console.log('end input', event.target.value)
        const offset = new Date().getTimezoneOffset()
        const sDate = new Date(value)
        const date = new Date(sDate.getTime() + (offset*60*1000) + 18*60*60*1000)
        // console.log('end date Local', date)
        // console.log('end date UTC', date.toISOString())
        const minDate = new Date()
        const maxDate = new Date()
        const start = new Date(new Date(startDate).getTime() + (offset*60*1000) + 9*60*60*1000)
        // console.log('start', start)
        minDate.setDate(minDate.getDate() - 1)
        maxDate.setDate(maxDate.getDate() + 775)
        const eDate = new Date(date.getTime() - (offset*60*1000)).toISOString().split('T')[0]
        setEndDate(eDate)
        if(date >= minDate && date < maxDate) { 
            setNewEndDate(date)           
            date >= start ? setValidEndDate(true) : setValidEndDate(false)
        } else {
            setValidEndDate(false)
        }
    }

    const changeTournamentHandler = (event) => {
        if(event) {
            setBtnLabel(prev => {
                if (prev === 'Change Settings') {
                    setFlag(false)
                    return 'Confirm Changes'
                }  
                return changeSettings(prev)
                // return 'Change Settings'
            })
            return
        }
        setBtnLabel('Change Settings')  
    }

    const changeSettings = () => {
        if (!validName) message('Invalid name of the tournament')
        if (!validCountry) message('Invalid country')
        if (!validCity) message('Invalid city')
        if (!validRounds) message('Invalid number of rounds')
        if (!validStartDate || !validEndDate) message('Invalid dates')
        if (!validName || !validCountry || !validCity || !validRounds || !validStartDate || !validEndDate) return 'Confirm Changes'
                    
        setFlag(true)
        startDateRef.current = newStartDate
        endDateRef.current = newEndDate
        if (!started && (tournamentSystem === 'Round Robin' || tournamentSystem === 'Double Round Robin')) setRounds(0)
        socket.emit('change-otb-tournament', id, {name: tournamentName, rounds: rounds, country: getCode(country), city: city, startDate: newStartDate, endDate: newEndDate, system: tournamentSystem, finals: withFinals}) 
        return 'Change Settings'
    }

    const deleteLastRound = () => {
        toast.dismiss()
        socket.emit('delete-last-round', id)
        const lastRound = roundsArr.length > 1 ? roundsArr[roundsArr.length - 2]?.round : 0
        setCurrentRound(lastRound)
        setRoundsArr(prev => prev.slice(0,prev.length - 1))
        setRound(prev => prev > 0 ? lastRound : 0)
    }

    useEffect(()=> {
        if(round < 1) {
            setStarted(false)
        }
    },[round])

    useEffect(()=> {
        if(tournamentSystem !== 'Round Robin' && tournamentSystem !== 'Double Round Robin' && rounds === 0) setValidRounds(false)
    },[tournamentSystem, rounds])

    const downloadFile = async (e) => {

        const response = await fetch(`/api/papp`, {
            method: 'post', 
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({id: id, sid: socket.id})
        })
        const blob = await response.blob(); // Get the response as a Blob
        const url = window.URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = tournamentName+'.zip'; // Specify the filename
        document.body.appendChild(a);
        a.click();
        a.remove();
        
        window.URL.revokeObjectURL(url); // Cleanup
    }

    const WarningToast = (roundsArr, currentRound) => {
        return (
            <div className="notification-nav">
                <span>{`Are you sure you want to delete pairing for ${getFullRoundName(roundsArr, roundsArr[roundsArr.length - 1].round)}? All entered results will be lost`}</span>
                <button onClick = {deleteLastRound}>Confirm</button>
            </div>
        )
    }

    const deleteRound = (event) => {
        if(event && started && !finished) {
            toast.dismiss()
            toast.warn(WarningToast(roundsArr, currentRound)) 
        }
    }

    useEffect(() => {
        if(!flag) return
        setTName(tournamentName)
    },[flag])

    return (
        <div > 
            <div className = "layout-new-tournament" style ={{marginTop: '75px'}}>
                <div className="card-content">
                    <input hidden = {true} autoComplete='false'></input>
                    <label className='lbl'>Name</label>
                    <input className = {`input ${btnLabel === 'Change Settings' ? 'inactive' : validName ? 'valid' : ''}`} disabled = {btnLabel === 'Change Settings' || !isTD || finished} placeholder = "Enter tournament name" name = 'f1' type = "text" autoComplete ="new-password"  onChange = {changeHandler} value = {tournamentName}/>
                    <div className='dates-container'>
                        <label className='lbl'>Start Date</label>
                        <label className='lbl'>End Date</label>
                    </div>

                    <div className='dates-container'> 
                        <input className = {`input date ${btnLabel === 'Change Settings' ? 'inactive' : validStartDate ? 'valid' : ''}`} type = "date"  value = {startDate} disabled = {btnLabel === 'Change Settings' || started || !isTD || finished} onChange = {changeStartDateHandler}></input> 
                        <input className = {`input date ${btnLabel === 'Change Settings' ? 'inactive' : validEndDate ? 'valid' : ''}`} type = "date"  value = {endDate} disabled = {(btnLabel === 'Change Settings') || !isTD || finished} onChange = {changeEndDateHandler}></input>
                    </div>
                    
                    <label className='lbl'>Pairing System</label>
                    <input className = {`tournament-type`} name = 'f2' onClick = {() => setSystemFlag(prev => !prev)} value = {tournamentSystem} readOnly = {true} disabled = {btnLabel === 'Change Settings' || !isTD || finished || started}/>
                    {systemFlag ? <DropDown options = {systemOptions} setValue = {setTournamentSystem} setFlag = {setSystemFlag} fieldName = 'system' setValidRounds = {setValidRounds}/> : <></>}
                    <label className='lbl'>Country</label>
                    <input className = {`input ${btnLabel === 'Change Settings' ? 'inactive' : validCountry ? 'valid' : ''}`} disabled = {btnLabel === 'Change Settings'} placeholder = "Enter country" name = 'f3' type = "text" autoComplete ="new-password" onChange = {changeCountry} value = {country}/>
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
                    <label className='lbl'>City</label>
                    <input className = {`input ${btnLabel === 'Change Settings' ? 'inactive' : validCity ? 'valid' : ''}`} disabled = {btnLabel === 'Change Settings'} placeholder = "Enter city" name = 'f4' type = "text" autoComplete ="new-password"  onChange = {changeHandler} value = {city} />
                    
                    {started || (tournamentSystem !== 'Round Robin' && tournamentSystem !== 'Double Round Robin') ? 
                        <>
                        <label className='lbl'>Total Rounds</label>
                        <input 
                            className = {`input ${btnLabel === 'Change Settings' || tournamentSystem === 'Round Robin' || tournamentSystem === 'Double Round Robin' ? 'inactive' : validRounds ? 'valid' : ''}`} 
                            disabled = {btnLabel === 'Change Settings' || tournamentSystem === 'Round Robin' || tournamentSystem === 'Double Round Robin'} 
                            ref = {roundsRef} 
                            placeholder = "Enter number of rounds" 
                            name = 'rounds' 
                            type = "number" 
                            value = {rounds} 
                            max = "99" 
                            onKeyDown = {checkLetters} 
                            autoComplete ="off" 
                            onChange = {changeRounds}/>
                        </> : <></>}
                    <Switcher flagFinals = {withFinals} setFinals = {setWithFinals} allowedToChange = {currentRound < 100 && btnLabel !== 'Change Settings'} />

                    {isTD && started? 
                    <div style = {{display: 'flex', justifyContent: 'space-around', width: '100%'}}>
                        {!finished ? <button className = 'delete-last-round' onClick = {deleteRound} >Delete Last Round</button> : <></>}
                        
                        <button className = 'download-papp' onClick = {downloadFile} >PAPP Back-Up</button>
                    </div> : <></>}
                </div>
            </div>
            {isTD && !finished? <button className = "btn-new-tournament" onClick = {changeTournamentHandler}>{btnLabel}</button> : <></>}
        </div>
    )
}

export default SettingsOTB

//href = {'/otb_papp_files/'+ id +'/' + pappFileName} download = {pappFileName}
//()=> {linkRef.current.click()}