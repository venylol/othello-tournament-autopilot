import { useEffect, useRef, useContext } from "react"
import { useIDB } from '../../../hooks/idb.hook'
import { useNavigate } from 'react-router-dom'
import { useOutsideAlerter } from '../../../hooks/outside.click.hook'
import { useWindowSize } from '../../../hooks/resize.hook'
import { UserContext } from '../../../context/UserContext'
import { AuthContext } from '../../../context/AuthContext'
import { TrophyIcon } from './TournamentNotificationToast'
import { WOFSVG } from '../SVG'
import { CountryFlags } from '../CountryFlags'

const WOFIcon = () => (
    <div style={{ width: 30, height: 22, display: 'flex', alignItems: 'center' }}>
        <WOFSVG active={true} />
    </div>
)

const FlagIcon = ({ countryCode }) => (
    <div style={{ width: 30, height: 22, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <CountryFlags countryCode={countryCode} />
    </div>
)

export const Notifications = ({notifications, setNotifications, setNotificationsOpen, navRef}) => {

    const notficationsRef = useRef(null)
    const listRef = useRef ()
    const { updateNotification, getNotifications, getNotificationById, deleteNotification, clearAllNotifications} = useIDB()
    const {isPlaying} = useContext(UserContext)
    const {socket} = useContext(AuthContext)
    const history = useNavigate()
    const [width, listWidth, rowHeight, rowHeightExpanded, height, offsetY, boardSize] = useWindowSize(listRef, false)
    useOutsideAlerter(notficationsRef, navRef, null, setNotificationsOpen)
    const offset = 110

    async function getAllNotifications() {
        const allNotifications = await getNotifications()
        setNotifications(allNotifications)
    }

    const formatDate = (date) => {
        return date.toLocaleDateString() + ' ' + date.toLocaleTimeString()
    }
    
    const playConfirm = async (tableId, id) => {
        const url = `/invite/${tableId}`
        await updateNotification(id)
        const allNotifications = await getNotifications()
        setNotifications(allNotifications)
        history(url)
    }
    
    const rejectInvite = async (notificationId) => {
        await updateNotification(notificationId)
        const notofication = await getNotificationById(notificationId)
        socket.emit('decline-invite', notofication.tableId)
        const allNotifications = await getNotifications()
        setNotifications(allNotifications)
    }

    const deleteItem = async (notificationId) => {
        await deleteNotification(notificationId)
        const allNotifications = await getNotifications()
        setNotifications(allNotifications)
    }

    const handleClearAll = async () => {
        await clearAllNotifications()
        setNotifications([])
        // Mirror clicking the bell again — collapse the dropdown after clearing.
        setNotificationsOpen(false)
    }

    useEffect (() => {
        getAllNotifications()
    }, [])

    const viewTournament = async (tournamentId, id) => {
        await updateNotification(id)
        const allNotifications = await getNotifications()
        setNotifications(allNotifications)
        history(`/tournaments/${tournamentId}`)
    }

    const getNotificationIcon = (notification) => {
        if (notification.tournamentName === 'WOF Verification') return <WOFIcon />
        // OTB tournament push notifications carry the host country; render its flag
        // (CountryFlags handles WO → WOF logo and Chinese Taipei specially).
        if (notification.countryCode) return <FlagIcon countryCode={notification.countryCode} />
        if (notification.tournamentId) return <TrophyIcon />
        return <img src="/favicon.ico" style={{width: '30px', height: '30px'}} alt=""/>
    }

    return (
        <>
        <div className='notifications-container' ref={notficationsRef}>
            {notifications.length > 0 && (
                <div className='notifications-clear-all' onClick={handleClearAll}>clear all</div>
            )}
            <div className='notifications-list'>
                {notifications.length === 0 && (
                    <div className='notifications-empty'>There are no notifications</div>
                )}
                {notifications.map((notification) => {
                    const isTournament = !!notification.tournamentId
                    const isWof = notification.tournamentName === 'WOF Verification'
                    // OTB notifications use `otbTournamentId` (not `tournamentId`); treat them like
                    // tournament rows for header layout (show name + remove-only actions).
                    const isOtb = !!notification.otbTournamentId

                    return (
                        <div key={notification.id} className="notification-row">
                            <div className='notification-icon'>
                                {getNotificationIcon(notification)}
                            </div>
                            <div className='notification-info'>
                                <div className="notification-title-row">
                                    <span className='notification-name'>{isTournament || isWof || isOtb ? notification.tournamentName : notification.oppNick}</span>
                                    {!isTournament && !isWof && !isOtb && <span className='notification-rating'>{notification.title}</span>}
                                </div>
                                <div className="notification-msg">{notification.message}</div>
                            </div>
                            <div className="notification-actions">
                                <span className='notification-date'>{formatDate(notification.date)}</span>
                                {isTournament && !isWof ? (
                                    <div className='notification-buttons'>
                                        <button className='notification-button' onClick={() => viewTournament(notification.tournamentId, notification.id)}>View</button>
                                        <button className='notification-button remove' onClick={() => deleteItem(notification.id)}>Remove</button>
                                    </div>
                                ) : notification.active && !isPlaying ? (
                                    <div className='notification-buttons'>
                                        <button className='notification-button' onClick={() => playConfirm(notification.tableId, notification.id)}>Play</button>
                                        <button className='notification-button remove' onClick={() => rejectInvite(notification.id)}>Decline</button>
                                    </div>
                                ) : (
                                    <div className='notification-buttons'>
                                        <button className='notification-button remove' onClick={() => deleteItem(notification.id)}>Remove</button>
                                    </div>
                                )}
                            </div>
                        </div>
                    )
                })}
            </div>
        </div>
        <div className='active' id='overlay'></div>
        </>
    )
}