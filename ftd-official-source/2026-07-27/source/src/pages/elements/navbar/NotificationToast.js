export const NotificationToast = ({tableId, title, oppNick, message, playConfirm, rejectInvite, notificationId}) => {
    return (
        <div className="notification-nav">
            <div>
                <span className = 'invitation-nick'>{oppNick}</span>
                <span className = 'invitation-title'>{title}</span>
            </div>     
            <div>
                <span className = 'invitation-message'>{message}</span>
            </div>
            <div className = 'invitation-buttons'>
                <button className = 'notification-button' onClick = {() => playConfirm(tableId, notificationId)}>Play</button>   
                <button className = 'notification-button' style = {{backgroundColor: '#8b0100'}} onClick = {() => rejectInvite()}>Decline</button> 
            </div>
        </div>
    )
}