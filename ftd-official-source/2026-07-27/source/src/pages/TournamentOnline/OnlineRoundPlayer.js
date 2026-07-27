import React  from "react"
import { getName } from 'country-list';
import { toCapitalized, toNameCase } from "../functions/functions";
import { CountryFlags } from "../elements/CountryFlags";

export const Player = ({player, number, isWinner, verifiedOnly = false, viewerVerified = false}) => {
    const id = player.id
    if (id === -1) return (
        <div className = {`online-player${number}`}>
            <div className="flag-container"/>
            <div className="online-player-lastname">BYE</div>
        </div>
    )
    
    const useWofName = verifiedOnly && viewerVerified && player.wof_name
    const surname = useWofName ? toNameCase(player.wof_name) : player.surname
    const name = useWofName ? '' : player.name
    const country = player.country_code
    const countryName = getName(country)
    return (
        <div className= {`online-player${number}`}>
            <div className="flag-container"> 
                <CountryFlags countryName = {countryName} countryCode = {country}></CountryFlags>
            </div>
            <div className={`split-row ${player.left ? 'left' : ''}`}>
                <div className= {`online-player-lastname ${isWinner ? 'winner' : ''}`}>{surname}</div>
                <div className={`online-player-name ${isWinner ? 'winner' : ''}`}>{name}</div>
            </div>
        </div>
    )
}