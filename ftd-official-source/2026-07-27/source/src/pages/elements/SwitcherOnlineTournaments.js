import React, {useState} from 'react'
import { EditableList } from './EditableList'

export const SwitcherOnlineTournaments = ({flagTest, flagFinals, flagCategories, flagXOT, flagVerifiedOnly = false, setSettings, defaultCategories}) => {
    const [checkedTest, setCheckedTest] = useState(flagTest)
    const [checkedFinals, setCheckedFinals] = useState(flagFinals)
    const [checkedCategories, setCheckedCategories] = useState(flagCategories)
    const [checkedXOT, setCheckedXOT] = useState(flagXOT)
    const [checkedVerifiedOnly, setCheckedVerifiedOnly] = useState(flagVerifiedOnly)

    const switchHandlerFinals = () => {
        setSettings(prev=> ({...prev, finals: !prev.finals}))
        setCheckedFinals(prev => !prev)   
    }

    const switchHandlerCategories = () => {
        setSettings(prev=> ({...prev, withCategories: !prev.withCategories, categories: prev.withCategories ? [] : [...defaultCategories]}))
        setCheckedCategories(prev => !prev) 
    }

    const switchHandlerXOT = () => {
        setSettings(prev=> ({...prev, xot: !prev.xot}))
        setCheckedXOT(prev => !prev) 
    }

    const switchHandlerTest = () => {
        setSettings(prev=> ({...prev, private: !prev.private}))
        setCheckedTest(prev => !prev)
    }

    const switchHandlerVerifiedOnly = () => {
        setSettings(prev=> ({...prev, verifiedOnly: !prev.verifiedOnly}))
        setCheckedVerifiedOnly(prev => !prev)
    }



    return (
        <>
        <div className = 'options-container'>
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
            : <></>}
        <div className = 'options-container'>
            <div className = 'settings-option' onClick = {switchHandlerFinals} >{'will there be finals?'}
                <label className ='switcher otb'>
                    <input type ='checkbox' checked = {checkedFinals} onChange = {switchHandlerFinals} ></input> 
                    <span className="slider"></span>
                </label>
            </div>

            
            <div className = 'settings-option' onClick = {switchHandlerXOT} >{'is it a XOT tournament?'}
                <label className ='switcher otb'>
                    <input type ='checkbox' checked = {checkedXOT} onChange = {switchHandlerXOT} ></input> 
                    <span className="slider"></span>
                </label>
            </div>

            <div className = 'settings-option' onClick = {switchHandlerTest} >{'private tournament?'}
                <label className ='switcher otb'>
                    <input type ='checkbox' checked = {checkedTest} onChange = {switchHandlerTest} ></input> 
                    <span className="slider"></span>
                </label>
            </div>

            <div className = 'settings-option' onClick = {switchHandlerVerifiedOnly} >{'verified players only?'}
                <label className ='switcher otb'>
                    <input type ='checkbox' checked = {checkedVerifiedOnly} onChange = {switchHandlerVerifiedOnly} ></input> 
                    <span className="slider"></span>
                </label>
            </div>
        </div>
        </>

    )
}
export default SwitcherOnlineTournaments