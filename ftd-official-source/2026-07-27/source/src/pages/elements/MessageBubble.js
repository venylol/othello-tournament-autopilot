import { useContext, useEffect, useState} from "react"


export const MessageBubble = ({message}) => {

    if (message) {
        return (
            <div className= 'bubble'>
                <div className= 'bubble-message'>{message}</div>
                <div className="bubble-div"></div>
            </div>
        )
    }
}


