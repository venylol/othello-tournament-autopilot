import React from 'react'

export const DropDown = ({options, setValue, setFlag, setSettings, fieldName}) => {
    console.log(options)
    const clickHandler = (option) => {
        setValue(option)
        if(setSettings) {setSettings(prev => ({...prev, [fieldName]:option}))}
        setFlag(false)
    }
    return (
        <div className='countries-list'>
        {options.map(option => 
            <div className = 'country-select' onClick = {() => clickHandler(option)} key = {option}>
                <div className="flag-container"></div>
                <div className = 'select-text'>{option}</div>
            </div>
        )}
        </div>
    )
}
export default DropDown