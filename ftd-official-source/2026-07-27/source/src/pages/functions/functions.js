const BOARD_SIZE = 64 

const formatDate = (date) => {
    return window.innerWidth > 550 ?  date.split('T')[0].concat(' ', date.split('T')[1].substring(0, 5)) : date.split('T')[0]     
}

const checkInput = str => {
    let format = /[ `!@#$%^&*()+\-=\[\]{};'"\\|,.<>\/?~]/
    let formatLogin = /^[A-Za-z0-9_]+$/
    if (str.length > 20 || format.test(str) || !formatLogin.test(str)) {
        return false
    }
    return true
}

const checkTName = str => {
    let format = /[`!@#$%^&*()+\=\[\]{};"\\|<>\/?~]/
    let formatLogin = /^[A-Za-z0-9_'\-\., ]+$/
    if (str.length > 50 || format.test(str) || !formatLogin.test(str)) {
        return false
    }
    return true
}

const checkEmail = str => {
    let format = /^(([^<>()[\]\\.,;:\s@"]+(\.[^<>()[\]\\.,;:\s@"]+)*)|(".+"))@((\[[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\])|(([a-zA-Z\-0-9]+\.)+[a-zA-Z]{2,}))$/
    let email = /^[A-Za-z0-9_.-]+$/
    if (format.test(str) && email.test(str.split('@')[0]) && !str.split('@')[1].includes('--')) {
        return true
    }
    return false
}

const checkLogin = str => {
    let format = /[ `!#$%^&*()+\-=\[\]{};'"\\|,<>\/?~]/
    let email = /^[A-Za-z0-9_@.-]+$/
    if (format.test(str) || !email.test(str)) {
        return false
    }
    return true
}

const debounce = (fn) => {
    let timeout;
    return function (...args) {
        const context = this;
        if (timeout) clearTimeout(timeout)
        timeout = setTimeout(() =>{
            timeout = null
            fn.apply(context, args)
        },150)
    }
}

const onEnter = (event) => {
    if(event.key === 'Enter') event.target.blur()
}

function numberWithCommas (x) {
    return x.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

const findImage = (nickName) => {
    if (!nickName) return '/api/avatar/-default'
    return `/api/avatar/${encodeURIComponent(nickName)}`
}

const roundReady = (arr) => {
    if (!arr) return false
    let flag = true
    arr.map(pair => {
        if (!(pair[0].score || pair[0].score === 0) && pair[1].id !== -1 && pair[0].id !== -1 && !(pair[1].score || pair[0].score === 0) && typeof pair !== 'string') {
            flag = false
            return
        }
    })
    return flag
}

const roundEdit = (arr, gameId, score) => {
    if(!arr || !gameId) return
    const pairing = [...arr]
    for (let i = 0; i < pairing.length; i++) {
        if (pairing[i][0].gameId === gameId) {
            pairing[i][0].score = score ? score : null
        } 
    }
    return pairing
}

const fillArr = (round) => {
    const arr = []
    for (let i = round; i > 0; i--) {
        arr.push(i)
    }
return arr
}

// const fillRoundsArr = (roundNames) => { 
//     return roundNames.sort((a,b) => b.round - a.round)
// }

const toCapitalized = (str) => {
    return str.charAt(0).toUpperCase() + str.slice(1)
}

const toNameCase = (str) => {
    if (!str) return str
    return str.toLowerCase().split(' ').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ')
}

const getFullRoundName = (arr, round) => {
    // console.log(arr, round)
    if (!arr && !round) return ''
    for (let i = 0; i < arr.length; i++) {
        if(arr[i].round === round) {
            if (!arr[i].round_name || arr[i].round_name == round) return 'Round ' + round
            if (arr[i].round_name === 'F') return 'Finals'
            if (arr[i].round_name === '3/4') return 'Match for 3rd place'
            if (arr[i].round_name === 'PO') return 'Play-off'
            if (arr[i].round_name === 'SF') return 'Semi-Finals'
            if (arr[i].round_name === 'QF') return 'Quarter-Finals'
        }
    }
    return round
}

const getFullGameName = (code) => {
    if (!code) return ''
    if (code === '3/41' || code === 'F1' || code === 'WF1' || code === 'SF1') return '1st Game'
    if (code === '3/42' || code === 'F2' || code === 'WF2' || code === 'SF2') return '2nd Game'
    if (code === '3/43' || code === 'F3' || code === 'WF3' || code === 'SF3') return '3rd Game'
    return code
}

const fakeResults = (arr, id, socket) => {
    const buffer = []
    for (let i = 0; i < arr.length; i ++) {
        buffer.push(arr[i])
        if (arr[i][0].result === null && arr[i][1].id !== -1 && typeof arr[i] !== 'string') {
            const score = Math.round(Math.random() * 64)
            const result = score > 32 ? 2 : score === 32 ? 1 : 0
            const gameId = arr[i][0].gameId
            buffer[i][0].score = score
            buffer[i][0].result = result
            socket.emit('score-otb', id, gameId, score)
        }
    }
    return buffer
}

const rotate = (board) => {
    const result = JSON.parse(JSON.stringify(board))
    for (let i = 0; i < board.length; i++) {
        for (let j = i + 1; j < board.length; j++) {
            const temp = result[i][j]
            result[i][j] = result[j][i]
            result[j][i] = temp 
        }
    }
    for (let i = 0; i < board.length; i++) {
        result[i].reverse()
    }
    return result
}

const rotateCell = (cell, rotation) => {
    if (rotation === 0) return cell
    let result = [...cell]
    for (let i = 0; i < 4 - rotation; i ++) {
        const temp = result[0] 
        result[0] = result[1]
        result[1] = 7 - temp
    }
    return result
}

const formatTextTranscript = (str) => {
    return str.replace(/(?<=\d)\.(?=\s)|\d+\.\s*|[-]+|[ \n\r]+/g, '').toLowerCase();
}

const checkTranscript = (str) => {
    const regex = /^[a-h1-8]+$/;
    if (str.length > 120) return false
    if (str.length % 2 !== 0) return false
    if (!regex.test(str)) return false
    return true
}

const getFinalResults = (standingsRaw, finals, categoryRaw) => { // add Play Off at least and come up with something for 1/4, 1/8, 1/16 finals...
    let newStandings = []
    const category = categoryRaw ? categoryRaw : 'open' 
    // console.log(category)
    let standings = []
    if (category !== 'open' && category !== 'team') {
        standings = standingsRaw.filter( player => 
            player.categories.includes(category) || 
            category === 'open')
    } else {
        standings = [...standingsRaw]
    }
    const finalsF = finals.filter( game => game.category === category && game.round_name === 'F')
    // console.log(finalsF)
    if (finalsF.length === 0) return standings
    let countF = finalsF.length > 0 ? [{player_id: finalsF[0].black_id, score: 0, discs: 0}, {player_id: finalsF[0].white_id, score: 0, discs: 0}] : []
    for (let i = 0; i < finalsF.length; i++) {
      if (finalsF[i].black_id === countF[0].player_id) {
        countF[0].score += finalsF[i].result
        countF[0].discs += finalsF[i].score
        countF[1].score += 2 - finalsF[i].result
        countF[1].discs += BOARD_SIZE - finalsF[i].score
      } else {
        countF[1].score += finalsF[i].result
        countF[1].discs += finalsF[i].score
        countF[0].score += 2 - finalsF[i].result
        countF[0].discs += BOARD_SIZE - finalsF[i].score
      }
    }
  
    for (let i = 0; i < standings.length; i++) {
      if (standings[i].player_id === countF[0].player_id) {
        countF[0].minor = 1
        countF[1].minor = 0
        break
      }
      if (standings[i].player_id === countF[1].player_id) {
        countF[1].minor = 1
        countF[0].minor = 0
        break
      }
    }
  
    const finals34 = finals.filter( game => game.category === category && game.round_name === '3/4')
    let count34 = finals34.length > 0 ? [{player_id: finals34[0].black_id, score: 0, discs: 0}, {player_id: finals34[0].white_id, score: 0, discs: 0}] : []
    for (let i = 0; i < finals34.length; i++) {
      if (finals34[i].black_id === count34[0].player_id) {
        count34[0].score += finals34[i].result
        count34[0].discs += finals34[i].score
        count34[1].score += 2 - finals34[i].result
        count34[1].discs += BOARD_SIZE - finals34[i].score
      } else {
        count34[1].score += finals34[i].result
        count34[1].discs += finals34[i].score
        count34[0].score += 2 - finals34[i].result
        count34[0].discs += BOARD_SIZE - finals34[i].score
      }
    }
  
    for (let i = 0; i < standings.length; i++) {
      if (standings[i].player_id === count34[0]?.player_id ) {
        count34[0].minor = 1
        count34[1].minor = 0
        break
      }
      if (standings[i].player_id === count34[1]?.player_id) {
        count34[1].minor = 1
        count34[0].minor = 0
        break
      }
    }

    const finals56 = finals.filter( game => game.category === category && game.round_name === '5/6')
    let count56 = finals56.length > 0 ? [{player_id: finals56[0].black_id, score: 0, discs: 0}, {player_id: finals56[0].white_id, score: 0, discs: 0}] : []
    for (let i = 0; i < finals56.length; i++) {
      if (finals56[i].black_id === count56[0].player_id) {
        count56[0].score += finals56[i].result
        count56[0].discs += finals56[i].score
        count56[1].score += 2 - finals56[i].result
        count56[1].discs += BOARD_SIZE - finals56[i].score
      } else {
        count56[1].score += finals56[i].result
        count56[1].discs += finals56[i].score
        count56[0].score += 2 - finals56[i].result
        count56[0].discs += BOARD_SIZE - finals56[i].score
      }
    }
  
    for (let i = 0; i < standings.length; i++) {
      if (standings[i].player_id === count56[0]?.player_id ) {
        count56[0].minor = 1
        count56[1].minor = 0
        break
      }
      if (standings[i].player_id === count56[1]?.player_id) {
        count56[1].minor = 1
        count56[0].minor = 0
        break
      }
    }
  
    if (countF.length > 0) {
      if(countF[0].score > countF[1].score || (countF[0].score === countF[1].score && countF[0].discs > countF[1].discs) ||
      (countF[0].score === countF[1].score && countF[0].discs === countF[1].discs && countF[0].minor > countF[1].minor)) {
        newStandings.push(standings.filter(player => player.player_id === countF[0].player_id)[0])
        newStandings.push(standings.filter(player => player.player_id === countF[1].player_id)[0])
      } else {
        newStandings.push(standings.filter(player => player.player_id === countF[1].player_id)[0])
        newStandings.push(standings.filter(player => player.player_id === countF[0].player_id)[0])
      }
    }
    if (count34.length > 0) {
      if(count34[0].score > count34[1].score || (count34[0].score === count34[1].score && count34[0].discs > count34[1].discs) ||
      (count34[0].score === count34[1].score && count34[0].discs === count34[1].discs && count34[0].minor > count34[1].minor)) {
        newStandings.push(standings.filter(player => player.player_id === count34[0].player_id)[0])
        newStandings.push(standings.filter(player => player.player_id === count34[1].player_id)[0])
      } else {
        newStandings.push(standings.filter(player => player.player_id === count34[1].player_id)[0])
        newStandings.push(standings.filter(player => player.player_id === count34[0].player_id)[0])
      }
    }
    if (count56.length > 0) {
      if(count56[0].score > count56[1].score || (count56[0].score === count56[1].score && count56[0].discs > count56[1].discs) ||
      (count56[0].score === count56[1].score && count56[0].discs === count56[1].discs && count56[0].minor > count56[1].minor)) {
        newStandings.push(standings.filter(player => player.player_id === count56[0].player_id)[0])
        newStandings.push(standings.filter(player => player.player_id === count56[1].player_id)[0])
      } else {
        newStandings.push(standings.filter(player => player.player_id === count56[1].player_id)[0])
        newStandings.push(standings.filter(player => player.player_id === count56[0].player_id)[0])
      }
    }
  
    
    for (let i = 0; i < standings.length; i++) {
      let flag = false
      for (let j = 0; j < newStandings.length; j ++) {
        if (standings[i].player_id === newStandings[j].player_id) {
          flag = true
          break
        }
      }
      if(!flag) {
        newStandings.push(standings[i])
      }
    }
    
    return newStandings
  }

function getControlName (timeControl, xot) {
  if (!xot) {
      if (timeControl < 3) return 'bullet'
      if (timeControl < 10) return 'blitz'
      if (timeControl < 20) return 'rapid'
      if (timeControl >= 20) return 'classic'
  }
  if (timeControl < 3) return 'bullet_xot'
  if (timeControl < 10) return 'blitz_xot'
  if (timeControl < 20) return 'rapid_xot'
  if (timeControl >= 20) return 'classic_xot'
}


export {
    formatDate,
    debounce,
    onEnter,
    checkInput,
    checkLogin,
    checkEmail,
    checkTName,
    numberWithCommas,
    findImage,
    roundReady, 
    fillArr,
    toCapitalized,
    toNameCase,
    getFullRoundName,
    getFullGameName,
    roundEdit,
    fakeResults,
    rotate,
    rotateCell,
    formatTextTranscript,
    checkTranscript,
    getFinalResults,
    getControlName
}
