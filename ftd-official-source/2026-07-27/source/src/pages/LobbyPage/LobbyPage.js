import React, {useState, useEffect, useContext} from 'react'
import {useBoardSize} from '../../hooks/board.size.hook'
import { LobbySettings } from './Settings'
import { PlayersList } from './PlayersList'
import { GamesList } from './GamesList'
import { TablesList } from './TableList'
import { DirectLink } from './DirectLink'
import { AuthContext } from '../../context/AuthContext'
import { NavBar } from '../elements/navbar/NavBar'
import { LayoutContext } from '../../context/LayoutContext'
import { UserContext } from '../../context/UserContext'
import { FooterLobby } from './FooterLobby/FooterLobby'
import { toast } from 'react-toastify';


export const LobbyPage = () => {
    const {userId, isAuthenticated, socket} = useContext(AuthContext)
    const {isPlaying, setIsPlaying, isOnline} = useContext (UserContext)
    const [usersList, setUsersList] = useState([])
    const [tablesList, setTablesList] = useState([])
    const [gamesList, setGamesList] = useState([])
    const [btnLabel, setBtnLabel] = useState('New Game')
    const [tablesListSorted, setTablesListSorted] = useState([])
    const [gamesListSorted, setGamesListSorted] = useState([])
    const [pressed, setPressed] = useState (null) 
    const [settings, setSettings] = useState({})
    const [startModalFlag, setStartModalFlag] = useState(false)
    const [url, setUrl] = useState(null)
    const [invitation, setInvitation] = useState(null)
    const [invited, setInvited] = useState(null)
    // const {height, gameBoard, fullBoard} = useContext(LayoutContext)
    const {height, gameBoard, fullBoard} = useBoardSize()


    // const [width, height, offsetY, gameBoard, fullBoard] = useBoardSize()

    const params = { 
        '--board-size' : gameBoard + 'px',
        '--cell-size': gameBoard * 0.114795919 + 'px',
        '--board-margin': gameBoard * 0.040815689 + 'px',
        '--board-size-full' : fullBoard + 'px',
        '--cell-size-full': fullBoard * 0.114795919 + 'px',
        '--board-margin-full': fullBoard * 0.040815689 + 'px',
        '--global-height': height + 'px',
        'maxWidth': '500px',
    }

    const sortTables = (tables) => {
        if(!tables) return tables
        tables.sort((a, b) => 
            a.player1.id === userId ? -1 : b.player1.id === userId ? 1
            : a.xot === settings.xot ? -1 : b.xot === settings.xot ? 1
            : a.timeControl === settings.timeControl ? -1 : b.timeControl === settings.timeControl ? 1  
            : a.player1.rating > b.player1.rating ? -1 
            : 0)
        return tables
    }

    const sortGames = (games) => {
        if(!games) return games
        games.sort((a, b) => 
            (a.player1.id === userId || a.player2.id === userId) ? -1 : (b.player1.id === userId || b.player2.id === userId) ? 1
            : Math.max(a.player1.rating, a.player2.rating) > Math.max(b.player1.rating, b.player2.rating) ? -1 
            : a.player1.rating + a.player2.rating > b.player1.rating + b.player2.rating ? -1
            : 0)
        return games
    } 

    useEffect( () => {

        socket.emit('joined lobby')
        socket.emit('get-online')

        socket.on('userslist', (users) => {
            setUsersList(users)
            setTablesList(null)
            setGamesList(null)
        })

        socket.on('direct-link', tableId => {
            setStartModalFlag(true)
            // setUrl(`http://192.168.1.100:3000/invite/${tableId}`)
            setUrl(`https://flipthedisc.com/invite/${tableId}`)
        })

        socket.on('invitation-declined', nick => {
            setInvited(null)
            toast.dismiss()
            toast.info(`${nick} declined your invitation`, {
                autoClose: 2000,
            })
        })

        return () => {
            socket.off('tableslist')
            socket.off('userslist')
            socket.off('gameslist')
            socket.off('direct-link')
            socket.off('invitation-declined')
        }
    },[socket, isOnline])

    useEffect(() => {
        try{
            if (pressed === 'Tables') {
                socket.emit('get-tableslist')
                socket.on('tableslist', (tables) => {
                    let flag = false
                    tables.map(table => {
                        if (table.player1.id === userId) {
                            flag = true
                            setBtnLabel('Change Settings')}
                            
                    })
                    if (!flag && btnLabel !== 'New Game') {setBtnLabel('New Game')}
                    setUsersList(null)
                    setTablesList(tables)
                    setGamesList(null)
                })
            }
            if (pressed === 'Players') {
                socket.emit('get-userslist')
                socket.on('userslist', (users) => {
                    setUsersList(users)
                    setTablesList(null)
                    setGamesList(null)
                })
            }
            if (pressed === 'Watch') {
                socket.emit('get-gameslist')
                socket.on('gameslist', (games) => {
                    setUsersList(null)
                    setTablesList(null)
                    setGamesList(games)
                })
            }
        } catch (e) {console.log (e)}
        return () => {
            socket.off('tableslist')
            socket.off('userslist')
            socket.off('gameslist')
        }
    },[pressed])

    useEffect(() => {
        // console.log(settings)
        setTablesListSorted(sortTables(tablesList))
    },[settings, tablesList, userId])

    useEffect(() => {
        setGamesListSorted(sortGames(gamesList))
    },[settings, gamesList, userId])

    return (
        <div style ={params}>
            <NavBar isHome = {false}></NavBar>           
                {/* <div className = 'search-contaner'>
                    <input ref = {searchRef} type = "text" maxLength="20" placeholder = 'Search by opponent' onChange = {event => debouncedSearch(event)} onKeyUp = {event => onEnter(event)}/>    
                </div> */}
            
            <div className = "layout">
                {(pressed === 'Players' || !pressed) && usersList ?
                    usersList.length > 0 ?
                    <PlayersList data = {usersList} control = {settings.timeControl} isXot = {settings.xot} setBtnLabel = {setBtnLabel} setInvitation = {setInvitation} invited = {invited} setInvited = {setInvited}/>
                    : <></> : <></>
                }

                {pressed === 'Watch' && gamesListSorted ?
                    gamesListSorted.length > 0 ?
                    <GamesList data = {gamesListSorted}/>
                    : <></> : <></>
                }
     {/* || !pressed */}
                {(pressed === 'Tables') && tablesListSorted ? 
                    tablesListSorted.length > 0 ?
                    <TablesList data = {tablesListSorted}/>
                    : <></> : <></>
                }

            </div>
            <FooterLobby pressed = {pressed} setPressed = {setPressed}/>
            <LobbySettings settings = {settings} setSettings = {setSettings} btnLabel = {btnLabel} setBtnLabel = {setBtnLabel} pressed = {pressed} invitation = {invitation} setInvited = {setInvited}/>
            <DirectLink settings = {{timeControl: settings.timeControl, increment: settings.increment, xot: settings.xot, directLink: settings.directLink, url: url}}  modalFlag = {startModalFlag} setModalFlag = {setStartModalFlag}/>

        </div>
    )
}

export default LobbyPage
