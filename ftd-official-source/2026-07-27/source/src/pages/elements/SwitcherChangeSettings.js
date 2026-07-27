import React, {useState} from 'react'
import { EditableList } from './EditableList'

export const Switcher = ({flagFinals, setFinals, allowedToChange}) => {
    const [checkedFinals, setCheckedFinals] = useState(flagFinals)

    // const switchHandlerLO = () => {
    //     if(!flagTest) {
    //         setSettings(prev=> ({...prev, liveOthello: !prev.liveOthello}))
    //         setCheckedLO(prev => !prev)
    //     }
    // }

    const switchHandlerFinals = () => {
        if (allowedToChange) {
            setFinals(prev => !prev)
            setCheckedFinals(prev => !prev) 
        }  
    }

    // const switchHandlerCategories = () => {
    //         setSettings(prev=> ({...prev, withCategories: !prev.withCategories, categories: prev.withCategories ? [] : [...defaultCategories]}))
    //         setCheckedCategories(prev => !prev) 
    // }

    // const switchHandlerXOT = () => {
    //     setSettings(prev=> ({...prev, xot: !prev.xot}))
    //     setCheckedXOT(prev => !prev) 
    // }

    // const switchHandlerCountry = () => {
    //     setSettings(prev=> ({...prev, sameCountry: !prev.sameCountry}))
    //     setCheckedCountry(prev => !prev) 
    // }

    // const switchHandlerTest = () => {
    //     if(!flagTest) {
    //         setSettings(prev=> ({...prev, private: !prev.private, liveOthello: false}))
    //         setCheckedTest(prev => !prev)
    //         setCheckedLO(false)
    //     } else {
    //         setSettings(prev=> ({...prev, private: !prev.private}))
    //         setCheckedTest(prev => !prev)
    //     }
    // }

    return (
        <>
        {/* <div className = 'options-container'>

            <div className = 'settings-option' onClick = {switchHandlerCategories} >{'will there be categories?'}
                <label className ='switcher otb'>
                    <input type ='checkbox' checked = {checkedCategories} onChange = {switchHandlerCategories} ></input> 
                    <span className="slider"></span>
                </label>
            </div>
        </div>

            {checkedCategories? 
                        <EditableList defaultOptions = {defaultCategories} setSettings = {setSettings} fieldName = {'categories'}
                        /> 
            : <></>} */}
        <div className = 'options-container'>
            <div className = 'settings-option' onClick = {switchHandlerFinals} >{'will there be finals?'}
                <label className ='switcher otb'>
                    <input type ='checkbox' checked = {flagFinals} onChange = {switchHandlerFinals} ></input> 
                    <span className="slider"></span>
                </label>
            </div>

            {/* <div className = 'settings-option' onClick = {switchHandlerCountry} >{'same country penalty?'}
                <label className ='switcher otb'>
                    <input type ='checkbox' checked = {checkedCountry} onChange = {switchHandlerCountry} ></input> 
                    <span className="slider"></span>
                </label>
            </div>

            <div className = 'settings-option' onClick = {switchHandlerXOT} >{'is it a XOT tournament?'}
                <label className ='switcher otb'>
                    <input type ='checkbox' checked = {checkedXOT} onChange = {switchHandlerXOT} ></input> 
                    <span className="slider"></span>
                </label>
            </div>

            <div className = 'settings-option' onClick = {switchHandlerLO} >{'re-stream games to liveothello.com?'}
                <label className ='switcher otb'>
                    <input type ='checkbox' checked = {checkedLO} onChange = {switchHandlerLO} ></input> 
                    <span className="slider"></span>
                </label>
            </div>

            <div className = 'settings-option' onClick = {switchHandlerTest} >{'test tournament?'}
                <label className ='switcher otb'>
                    <input type ='checkbox' checked = {checkedTest} onChange = {switchHandlerTest} ></input> 
                    <span className="slider"></span>
                </label>
            </div> */}

        </div>
        </>

    )
}
export default Switcher