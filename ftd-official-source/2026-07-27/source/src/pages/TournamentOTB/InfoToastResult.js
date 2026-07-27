import React, {useContext} from "react"

export const InfoToastResult = ({round, id, setPressed, socket}) => {
    const toastButton = () => {
        setPressed(round)
        socket.emit('get-otb-rounds', id)
    } 

    return (
        <div className="notification-nav" onClick = {toastButton}>
            <span>New result is availiable</span>
        </div>
    )
}