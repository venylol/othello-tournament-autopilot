const cols = ['a','b','c','d','e','f','g','h']

const stringToIndex = string => {
    let result = []
    cols.map((val, idx) => {
        if (val !== string[0]) return
        if (val === string[0]) {
            result[1] = idx
        } 
    })
    result[0] = string[1] - 1
    return result
}

const sumArray = (arr1,arr2) => arr1.map(function (num, i) {
    return num + arr2[i];
})

function clearLegalMoves (currentPosition) {
    for (let i = 0; i < currentPosition[0].length; i++ ) {
        for (let j = 0; j < currentPosition.length; j++) {
            if (currentPosition[i][j] === 'l') {
                currentPosition[i][j] = ''
            }
        }
    }
    return (currentPosition)
}

const countFinalDiscs = (currentPosition) => {
    let black = 0 
    let white = 0
    for (let i = 0; i < currentPosition[0].length; i++ ) {
        for (let j = 0; j < currentPosition.length; j++) {
            if (currentPosition[i][j] === 'b') {
                black++
            }
            if (currentPosition[i][j] === 'w') {
                white++
            }
        }
    }
    const score = black > white ? 64 - white : black < white ? black : 32
    return score
}

const getFinalScore = (currentPosition, turn) => {
    // check if there's no legal moves possible in this position and return score
    let buffer = JSON.parse(JSON.stringify(currentPosition))
    buffer = newLegalMoves(clearLegalMoves(buffer), turn)
    if (buffer.flat().includes('l')) return -1 
    turn = turn === 'b' ? 'w' : 'b'
    buffer = newLegalMoves(buffer, turn)
    if (buffer.flat().includes('l')) return -1 
    const score = countFinalDiscs(currentPosition)
    return score
}

const newLegalMoves = (currentPosition, turn) => {
    let color = turn[0]                                                                                     // фиксируем цвет, с которым работаем 
    let buffer = [...currentPosition]
    for (let i = 0; i < buffer[0].length; i++ ) {                                                           // пробегаем по всей доске
        for (let j = 0; j < buffer.length; j++) {
            if (buffer[i][j] === color) {                                                                   // нашли того же цвета, что и мы  
                for (let k = Math.max(i - 1, 0); k <= Math.min(i + 1, buffer[0].length - 1); k++ ) {        // проверям все по периметру от нашей фишки
                    for (let n = Math.max(j - 1, 0); n <= Math.min(j + 1, buffer.length - 1); n++) {
                        if (buffer[k][n] !== color && buffer[k][n]!== '' && buffer[k][n]!== 'l') {          // нашли рядом с нашей фишку противоположного цвета
                            let step = [k - i, n - j]                                                       // задаем шаг, где [k,n] - координаты ближайшей фишки другого цвета от той, что поставили
                            let curIndex = [k,n]                                                            // фиксируем координаты ближайшей фишки противоложного цвета 
                            do {
                                if (sumArray(curIndex, step)[0] < 0 || sumArray(curIndex, step)[1] < 0 || sumArray(curIndex, step)[0] > buffer.length - 1 || sumArray(curIndex, step)[1] > buffer.length) { // проверяем в пределах ли доски следующий шаг
                                    break
                                }
                                curIndex = sumArray(curIndex, step)                                         // меняем индекс на следующую по прямой
                                if (buffer[curIndex[0]][curIndex[1]] === '' || buffer[curIndex[0]][curIndex[1]] === 'l') { 
                                    buffer[curIndex[0]][curIndex[1]] = 'l'                                  // нашли первую пустую по прямой и ставим ей 'l', выходим
                                    break
                                }                           
                            } while ( curIndex[0] >= 0 && curIndex[1] >= 0 && curIndex[0] <= buffer.length && curIndex[1] <= buffer.length && buffer[curIndex[0]][curIndex[1]] !== color && buffer[curIndex[0]][curIndex[1]] !== 'l'                            
                            ) 
                        }
                    }
                }
            }
        }
    }
    return buffer
}

