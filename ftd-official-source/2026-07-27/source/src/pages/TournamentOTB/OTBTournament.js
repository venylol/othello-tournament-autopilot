import React, {useState, useEffect, useRef, useContext} from 'react'
import { useParams, useNavigate } from 'react-router-dom'
// import { useHttp } from '../hooks/http.hooks'
import { SettingsOTB } from './SettingsOTB'
import { PlayersListOTB } from './PlayersListOTB'
// import { RoundsListOTB } from './RoundsListOTBDesktop'
import { RoundsListOTB } from './RoundsListOTB'
import { StandingsOTB } from './StandingsOTB'
import { AuthContext } from '../../context/AuthContext'
import { UserContext } from '../../context/UserContext'
import { NavBar } from '../elements/navbar/NavBar'
import { toast } from 'react-toastify';
import { RoundsByPlayer } from './RoundsByPlayer'
import { LayoutContext } from '../../context/LayoutContext'
// import { useOtbIdb } from '../../hooks/idb.otb.hook'
import './otb.css'
window.mobileCheck = function() {
    let check = false;
    (function(a){if(/(android|bb\d+|meego).+mobile|avantgo|bada\/|blackberry|blazer|compal|elaine|fennec|hiptop|iemobile|ip(hone|od)|iris|kindle|lge |maemo|midp|mmp|mobile.+firefox|netfront|opera m(ob|in)i|palm( os)?|phone|p(ixi|re)\/|plucker|pocket|psp|series(4|6)0|symbian|treo|up\.(browser|link)|vodafone|wap|windows ce|xda|xiino/i.test(a)||/1207|6310|6590|3gso|4thp|50[1-6]i|770s|802s|a wa|abac|ac(er|oo|s\-)|ai(ko|rn)|al(av|ca|co)|amoi|an(ex|ny|yw)|aptu|ar(ch|go)|as(te|us)|attw|au(di|\-m|r |s )|avan|be(ck|ll|nq)|bi(lb|rd)|bl(ac|az)|br(e|v)w|bumb|bw\-(n|u)|c55\/|capi|ccwa|cdm\-|cell|chtm|cldc|cmd\-|co(mp|nd)|craw|da(it|ll|ng)|dbte|dc\-s|devi|dica|dmob|do(c|p)o|ds(12|\-d)|el(49|ai)|em(l2|ul)|er(ic|k0)|esl8|ez([4-7]0|os|wa|ze)|fetc|fly(\-|_)|g1 u|g560|gene|gf\-5|g\-mo|go(\.w|od)|gr(ad|un)|haie|hcit|hd\-(m|p|t)|hei\-|hi(pt|ta)|hp( i|ip)|hs\-c|ht(c(\-| |_|a|g|p|s|t)|tp)|hu(aw|tc)|i\-(20|go|ma)|i230|iac( |\-|\/)|ibro|idea|ig01|ikom|im1k|inno|ipaq|iris|ja(t|v)a|jbro|jemu|jigs|kddi|keji|kgt( |\/)|klon|kpt |kwc\-|kyo(c|k)|le(no|xi)|lg( g|\/(k|l|u)|50|54|\-[a-w])|libw|lynx|m1\-w|m3ga|m50\/|ma(te|ui|xo)|mc(01|21|ca)|m\-cr|me(rc|ri)|mi(o8|oa|ts)|mmef|mo(01|02|bi|de|do|t(\-| |o|v)|zz)|mt(50|p1|v )|mwbp|mywa|n10[0-2]|n20[2-3]|n30(0|2)|n50(0|2|5)|n7(0(0|1)|10)|ne((c|m)\-|on|tf|wf|wg|wt)|nok(6|i)|nzph|o2im|op(ti|wv)|oran|owg1|p800|pan(a|d|t)|pdxg|pg(13|\-([1-8]|c))|phil|pire|pl(ay|uc)|pn\-2|po(ck|rt|se)|prox|psio|pt\-g|qa\-a|qc(07|12|21|32|60|\-[2-7]|i\-)|qtek|r380|r600|raks|rim9|ro(ve|zo)|s55\/|sa(ge|ma|mm|ms|ny|va)|sc(01|h\-|oo|p\-)|sdk\/|se(c(\-|0|1)|47|mc|nd|ri)|sgh\-|shar|sie(\-|m)|sk\-0|sl(45|id)|sm(al|ar|b3|it|t5)|so(ft|ny)|sp(01|h\-|v\-|v )|sy(01|mb)|t2(18|50)|t6(00|10|18)|ta(gt|lk)|tcl\-|tdg\-|tel(i|m)|tim\-|t\-mo|to(pl|sh)|ts(70|m\-|m3|m5)|tx\-9|up(\.b|g1|si)|utst|v400|v750|veri|vi(rg|te)|vk(40|5[0-3]|\-v)|vm40|voda|vulc|vx(52|53|60|61|70|80|81|83|85|98)|w3c(\-| )|webc|whit|wi(g |nc|nw)|wmlb|wonu|x700|yas\-|your|zeto|zte\-/i.test(a.substr(0,4))) check = true;})(navigator.userAgent||navigator.vendor||window.opera);
    return check;
};

