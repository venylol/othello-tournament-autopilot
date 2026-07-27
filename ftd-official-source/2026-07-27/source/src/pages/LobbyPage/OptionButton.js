import React from "react"

export const OptionButton = ({ id, value, onClick, className, timeControl, text, disabled}) => {
    const handleClick = () => {
        onClick(value)
    }
    return (
        <button id = {id} className = {timeControl === value ? className + ' clicked' : className} onClick = {handleClick} disabled = {disabled}>{text}</button>
    )
}
