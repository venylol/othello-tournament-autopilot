import React, { useEffect, useRef } from 'react'
import './dropdown.css'

export const DropDownStyled = ({options, value, setValue, setFlag, setSettings, fieldName, disabled = false, placeholder = 'Select...'}) => {
    const dropdownRef = useRef(null)

    const clickHandler = (option) => {
        setValue(option)
        if(setSettings) {setSettings(prev => ({...prev, [fieldName]: option}))}
        setFlag(false)
    }

    // Close dropdown when clicking outside
    useEffect(() => {
        const handleClickOutside = (event) => {
            if (dropdownRef.current && !dropdownRef.current.contains(event.target)) {
                setFlag(false)
            }
        }
        document.addEventListener('mousedown', handleClickOutside)
        return () => document.removeEventListener('mousedown', handleClickOutside)
    }, [setFlag])

    return (
        <div className='dropdown-styled' ref={dropdownRef}>
            <div className='dropdown-options'>
                {options.map((option, idx) => (
                    <div 
                        className={`dropdown-option ${option === value ? 'selected' : ''}`} 
                        onClick={() => clickHandler(option)} 
                        key={idx}
                    >
                        <span className='dropdown-option-text'>{option}</span>
                        {option === value && <span className='dropdown-checkmark'>✓</span>}
                    </div>
                ))}
            </div>
        </div>
    )
}

export const DropDownInput = ({options, value, onChange, setValue, setSettings, fieldName, disabled = false, placeholder = 'Select...', formatOption = null}) => {
    const [isOpen, setIsOpen] = React.useState(false)
    const dropdownRef = useRef(null)

    const displayValue = (opt) => {
        if (formatOption) return formatOption(opt)
        return opt
    }

    const clickHandler = (option) => {
        if (onChange) {
            onChange(option)
        } else if (setValue) {
            setValue(option)
        }
        if(setSettings) {setSettings(prev => ({...prev, [fieldName]: option}))}
        setIsOpen(false)
    }

    // Close dropdown when clicking outside
    useEffect(() => {
        const handleClickOutside = (event) => {
            if (dropdownRef.current && !dropdownRef.current.contains(event.target)) {
                setIsOpen(false)
            }
        }
        document.addEventListener('mousedown', handleClickOutside)
        return () => document.removeEventListener('mousedown', handleClickOutside)
    }, [])

    return (
        <div className='dropdown-container' ref={dropdownRef}>
            <div 
                className={`dropdown-input ${disabled ? 'disabled' : ''} ${isOpen ? 'open' : ''}`}
                onClick={() => !disabled && setIsOpen(prev => !prev)}
            >
                <span className='dropdown-value'>{displayValue(value) || placeholder}</span>
                <span className={`dropdown-arrow ${isOpen ? 'open' : ''}`}>▼</span>
            </div>
            {isOpen && !disabled && (
                <div className='dropdown-options'>
                    {options.map((option, idx) => (
                        <div 
                            className={`dropdown-option ${String(option) === String(value) ? 'selected' : ''}`} 
                            onClick={() => clickHandler(option)} 
                            key={idx}
                        >
                            <span className='dropdown-option-text'>{displayValue(option)}</span>
                            {String(option) === String(value) && <span className='dropdown-checkmark'>✓</span>}
                        </div>
                    ))}
                </div>
            )}
        </div>
    )
}

export default DropDownStyled
