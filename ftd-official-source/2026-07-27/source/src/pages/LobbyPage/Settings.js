import React, {useState, useEffect, useRef, useContext} from "react"
import { OptionButton } from './OptionButton'
import { useNavigate } from 'react-router-dom'
import { useOutsideAlerter } from '../../hooks/outside.click.hook'
import { AuthContext } from '../../context/AuthContext'

// Invitation on players tab:
// button doesn't show up at first.
// when any invite pressed on players tab - seyInviteId - pass to lobby pass to settings
// show settings. and confirm button. After it is pressed - send ivitation to back end
// remove invite button from and change to "cancel"

export const LobbySettings = ({settings, setSettings, btnLabel, setBtnLabel, pressed, invitation, setInvited, bottom = 50, visible, onHide, excludeRef}) => {
    const {userId, isAuthenticated, socket} = useContext(AuthContext)
    const [directLink, setDirectLink] = useState(false)
    const [timeControl, setTimeControl] = useState(5)
    const [increment, setIncrement] = useState(0)
    const [xot, setXot] = useState(0)
    const [color, setColor] = useState('r')
    // const [invite, setInvite] = useState(null) 

    const gameSettingsRef = useRef (null)
    const buttonRef = useRef (null)
    const storageName = 'tableSettings'

    useOutsideAlerter(gameSettingsRef, buttonRef, visible === undefined ? setBtnLabel : null)

    // Handle outside clicks when visibility is controlled externally (e.g. profile page)
    useEffect(() => {
        if (visible === undefined || !onHide) return
        function handleClickOutside(event) {
            if (gameSettingsRef.current && !gameSettingsRef.current.contains(event.target)
                && (!excludeRef?.current || !excludeRef.current.contains(event.target))
                && visible) {
                onHide()
            }
        }
        document.addEventListener('mousedown', handleClickOutside)
        return () => document.removeEventListener('mousedown', handleClickOutside)
    }, [visible, onHide, excludeRef])

    const history = useNavigate()

    useEffect(() => {
        getSettings()   
    },[])

    // useEffect (()=> {
    //     console.log('timecontrol',timeControl)
    // },[timeControl])

    const getSettings = async () => {
        const data = await JSON.parse(localStorage.getItem(storageName))
        // console.log(data && data.timeControl)
        if (data  && data.timeControl) {
            // console.log('hi') 
            setTimeControl(data.timeControl)
            setXot(data.xot)
            setIncrement(data.increment)
            setColor('r')
            setSettings({timeControl: data.timeControl, increment: data.increment, xot: data.xot, directLink: false, color: 'r'})
            return
        }
        setSettings({timeControl: 5, increment: 0, xot: 0, directLink: false})
        return
    }

    const handleIncrementTab = (val) => {
        setIncrement(parseInt(val))
    }

    const handleColorTab = (val) => {
        setColor(val)
    }

    const handleTimeControlTab = (val) => {
        setTimeControl(parseInt(val))
        setIncrement(0)
    }

    const handleXOT = (val) => {
        setXot(parseInt(val))
    }

    const redirectHandler = () => {
        history('/login')
    }

    const Switcher = ({flag, lbl}) => {
        const [checked, setChecked] = useState(flag)
        const switchHandler = () => {
            setChecked(prev => !prev)
            setDirectLink(prev => !prev)
            // setTableSettings(prev => ({...prev, directLink: parseInt(lbl)}))
            // console.log (flag, lbl)

        }

        return (
            <div className = 'settings-option' onClick = {switchHandler} >{lbl}
                <label className ='switcher'>
                    <input type ='checkbox' checked = {checked} onChange = {switchHandler}></input> 
                    <span className="slider"></span>
                </label>
            </div>
        )
    }

    const fischerOptions = timeControl => {
        if (timeControl === 1) return [0, 1]
        if (timeControl === 3) return [0, 1, 2]
        if (timeControl === 5) return [0, 3, 5]
        if (timeControl === 10) return [0, 5, 10]
        if (timeControl === 15) return [0, 5, 10, 15]
        if (timeControl === 20) return [0, 10, 20, 30]
    }

    const createTable = (buttonName) => {
        const tableSettings = {
            timeControl: timeControl,
            increment: increment,
            xot: xot,
            directLink: directLink,
        }

        if (buttonName === 'Confirm' && JSON.stringify(tableSettings) === JSON.stringify(settings)) {
            setBtnLabel('Change Settings')
            return
        }
        if (buttonName === 'Confirm') {
            socket.emit('change-settings', tableSettings)
            setSettings(tableSettings)
            setBtnLabel('Change Settings')
            return
        }
        socket.emit('create-table', tableSettings)
        setSettings(tableSettings)
        setBtnLabel('Change Settings')
        localStorage.setItem(storageName, JSON.stringify(tableSettings))
        //here set local storage to new table settings
    }

    const createInvitation = () => {
        const tableSettings = {
            timeControl: timeControl,
            increment: increment,
            xot: xot,
            directLink: false,
            color: color,
        }
        socket.emit('invite', invitation, tableSettings)
        setSettings(tableSettings)
        setInvited(invitation)
        // setInvitation(null)
    }

    useEffect(() => {
        if (visible === undefined) return
        if (gameSettingsRef.current) {
            gameSettingsRef.current.style.bottom = visible ? (40 + bottom + 'px') : ('-' + (gameSettingsRef.current.scrollHeight + 10) + 'px')
        }
    }, [visible, bottom])

    useEffect(()=> {
        // console.log(btnLabel)
        if (visible !== undefined) return
        if (btnLabel === 'Invite') {
            // console.log(invitation)
            gameSettingsRef.current.style.bottom === 40 + bottom + 'px' ? gameSettingsRef.current.style.bottom = '-227px' : gameSettingsRef.current.style.bottom = 40 + bottom + 'px'
        } 
    }, [btnLabel])

    const newGameHandler = (event) => {
        if(event) {
            setBtnLabel(prev => {
                if (prev === 'New Game') {return 'Start Game'} 
                if (prev === 'Change Settings') {return 'Confirm'}  
                createTable(prev)
            })
            gameSettingsRef.current.style.bottom === 40 + bottom + 'px' ? gameSettingsRef.current.style.bottom = '-227px' : gameSettingsRef.current.style.bottom = 40 + bottom + 'px' //'-183.6px'
            return
        }
        setBtnLabel('New Game')
        gameSettingsRef.current.style.bottom = '-227px'   
    }

    const InviteHandler = (event) => {
        // console.log(btnLabel)
        if(event) {
            createInvitation()
            setBtnLabel('New Game')
            gameSettingsRef.current.style.bottom = '-227px'   
        }
        
        // if(event) {
        //     setBtnLabel(prev => {
        //         if (prev === 'New Game') {return 'Start Game'} 
        //         if (prev === 'Change Settings') {return 'Confirm'}  
        //         createTable(prev)
        //     })
        //     gameSettingsRef.current.style.bottom === '90px' ? gameSettingsRef.current.style.bottom = '-227px' : gameSettingsRef.current.style.bottom = '90px' //'-183.6px'
        //     return
        // }
        // setBtnLabel('Invite')
        // gameSettingsRef.current.style.bottom = '-227px'   
    }

    return (
        <>
        <div className = 'table-settings' ref = {gameSettingsRef}>
            <div className = 'table-options'>
                <label className='lbl-table-settings'>Time Control</label>
                <div className='btn-time-control'>                       
                    <OptionButton id = 'tc0' value = {1} className = 'time-control' onClick = {handleTimeControlTab} timeControl = {timeControl} text = '1'></OptionButton>
                    <OptionButton id = 'tc1' value = {3} className = 'time-control' onClick = {handleTimeControlTab} timeControl = {timeControl} text = '3'></OptionButton>
                    <OptionButton id = 'tc2' value = {5} className = 'time-control' onClick = {handleTimeControlTab} timeControl = {timeControl} text = '5'></OptionButton>
                    <OptionButton id = 'tc3' value = {10} className = 'time-control' onClick = {handleTimeControlTab} timeControl = {timeControl} text = '10'></OptionButton>
                    <OptionButton id = 'tc4' value = {15} className = 'time-control' onClick = {handleTimeControlTab} timeControl = {timeControl} text = '15'></OptionButton>
                    <OptionButton id = 'tc5' value = {20} className = 'time-control' onClick = {handleTimeControlTab} timeControl = {timeControl} text = '20'></OptionButton>
                </div>
                <label className = 'lbl-table-settings'>Increment</label>
                <div className='btn-time-control'> 
                    {fischerOptions(timeControl).map(val =>
                        <OptionButton key = {val} value = {val} className = 'increment' onClick = {handleIncrementTab} timeControl = {increment} text = {val +'s'}></OptionButton>
                    )}
                </div>
                {pressed === 'Players' || !pressed ? 
                    <>
                        <label className = 'lbl-table-settings'>Your Color</label>
                        <div className='btn-time-control' >
                            <OptionButton key = 'b' value = 'b' className = 'score-replayer-black' onClick = {handleColorTab} timeControl = {color} text = ''></OptionButton>
                            <OptionButton key = 'r' value = 'r' className = 'score-replayer-random' onClick = {handleColorTab} timeControl = {color} text = ''></OptionButton>
                            <OptionButton key = 'w' value = 'w' className = 'score-replayer-white' onClick = {handleColorTab} timeControl = {color} text = ''></OptionButton>
                        </div>
                    </>
                : <></> }

                {/* <label className = 'lbl-table-settings'>Game Type</label> */}
                <div className='btn-time-control' >
                    <OptionButton id = 'xot0' value = {0} className = 'xot' onClick = {handleXOT} timeControl = {xot} text = 'Classic' ></OptionButton>  
                    <OptionButton id = 'xot1' value = {1} className = 'xot' onClick = {handleXOT} timeControl = {xot} text = 'XOT'></OptionButton>                      
                </div>
                {pressed === 'Tables' ? <Switcher lbl = 'Send Invitation' flag = {directLink}/> :<></>}
                

                {/* <label className = 'lbl-table-settings'>{'Rating >'}</label> */}
            </div>
        </div>

        {!isAuthenticated ?
        <button ref = {buttonRef} id = 'login' value = 'Sign In' className = "btn-new-game" onClick = {redirectHandler} style = {{bottom: bottom}}>Sign In</button> 
        : pressed === 'Tables' ?
        <button ref = {buttonRef} id = 'newgame' value = {btnLabel} className = "btn-new-game" onClick = {newGameHandler} style = {{bottom: bottom}}>{btnLabel}</button> 
        : (pressed === 'Players' || !pressed) && btnLabel === 'Invite' && visible !== false ?
        <button ref = {buttonRef} id = 'invite' value = {btnLabel} className = "btn-new-game" onClick = {InviteHandler} style = {{bottom: bottom}}>{btnLabel}</button>
        : <></>
        }
        </>
    )
}

