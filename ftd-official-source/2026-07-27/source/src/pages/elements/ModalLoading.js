import React, {useRef} from "react"


export const ModalLoading = () => { 
    const modalRef = useRef(null)
    const overlayRef = useRef(null)

    return (  
        <>
        <div className = {`modal-container-disconnect active`} ref = {modalRef}>
            <div className= {'modal-disconnect res-draw'}> 
                <div className = "modal-result text">Loading...</div> 
            </div>
        </div>
        <div className = 'active' id='overlay' ref = {overlayRef}></div>
        </>
    )
}