export const OTBTournament = () => {
    const {socket} = useContext(AuthContext)
    const {settings, isPlaying, setIsPlaying, isOnline, typing} = useContext (UserContext)
    const tournamentId = useParams().id 
    const history = useNavigate()
    const [isTD, setIsTD] = useState(false)
    const [isAssistant, setIsAssistant] = useState(false)
    const [isPlayer, setIsPlayer] = useState (false) 
    const [tName, setTName] = useState(' ')
    const [round, setRound] = useState(0) 
    const [pressed, setPressed] = useState (null)
    const [coordinates, setCoordinates] = useState([])
    const [pairingSystem, setPairingSystem] = useState ('')
    const [roundsByPlayer, setRoundsByPlayer] = useState (null)
    const [roundsByPlayerID, setRoundsByPlayerID] = useState(null)
    const [tournamentFinished, setTournamentFinished] = useState(false)
    const [categories, setCategories] = useState (false)
    const [test, setTest] = useState (false)
    const [tournamentType, setTournamentType] = useState(null)
    const [isXOT, setIsXOT] = useState(false)
    const [country, setCountry] = useState(null)
    const buttonRef = useRef (null)
    const isMobile = window.mobileCheck()
    const width = Math.min(window.innerWidth, 500)
    // const { updateWOFPlayers, getTournamentById } = useOtbIdb()

    useEffect(()=> {
        // if(!isOnline) {
        //     async function getFromIdb() {
        //         const tournament = await getTournamentById(tournamentId)
        //         // console.log(tournament)
        //         if(!tournament) return
        //         setIsTD(true)
        //         setTName('Offline! ' + tournament.name)
        //         setIsPlayer(false) // change that and check if he actually a player
        //         setIsPlaying(true)
        //         setRound(tournament.current_round)
        //         setPairingSystem(tournament.payring_system)

        //         if (tournament.current_round === 0) {
        //             // socket.emit('get-otb-reg', tournamentId)

        //             setPressed('Players')
        //         // } else if (roundFinished) {
        //         //     // socket.emit('get-standings-otb', tournamentId)
        //         //     setPressed('Standings')
        //         } else {
        //             // socket.emit('get-otb-rounds', tournamentId)
        //             setPressed('Rounds')
        //         }
        //     }
        //     getFromIdb()
        //     return
        // }
        socket.emit('is-td', tournamentId)
        socket.on('td', async (val, asisstant, name, currentRound, roundFinished, system, isPlayer, categories, test, tournamentFinished, type, xot, country) => {
            // console.log(val, asisstant, name, currentRound, roundFinished, system, isPlayer, categories, test, tournamentFinished, type, xot)
            if(!name) {
                history(`/live`)
                return () => {
                    socket.off('td')
                    socket.off('otb-update')
                }
            }
            setIsTD(val)
            setIsAssistant(asisstant)
            setTest(test)
            setRoundsByPlayer(null)
            setRoundsByPlayerID(null)
            setIsPlayer(isPlayer)
            setIsPlaying(val || isPlayer)
            setTName(name)
            setRound(currentRound)
            setPairingSystem(system)
            setCategories(categories)
            setTournamentFinished(tournamentFinished)
            setTournamentType(type)
            setIsXOT(xot)
            setCountry(country)
            if (currentRound === 0 && !val) {
                socket.emit('get-otb-reg', tournamentId)
                setPressed('Players')
            } else if (currentRound === 0) {
                // await updateWOFPlayers()
                socket.emit('get-otb-reg', tournamentId)
                setPressed('Players')
            }
            
            else if (roundFinished && (currentRound < 100 || currentRound === 110)) {
                socket.emit('get-standings-otb', tournamentId)
                setPressed('Standings')
            } else {
                socket.emit('get-otb-rounds', tournamentId)
                setPressed('Rounds')
            }
        })
        socket.on('otb-update', (text, reason) => {
            toast.clearWaitingQueue()
            toast.dismiss()
            toast.info(InfoToast(text, reason))
        }) 

        socket.on('otb-results-by-player', (data) => {
            // console.log('games', data.pairing)
            setRoundsByPlayer(data.pairing)
            setRoundsByPlayerID(data.playerId)
        })

        return () => {
            socket.off('td')
            socket.off('otb-update')
            socket.off('otb-results-by-player')
            socket.emit('leave-otb', tournamentId)
            setIsPlaying(false)
        }
    },[isOnline])

    const toggleHandler = (event) => {
        setPressed(event.target.value) 
        setRoundsByPlayer(null)
        if(event.target.value === 'Players') {
            socket.emit('get-otb-reg', tournamentId)
        }
        if(event.target.value === 'Rounds') {
            socket.emit('get-otb-rounds', tournamentId)
        }
        if(event.target.value === 'Standings') {
            socket.emit('get-standings-otb', tournamentId)
        }
        setCoordinates([event.clientX - event.target.offsetLeft, '2vh'])   
    }

    useEffect (() => {
        if (!buttonRef.current) {return}
            buttonRef.current.style.animation = 'none' 
            buttonRef.current.style.left = coordinates[0] + 'px'
            buttonRef.current.style.top = coordinates[1]
            requestAnimationFrame(() => {
                buttonRef.current.style.animation = 'ripples-toggle 0.5s ease-in forwards'
            })
    }, [coordinates]) 

    const toastButton = (reason) => { 
        if (reason === 'standings') {
                setPressed('Standings')
                socket.emit('get-standings-otb', tournamentId)
                return
        }

        if (reason === 'rounds') {            
                setPressed('Rounds')
                socket.emit('get-otb-rounds', tournamentId)
                return
        } 
    } 

    const InfoToast = (text, reason) => {
        return (
            <div className="notification-nav" onClick = {() => toastButton(reason)}>
                <span>{text}</span>
            </div>
        )
    }
//
    return (
        <>
        <LayoutContext.Provider value = {{isMobile}}>
        <div style = {{'--global-width': width + 'px'}}> 
            <NavBar isHome = {false} text = {tName}></NavBar>
            <div className = 'toggle-button-contaner'>
                <button value = 'Settings' className = 'toggle-button tournament' disabled = {pressed === 'Settings' ? true : false } onClick = {toggleHandler}>{isTD ? 'Settings' : 'Info'}
                    {pressed === 'Settings' ? 
                    <div className="ripple-container toggle">
                        <span ref = {buttonRef} className = 'ripple'></span> 
                    </div> : <></>
                    }
                </button>
                <button value = 'Players' className = 'toggle-button tournament' disabled = {pressed === 'Players' ? true : false} onClick = {toggleHandler}>Players
                    {pressed === 'Players' ? 
                        <div className="ripple-container toggle">
                            <span ref = {buttonRef} className = 'ripple'></span> 
                        </div> : <></>
                    }
                </button>
                <button value = 'Rounds' className = 'toggle-button tournament' disabled = {pressed === 'Rounds' ? true : false} onClick = {toggleHandler}>Rounds
                {pressed === 'Rounds' ? 
                    <div className="ripple-container toggle">
                        <span ref = {buttonRef} className = 'ripple'></span> 
                    </div> : <></>}
                </button>
                <button value = 'Standings' className = 'toggle-button tournament' disabled = {pressed === 'Standings' ? true : false} onClick = {toggleHandler}>Standings
                {pressed === 'Standings' ? 
                    <div className="ripple-container toggle">
                        <span ref = {buttonRef} className = 'ripple'></span> 
                    </div> : <></>}
                </button>
            </div> 
            <div>
                {pressed === 'Settings' && (!roundsByPlayer || roundsByPlayer?.length === 0)?
                    <SettingsOTB  
                        id = {tournamentId} 
                        socket = {socket} 
                        isTD = {isTD} 
                        setTName = {setTName} 
                        round = {round} 
                        setRound = {setRound} 
                        isOnline = {isOnline} 
                    />
                    : <></>
                }
                {pressed === 'Players' && (!roundsByPlayer || roundsByPlayer?.length === 0)?
                    <PlayersListOTB 
                        id = {tournamentId} 
                        socket = {socket} 
                        isTD = {isTD} 
                        setTab = {setPressed} 
                        pairingSystem = {pairingSystem} 
                        isOnline = {isOnline} 
                        hasCategories = {categories} 
                        setRoundsByPlayerID = {setRoundsByPlayerID}
                        currentRound = {round}
                        tournamentCountry = {country}
                    />
                    : <></> 
                }
                {pressed === 'Rounds' && (!roundsByPlayer || roundsByPlayer?.length === 0)?
                    <RoundsListOTB 
                        id = {tournamentId} 
                        isTD = {isTD}
                        isAssistant = {isAssistant}
                        setTab = {setPressed} 
                        round = {round} 
                        setRound = {setRound} 
                        isPlayer = {isPlayer} 
                        test = {test} 
                        tournamentFinished = {tournamentFinished} 
                        ifCategories = {categories}
                        xot = {isXOT}
                        tName = {tName}/>
                    : <></> 
                }
                {pressed === 'Standings' && (!roundsByPlayer || roundsByPlayer?.length === 0)?
                    <StandingsOTB 
                        id = {tournamentId} 
                        socket = {socket} 
                        isTD = {isTD} 
                        setTab = {setPressed} 
                        isOnline = {isOnline} 
                        setRoundsByPlayerID = {setRoundsByPlayerID} 
                        tournamentFinished = {tournamentFinished}
                        ifCategories = {categories}
                        isWOC = {tournamentType === 'WOC'}
                    />
                    : <></> 
                }
                {roundsByPlayer && roundsByPlayer?.length > 0?
                    <RoundsByPlayer 
                        id = {tournamentId} 
                        setTab = {setPressed} 
                        pairings = {roundsByPlayer} 
                        playerId = {roundsByPlayerID} 
                        setRoundsByPlayer = {setRoundsByPlayer} 
                        pressed = {pressed} 
                        tName = {tName}
                        xot = {isXOT}
                    />
                    : <></>
                }
                {!pressed && !roundsByPlayer ? 
                    <div className = 'big-text-empty'>Loading...</div>
                    : <></> 
                }
            </div>
        </div>
        </LayoutContext.Provider>
        </>
    )
}

export default OTBTournament
