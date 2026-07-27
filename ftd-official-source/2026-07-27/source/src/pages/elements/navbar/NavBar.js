import React, {useContext, useEffect, useRef, useState} from "react"
import { AuthContext } from '../../../context/AuthContext'
import { UserContext } from '../../../context/UserContext'
import { findImage } from "../../functions/functions"
import { useNavigate, useLocation } from 'react-router-dom'
import { ToastContainer, toast } from 'react-toastify';
import { LayoutContext } from "../../../context/LayoutContext"
import { Bell, Friends, DownloadSVG, ExitFullScreen, FullScreen, BackArrow, WOFSVG, SettingsSVG } from "../SVG"
import { useIDB } from '../../../hooks/idb.hook'
import { usePWAInstall } from '../../../hooks/pwaInstall.hook'
import { Notifications } from './Notifications'
import { WarningToast } from './LeaveWarning'
import { NotificationToast } from './NotificationToast'
import { TournamentNotificationToast, TrophyIcon } from './TournamentNotificationToast'
import "./notifications.css"
import "./navbar.css"

//add onClick event to avatar!

export const NavBar = ({isHome, isGame, text, tournamentId, fromProfile, onSettingsClick}) => {
    
    const {isAuthenticated, socket} = useContext(AuthContext)
    const {nick, typing, isPlaying, setNotificationsOpen, notificationsOpen, isMobile, isFullScreen, isFirefox} = useContext(UserContext)
    const {gameBoard, height} = useContext(LayoutContext)
    // const {nick, typing, isPlaying, setNotificationsOpen, notificationsOpen} = useContext(UserContext)
    // const {isMobile, isFullScreen, isFirefox, gameBoard, height} = useContext(LayoutContext)
    // console.log(isMobile, isFullScreen)
    const [unread, setUnread] = useState(0)
    const [notifications, setNotifications] = useState([])
    const history = useNavigate()
    const location = useLocation()
    const toastClickedRef = useRef(null)
    const toastRef = useRef(null)
    const navBarRef = useRef(null)
    const { addNotification, getUnreadNotifications, updateNotification, markReadAll, getNotifications, getNotificationById } = useIDB()
    const { canInstall, isInstalled, installApp } = usePWAInstall()
    const showDownloadIcon = isMobile && !isInstalled
    const delay = 3000

    async function getUnread(opened = false) {
        const unread = !opened ? await getUnreadNotifications() : 0
        setUnread(unread)
    }

    async function getAllNotifications() {
        const allNotifications = await getNotifications()
        setNotifications(allNotifications)
    }

    useEffect(() => {
        getUnread()
        getAllNotifications()
        if('serviceWorker' in navigator) {
            navigator.serviceWorker.ready.then(reg => {
                reg.getNotifications().then(notifications => {
                  for (let i = 0; i < notifications.length; i += 1) {
                    notifications[i].close();
                  }
                });
            });
        }

        socket.on('error', message => {
            toast.dismiss()
            toast.error(message, {autoClose: 2000})
        })
        
        return () => {
            setNotificationsOpen(false)
            socket.off('error')
        }
    }, [])

    // Show install toast for mobile users who haven't installed the app
    useEffect(() => {
        if (!isMobile || isInstalled || !canInstall) return
        if (localStorage.getItem('pwa-install-dismissed') === 'true') return

        const toastId = 'pwa-install-toast'
        const handleInstall = async () => {
            toast.dismiss(toastId)
            await installApp()
        }
        const handleDismiss = () => {
            localStorage.setItem('pwa-install-dismissed', 'true')
            toast.dismiss(toastId)
        }

        toast.info(
            <div className='install-toast-content'>
                <strong>Get the Flip the Disc app!</strong>
                <span>Enjoy fullscreen mode, receive only important push notifications about your games and tournaments, and upcoming offline mode.</span>
                <div className='install-toast-actions'>
                    <button className='install-toast-btn install-toast-accept' onClick={handleInstall}>Install</button>
                    <button className='install-toast-btn install-toast-dismiss' onClick={handleDismiss}>Dismiss</button>
                </div>
            </div>,
            {
                toastId,
                autoClose: false,
                closeOnClick: false,
                // icon: () => <img src="/favicon.ico" style={{width: '30px', height: '30px'}} alt=""/>
            }
        )
    }, [isMobile, isInstalled, canInstall])

    useEffect(() => { // prevent browser back button 
        if (isGame && isPlaying && location.hash.split('#')[1] === 'start') {
            history(`${location.pathname}`, { replace: false });
            history(`${location.pathname}#game`, { replace: false });
        }
        else if (isGame && isPlaying && location.hash.split('#')[1] !== 'game' ) {
            history(`${location.pathname}#game`, { replace: false });
            leaveConfirm()
        }
    }, [location, isGame, isPlaying, history]);
    

    useEffect(() => {
        socket.on('invitation', async (tableId, tableSettings, oppNick, rating, dan) => {
            //add color to notification
            const notificationId = tableId + tableSettings.timeControl + tableSettings.increment + tableSettings.xot
            const title =` ${rating} ${dan}`
            const message = `challenged you to ${tableSettings.timeControl}|${tableSettings.increment}${tableSettings.xot? ' XOT' : ''}`
            const notification = {
                id: notificationId,
                active: true,
                oppNick: oppNick,
                message: message,
                title: title,
                tableId: tableId,
                read: notificationsOpen,
                date: new Date()
            }
            if (!isPlaying && !notificationsOpen) {   
                toast.success(NotificationToast({tableId, title, oppNick, message, playConfirm, rejectInvite, notificationId}),
                {
                    autoClose: delay, 
                    toastId: notificationId,
                    onOpen: () => {toastClickedRef.current = null},
                    onClose: async () => {
                        await getUnread()
                    },
                    icon: ({theme, type}) =>  <img src="/favicon.ico" style ={{width: '30px', heigth: '30px'}}/>
                })
            }

            toastRef.current = notificationId
            await addNotification(notification)
            if(!notificationsOpen) {await getUnread(notificationsOpen)}
            await getAllNotifications()
        })

        socket.on('invitation-cancel', async notificationId => {
            // console.log(notificationId)
            toast.dismiss(notificationId)
            await updateNotification(notificationId)
            await getUnread()
            await getAllNotifications()
        })

        socket.on('tournament-notification', async (data) => {
            const notificationId = data.id
            const notification = {
                id: notificationId,
                active: false,
                oppNick: null,
                tournamentName: data.tournamentName,
                tournamentId: data.tournamentId,
                message: data.message,
                title: data.tournamentName,
                read: notificationsOpen,
                date: new Date()
            }
            if (!notificationsOpen) {
                const isWof = data.tournamentName === 'WOF Verification'
                const isAvatar = data.tournamentName === 'Avatar Request'
                toast.info(
                    TournamentNotificationToast({
                        tournamentId: data.tournamentId,
                        tournamentName: data.tournamentName,
                        message: data.message,
                        format: data.format,
                        startDate: data.startDate
                    }),
                    {
                        autoClose: 10000,
                        toastId: notificationId,
                        onClose: async () => {
                            await getUnread()
                        },
                        icon: () => isWof ? <WOFSVG active={true} /> : isAvatar ? <img src='/api/avatar/-default' alt='avatar' style={{width: 30, height: 30, borderRadius: 6}} /> : <TrophyIcon />
                    }
                )
            }
            await addNotification(notification)
            if (!notificationsOpen) { await getUnread(notificationsOpen) }
            await getAllNotifications()
        })

        return () => {
            socket.off('invitation')
            socket.off('invitation-cancel')
            socket.off('tournament-notification')
        }
    },[socket, notificationsOpen, isPlaying])


    const leave = () => {
        // Browser-back behaviour: if we have a previous in-app entry, just pop.
        // This avoids loops (e.g. profile → replayer → profile → replayer …)
        // because navigating via history(-1) doesn't push a new entry.
        const canGoBack = location.key && location.key !== 'default'

        // On profile pages, behave like browser back
        if (location.pathname.startsWith('/profile/') || location.pathname === '/profile') {
            if (canGoBack) history(-1)
            else history('/')
            return
        }
        // Return to profile page if navigating back from a game replayer opened from profile.
        // Use history(-1) when possible so we don't push a new /profile entry that would
        // create an infinite back-and-forth between the replayer and the profile page.
        if (fromProfile) {
            if (canGoBack) history(-1)
            else history(`/profile/${encodeURIComponent(fromProfile)}`)
            return
        }
        // Return to by-player page if navigating back from a game opened from that view
        const byPlayerNick = location.state?.byPlayerNick
        // console.log(location.state, tournamentId, location.pathname, location.pathname.split('game/')[1])
        if (byPlayerNick) {
            if (tournamentId) {
                history(`/tournaments/${tournamentId}/player/${encodeURIComponent(byPlayerNick)}`)
                return
            }
        }

        if (tournamentId && location.pathname.includes('/player/')) {
            history(`/tournaments/${tournamentId}`)
            return
        }

        const tableId = location.pathname.split('game/')[1]
        if (tableId && !tournamentId) {
            history('/lobby')
            return
        }
        if (tableId && tournamentId && isPlaying && isGame) {
            history(`/tournaments/${tournamentId}`)
            // console.log('navbar sent unregister, isplaying', isPlaying)
            if (isPlaying) socket.emit('unregister', tournamentId)
            return
        }
        
        if (tableId && tournamentId && !isPlaying) {
            history(`/tournaments/${tournamentId}`)
            return
        }

        const path = location.pathname.charAt(location.pathname.length - 1) === "/" ? location.pathname.substring(0, location.pathname.length - 1) : location.pathname
        const newURL = path.substring(0, path.lastIndexOf("/"))
        newURL.length > 0 ? history(newURL) : history('/')
    }

    const fullsScreenHandler = () => {
        // console.log('FullScreenHandler:', isFullScreen, isMobile )
        if(isFullScreen) {
            // setShouldResize(false)
            try {
                if (document.exitFullscreen) {
                    document.exitFullscreen();
                  } else if (document.webkitExitFullscreen) {
                    document.webkitExitFullscreen();
                  } else if (document.mozCancelFullScreen) {
                    document.mozCancelFullScreen();
                  }
                  
                window.scrollTo(0,0)
            } catch (e) {console.log(e)}
            
        } 
        if(!isFullScreen && isMobile && !isFirefox ) { 
            const elem = document.getElementById('root')
            try {
                if (elem.requestFullscreen) { elem.requestFullscreen({navigationUI: 'show'}) } 
                
                else if (elem.webkitRequestFullscreen) { elem.webkitRequestFullscreen({navigationUI: 'show'}) }
                
                else if (elem.webkitEnterFullscreen) { elem.webkitEnterFullscreen({navigationUI: 'show'}) }

                else if (elem.mozRequestFullScreen) { elem.mozRequestFullScreen({navigationUI: 'show'}) }

                window.scrollTo(0,0)
            } catch (e) {console.log (e)}
        }
    }

    const leaveConfirm = () => {
        if(isGame && isPlaying) {
        toast.dismiss()
        toast.warn(WarningToast({leave, isTournament: !!tournamentId}))}
        else {
            leave()
        }
    }

    const playConfirm = async (tableId, id) => {
        const url = `/invite/${tableId}`
        // console.log(id)
        await updateNotification(id)
        await getUnread()
        await getAllNotifications()
        toastClickedRef.current = true
        history(url)
    }
    
    const rejectInvite = async () => {
        toastClickedRef.current = true
        toast.dismiss(toastRef.current)
        const notofication = await getNotificationById(toastRef.current)
        socket.emit('decline-invite', notofication.tableId)
        await updateNotification(toastRef.current)
        await getUnread()
        await getAllNotifications()
    }

    const notificationHandler = async () => {
        toast.dismiss()
        setNotificationsOpen(prev => !prev)
        setUnread(0)
        markReadAll()
    } 

    return (
        <>
        {height > gameBoard + 88 || !typing ?
        <div className = 'navbar' ref = {navBarRef}>
            {!isHome ? 
                <div className = 'return-button nav' onClick={leaveConfirm}>
                    <BackArrow/>
                </div>
            :
                <div className = 'avatar-medium nav' onClick={() => isAuthenticated && nick ? history(`/profile/${nick}`) : history('/login')} style={{cursor: 'pointer'}}>
                    <img className = 'photo' src = {findImage(nick)} alt = "avatar"/>
                </div>
            }
            <div className = {text ? 'new-logo' : 'logo'}>
                 <span>{text ? text : 'Flip The Disc'}</span>
            </div>
            {isAuthenticated ? 
            <div className= "nav-buttons">
                <div className = "messages nav" onClick = {notificationHandler}>
                    <Bell opened = {notificationsOpen}/>
                    {unread > 0 ? <span className='notification-counter'>{unread}</span> : <></>} 
                </div>
                {isGame && !isFullScreen && isMobile?
                    <div className = "friends nav" onClick = {fullsScreenHandler}>
                        <FullScreen />
                    </div>
                : isGame && isFullScreen && isMobile?
                    <div className = "friends nav" onClick = {fullsScreenHandler}>
                        <ExitFullScreen />
                    </div>
                : 
                    <div className = "friends nav" onClick = {onSettingsClick ? onSettingsClick : showDownloadIcon && canInstall ? installApp : undefined} style = {showDownloadIcon || onSettingsClick ? {cursor: 'pointer'} : {}}>
                        {onSettingsClick ? <SettingsSVG /> : showDownloadIcon ? <DownloadSVG /> : <Friends />}
                    </div>
                }
                
            </div>
            : 
            <div className= "nav-buttons">
                <div className = "messages nav">
                    {/* <Bell/> */}
                </div>
                {isGame && !isFullScreen && isMobile?
                    <div className = "friends nav" onClick = {fullsScreenHandler}>
                        <FullScreen />
                    </div>
                : isGame && isFullScreen && isMobile?
                    <div className = "friends nav" onClick = {fullsScreenHandler}>
                        <ExitFullScreen />
                    </div>
                : 
                    <div className = "friends nav" onClick = {onSettingsClick ? onSettingsClick : showDownloadIcon && canInstall ? installApp : undefined} style = {showDownloadIcon || onSettingsClick ? {cursor: 'pointer'} : {}}>
                        {onSettingsClick ? <SettingsSVG /> : showDownloadIcon ? <DownloadSVG /> : <Friends />}
                    </div>
                }
            </div>}
        </div>
        : <></>
        }
        {notificationsOpen ? 
            <Notifications notifications = {notifications} setNotifications = {setNotifications} setNotificationsOpen = {setNotificationsOpen} navRef = {navBarRef}/>
        : <></>}
        <ToastContainer 
            theme = "dark"
            pauseOnFocusLoss= {false}
            draggable = {false}
            autoClose={false}
            newestOnTop = {true}
            pauseOnHover = {false}
            closeOnClick = {true}
            limit={1}
        />
        </>
    )
}
