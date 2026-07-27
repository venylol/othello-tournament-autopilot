import React, {useEffect, useRef, useState} from "react"
import { getName } from 'country-list';
import { FixedSizeList } from "react-window";
import { ToggleStandings } from "./ToggleStandings";
import { CreateGame } from "./CreateGameOTB";
import { useWindowSize } from '../../hooks/resize.hook'
import { CountryFlags } from "../elements/CountryFlags";
import { getFinalResults } from "../functions/functions";

const toCapitalized = (str) => {
    return str.charAt(0).toUpperCase() + str.slice(1)
}

export const StandingsOTB = ({id, socket, isTD, setTab, ifCategories, isWOC}) => {
    const [data, setData] = useState([])
    const [filteredData, setFilteredData] = useState([])
    const [pressed, setPressed] = useState ()
    const [round, setRound] = useState ()
    const [finished, setFinished] = useState ()
    const [roundsArr, setRoundsArr] = useState ([])
    const [totalRounds, setTotalRounds] = useState()
    const [eloFileName, setEloFileName] = useState(null)
    const [finalsButton, setFinalsButton] = useState(false)
    const [createGame, setCreateGame] = useState(false)
    const [filterCategory, setFilterCategory] = useState()
    const [categories, setCategories] = useState([])
    const linkRef = useRef ()
    const listRef = useRef ()
    const teamsStandings = useRef(null)
    const finalRounds = useRef(null)
    const [width, listWidth, rowHeight, rowHeightExpanded, height, offsetY, boardSize] = useWindowSize(null, true, false)    

    const startNextRound = () => {
        socket.emit('next-round-otb', id, round)
        setTab('Rounds')
    }

    const getTotalHeight = () => {
        if (!ifCategories) return isTD ? Math.min(filteredData.length * 45, height - 198) : Math.min(filteredData.length * 45, height - 150)
        return isTD ? Math.min(filteredData.length * 45, height - 238) : Math.min(filteredData.length * 45, height - 190)
    }

    useEffect(()=> {
        socket.on('new-standings', (standings, lastRound, curRound, finished, totalRounds, roundNames, eloFileName, startFinals, finalGames) => {            
            setRound(lastRound)
            setRoundsArr(roundNames?.sort((a,b) => b.round - a.round))
            setFinished(finished)
            setData(standings)
            setFilteredData(finished && curRound > totalRounds ? getFinalResults(standings, finalGames) : standings)
            setPressed(curRound)
            setTotalRounds(totalRounds)
            setEloFileName(eloFileName)
            setFinalsButton(startFinals)
            finalRounds.current = [...finalGames]
            let cat = ['open']
            
            if (ifCategories) {
                for (let i = 0; i < standings.length; i++) {
                    cat = [...new Set([...cat, ...standings[i].categories])]
                }
                if (isWOC) cat.push('team')
                setCategories(cat)
                setFilterCategory(0)
            } else {
                setCategories([])
                setFilterCategory(null)
            }

            if (isWOC) {
                const teams = []
                for (let i = 0; i < standings.length; i ++) {
                    if (standings[i].not_team_member) continue
                    let newTeamFlag = true
                    for (let j = 0; j < teams.length; j++) {
                        if (teams[j].country_code === standings[i].country_code) {
                            newTeamFlag = false
                            // add check that player counts for the team score
                            if(teams[j].headCount < 3) {
                                teams[j].score = teams[j].score + standings[i].score
                                teams[j].headCount = teams[j].headCount + 1
                            }
                            break
                        }
                    }
                    if(newTeamFlag) {
                        // check if player counts for team score
                        const team = {country_code: standings[i].country_code, name: getName(standings[i].country_code), score: standings[i].score, mbq: '', headCount: 1, surname: '', }
                        teams.push(team)
                    }
                }
                // console.log(teams)
                teams.sort((a,b) => 
                    a.score < b.score ? 1 :
                    a.score > b.score ? -1 :
                    a.name < b.anme ? -1 :
                    a.name > b.name ? 1 : 0
                )
                teamsStandings.current = [...teams]
            }
        })
        return () => {
            socket.off('new-standings')
        }
    },[])

    const startFinals = (e) => {
        setCreateGame(true)
    }

    const categoryHandler = (e) => {
        if(filterCategory === categories.length - 1) {
            setFilterCategory(0)
            setFilteredData(finished && pressed > totalRounds ? getFinalResults(data, finalRounds.current) : data)
            return
        } 

        setFilterCategory(prev => prev + 1)
        const filtered = finished && pressed > totalRounds ? getFinalResults(data, finalRounds.current,categories[filterCategory + 1]): data.filter(player => 
            (player.categories.includes(categories[filterCategory + 1])) || 
            categories[filterCategory + 1] === 'open')
        if(categories[filterCategory + 1] !== 'team') {
            setFilteredData(filtered)
        } else {
            setFilteredData(teamsStandings.current)
        }
    }

    const getPlayersGames = (e) => {
        socket.emit("get-rounds-by-player", id, e.target.id)
    }

    const Row = ({index, style}) => {
        const id = filteredData[index].player_id
        const surname = toCapitalized(filteredData[index].surname.toLowerCase())
        const name = filteredData[index].name
        const score = filteredData[index].score
        const mbq = filteredData[index].mbq
        const country = filteredData[index].country_code
        const leftRound = filteredData[index].left_after_round
        const countryName = getName(country)
        
        return (
            <div style = {style}>
                <div className = 'table-row reg' id = {index} key = {id}>
                    <div className = 'table-place'>{index + 1}</div>
                    <CountryFlags countryName = {countryName} countryCode = {country}></CountryFlags>
                    <div className={`select-text ${leftRound && leftRound < pressed ? 'left' : ''}`} onClick = {getPlayersGames} id = {id}>{surname} {name}</div>                       
                    <div className="select-text wof-rating" title = 'score'>{score}</div>
                    <div className="select-text wof-rating" title = 'score'>{mbq}</div>
                </div>
            </div>
        )
    }

    return (
        <div>
            {createGame ? <CreateGame id = {id} standingsRaw = {data} socket = {socket} setVisible = {setCreateGame} setPressed = {setTab} ifCategories = {ifCategories} categories = {categories}></CreateGame>
            : 
            <>       
            <ToggleStandings pressed = {pressed} roundsArr = {roundsArr} totalRounds = {totalRounds} id = {id}/>  
            {data.length > 0 ?
            
            <>
            {ifCategories ? 
            <div className = 'filter-standings'>
                <div>Filter by Category</div>
                <button onClick = {categoryHandler} val = {filterCategory} >{categories[filterCategory]}</button>
            </div> : <></>}
            <div className = 'table-container' style = {{'--offset': `${ifCategories ? '190px' : '150px'}`}}>
                <FixedSizeList 
                    className="list"
                    height={getTotalHeight()}
                    itemCount={filteredData.length}
                    itemSize = {45}
                    width={Math.min(width * 0.98, 500 * 0.98)}
                    ref = {listRef}
                >
                    {Row}
                </FixedSizeList>              
            </div> 
            </>:
            round === 0 ? <div className = 'big-text-empty'>No rounds has been played</div> : <></>
            }
                         
        { (!isTD && data.length > 1) || !finished || totalRounds === round && !finalsButton? <></> : <button className = "btn-new-tournament" onClick = {startNextRound}>Start Next Round</button>} 
        {finished && isTD && eloFileName?
        <button className = "btn-new-tournament" onClick = {()=> {linkRef.current.click()}}>Download Elo File
            <a ref = {linkRef} href = {'/otb_elo_files/' + eloFileName} download = {eloFileName}></a>
        </button>
        : isTD && finalsButton ?
        <button className = "btn-new-tournament" onClick = {startFinals}>Proceed with Finals</button>
        : <></>}
        </>}

        </div>
    )
}
