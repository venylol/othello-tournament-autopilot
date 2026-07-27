import React, {useRef, useContext} from "react"
import { TimeControl } from "../elements/SVG"
import { getName } from 'country-list';
import { FixedSizeList } from "react-window"
import { useWindowSize } from '../../hooks/resize.hook'
import { findImage } from "../functions/functions"
import { AuthContext } from '../../context/AuthContext'
import { CountryFlags } from "../elements/CountryFlags";

export const TablesList = ({data}) => {
    // console.log ('TableList', data)
    const listRef = useRef ()
    const {userId, isAuthenticated, socket} = useContext(AuthContext)
    const [width, listWidth, rowHeight, rowHeightExpanded, height, offsetY, boardSize] = useWindowSize(listRef, false)
    const offset = 150
    const listHeight = Math.min(data.length * rowHeight, height-offset)

    const closeTable = () => {
        socket.emit('remove-table')
    } 

    const Row = ({index, style}) => {
        // console.log(data[index])
        const key = data[index][0]
        const timeControl = data[index].timeControl
        const dan = data[index].player1.dan >= 0 ? `${data[index].player1.dan + 1}D` : `${- data[index].player1.dan}K`
        const rating = data[index].player1.rating
        const increment = data[index].increment
        const country = data[index].player1.country
        const countryName = getName(country)
        const xot = data[index].xot === 1 ? 'XOT ' : ''

        const joinTable = () => {
            socket.off('tableslist') //
            socket.emit('matched', data[index].id)
        }
        
        return (           
            <div style = {style}>
                <div className = 'table-row' id = {index} key = {key} >
                    <div className="first-table-element">
                        <TimeControl timeControl = {timeControl}/>
                        <div className = 'small-text'>{data[index].control}</div>
                    </div>
                    {/* <div className = "small-text ping">ping</div> */}
                    <div className="table-info">
                        <div className = 'pictures-container table'>
                            <div className = 'avatar-small'>
                                <img className = 'photo' src ={findImage(data[index].player1.nick)} alt = "avatar"/>
                            </div>
                            <div className="flag-container"> 
                                <CountryFlags countryName = {countryName} countryCode = {country}></CountryFlags>
                            </div>
                            <div className="table-text split-top">{data[index].player1.nick}</div>
                        </div>
                        <div className="table-text split-bottom">{`${xot}${timeControl} min + ${increment}s`}</div>
                    </div>
                    <div className="table-text rating">{`${rating} ${dan}`}</div>
                    {/* {console.log (userId)} */}
                    {data[index].player1.id !== userId && isAuthenticated ? 
                        <div className = 'tables-button-container'>
                            <button onClick = {joinTable}>Join</button>
                        </div>
                    : userId && isAuthenticated? <div className = 'tables-button-container'>
                        <button onClick = {closeTable} style = {{backgroundColor: '#8b0100'}}>Close</button>
                    </div>
                    : <div className = 'tables-button-container'/>}
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
