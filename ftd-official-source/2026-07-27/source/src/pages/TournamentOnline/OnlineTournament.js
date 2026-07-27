import React, {useState, useEffect, useRef, useContext} from 'react'
import { useParams, useNavigate, useLocation } from 'react-router-dom'
// import Countdown from 'react-countdown';
// import { useHttp } from '../hooks/http.hooks'
import { SettingsOnlineNew } from './SettingsOnlineNew'
import { InfoOnline } from './InfoOnline'
import { PlayersListOnline } from './PlayersListOnline'
// import { RoundsListOTB } from './RoundsListOTBDesktop'
import { RoundsListOTB } from './RoundsListOnline'
import { WithdrawWarningToast } from './WithdrawWarning'
// import { StandingsOnline } from './StandingsOnline' // Old standings component
import { StandingsOnlineDetailed } from './StandingsOnlineDetailed' // New detailed standings
import { AuthContext } from '../../context/AuthContext'
import { UserContext } from '../../context/UserContext'
import { SFXContext } from '../../context/SFXContext'
import { NavBar } from '../elements/navbar/NavBar'
import { toast } from 'react-toastify';
import { RoundsByPlayerOnline } from './RoundsByPlayerOnline'
import { LayoutContext } from '../../context/LayoutContext'
import { InfoSVG, TrophySVG, RoundsSVG, PlayersSVG, SettingsSVG } from '../elements/SVG'
import { TournamentWinnerModal } from './TournamentWinnerModal'
// import { useOtbIdb } from '../../hooks/idb.otb.hook'
import './tournament.css'
window.mobileCheck = function() {
    let check = false;
    (function(a){if(/(android|bb\d+|meego).+mobile|avantgo|bada\/|blackberry|blazer|compal|elaine|fennec|hiptop|iemobile|ip(hone|od)|iris|kindle|lge |maemo|midp|mmp|mobile.+firefox|netfront|opera m(ob|in)i|palm( os)?|phone|p(ixi|re)\/|plucker|pocket|psp|series(4|6)0|symbian|treo|up\.(browser|link)|vodafone|wap|windows ce|xda|xiino/i.test(a)||/1207|6310|6590|3gso|4thp|50[1-6]i|770s|802s|a wa|abac|ac(er|oo|s\-)|ai(ko|rn)|al(av|ca|co)|amoi|an(ex|ny|yw)|aptu|ar(ch|go)|as(te|us)|attw|au(di|\-m|r |s )|avan|be(ck|ll|nq)|bi(lb|rd)|bl(ac|az)|br(e|v)w|bumb|bw\-(n|u)|c55\/|capi|ccwa|cdm\-|cell|chtm|cldc|cmd\-|co(mp|nd)|craw|da(it|ll|ng)|dbte|dc\-s|devi|dica|dmob|do(c|p)o|ds(12|\-d)|el(49|ai)|em(l2|ul)|er(ic|k0)|esl8|ez([4-7]0|os|wa|ze)|fetc|fly(\-|_)|g1 u|g560|gene|gf\-5|g\-mo|go(\.w|od)|gr(ad|un)|haie|hcit|hd\-(m|p|t)|hei\-|hi(pt|ta)|hp( i|ip)|hs\-c|ht(c(\-| |_|a|g|p|s|t)|tp)|hu(aw|tc)|i\-(20|go|ma)|i230|iac( |\-|\/)|ibro|idea|ig01|ikom|im1k|inno|ipaq|iris|ja(t|v)a|jbro|jemu|jigs|kddi|keji|kgt( |\/)|klon|kpt |kwc\-|kyo(c|k)|le(no|xi)|lg( g|\/(k|l|u)|50|54|\-[a-w])|libw|lynx|m1\-w|m3ga|m50\/|ma(te|ui|xo)|mc(01|21|ca)|m\-cr|me(rc|ri)|mi(o8|oa|ts)|mmef|mo(01|02|bi|de|do|t(\-| |o|v)|zz)|mt(50|p1|v )|mwbp|mywa|n10[0-2]|n20[2-3]|n30(0|2)|n50(0|2|5)|n7(0(0|1)|10)|ne((c|m)\-|on|tf|wf|wg|wt)|nok(6|i)|nzph|o2im|op(ti|wv)|oran|owg1|p800|pan(a|d|t)|pdxg|pg(13|\-([1-8]|c))|phil|pire|pl(ay|uc)|pn\-2|po(ck|rt|se)|prox|psio|pt\-g|qa\-a|qc(07|12|21|32|60|\-[2-7]|i\-)|qtek|r380|r600|raks|rim9|ro(ve|zo)|s55\/|sa(ge|ma|mm|ms|ny|va)|sc(01|h\-|oo|p\-)|sdk\/|se(c(\-|0|1)|47|mc|nd|ri)|sgh\-|shar|sie(\-|m)|sk\-0|sl(45|id)|sm(al|ar|b3|it|t5)|so(ft|ny)|sp(01|h\-|v\-|v )|sy(01|mb)|t2(18|50)|t6(00|10|18)|ta(gt|lk)|tcl\-|tdg\-|tel(i|m)|tim\-|t\-mo|to(pl|sh)|ts(70|m\-|m3|m5)|tx\-9|up(\.b|g1|si)|utst|v400|v750|veri|vi(rg|te)|vk(40|5[0-3]|\-v)|vm40|voda|vulc|vx(52|53|60|61|70|80|81|83|85|98)|w3c(\-| )|webc|whit|wi(g |nc|nw)|wmlb|wonu|x700|yas\-|your|zeto|zte\-/i.test(a.substr(0,4))) check = true;})(navigator.userAgent||navigator.vendor||window.opera);
    return check;
};

