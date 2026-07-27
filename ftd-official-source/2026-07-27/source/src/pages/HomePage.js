import React, {useContext, useEffect, useState} from 'react'
import { AuthContext } from '../context/AuthContext'
import { UserContext } from '../context/UserContext'
import { useNavigate } from "react-router-dom"
import { NavBar } from './elements/navbar/NavBar'
import { useIDB } from '../hooks/idb.hook'
import { swVersion } from '../swDev'
import { usePWAInstall } from '../hooks/pwaInstall.hook'
import { useNotificationPermission } from '../hooks/notificationPermission.hook'

export const Homepage = () => {
    const {token, isAuthenticated, logout, socket} = useContext(AuthContext) 
    const {nick, isOnline, isMobile} = useContext(UserContext)
    const [online, setOnline] = useState(0)
    const [lobby, setLobby] = useState(0)
    const [games, setGames] = useState (0)
    const [isAdmin, setIsAdmin] = useState(false)
    const [appVersion, setAppVersion] = useState(null)
    const history = useNavigate();
    const { updateList } = useIDB()
    const { canInstall, isInstalled, isInWebView, installApp } = usePWAInstall()
    const { canAsk, isDenied, requestPermission } = useNotificationPermission()
    const [notifDismissed, setNotifDismissed] = useState(
        () => sessionStorage.getItem('notif-prompt-dismissed') === 'true'
    )

    // Show install prompt only for mobile users who don't have the app
    const showInstallButton = isMobile && !isInstalled && canInstall

    useEffect(() => {
        const unsub = swVersion.subscribe(setAppVersion)
        swVersion.request()
        return unsub
    }, [])

    useEffect (()=> {
        socket.emit('get-online')
        socket.emit('is-admin')
        socket.on('online-count', data => {
            // console.log(data)
            if (data.online) setOnline(data.online)
            if (data.lobbyCounter) setLobby(data.lobbyCounter)  
            if (data.games) setGames(data.games)
        })
        socket.on('check-notifications', invitations => {
            updateList(invitations)
            //update notifications that are not found in the list
        })
        socket.on('is-admin', value => {
            setIsAdmin(value)
        })


    
        return () => {
            socket.off('online-count')
            socket.off('is-admin')
            socket.off('check-notifications')
            socket.emit('unsub-online')
        }
    },[isOnline])

    useEffect (() => {
        if(isAuthenticated) {
            socket.emit('check-invitations')
        }
    },[isAuthenticated])

    const playOnlineHandler = () => {      
            history(`/lobby`)
    }

    const OnlineTournamentsHandler = () => {      
        history(`/tournaments`)
}

    const LiveEventsHandler = () => {          
            history(`/live`)
    }

    const login = () => {
        history(`/login`)
    }

    const toProfile = () => {
        history(`/profile/${nick.toLowerCase()}`)
    }

    const toAdmin = () => {
        history(`/users`)
    }

    const dismissNotifPrompt = () => {
        setNotifDismissed(true)
        sessionStorage.setItem('notif-prompt-dismissed', 'true')
    }

    return (
        <>
        <NavBar isHome = {true}></NavBar>
        {/* <div className = 'main-message-container'> 
            <img src ={construction} alt = "Under Construction" style = {{width: '85px', height: '85px', position: 'relative'}}/>
            <div className = 'main-message'>
                <span>Website is under construction!</span>
                <br></br>
                <span className='secondary-message'>if you want to run an over the board Othello tournament contact us via 
                    <a className = 'email-link' href = 'mailto: flipthediscs@gmail.com'> email</a>
                </span>
            </div>  
            <img src ={construction} alt = "Under Construction" style = {{width: '85px', height: '85px', position: 'relative'}}/>      
        </div> */}
{/* 
        <div className = 'main-message-container'> 
            <div className = 'main-message'>
                <span>Website is under construction!</span>
                <br></br>
                <span className='secondary-message'>if you want to run an over the board Othello tournament contact us via 
                    <a className = 'email-link' href = 'mailto: flipthediscs@gmail.com'> email</a>
                </span>
            </div>  

        </div> */}

            <div className = 'online-count'>
                <span className = 'online-count'>Online: {online} Lobby: {lobby} Games: {games}</span>
            </div>

        <main className = 'main-buttons'>
            <button id = 'lobby' className = 'main-button' onClick = {playOnlineHandler} disabled = {!isOnline} >Play Online</button>
            <button className = 'main-button' disabled = {false} onClick = {OnlineTournamentsHandler} >Online Tournaments</button>
            <button className = 'main-button' onClick = {LiveEventsHandler} >Live Events</button>
            <button className = 'main-button-logout' disabled = {!isAuthenticated || !isOnline} onClick={toProfile} >My Profile</button>
            {isAdmin ? 
                <button className = 'main-button-logout' onClick={toAdmin} >Admin</button>
            : <></>
            }
            <button className = 'main-button-logout' onClick = {isAuthenticated? logout : login} disabled = {!isOnline}>{isAuthenticated? 'Logout' : 'Login'}</button>
            {showInstallButton && (
                <button className = 'main-button main-button-install' onClick = {installApp}>Install App</button>
            )}
        </main>
        {appVersion && <footer className='app-version-footer'>
            <span>{appVersion.replace('app_', '')}</span>
        </footer>}

        {isInstalled && !notifDismissed && canAsk && (
            <div className='notif-permission-banner'>
                <div className='notif-permission-text'>
                    <strong>Enable Notifications</strong>
                    <span>Get notified about game invitations and upcoming tournaments.</span>
                    <span className='notif-hint'>You will be able to configure notifications in your profile later.</span>
                </div>
                <div className='notif-permission-actions'>
                    <button className='notif-enable-button' onClick={requestPermission}>Enable</button>
                    <button className='notif-dismiss-button' onClick={dismissNotifPrompt}>Later</button>
                </div>
            </div>
        )}

        {isInstalled && isDenied && !notifDismissed && (
            <div className='notif-permission-banner notif-denied'>
                <div className='notif-permission-text'>
                    <strong>Notifications Blocked</strong>
                    <span>You've blocked notifications. To receive game invites and tournament alerts, enable notifications in your browser settings for this site.</span>
                </div>
                <button className='notif-dismiss-button' onClick={dismissNotifPrompt}>Dismiss</button>
            </div>
        )}

        {isInWebView && isMobile && !isInstalled && (
            <div className='notif-permission-banner'>
                <div className='notif-permission-text'>
                    <strong>Open in Browser</strong>
                    <span>You're viewing this in an in-app browser. For the best experience, open this page in your regular browser and install the Flip the Disc app.</span>
                </div>
            </div>
        )}
        </>
    )
};

export default Homepage;