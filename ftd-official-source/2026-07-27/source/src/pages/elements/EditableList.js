import React, {useState, useRef, useEffect} from 'react'

export const EditableList = ({defaultOptions, setSettings, fieldName}) => {
    const [list, setList] = useState([...defaultOptions])
    const [validName, setValidName] = useState(false)
    const inputRef = useRef(null)

    const clickHandler = () => {
        const newCategory = inputRef.current.value.toLowerCase().trim()
        setList(prev => [...prev, newCategory])
        if(setSettings) {setSettings(prev => ({...prev, [fieldName]:[...prev[fieldName], newCategory]}))}
        inputRef.current.value = ''
        setValidName(false)
    }

    const removeCategory = (index) => {
        setList(list.filter((val, idx) => idx !== index))
        if(setSettings) {setSettings(prev => ({...prev, [fieldName]:list.filter((val, idx) => idx !== index)}))}
    }

    const changeName = (e) => {
        const val = e.target.value.toLowerCase().trim()
        if(checkCategoryName(val) && val.length > 2 && !list.includes(val)) setValidName(true)
        else setValidName(false)
    }

    const onEnter = (event) => {
        if(event.key === 'Enter' && validName) clickHandler()
    }

    const checkCategoryName = str => {
        let format = /[`!@#$%^&*()+\=\[\]{};"\\|<>\/?~]/
        let formatLogin = /^[A-Za-z0-9_'\-\., ]+$/
        if (str.length > 20 || format.test(str) || !formatLogin.test(str)) {
            return false
        }
        return true
    }

    return (    
        <>
        <div className="card-content">
            <input className = {`input category ${validName ? 'valid' : ''}`} placeholder = "New Category" name = 'f3' type = "text" autoComplete ="off" onChange = {changeName} ref = {inputRef} onKeyUp={onEnter}/>
            <button className = {`add-button category ${validName ? 'valid' : ''}`} onClick = {clickHandler} style = {{fontSize: validName ? '24px' : '14px'}} disabled = {!validName}>+</button>
        </div>
        
        <div className='category-list'>
        {list.map((item, idx) => 
            <div className = 'category-select' key = {idx}>
                <div className = 'select-text category'>{item}</div>
                <button className = 'remove-button category' id = {idx} onClick = {() => removeCategory(idx)}>-</button>
            </div>
        )}
        </div>
        </>
    )
}
export default EditableList


                    