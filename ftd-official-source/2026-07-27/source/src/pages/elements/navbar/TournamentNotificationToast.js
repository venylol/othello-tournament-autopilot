const TrophyIcon = () => (
    <svg viewBox="0 0 24 24" fill="#FFD700" xmlns="http://www.w3.org/2000/svg" style={{width: '30px', height: '30px', flexShrink: 0}}>
        <path d="M7 4V2H17V4H20C20.5523 4 21 4.44772 21 5V8C21 9.65685 19.6569 11 18 11H17.9291C17.4439 13.3316 15.4488 15.1 13 15.4529V18H16V20H8V18H11V15.4529C8.55118 15.1 6.55613 13.3316 6.07089 11H6C4.34315 11 3 9.65685 3 8V5C3 4.44772 3.44772 4 4 4H7ZM7 6H5V8C5 8.55228 5.44772 9 6 9H7V6ZM17 9H18C18.5523 9 19 8.55228 19 8V6H17V9Z"/>
    </svg>
)

export const TournamentNotificationToast = ({tournamentId, tournamentName, message, format, startDate}) => {
    const hasSchedule = startDate && format
    const localTime = hasSchedule ? new Date(startDate).toLocaleTimeString([], {hour: '2-digit', minute: '2-digit'}) : null

    return (
        <div className="notification-nav" onClick={() => { window.location.href = tournamentId ? `/tournaments/${tournamentId}` : '#' }} style={{cursor: 'pointer'}}>
            <div>
                <span className='invitation-nick'>{tournamentName}</span>
            </div>     
            <div>
                <span className='invitation-message'>{message}{hasSchedule ? ` (at ${localTime}) • ${format}` : ''}</span>
            </div>
        </div>
    )
}

export { TrophyIcon }
