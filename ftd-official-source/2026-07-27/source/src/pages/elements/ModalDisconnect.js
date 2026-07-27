import React, {useRef} from "react"


export const ModalDisconnect = () => { 
    const modalRef = useRef(null)
    const overlayRef = useRef(null)

    return (  
        <>
        <div className = {`modal-container-disconnect active`} ref = {modalRef}>
            <div className= {'modal-disconnect res-draw'}> 
                <div className = "modal-result text">Reconnecting...</div> 
            </div>
        </div>
        <div className = 'active' id='overlay' ref = {overlayRef}></div>
        </>
    )
}