const makeNewMove = (cell, position, color, isLive) => {
    let buffer = JSON.parse(JSON.stringify(position))
    let isLegal = false
    for (let i = Math.max(cell[0] - 1, 0); i <= Math.min(cell[0] + 1, buffer.length - 1); i++ ) { 
        for (let j = Math.max(cell[1] - 1, 0); j <= Math.min(cell[1] + 1, buffer.length - 1); j++) {         // проверяем все клетки в пределах доски по периметру от той, куда ходим
            if (buffer[i][j] !== color && buffer[i][j] !== '' && buffer[i][j] !== 'l') {                                            // если нашли клетку другого цвета                    
                let step = [i - cell[0], j - cell[1]]                                                       // задаем шаг, где [i,j] - координаты ближайшей фишки другого цвета от той, что поставили
                let curIndex = [i,j]                                                                        // фиксируем координаты ближайшей фишки противоложного цвета                      
                do {
                    if (sumArray(curIndex, step)[0] < 0 || sumArray(curIndex, step)[1] < 0 || sumArray(curIndex, step)[0] > buffer.length -1 || sumArray(curIndex, step)[1] > buffer.length -1) { // проверяем в пределах ли доски следующий шаг
                        break
                    }
                    curIndex = sumArray(curIndex, step)                                                     // меняем индекс на следующую по прямой
                    if (buffer[curIndex[0]][curIndex[1]] === color) {                                       // добрались до черной с координатами curIndex?
                            let startIndex = [i,j] 
                            isLegal = true                                                                  
                            do {                                                                            // вспоминаем координаты ближайшей фишки соперника, с которой надо все перевернуть                              
                                buffer[startIndex[0]][startIndex[1]] = color                                // переворачиваем фишку
                                startIndex = sumArray(startIndex, step)                                     // шагаем в сторону curIndex, меняя значение startIndex                                        
                            } while (startIndex[0]!==curIndex[0] || startIndex[1]!==curIndex[1])            // пока обе координаты не сравняются
                            buffer[startIndex[0]][startIndex[1]] = color  
                            // console.log ('hi')                                     // и когда сравнялись - еще разок, так как условие не сработало
                            break
                    }                                                    
                } while ( curIndex[0] >= 0 && curIndex[1] >= 0 && curIndex[0] < buffer.length && curIndex[1] < buffer.length && buffer[curIndex[0]][curIndex[1]] !== '' && buffer[curIndex[0]][curIndex[1]] !== 'l') 
            }
        }
    }
    let turn = color === 'b' ? 'w' : 'b'
    if (!isLegal) {
        return makeNewMove(cell, position, turn) 
    } else {
        buffer[cell[0]][cell[1]] = color
        if (isLive) {
            buffer = newLegalMoves(clearLegalMoves(buffer), turn)
            if (!buffer.flat().includes('l')) {
                turn = turn === 'b' ? 'w' : 'b'
                buffer = newLegalMoves(buffer, turn)
            }
            return {buffer, turn}
        }
        return {buffer, turn}
    }
}

function getPositions (transcript, isLive = false) {
    const board = !isLive ? [['','','','','','','',''],
            ['','','','','','','',''],
            ['','','','','','','',''],
            ['','','','w','b','','',''],
            ['','','','b','w','','',''],
            ['','','','','','','',''],
            ['','','','','','','',''],
            ['','','','','','','','']] 
            :
            [['','','','','','','',''],
            ['','','','','','','',''],
            ['','','','l','','','',''],
            ['','','l','w','b','','',''],
            ['','','','b','w','l','',''],
            ['','','','','l','','',''],
            ['','','','','','','',''],
            ['','','','','','','','']]

    let positionTable = []
    positionTable.push(JSON.parse(JSON.stringify(board)))
    let turn = 'b'
    const turns = ['b']
    const len = transcript ? transcript.length : 0
    const moves = []
    // console.log(len)
    for (let i = 0; i < len - 1; i = i + 2) {
        const move = stringToIndex(transcript.substring(i, i + 2))
        if(moves.includes(transcript.substring(i, i + 2))) {
            const err = `Duplicate move ${i/2 + 1}. ${transcript.substring(i, i + 2)}`
            return {positionTable, turn, turns, err}
        }
        if(positionTable[i/2][move[0]][move[1]] !== 'l' && isLive) {
            const err = `Illegal move ${i/2 + 1}. ${transcript.substring(i, i + 2)}`
            return {positionTable, turn, turns, err}
        }
        
        moves.push(transcript.substring(i, i + 2))
        
        let result = makeNewMove (move, positionTable[i / 2], turn, isLive)
        turn = result.turn
        turns.push(result.turn)
        positionTable.push(JSON.parse(JSON.stringify(result.buffer)))
    }
    turns.splice(-1)
    // console.log('getPositions', positionTable)
    return {positionTable, turn, turns}
}

function getTurn (transcript) {
    const board = [
        ['','','','','','','',''],
        ['','','','','','','',''],
        ['','','','l','','','',''],
        ['','','l','w','b','','',''],
        ['','','','b','w','l','',''],
        ['','','','','l','','',''],
        ['','','','','','','',''],
        ['','','','','','','','']
    ]

    let positionTable = []
    positionTable.push(JSON.parse(JSON.stringify(board)))
    let turn = 'b'
    let score = null
    const len = transcript ? transcript.length : 0
    for (let i = 0; i < len - 1; i = i + 2) {
        const move = stringToIndex(transcript.substring(i, i + 2))
        const result = makeNewMove (move, positionTable[i / 2], turn)
        turn = result.turn
        score = result.score
        positionTable.push(JSON.parse(JSON.stringify(result.position)))
    }
    const nextToPlay = score !== null ? '' : turn === 'b' ? 'BLACK' : 'WHITE'
    const gameData = {nextToPlay, score}
    return gameData
}

export {
    getPositions,
    clearLegalMoves,
    stringToIndex,
    getTurn,
    sumArray,
    makeNewMove,
    getFinalScore
}



  
    
  




