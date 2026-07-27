import React, {useState, useRef} from 'react'
import { getName, getNames, getCode, search } from 'country-list';
import { checkTName } from '../functions/functions';
import { CountryFlags } from '../elements/CountryFlags';

const SwitherCategory = ({categoryName, playerCategories, setPlayerCategories}) => {
    const [checked, setChecked] = useState(false)
    const toggleRef = useRef()
    const switchHandler = () => {
        console.log('categoryName', categoryName, checked)
        setChecked(prev=> !prev)
        if (checked) {
            setPlayerCategories(playerCategories.filter(cat => cat !== categoryName))
        } else {
            setPlayerCategories(prev => [...prev, categoryName]) 
        } 
    }

    const divHandler = (e) => {
        e.preventDefault()
        switchHandler()
    }

    return (
        <div className = 'settings-option' onClick = {divHandler}>{categoryName + ' category?'}
            <label className ='switcher'>
                <input type ='checkbox' checked = {checked} onChange = {switchHandler} ref = {toggleRef}></input> 
                <span className="slider"></span>
            </label>
        </div>
    )
}

export const SwitcherCategories = ({hasCategories, categories, team, playerCategories, setPlayerCategories, setTeam, family, setFamily}) => {
    const [countries, setCountries] = useState([])
    const [validCountry, setValidCountry] = useState(true)
    const [validFamily, setValidFamily] = useState(true)
    const allCountries = getNames()

    const changeCountry = event => {
        const value = JSON.parse(JSON.stringify(event.target.value))
        if(value.length > 2) {
            setCountries(search(value))
        } else {
            setCountries([])
        }
        if (allCountries.includes(value)) {
            setValidCountry(true)
            setCountries([])
        }
        else {setValidCountry(false)}
        if (checkTName(value) || value.length === 0) {
            setTeam(value)
        }
    }

    const onCountryClick = e => {
        const code = getCode(countries[e.currentTarget.id])
        setTeam(countries[e.currentTarget.id])
        setCountries([])
        setValidCountry(true)
    }

    const changeFamilyHandler = (event) => {
        const value = JSON.parse(JSON.stringify(event.target.value))
        setFamily(value)
        value.length > 0 && checkTName(value) ? setValidFamily(true) : setValidFamily(false)
    }

    return (
        <div className="categories-conainer">
            {hasCategories ?
            <div className = 'options-container'>
                {categories.map(category => 
                    <SwitherCategory categoryName = {category.category_name} playerCategories = {playerCategories} setPlayerCategories = {setPlayerCategories} key = {category.category_name}/>
                )}
            </div> : <></>}
            {setTeam ? 
            <>
            <label className='lbl-categories'>current federation</label>
            <input className = {`input category-country ${validCountry ? 'valid' : ''}`} placeholder = "Current Federation" name = 'f3' type = "text" autoComplete ="off" value = {team} onChange = {changeCountry}/>
            
            <div className='countries-list'>
                {countries ?                               
                    countries.map( (country, idx) => 
                        <div className = 'country-select' onClick = {onCountryClick} name = {country} key = {country} id = {idx}> 
                            <div className="flag-container"> 
                                <CountryFlags countryName = {country}></CountryFlags>
                            </div>
                            <div className = 'select-text' style = {{maxWidth: "100%"}}>{country}</div>
                        </div>
                ) : <></>}
            </div>
            </> : <></>
            }
            {setFamily ?
            <div >
                <label className='lbl-categories' style = {{display: 'block'}}>family</label>
                <input className = {`input category-country ${validFamily ? 'valid' : ''}`} placeholder = "Family" name = 'f3' type = "text" autoComplete ="off" value = {family} onChange = {changeFamilyHandler}/>
            </div>:<></>}
        </div>

    )
}
export default SwitcherCategories