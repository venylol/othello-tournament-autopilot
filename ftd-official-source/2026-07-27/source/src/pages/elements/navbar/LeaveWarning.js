export const WarningToast = ({leave, isTournament}) => {
    if (isTournament) {
    return (
        <div className="notification-nav">
            <span>If you leave now you will forfeit the game and will be withdrawn from the tournament!</span>
            <button  onClick = {leave}>Confirm</button>
        </div>     
    )}
    return (
        <div className="notification-nav">
            <span>If you leave now you will forfeit the game!</span>
            <button  onClick = {leave}>Confirm</button>
        </div>     
    )
}