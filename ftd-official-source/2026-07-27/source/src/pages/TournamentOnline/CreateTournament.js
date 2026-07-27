import React, {useState, useEffect, useRef, useContext} from 'react'
import { checkTName } from '../functions/functions'
import { useNavigate } from 'react-router-dom'
import { AuthContext } from '../../context/AuthContext'
import { UserContext } from '../../context/UserContext'
import { NavBar } from '../elements/navbar/NavBar'
import { DropDownInput } from '../elements/DropDownStyled'
import { ScrollDownSVG } from '../elements/SVG'
import { SwitcherOnlineTournaments } from '../elements/SwitcherOnlineTournaments'
import { toast } from 'react-toastify';
import { useWindowSize } from '../../hooks/resize.hook'
import { ModalLoading } from '../elements/ModalLoading';
import './tournament.css'
import '../elements/dropdown.css'

export const CreateOTB = () => {
    const {token, userId, login, logout, isAuthenticated, socket} = useContext(AuthContext)
    const {isOnline} = useContext (UserContext)
    const [focus, setFocus] = useState (false)
    const [settings, setSettings] = useState({
        system: 'Swiss System', 
        private: false, 
        finals: false, 
        xot: false, 
        withCategories: false, 
        timeControl: 5, 
        increment: 0,
        lateReg: 0,
        breakDuration: 60,
        verifiedOnly: false,
        minRating: null,
        maxRating: null
    })
    const [isDisabled, setIsDisabled] = useState(true)
    const [validName, setValidName] = useState(false)
    const [validRounds, setValidRounds] = useState(false)
    const [validStartDate, setValidStartDate] = useState(false)
    const [rounds, setRounds] = useState('')
    const [authorized, setAuthorized] = useState (false)
    const [tournamentSystem, setTournamentSystem] = useState ("Swiss System")
    const [timeControl, setTimeControl] = useState(5)
    const [increment, setIncrement] = useState(0)
    const [lateReg, setLateReg] = useState(0)
    const [breakDuration, setBreakDuration] = useState(60)
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
    const minTimeDifference = 15 * 60000
    const systemOptions = ["Swiss System", "Dutch System", "Round Robin", "Double Round Robin"]
    const defaultCategories = ["junior", "female", "senior"] 
    const timeControlOptions = {1: [0, 1], 3: [0, 1, 2], 5: [0, 3, 5], 10: [0, 5, 10], 15: [0, 5, 10, 15], 20: [0, 10, 20, 30]}
    const breakDurationOptions = [15, 30, 45, 60, 90, 120, 180, 300]
    
    // Generate late registration options based on rounds (0 to rounds-1, or just 0 for RR)
    const isRoundRobin = tournamentSystem === "Round Robin" || tournamentSystem === "Double Round Robin"
    const lateRegOptions = isRoundRobin ? [0] : Array.from({length: Math.max(1, parseInt(rounds) || 1)}, (_, i) => i)

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
            // Reset late registration if it exceeds new rounds value
            if (lateReg >= parseInt(value)) {
                setLateReg(0)
                setSettings(prev => ({...prev, lateReg: 0}))
            }
        }
    }

    const changeHandler = event => {
        const name = event.target.name.toString()
        const value = JSON.parse(JSON.stringify(event.target.value))      
        
        if (name === 'tournament-name') { // name
            setSettings(prev => ({...prev,['name']: value}))
            value.length > 2 && checkTName(value) ? setValidName(true) : setValidName(false)
            return
        }
    }

    // Dropdown change handlers
    const handleSystemChange = (value) => {
        setTournamentSystem(value)
        setSettings(prev => ({...prev, system: value}))
        // Reset late registration for Round Robin
        if (value === "Round Robin" || value === "Double Round Robin") {
            setLateReg(0)
            setSettings(prev => ({...prev, lateReg: 0}))
        }
    }

    const handleTimeControlChange = (value) => {
        const tc = parseInt(value)
        setTimeControl(tc)
        setSettings(prev => ({...prev, timeControl: tc}))
        // Reset increment if not available for new time control
        const availableIncrements = timeControlOptions[tc] || [0]
        if (!availableIncrements.includes(increment)) {
            setIncrement(0)
            setSettings(prev => ({...prev, increment: 0}))
        }
    }

    const handleIncrementChange = (value) => {
        const inc = parseInt(value)
        setIncrement(inc)
        setSettings(prev => ({...prev, increment: inc}))
    }

    const handleLateRegChange = (value) => {
        const lr = parseInt(value)
        setLateReg(lr)
        setSettings(prev => ({...prev, lateReg: lr}))
    }

    const handleBreakDurationChange = (value) => {
        const bd = parseInt(value)
        setBreakDuration(bd)
        setSettings(prev => ({...prev, breakDuration: bd}))
    }

    const handleMinRatingChange = (event) => {
        const value = event.target.value
        if (value === '' || (parseInt(value) >= 0 && parseInt(value) <= 3000)) {
            setSettings(prev => ({...prev, minRating: value === '' ? null : parseInt(value)}))
        }
    }

    const handleMaxRatingChange = (event) => {
        const value = event.target.value
        if (value === '' || (parseInt(value) >= 0 && parseInt(value) <= 3000)) {
            setSettings(prev => ({...prev, maxRating: value === '' ? null : parseInt(value)}))
        }
    }

    const createTournament = () => {
        if (!validName) return message('Invalid name of the tournament')
        if (!validRounds && tournamentSystem !== "Round Robin" && tournamentSystem !== "Double Round Robin") return message('Invalid number of rounds')
        if (!validStartDate) return message('Invalid start date')
        if (settings.withCategories && (settings.categories?.length === 0 || !settings.categories)) return message('Add categories or disable them')
        socket.emit('create-online-tournament', settings)
        console.log(settings)
        setIsDisabled(true)
    }

    const changeStartDateHandler = (event) => {
        const value = JSON.parse(JSON.stringify(event.target.value)) // get midnight of entered date at UTC
        const sDate = new Date(value)
        let minDate = new Date()
        const maxDate = new Date()
        minDate = new Date(minDate.getTime() + minTimeDifference);
        maxDate.setDate(maxDate.getDate() + 771)
        console.log('minDate:', minDate)
        console.log('date:', sDate)
        if(sDate >= minDate && sDate < maxDate) { 
            setSettings(prev => ({...prev,['startDate']: sDate}))
            setValidStartDate(true)
        } else {
            setSettings(prev => ({...prev,['startDate']: null}))
            setValidStartDate(false)
        }
    }

    const scrollToBottom = () => {
        if(scrollRef.current) {
            scrollRef.current.scrollTo({ top: scrollRef.current.scrollHeight, left: 0, behavior: "smooth" })
        }
    }

    useEffect(() => {
        socket.on('online-tournament-created', (id) => {
            history(`/tournaments/${id}`)
        })

        socket.emit('online-authorized')
        socket.on('online-authorized', (isTd) => {
            if(!isTd) history('/tournaments')
            setAuthorized(isTd)
            setIsDisabled(false)
            setIsLoading(false)
        })

        // Set default start date to now + 15 minutes
        if (startDateRef.current) {
            const now = new Date()
            now.setMinutes(now.getMinutes() + 15)
            const offset = now.getTimezoneOffset()
            const local = new Date(now.getTime() - offset * 60000)
            startDateRef.current.value = local.toISOString().slice(0, 16)
            setSettings(prev => ({...prev, startDate: now}))
            setValidStartDate(true)
        }

        return () => {
            socket.off('online-tournament-created')
            socket.off('online-authorized')
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
                    <input className = {`input ${validName ? 'valid' : ''}`} placeholder = "Enter tournament name" name = 'tournament-name' type = "text" autoComplete ="new-password"  onChange = {changeHandler} onFocus = {() => {setFocus(true)}} onBlur = {() => {setFocus(false)}}/>
                    <label className='lbl'>Start Date and Time</label>
                    <input className = {`input ${validStartDate ? 'valid' : ''}`} placeholder = 'Enter start date and time' type = "datetime-local" ref = {startDateRef}  onChange = {changeStartDateHandler} ></input> 

                    <label className='lbl'>Pairing System</label>
                    <DropDownInput 
                        options={systemOptions} 
                        value={tournamentSystem} 
                        onChange={handleSystemChange}
                    />
                    
                    <div className='dates-container'>
                        <label className='lbl'>Time control</label>
                        <label className='lbl'>Time increment</label>
                    </div>
                    <div className='dropdown-inline'>
                        <DropDownInput 
                            options={Object.keys(timeControlOptions)} 
                            value={timeControl} 
                            onChange={handleTimeControlChange}
                            formatOption={(opt) => `${opt} min`}
                        />
                        <DropDownInput 
                            options={timeControlOptions[timeControl] || [0]} 
                            value={increment} 
                            onChange={handleIncrementChange}
                            formatOption={(opt) => `${opt} sec`}
                        />
                    </div>

                    
                    {tournamentSystem === "Round Robin" || tournamentSystem === "Double Round Robin" ? <></> :
                    <>
                        <label className='lbl'>Total Rounds</label>
                        <input className = {`input ${validRounds ? 'valid' : ''}`} ref = {roundsRef} placeholder = "Enter number of rounds" name = 'rounds' type = "number" value = {rounds} max = "99" onKeyDown = {checkLetters} autoComplete ="off" onChange = {changeRounds} onFocus = {() => {setFocus(true)}} onBlur = {() => {setFocus(false)}} />
                    </>
                    }

                    <div className='dates-container'>
                        <label className='lbl'>Late Registration</label>
                        <label className='lbl'>Break Duration</label>
                    </div>
                    <div className='dropdown-inline'>
                        <DropDownInput 
                            options={lateRegOptions} 
                            value={lateReg} 
                            onChange={handleLateRegChange}
                            formatOption={(opt) => opt === 0 ? 'Disabled' : `Until round ${opt}`}
                            disabled={isRoundRobin}
                        />
                        <DropDownInput 
                            options={breakDurationOptions} 
                            value={breakDuration} 
                            onChange={handleBreakDurationChange}
                            formatOption={(opt) => {
                                if (opt < 60) return `${opt}s`
                                if (opt === 60) return '1 min'
                                if (opt === 90) return '1 min 30s'
                                if (opt === 120) return '2 min'
                                if (opt === 180) return '3 min'
                                if (opt === 300) return '5 min'
                                return `${Math.floor(opt/60)} min`
                            }}
                        />
                    </div>

                    <div className='dates-container'>
                        <label className='lbl'>Min Rating</label>
                        <label className='lbl'>Max Rating</label>
                    </div>
                    <div className='dates-container'>
                        <input 
                            className='input double' 
                            type="number" 
                            placeholder="No min" 
                            min="0" 
                            max="3000"
                            value={settings.minRating || ''} 
                            onChange={handleMinRatingChange}
                        />
                        <input 
                            className='input double' 
                            type="number" 
                            placeholder="No max" 
                            min="0" 
                            max="3000"
                            value={settings.maxRating || ''} 
                            onChange={handleMaxRatingChange}
                        />
                    </div>

                    <SwitcherOnlineTournaments 
                        flagTest = {settings.private}  
                        flagFinals = {settings.finals} 
                        flagCategories = {settings.withCategories} 
                        flagXOT = {settings.xot} 
                        flagVerifiedOnly = {settings.verifiedOnly}
                        setSettings = {setSettings} 
                        defaultCategories = {defaultCategories}
                    />
                </div>
            </div>
            
            {showScroll ?
                <ScrollDownSVG onClick = {scrollToBottom}/> : <></>}
            {authorized ? <button className = "btn-new-tournament"  disabled = {isDisabled} onClick = {createTournament}>Create Tournament</button> : <></>} 
        </div>
    )
}

export default CreateOTB
