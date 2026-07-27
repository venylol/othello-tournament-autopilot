export const WithdrawWarningToast = ({leave}) => {
    return (
        <div className="notification-nav">
            <span>Are you sure you want to withdraw from the tournament?</span>
            <button  onClick = {leave}>Confirm</button>
        </div>     
    )
}