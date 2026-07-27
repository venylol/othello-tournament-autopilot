
import ReactCountryFlag from "react-country-flag";
import wofLogo from '../../assets/wof.png';
import ChineseTaipei from '../../assets/ct.jpg';
import { getName, getCode } from 'country-list';

export const CountryFlags = ({countryName, countryCode, isWOF = false}) => {
    if(!countryName && !countryCode) {
        return (
            <></>
        )
    }
    if(!countryName) countryName = getName(countryCode)
    if(!countryCode) countryCode = getCode(countryName)

    if(isWOF) {
        return (
            <>
                {countryName ? 
                    countryName === 'World Othello Federation' ? 
                    <img src = {wofLogo} alt = "WOF Logo" title = {'World Othello Federation'} style={{height: '60px', width: '80px', borderBottomLeftRadius: '0.5rem', borderTopLeftRadius: '0.5rem'}}/>
                    : countryName === 'Chinese Taipei' ?
                    <img src = {ChineseTaipei} alt = "Chinese Taipei" title = {'Chinese Taipei'} style={{height: '60px', width: '80px', borderBottomLeftRadius: '0.5rem', borderTopLeftRadius: '0.5rem'}}/>
                    :
                    <ReactCountryFlag countryCode= {countryCode} svg title = {countryName} style={{height: '60px', width: '80px', borderBottomLeftRadius: '0.5rem', borderTopLeftRadius: '0.5rem'}}></ReactCountryFlag> 
                
                : <></>
                }
            </>
        )

    }
    return (
        <>
            {countryName ? 
                countryName === 'World Othello Federation' ? 
                <img src = {wofLogo} alt = "WOF Logo" title = {'World Othello Federation'} style={{fontSize: '1.5rem', lineHeight: '1.5rem',  width: 24}}/>
                : countryName === 'Chinese Taipei' ?
                <img src = {ChineseTaipei} alt = "Chinese Taipei" title = {'Chinese Taipei'} style={{fontSize: '1.5rem', lineHeight: '1.5rem',  width: 24}}/>
                :
                <ReactCountryFlag countryCode= {countryCode} svg title = {countryName} style={{fontSize: '1.5rem', lineHeight: '1.5rem'}}></ReactCountryFlag> 
            
            : <></>
            }
        </>
    )
} 


