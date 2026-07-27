import React, {useState} from "react"



export const TranscriptCell = React.forwardRef(({id, name, transcriptArray, setTranscriptArray, focusNext, isDuplicate}, ref) => {  
    const [cellValue, setCellValue] = useState(transcriptArray[name])
    const isEmpty = !['d4', 'd5', 'e4','e5'].includes(id)
    const discColor = ['d4','e5'].includes(id) ? 'white' : 'black'

    const changeHandler = (event) => {
        const value = event.target.value
        let format = /^[0-9]+$/
        if ((value.length <= 2 && format.test(value) && parseInt(value) >= 0 && parseInt(value) <= 60 && !isNaN(parseInt(value))) || value.length === 0 ) {
            value.length === 0 ? setCellValue('') : setCellValue(parseInt(value))
            if(value.length === 2) {
                if (parseInt(value) === 0) return
                if (id === 'c4') return focusNext(28)
                if (id === 'c5') return focusNext(36)
                focusNext (name)
            }
        }
    }
    
    const handleFocus = (event) => {
        event.target.select()
    }

    const handleBlur = (event) => {
        const value = event.target.value
        const buffer = [...transcriptArray]
        buffer[name] = value.length === 0 ? null : parseInt(value)
        setTranscriptArray(buffer)
    }

    if(isEmpty) {
        return (
            <input
                className = {`cell-transcript ${isDuplicate ? 'duplicate' : ''}`}
                type = "text"
                autoComplete = "off"
                maxLength={2}
                id = {id}
                name = {name}
                value = {cellValue}
                onChange = {changeHandler}
                onFocus = {handleFocus}
                onBlur = {handleBlur}
                ref = {ref}
            />
        )
    }

    return (
        <div
         className= 'disc-transcript'
         id = {id}
         disabled = {true}
         value = {name}
         ref = {ref}
        >
            <svg className = 'disc' xmlsn = 'http://www.w3.org/2000/svg'>
                <circle className = {`disc-transcript-${discColor}`}/>
            </svg>
        </div>
    )

    
})
