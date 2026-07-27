import React, {useRef, useContext} from "react"
import { getName } from 'country-list';
import { FixedSizeList } from "react-window"
import { useWindowSize } from '../../hooks/resize.hook'
import { findImage } from "../functions/functions"
import { TimeControl } from "../elements/SVG"
import { AuthContext } from '../../context/AuthContext'
import { CountryFlags } from "../elements/CountryFlags";

export const GamesList = ({data}) => {
    // console.log ('GamesList', data)
    const listRef = useRef ()
    const {userId, isAuthenticated, socket} = useContext(AuthContext)
    const [width, listWidth, rowHeight, rowHeightExpanded, height, offsetY, boardSize] = useWindowSize(listRef, false)
    const offset = 150
    const listHeight = Math.min(data.length * rowHeight, height-offset)
  
    const Row = ({index, style}) => {
        // console.log(data[index])
        const key = data[index][0]
        const timeControl = data[index].timeControl
        const danP1 = data[index].player1.dan >= 0 ? `${data[index].player1.dan + 1}D` : `${- data[index].player1.dan}K`
        const ratingP1 = data[index].player1.rating
        const increment = data[index].increment
        const countryP1 = data[index].player1.country
        const countryNameP1 = getName(countryP1)

        const danP2 = data[index].player2.dan >= 0 ? `${data[index].player2.dan + 1}D` : `${- data[index].player2.dan}K`
        const ratingP2 = data[index].player2.rating
        const countryP2 = data[index].player2.country
        const countryNameP2 = getName(countryP2)

        const xot = data[index].xot === 1 ? 'XOT ' : ''
        // console.log(data)

        const joinTable = (e) => {
            socket.off('gameslist') //
            socket.emit('watch', data[index].id)
        }
        
        return (           
            <div style = {style}>
                <div className = 'table-row' id = {index} key = {key} onClick = {userId ? joinTable : ()=>{}} >                   
                    <div className="first-table-element"> 
                        <TimeControl timeControl = {timeControl}/>
                        <div className = 'small-text'>{data[index].control}</div>
                    </div>

                    <div className="table-info watch">
                        
                        <div className = 'pictures-container table'>
                            <div className = 'avatar-small'>
                                <img className = 'photo' src ={findImage(data[index].player1.nick)} alt = "avatar"/>
                            </div>
                            <div className="flag-container"> 
                                <CountryFlags countryName = {countryNameP1} countryCode = {countryP1}></CountryFlags>
                            </div>
                            <div className="table-text split-row games-list">
                                <div className = "table-text games-list">{data[index].player1.nick}</div>
                                <div className = "table-text games-list rating">{`${ratingP1} ${danP1}`}</div>
                            </div>
                        </div>

                        <div className = 'pictures-container table'>
                            <div className = 'avatar-small'>
                                <img className = 'photo' src ={findImage(data[index].player2.nick)} alt = "avatar"/>
                            </div>
                            <div className="flag-container"> 
                                <CountryFlags countryName = {countryNameP2} countryCode = {countryP2}></CountryFlags>
                            </div>
                            <div className="table-text split-row games-list">
                                <div className = "table-text games-list">{data[index].player2.nick}</div>
                                <div className = "table-text games-list rating">{`${ratingP2} ${danP2}`}</div>
                            </div>
                        </div>

                    </div>
                    <div className="table-text gametype">{`${timeControl}|${increment} ${xot}`}</div>
                                      
                    {/* {data[index].player1.id !== userId && userId ? 
                        <div className = 'tables-button-container watch'>
                            <button onClick = {joinTable}>Watch</button>
                        </div>
                    : <div className = 'tables-button-container'/>} */}
                </div>
            </div>
        )
    }
    
    if (!data) {return}
    return (
        <div className = 'table-container' style = {{'--offset': '55px'}}>
                <FixedSizeList 
                    className="list"
                    height={listHeight}
                    itemCount={data.length}
                    itemSize = {rowHeight}
                    width={Math.min(listWidth, 500 * 0.98)}
                    ref = {listRef}
                >
                    {Row}
                </FixedSizeList>              
        </div>
    )
}
