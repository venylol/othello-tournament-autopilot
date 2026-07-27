import React, { useRef, useState, useEffect } from "react"
import { findImage } from "../functions/functions"
import { TimeControl } from "./SVG"

export const StartModal = ({settings, modalFlag}) => { 
    const modalRef = useRef(null)
    const overlayRef = useRef(null)
    const [active, setActive] = useState('')

    useEffect (() => {
        modalFlag ? setActive(' active') : setActive('')
    }, [modalFlag])

    return (  
        <>
        <div className = {`modal-container${active}`} ref = {modalRef}>
            {settings ? 
            <>
                <div className= 'modal-result-cont new-game'>
                    <div className = "modal-start">NEW GAME
                    </div>
                </div>

                <div className = 'modal-avatar-container'>
                    <div className = 'avatar-large'>
                        <img className = 'photo' src ={findImage(settings?.blackNick)} alt = "avatar"/>
                    </div>
                    
                    <div className = 'avatar-large'>
                        <img className = 'photo' src ={findImage(settings?.whiteNick)} alt = "avatar"/>
                    </div>
                </div>

                <div className = 'modal-score-container'>
                    <div className = 'score-replayer-black draw'> 
                    </div>
                    
                    <div className = {`score-replayer-white draw`}> 
                    </div>
                </div>

                <div className = 'modal-nick-container'>
                    <div className = 'nick-result'>{settings?.blackNick}</div>
                    <div className = 'nick-result'>{settings?.whiteNick}</div>
                </div>
                <div className="modal-control">{settings?.control} {settings?.timeControl} + {settings?.increment}</div>
                <div className = 'modal-rating-container'>
                    <div className = 'rating'>
                        <span>
                            {settings?.blackRating}
                        </span>
                    </div>
                    <TimeControl timeControl = {settings?.timeControl} inRow = {false}/>
                    <div className = 'rating'>
                        <span>
                            {settings?.whiteRating}
                        </span>
                    </div>
                </div>

            </>
        : <></>}
        </div>
        
        <div className = {`${active}`} id='overlay' ref = {overlayRef}></div>
        </>
    )
}