export const OnlineTournament = () => {
    const {socket, isAuthenticated, isAdmin} = useContext(AuthContext)
    const {setIsPlaying, isOnline} = useContext (UserContext)
    const {playWithdraw} = useContext(SFXContext)
    const { id: tournamentId, nick: playerNickParam } = useParams()
    const history = useNavigate()
    const location = useLocation()
    const [isTD, setIsTD] = useState(false)
    const [isPlayer, setIsPlayer] = useState (false)
    const [withdrawn, setWithdrawn] = useState (false) 
    const [registerPressed, setRegisterPressed] = useState(false)
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
    const [nextRoundStartTime, setNextRoundStartTime] = useState(null)
    const [tournamentStatus, setTournamentStatus] = useState(null) // 1=created, 2=cancelled, 3=started, 4=finished
    const [lateRegAvailable, setLateRegAvailable] = useState(false)
    const [isRoundRobin, setIsRoundRobin] = useState(false)
    const [verifiedOnly, setVerifiedOnly] = useState(false)
    const [viewerVerified, setViewerVerified] = useState(false)
    const [totalRounds, setTotalRounds] = useState(null)
    const [hasPlayedRound, setHasPlayedRound] = useState(false) // Track if player has played any round (for Unregister vs Withdraw logic)
    const [tournamentInfo, setTournamentInfo] = useState(null) // Full tournament info for Info/Settings tabs
    const [showWinnerModal, setShowWinnerModal] = useState(false)
    const [winnerStandings, setWinnerStandings] = useState(null)
    const [winnerTotalRounds, setWinnerTotalRounds] = useState(0)
    const winnerModalKey = `__winnerModalShown_${tournamentId}`
    const buttonRef = useRef (null)
    const isMobile = window.mobileCheck()
    const width = Math.min(window.innerWidth, 500)

    useEffect(()=> {
        // console.log('OnlineTournament mounted, tournamentId:', tournamentId, 'playerNickParam:', playerNickParam)
        socket.emit('is-td-online', tournamentId)
        socket.on('td-online', async (data) => {
            console.log(data)
            if(!data?.name) {
                history(`/tournaments`)
                return () => {
                    socket.off('td-online')
                    socket.off('online-update')
                }
            }
            setIsTD(data.isTD)
            setTest(data.test)
            setRoundsByPlayer(null)
            setRoundsByPlayerID(null)
            setIsPlayer(data.isPlayer)
            // setIsPlaying(data.isPlayer)
            setTName(data.name)
            setRound(data.currentRound)
            setPairingSystem(data.system)
            setCategories(data.categories)
            setTournamentFinished(data.finished)
            setTournamentType(data.type)
            setIsXOT(data.xot)
            setTournamentStatus(data.status)
            setTotalRounds(data.rounds)
            setHasPlayedRound(data.hasPlayedRound || false)
            setWithdrawn(data.isWithdrawn || false)
            
            // Store full tournament info for Info/Settings tabs (avoids extra socket calls and flickering)
            setTournamentInfo({
                name: data.name,
                start_date: data.startDate,
                end_date: data.endDate,
                pairing_system: data.system,
                rounds: data.rounds,
                time_control: data.timeControl,
                increment: data.increment,
                xot: data.xot,
                private: data.isPrivate,
                verified_only: data.verifiedOnly,
                late_reg: data.lateReg,
                break_duration: data.break_duration,
                min_rating: data.min_rating,
                max_rating: data.max_rating,
                event_name: data.event_name,
                finals: data.finals,
                categories: data.categories,
                min_players: data.min_players,
                status: data.status
            })
            
            // Check if late registration is available
            const isRR = data.system === 'Round Robin' || data.system === 'Double Round Robin'
            setIsRoundRobin(isRR)
            const lateRegOpen = !isRR && data.currentRound > 0 && data.lateReg && data.currentRound <= data.lateReg && !data.finished
            setLateRegAvailable(lateRegOpen)
            setVerifiedOnly(data.verifiedOnly)
            // Only upgrade viewerVerified to true; don't downgrade on reconnect
            // (lobby.getUser may not find user yet with new socket ID)
            if (data.viewerVerified) setViewerVerified(true)
            
            // Handle cancelled tournament (status = 2)
            if (data.status === 2) {
                if (data.isTD || isAdmin) {
                    socket.emit('get-online-reg', tournamentId)
                    setPressed('Players')
                } else {
                    socket.emit('get-detailed-standings-online', tournamentId)
                    setPressed('Standings')
                }
                return
            }

            // Show winner modal for finished tournaments (once per page load)
            if (data.status === 4 && !window[winnerModalKey]) {
                window[winnerModalKey] = true
                const handleWinnerStandings = (standings, lastRnd, totalRnds) => {
                    if (standings?.length > 0) {
                        setWinnerStandings(standings)
                        setWinnerTotalRounds(totalRnds || lastRnd || 0)
                        setShowWinnerModal(true)
                    }
                    socket.off('detailed-standings-online-winner', handleWinnerStandings)
                }
                socket.on('detailed-standings-online-winner', handleWinnerStandings)
                socket.emit('get-detailed-standings-online-winner', tournamentId)
            }
            
            // change that
            if (data.currentRound === 0) {
                setNextRoundStartTime(data.startDate)
                if (data.isTD || isAdmin) {
                    socket.emit('get-online-reg', tournamentId)
                    setPressed('Players')
                } else {
                    socket.emit('get-detailed-standings-online', tournamentId)
                    setPressed('Standings')
                }
            }             
            else if (data.roundFinished && (data.currentRound < 100 || data.currentRound === 110)) {
                setNextRoundStartTime(data.nextRoundStarts)
                socket.emit('get-detailed-standings-online', tournamentId)
                setPressed('Standings')
            } else {
                setNextRoundStartTime(data.nextRoundStarts)
                socket.emit('get-online-rounds', tournamentId)
                setPressed('Rounds')
            }
        })
        socket.on('online-update', (text, reason, nextRoundStarts) => {
            setNextRoundStartTime(nextRoundStarts)
            // toast.clearWaitingQueue()
            // toast.dismiss()
            // toast.info(InfoToast(text, reason), {autoClose: 2000})
            
            // Auto-navigate and refresh based on reason
            if (reason === 'rounds' || reason === 'new-round') {
                // Update round number when new round starts
                
                if (reason === 'new-round' || text.toLowerCase().includes('round') && text.toLowerCase().includes('started')) {
                    // Extract round number from text if possible, or fetch updated tournament data
                    socket.emit('is-td-online', tournamentId) // - why do i need this??
                    if (text === 'Round 1 started') {
                        setPressed('Rounds')
                        socket.emit('get-online-rounds', tournamentId)
                    }
                }
                
                // If already on Rounds tab, refresh the data
                else if (pressed === 'Rounds') {
                    socket.emit('get-online-rounds', tournamentId)
                }
                // If already on Standings tab, refresh the data  
                else if (pressed === 'Standings') {
                    socket.emit('get-detailed-standings-online', tournamentId)
                }
                // If not on Rounds tab, navigate to it
                // else {
                //     setPressed('Rounds')
                //     setRoundsByPlayer(null)
                //     socket.emit('get-online-rounds', tournamentId)
                // }
            } else if (reason === 'standings') {
                // Navigate to standings and refresh
                if (pressed !== 'Standings') {
                    setPressed('Standings')
                }
                socket.emit('get-detailed-standings-online', tournamentId)

                // If the tournament just finished, show winner modal
                if (text === 'Tournament finished') {
                    setTournamentFinished(true)
                    setTournamentStatus(4)
                    if (!window[winnerModalKey]) {
                        window[winnerModalKey] = true
                        const handleWinnerStandings = (data, lastRnd, totalRnds) => {
                            if (data?.length > 0) {
                                setWinnerStandings(data)
                                setWinnerTotalRounds(totalRnds || lastRnd || 0)
                                setShowWinnerModal(true)
                            }
                            socket.off('detailed-standings-online-winner', handleWinnerStandings)
                        }
                        socket.on('detailed-standings-online-winner', handleWinnerStandings)
                        socket.emit('get-detailed-standings-online-winner', tournamentId)
                    }
                }
            } else if (reason === 'tournament-started') {
                // Tournament just started - navigate to Rounds
                setRound(1)
                setPressed('Rounds')
                setRoundsByPlayer(null)
                socket.emit('get-online-rounds', tournamentId)
            } else if (reason === 'cancelled') {
                setTournamentFinished(true)
                setTournamentStatus(2)
            }
        }) 
        socket.on('register', (id, reg, isWithdrawn) => {
            if (parseInt(tournamentId) === id) {
                setIsPlayer(reg)
                setWithdrawn(isWithdrawn)
                setRegisterPressed(false)
                // Re-fetch tournament state to update hasPlayedRound and other derived fields
                // This ensures the correct button (Unregister vs Withdraw) shows after late registration
                socket.emit('is-td-online', tournamentId)
            }
        })

        socket.on('registration-error', (message) => {
            toast.error(message)
            setRegisterPressed(false)
        })

        socket.on('online-results-by-player', (data) => {
            // console.log('games', data.pairing)
            setRoundsByPlayer(data.pairing)
            setRoundsByPlayerID(data.playerId)
        })

        return () => {
            socket.off('td-online')
            socket.off('online-update')
            socket.off('online-results-by-player')
            socket.off('register')
            socket.off('registration-error')
            socket.off('detailed-standings-online-winner')
            socket.emit('leave-online', tournamentId)
        }
    },[isOnline, tournamentId])

    const showPlayersTab = isTD || isAdmin

    const footerHandler = (tab) => {
        setPressed(tab) 
        setRoundsByPlayer(null)
        if(tab === 'Players') {
            socket.emit('get-online-reg', tournamentId)
        }
        if(tab === 'Rounds') {
            socket.emit('get-online-rounds', tournamentId)
        }
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
    
    const leave = () => {
        if (tournamentId) {
            history(`/tournaments/${tournamentId}`)
            socket.emit('unregister', tournamentId)
            return
        }
    }

    const withdrawAndPlay = () => {
        try { playWithdraw && playWithdraw() } catch (e) {}
        leave()
    }

    const leaveConfirm = () => {
            if(isPlayer && isAuthenticated && round > 0 && !tournamentFinished && tournamentStatus !== 2 && round < totalRounds) {
                setRegisterPressed(true)
                toast.dismiss()
                toast.warn(WithdrawWarningToast({leave: withdrawAndPlay}))
            }
            else {
                leave()
            }
        }

    const toastButton = (reason) => { 
        // console.log(reason)
        setRoundsByPlayer(null)
        if (reason === 'standings') {
                setPressed('Standings')
                // socket.emit('get-standings-online', tournamentId)
                return
        }

        if (reason === 'rounds') {            
                setPressed('Rounds')
                socket.emit('get-online-rounds', tournamentId)
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

    const registrationHandler = () => {
        // tournament is the one he can register to
        // user is logged in and has rights to play a tournaments (and this tournament!)
        if (!isAuthenticated) return
        if (!isPlayer) { // register
            setRegisterPressed(true)
            socket.emit('register', tournamentId)
        } else { // unregister
            setRegisterPressed(true)
            socket.emit('unregister', tournamentId)
        }
    }

    const redirectHandler = () => {
        history('/login')
    }

    // console.log('OnlineTournament component mounted/rendered, pressed:', pressed, 'tournamentId:', tournamentId)
//
    return (
        <>
        <LayoutContext.Provider value = {{isMobile}}>
        <div style = {{'--global-width': width + 'px'}}> 
            <NavBar isHome = {false} text = {tName} tournamentId = {tournamentId}></NavBar>
            <div style={{marginTop: '55px'}}>
                {pressed === 'Settings' && !playerNickParam && isTD && !tournamentFinished && tournamentStatus !== 2 && (!roundsByPlayer || roundsByPlayer?.length === 0)?
                    <SettingsOnlineNew  
                        id = {tournamentId} 
                        socket = {socket} 
                        isTD = {isTD} 
                        setTName = {setTName} 
                        round = {round} 
                        setRound = {setRound}
                        currentRound = {round}
                        nextRoundStartTime = {nextRoundStartTime}
                        setNextRoundStartTime = {setNextRoundStartTime}
                        tournamentInfo = {tournamentInfo}
                    />
                    : <></>
                }
                {pressed === 'Info' && !playerNickParam && (!isTD || tournamentFinished || tournamentStatus === 2) && (!roundsByPlayer || roundsByPlayer?.length === 0)?
                    <InfoOnline
                        id = {tournamentId} 
                        socket = {socket}
                        showBottomButton = {(round === 0 || lateRegAvailable || (isPlayer && round < totalRounds)) && !tournamentFinished && tournamentStatus !== 2 && (isAuthenticated || !verifiedOnly)}
                        currentRound = {round}
                        nextRoundStartTime = {nextRoundStartTime}
                        setNextRoundStartTime = {setNextRoundStartTime}
                        tournamentStatus = {tournamentStatus}
                        tournamentInfo = {tournamentInfo}
                        setTournamentInfo = {setTournamentInfo}
                    />
                    : <></>
                }
                {pressed === 'Players' && !playerNickParam && (!roundsByPlayer || roundsByPlayer?.length === 0)?
                    <PlayersListOnline
                        id = {tournamentId} 
                        socket = {socket} 
                        isTD = {isTD} 
                        setTab = {setPressed} 
                        pairingSystem = {pairingSystem} 
                        isOnline = {isOnline} 
                        hasCategories = {categories} 
                        setRoundsByPlayerID = {setRoundsByPlayerID}
                        currentRound = {round}
                        nextRoundStartTime = {nextRoundStartTime}
                        setNextRoundStartTime = {setNextRoundStartTime}
                        showBottomButton = {(round === 0 || lateRegAvailable || (isPlayer && round < totalRounds)) && !tournamentFinished && tournamentStatus !== 2 && (isAuthenticated || !verifiedOnly)}
                        tournamentStatus = {tournamentStatus}
                        isPrivate = {tournamentInfo?.private}
                        tName = {tName}
                        lateRegAvailable = {lateRegAvailable}
                        tournamentFinished = {tournamentFinished}
                        verifiedOnly = {verifiedOnly}
                        viewerVerified = {viewerVerified}
                    />
                    : <></> 
                }
                {pressed === 'Rounds' && !playerNickParam && (!roundsByPlayer || roundsByPlayer?.length === 0)?
                    <RoundsListOTB 
                        id = {tournamentId} 
                        isTD = {isTD}
                        setTab = {setPressed} 
                        round = {round} 
                        setRound = {setRound} 
                        isPlayer = {isPlayer} 
                        test = {test} 
                        tournamentFinished = {tournamentFinished} 
                        ifCategories = {categories}
                        xot = {isXOT}
                        nextRoundStartTime = {nextRoundStartTime}
                        setNextRoundStartTime = {setNextRoundStartTime}
                        tName = {tName}
                        showBottomButton = {(round === 0 || lateRegAvailable || (isPlayer && round < totalRounds)) && !tournamentFinished && tournamentStatus !== 2 && (isAuthenticated || !verifiedOnly)}
                        verifiedOnly = {verifiedOnly}
                        viewerVerified = {viewerVerified}/>
                    : <></> 
                }
                {pressed === 'Standings' && !playerNickParam && (!roundsByPlayer || roundsByPlayer?.length === 0)?
                    <StandingsOnlineDetailed 
                        id = {tournamentId} 
                        socket = {socket} 
                        setTab = {setPressed} 
                        setRoundsByPlayerID = {setRoundsByPlayerID} 
                        showBottomButton = {(round === 0 || lateRegAvailable || (isPlayer && round < totalRounds)) && !tournamentFinished && tournamentStatus !== 2 && (isAuthenticated || !verifiedOnly)}
                        tournamentStatus = {tournamentStatus}
                        currentRound = {round}
                        nextRoundStartTime = {nextRoundStartTime}
                        setNextRoundStartTime = {setNextRoundStartTime}
                        verifiedOnly = {verifiedOnly}
                        viewerVerified = {viewerVerified}
                    />
                    : <></> 
                }
                {playerNickParam && !roundsByPlayer ?
                    <RoundsByPlayerOnline
                        id = {tournamentId}
                        tName = {tName}
                        xot = {isXOT}
                        nextRoundStartTime = {nextRoundStartTime}
                        setNextRoundStartTime = {setNextRoundStartTime}
                        tournamentStatus = {tournamentStatus}
                        currentRound = {round}
                        verifiedOnly = {verifiedOnly}
                        viewerVerified = {viewerVerified}
                    />
                    : <></>
                }
                {!pressed && !roundsByPlayer && !playerNickParam ? 
                    <div className = 'big-text-empty'>Loading...</div>
                    : <></> 
                }
            </div>

            {!playerNickParam ?
            <div className='footer'>
                <div className="game-footer-container" onClick={() => footerHandler(isTD && !tournamentFinished && tournamentStatus !== 2 ? 'Settings' : 'Info')}>
                    <div className={`game-footer ${pressed === 'Settings' || pressed === 'Info' ? 'active' : ''}`}>
                        {isTD && !tournamentFinished && tournamentStatus !== 2 ? <SettingsSVG active={pressed === 'Settings'}/> : <InfoSVG active={pressed === 'Info'}/>}
                        <label className={`game-footer-label ${pressed === 'Settings' || pressed === 'Info' ? 'active' : ''}`}>{isTD && !tournamentFinished && tournamentStatus !== 2 ? 'Settings' : 'Info'}</label>
                    </div>
                </div>
                {showPlayersTab ?
                <div className="game-footer-container" onClick={() => footerHandler('Players')}>
                    <div className={`game-footer ${pressed === 'Players' ? 'active' : ''}`}>
                        <PlayersSVG active={pressed === 'Players'}/>
                        <label className={`game-footer-label ${pressed === 'Players' ? 'active' : ''}`}>Players</label>
                    </div>
                </div>
                : <></>}
                <div className="game-footer-container" onClick={() => footerHandler('Rounds')}>
                    <div className={`game-footer ${pressed === 'Rounds' ? 'active' : ''}`}>
                        <RoundsSVG active={pressed === 'Rounds'}/>
                        <label className={`game-footer-label ${pressed === 'Rounds' ? 'active' : ''}`}>Rounds</label>
                    </div>
                </div>
                <div className="game-footer-container" onClick={() => footerHandler('Standings')}>
                    <div className={`game-footer ${pressed === 'Standings' ? 'active' : ''}`}>
                        <TrophySVG active={pressed === 'Standings'}/>
                        <label className={`game-footer-label ${pressed === 'Standings' ? 'active' : ''}`}>Standings</label>
                    </div>
                </div>
            </div>
            : <></>}

            {/* (round === 0 || lateRegAvailable || (isPlayer && round < totalRounds)) && !tournamentFinished && tournamentStatus !== 2 && (isAuthenticated || !verifiedOnly) */}
            {/* Show Unregister if player is registered but hasn't played any round yet */}

            {pressed === 'Settings' || playerNickParam ? <></> 
            : isPlayer && isAuthenticated && !tournamentFinished && (round === 0 || (lateRegAvailable && !hasPlayedRound)) && !withdrawn ? 
                <button className = "btn-new-tournament" style = {{backgroundColor: 'rgb(139, 1, 0)', bottom: '50px'}} onClick = {registrationHandler} disabled = {registerPressed}>Unregister</button>
            /* Show Register if not registered and (tournament not started OR late registration available) */
            : !isPlayer && isAuthenticated && (round === 0 || lateRegAvailable) && !tournamentFinished && tournamentStatus !== 2 && !withdrawn?
                <button className = "btn-new-tournament" style = {{bottom: '50px'}} onClick = {registrationHandler} disabled = {registerPressed}>Register</button>
            /* Show Withdraw if player has played at least one round and tournament is ongoing */
            : isPlayer && isAuthenticated && round > 0 && !tournamentFinished && tournamentStatus !== 2 && round < totalRounds && !withdrawn?
                <button className = "btn-new-tournament" style = {{backgroundColor: 'rgb(139, 1, 0)', bottom: '50px'}} onClick = {leaveConfirm} disabled = {registerPressed}>Withdraw</button>
            /* Show Sign In if not authenticated and registration is possible (hide for verified-only tournaments) */
            : !isAuthenticated && (round === 0 || lateRegAvailable) && !tournamentFinished && tournamentStatus !== 2 && !verifiedOnly ?
                <button className = "btn-new-tournament" style = {{bottom: '50px'}} onClick = {redirectHandler}>Sign In</button>
            : <></>
            } 

            {/* Winner celebration modal */}
            {showWinnerModal && winnerStandings?.length > 0 && (
                <TournamentWinnerModal
                    standings={winnerStandings}
                    totalRounds={winnerTotalRounds}
                    tournamentName={tName}
                    endDate={tournamentInfo?.end_date}
                    onClose={() => setShowWinnerModal(false)}
                    verifiedOnly={verifiedOnly}
                    viewerVerified={viewerVerified}
                />
            )}
        </div>
        </LayoutContext.Provider>
        </>
    )
}

export default OnlineTournament
