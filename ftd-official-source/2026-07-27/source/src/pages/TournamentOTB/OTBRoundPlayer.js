import React  from "react"
import { getName } from 'country-list';
import { toCapitalized } from "../functions/functions";
import { CountryFlags } from "../elements/CountryFlags";

export const Player = ({player, number, isWinner}) => {
    const id = player.id
    if (id === -1) return (
        <div className = {`otb-player${number}`}>
            <div className="flag-container"/>
            <div className="otb-player-lastname">BYE</div>
        </div>
    )
    
    const surname = toCapitalized(player.surname.toLowerCase())
    const name = player.name
    const country = player.country_code
    const countryName = getName(country)
    return (
        <div className= {`otb-player${number}`}>
            <div className="flag-container"> 
                <CountryFlags countryName = {countryName} countryCode = {country}></CountryFlags>
            </div>
            <div className={`split-row ${player.left ? 'left' : ''}`}>
                <div className= {`otb-player-lastname ${isWinner ? 'winner' : ''}`}>{surname}</div>
                <div className={`otb-player-name ${isWinner ? 'winner' : ''}`}>{name}</div>
            </div>
        </div>
    )
}