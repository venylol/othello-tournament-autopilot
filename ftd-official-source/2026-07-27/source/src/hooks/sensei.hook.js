import {useState, useEffect, useRef, useContext} from 'react'
import SenseiEngine from '../module/sensei_cli_main.js'
import { AuthContext } from '../context/AuthContext'

// Sensei eval shape: {move, score, descendants, is_book}
// score is in discs from current player's perspective (negated from Sensei's opponent-perspective output)
// descendants replaces depth/prob — higher = more reliable

const START_EVALS = [{move: 'd3', score: 0, descendants: 0, is_book: true},
    {move: 'c4', score: 0, descendants: 0, is_book: true},
    {move: 'f5', score: 0, descendants: 0, is_book: true},
    {move: 'e6', score: 0, descendants: 0, is_book: true}
];
const MAX_BOOK_MOVE = 36;
const N_THREADS = (typeof SharedArrayBuffer !== 'undefined' && navigator.hardwareConcurrency)
    ? navigator.hardwareConcurrency
    : 1;

export const useSensei = (path = '../../') => {
    const [sensei, setSensei] = useState(null)
    const [hintEvals, setHintEvals] = useState([])
    const [error, setError] = useState(0)
    const [status, setStatus] = useState('not ready')
    const [senseiReady, setSenseiReady] = useState(false)
    const [hintedOnce, setHintedOnce] = useState(false)
    const hintEvalsFlag = useRef(0) // 0: ready, 1: thinking, 2: finished, 3: interrupted
    const evalsTable = useRef([START_EVALS])
    const edaxBookEmpty = useRef(MAX_BOOK_MOVE)
    const move = useRef(0)
    const transcript = useRef('')
    const askedForHint = useRef(false)
    const senseiReadyRef = useRef(false)
    const hintEvalsRef = useRef([])
    const evalsRef = useRef([])
    const editModeRef = useRef(false)
    const xotOffsetRef = useRef(0)
    const nextRef = useRef(null) 
    const legalMovesRef = useRef(0)
    const senseiRef = useRef(null)
    const lastDescendantsRef = useRef(0)
    const evalStartTimeRef = useRef(0)
    const bestMoveRef = useRef(null)
    const bestMoveTimeRef = useRef(0)
    const [retroAnalysis, setRetroAnalysis] = useState([])
    const [retroStatus, setRetroStatus] = useState('idle') // 'idle' | 'running' | 'complete'
    const [retroCurrentIndex, setRetroCurrentIndex] = useState(-1)
    const retroAnalysisRef = useRef([])
    const modeRef = useRef('eval') // 'eval' | 'retro'
    const retroStopRequestedRef = useRef(false)
    const thinkingRef = useRef(false) // true when engine is actively evaluating (eval_move)
    const onRetroCompleteRef = useRef(null) // callback fired after analyze_result
    const gameTranscriptRef = useRef('') // transcript loaded via set_game
    const pendingRetroRef = useRef(null) // {transcript, maxTime} queued while waiting for set_game_result
    const setGamePendingRef = useRef(false) // true while waiting for set_game_result
    const pendingEvalRef = useRef(null) // queued eval args while waiting for set_game_result
    const { socket } = useContext(AuthContext)

    // Benchmark logging: window.__senseiLog is an array of per-move results
    if (!window.__senseiLog) window.__senseiLog = []
    if (!window.__senseiReady) window.__senseiReady = false

    const maxTime = 30;

// not ready
// ready (finished or just loaded)
// thinking (evaluating position)
// interrupted (was thinking and received stop)

    const senseiStop = () => {
        askedForHint.current = false
        thinkingRef.current = false
        if(senseiRef.current) {
            senseiRef.current._sensei_stop()
        }
    }

    const sendCommand = (cmd) => {
        // console.log('sendCommand: ', {cmd})
        if(!senseiRef.current) return
        const ptr = senseiRef.current.stringToNewUTF8(cmd)
        senseiRef.current._sensei_command(ptr)
        // console.log('hello?')
        senseiRef.current._free(ptr)
    }

    const senseiHint = (str, moveNumber, nMove, table, legalMoves, stat) => {
        if(modeRef.current === 'retro') return
        if(legalMoves === 0) return
        move.current = moveNumber
        transcript.current = str
        nextRef.current = nMove
        legalMovesRef.current = legalMoves
        hintEvalsRef.current = []

        // Stop engine if it's currently evaluating — uses ref to prevent double-stop crashes
        if (thinkingRef.current) {
            thinkingRef.current = false
            if(senseiRef.current) senseiRef.current._sensei_stop()
        }
        senseiHintOriginal(str, moveNumber, nMove, table, legalMoves)
    }

    // chaining status change
    useEffect(()=> {
        if(status === 'not ready' || status === 'ready' || status === 'thinking' || status === 'started') return
        if(status === 'interrupted') {
            if (askedForHint.current) {
                senseiHintOriginal(transcript.current, move.current, nextRef.current, evalsTable.current, legalMovesRef.current)
            } else {
                setStatus('ready')
                hintEvalsFlag.current = 0
            }
            return
        }
    },[status])


    const senseiHintOriginal = (str, moveNumber, nMove, table, legalMoves) => {
        if(!senseiRef.current) return
        if(!senseiReadyRef.current) return
        
        hintEvalsFlag.current = 0
        setHintEvals([])
        setHintedOnce(true)

// starting position
        if(str === '') { 
            hintEvalsRef.current = [...START_EVALS]
            setHintEvals(START_EVALS)
            setStatus('ready')
            return
        }

// show cached evals immediately as placeholder, but continue to eval_move for deeper analysis
        if(table[moveNumber]?.length === legalMoves && legalMoves > 0) { 
            hintEvalsRef.current = [...table[moveNumber]]
            setHintEvals(table[moveNumber])
        }
        const notFromServer = editModeRef.current || evalsRef.current?.length === 0 || !evalsRef.current

// get some values from retro as initial placeholder (descendants=0 so engine evals override them)
        const evalIdx = moveNumber - xotOffsetRef.current
        if (!notFromServer && evalIdx >= 0 && evalIdx < evalsRef.current?.length) { 
            const bestMove = {}
            bestMove.move = evalsRef.current[evalIdx].best_move
            bestMove.score = evalsRef.current[evalIdx].best_eval
            bestMove.descendants = 0
            bestMove.is_book = false
            if(bestMove.move === nMove) {
                setHintEvals([bestMove])
                hintEvalsRef.current = [bestMove]
            } else {
                const nextMove = {}
                nextMove.move = nMove
                nextMove.score = evalsRef.current[evalIdx].eval
                nextMove.descendants = 0
                nextMove.is_book = false
                setHintEvals([bestMove, nextMove])
                hintEvalsRef.current = [bestMove, nextMove]
            }
        }
// !!!!ask book from server
        hintEvalsFlag.current = 0
        // if(str.length / 2 < edaxBookEmpty.current) { 
            // socket.emit('otb-get-hint', str)
            // perhaps ask for book evals from server. Not sure how it will be scaling.
            
        // }
// Wait for set_game to complete before sending eval_move
        if (setGamePendingRef.current) {
            pendingEvalRef.current = { str, moveNumber, nMove, table, legalMoves }
            return
        }
// proceed with actual sensei eval
        setStatus('thinking')
        thinkingRef.current = true
        hintEvalsFlag.current = 2
        lastDescendantsRef.current = 0
        evalStartTimeRef.current = performance.now()
        bestMoveRef.current = null
        bestMoveTimeRef.current = 0
        // If position is within a previously analyzed game, tell the engine to
        // re-evaluate even if it's on the analysis line (matches Flutter's
        // "evaluate if watching an analyzed game" setting).
        const reevaluate = (gameTranscriptRef.current && retroAnalysisRef.current.length > 0) ? 1 : 0
        sendCommand(`eval_move --board=${str} --max_time=${maxTime} --update_interval=1 --n_threads=${N_THREADS} --reevaluate=${reevaluate}`)
    }

    const senseiSetGame = (fullTranscript, force = false) => {
        if (!senseiRef.current || !senseiReadyRef.current) return
        if (!force && gameTranscriptRef.current === fullTranscript) return // already loaded
        gameTranscriptRef.current = fullTranscript
        setGamePendingRef.current = true
        sendCommand(`set_game --board=${fullTranscript}`)
    }

    const senseiAnalyzeGame = (fullTranscript, maxTime = 1) => {
        if (!senseiRef.current || !senseiReadyRef.current) return
        // Stop eval if running
        if (thinkingRef.current) {
            thinkingRef.current = false
            senseiRef.current._sensei_stop()
        }
        modeRef.current = 'retro'
        askedForHint.current = false
        setRetroStatus('running')
        setStatus('ready')
        hintEvalsFlag.current = 0
        hintEvalsRef.current = []
        setHintEvals([])
        if (gameTranscriptRef.current !== fullTranscript) {
            gameTranscriptRef.current = fullTranscript
            setGamePendingRef.current = true
            pendingRetroRef.current = { transcript: fullTranscript, maxTime }
            sendCommand(`set_game --board=${fullTranscript}`)
        } else if (setGamePendingRef.current) {
            // set_game sent but result hasn't arrived yet; queue analyze_game
            pendingRetroRef.current = { transcript: fullTranscript, maxTime }
        } else {
            sendCommand(`analyze_game --board=${fullTranscript} --max_time=${maxTime} --n_threads=${N_THREADS}`)
        }
    }

    const senseiStopRetro = () => {
        if (modeRef.current !== 'retro') return
        retroStopRequestedRef.current = true
        modeRef.current = 'eval'
        thinkingRef.current = false
        setStatus('ready')
        hintEvalsFlag.current = 0
        if (senseiRef.current) senseiRef.current._sensei_stop()
        // Interrupted = discard all retro data (user must start fresh)
        retroAnalysisRef.current = []
        setRetroAnalysis([])
        setRetroStatus('idle')
        setRetroCurrentIndex(-1)
    }

    const resetRetro = () => {
        if (modeRef.current === 'retro') senseiStopRetro()
        else {
            retroAnalysisRef.current = []
            setRetroAnalysis([])
            setRetroStatus('idle')
            setRetroCurrentIndex(-1)
        }
    }


// parse sensei JSON messages — each print() call is one complete line
    const parseOutput = (text) => {
        // console.log('log:', text)
        const trimmed = text.trim()
        if (!trimmed) return

        let msg
        try {
            msg = JSON.parse(trimmed)
        } catch {
            return
        }
        // console.log(msg)

        if (msg.type === 'ready') {
            console.log('Sensei Ready')
            senseiReadyRef.current = true
            window.__senseiReady = true
            setSenseiReady(true)
            setStatus('ready')
            return
        }

        if (msg.type === 'set_game_result') {
            console.log('set_game loaded:', msg.total_moves, 'moves')
            setGamePendingRef.current = false
            // Fire pending eval_move if one was queued while waiting for set_game
            if (pendingEvalRef.current) {
                const pending = pendingEvalRef.current
                pendingEvalRef.current = null
                senseiHintOriginal(pending.str, pending.moveNumber, pending.nMove, pending.table, pending.legalMoves)
            }
            // If analyze_game was waiting for set_game to finish, fire it now
            if (pendingRetroRef.current) {
                const { transcript, maxTime } = pendingRetroRef.current
                pendingRetroRef.current = null
                sendCommand(`analyze_game --board=${transcript} --max_time=${maxTime} --n_threads=${N_THREADS}`)
            }
            return
        }

        if (msg.type === 'stopped') {
            if (retroStopRequestedRef.current) {
                retroStopRequestedRef.current = false
                // Don't reset thinkingRef — a new eval_move may already be running
                return
            }
            if (modeRef.current === 'retro') return // transitional stop from previous command
            // If a new eval already started, ignore this stale stopped message
            if (thinkingRef.current) return
            setStatus('ready')
            hintEvalsFlag.current = 0
            return
        }

        if (msg.type === 'analyze_update') {
            if (modeRef.current !== 'retro') return // ignore late messages after stop
            const entry = {
                move_index: msg.move_index,
                black_move: msg.black_move,
                move_made: msg.move_made,
                move_made_eval: msg.move_made_eval,
                move_made_depth: msg.move_made_depth,
                best_move: msg.best_move,
                best_move_eval: msg.best_move_eval,
                best_move_depth: msg.best_move_depth,
                score_loss: msg.score_loss
            }
            retroAnalysisRef.current[msg.move_index] = entry
            setRetroAnalysis([...retroAnalysisRef.current])
            setRetroCurrentIndex(msg.move_index + 1) // +1: show position AFTER the analyzed move
            return
        }

        if (msg.type === 'analyze_result') {
            if (modeRef.current !== 'retro') return // ignore if retro was already stopped
            modeRef.current = 'eval'
            setRetroStatus('complete')
            setRetroCurrentIndex(-1)
            // Reset game tree: re-send set_game to clear cached evals from analyze_game
            // so that subsequent eval_move calls will search from scratch instead of
            // returning stale cached results immediately
            if (gameTranscriptRef.current) {
                setGamePendingRef.current = true
                sendCommand(`set_game --board=${gameTranscriptRef.current}`)
            }
            if (onRetroCompleteRef.current) onRetroCompleteRef.current([...retroAnalysisRef.current])
            return
        }

        if (msg.type === 'eval_update' || msg.type === 'eval_result') {
            if (!senseiReadyRef.current) return

            const evalMoves = (msg.moves || []).map(m => ({
                move: m.move,
                score: Math.round(-m.eval), // negate: Sensei reports from opponent's perspective
                descendants: m.descendants,
                is_book: m.is_book || false,
                certainty: m.certainty ?? 0,
                solved: m.solved || false
            }))

            if (evalMoves.length > 0) {
                updateHintEvals(evalMoves)
            }

            // Track best move changes for benchmark
            if (evalMoves.length > 0) {
                const sorted = [...evalMoves].sort((a, b) => b.score - a.score)
                const currentBest = sorted[0]?.move
                if (currentBest && currentBest !== bestMoveRef.current) {
                    bestMoveRef.current = currentBest
                    bestMoveTimeRef.current = performance.now()
                }
            }

            const finishEval = () => {
                const elapsed = (performance.now() - evalStartTimeRef.current) / 1000
                const bestMoveElapsed = bestMoveTimeRef.current > 0 ? (bestMoveTimeRef.current - evalStartTimeRef.current) / 1000 : elapsed
                const maxCertainty = evalMoves.reduce((m, e) => Math.max(m, e.certainty ?? 0), 0)
                // Use evalMoves from current message (hintEvalsRef may not be updated yet for fast evals)
                const evalsSource = hintEvalsRef.current.length > 0 ? hintEvalsRef.current : evalMoves
                const sorted = [...evalsSource].sort((a, b) => b.score - a.score)
                window.__senseiLog.push({
                    moveNumber: move.current,
                    finalSec: Math.round(elapsed * 100) / 100,
                    certainty: maxCertainty,
                    bestMoveSettledSec: Math.round(bestMoveElapsed * 100) / 100,
                    bestMove: sorted[0]?.move,
                    bestScore: sorted[0]?.score,
                    evals: sorted.map(e => ({ move: e.move, score: e.score }))
                })
                // console.log('[SENSEI BENCH]', window.__senseiLog[window.__senseiLog.length - 1])
                window.__senseiEvalDone = true
            }

            // Stale detection: if eval_update has same total descendants as previous, engine has stalled
            // Update retro analysis for current position from eval_move data
            const upgradeRetro = () => {
                if (!retroAnalysisRef.current[move.current]) return
                const totalDesc = evalMoves.reduce((s, m) => s + m.descendants, 0)
                const existingDesc = retroAnalysisRef.current[move.current].descendants || 0
                if (totalDesc > existingDesc) {
                    const sorted = [...evalMoves].sort((a, b) => b.score - a.score)
                    const nMove = nextRef.current
                    const played = nMove ? sorted.find(e => e.move === nMove) : null
                    retroAnalysisRef.current[move.current] = {
                        ...retroAnalysisRef.current[move.current],
                        best_move: sorted[0]?.move,
                        best_move_eval: sorted[0]?.score,
                        move_made_eval: played?.score ?? retroAnalysisRef.current[move.current].move_made_eval,
                        score_loss: Math.max(0, (sorted[0]?.score || 0) - (played?.score ?? 0)),
                        descendants: totalDesc
                    }
                    setRetroAnalysis([...retroAnalysisRef.current])
                }
            }

            // Update ancestor positions from corrected_ancestors (backward-propagated evals from set_game tree)
            const applyCorrectedAncestors = () => {
                const ancestors = msg.corrected_ancestors
                if (!ancestors || ancestors.length === 0) return
                let changed = false
                for (const anc of ancestors) {
                    const idx = anc.move_index
                    if (!retroAnalysisRef.current[idx]) continue
                    // corrected_ancestors eval is from current player's perspective at that position
                    const correctedEval = anc.eval
                    const existing = retroAnalysisRef.current[idx]
                    // Update best_move_eval with the corrected backward-propagated value
                    if (correctedEval !== existing.best_move_eval) {
                        retroAnalysisRef.current[idx] = {
                            ...existing,
                            best_move_eval: correctedEval,
                            score_loss: Math.max(0, correctedEval - existing.move_made_eval)
                        }
                        changed = true
                    }
                }
                if (changed) setRetroAnalysis([...retroAnalysisRef.current])
            }

            if (msg.type === 'eval_update') {
                const totalDesc = evalMoves.reduce((s, m) => s + m.descendants, 0)
                upgradeRetro()
                applyCorrectedAncestors()
                if (totalDesc > 0 && totalDesc === lastDescendantsRef.current) {
                    thinkingRef.current = false
                    senseiStop()
                    finishEval()
                    setStatus('ready')
                    hintEvalsFlag.current = 3
                    evalsTable.current[move.current] = [...hintEvalsRef.current]
                } else {
                    lastDescendantsRef.current = totalDesc
                }
            }

            if (msg.type === 'eval_result') {
                thinkingRef.current = false
                upgradeRetro()
                applyCorrectedAncestors()
                finishEval()
                setStatus('ready')
                hintEvalsFlag.current = 3
                evalsTable.current[move.current] = [...hintEvalsRef.current]
            }
            return
        }
    }

    const updateHintEvals = (arr) => {
        setHintEvals((prev) => {
            if (prev.length === 0) return arr
            const newVals = [...prev]
            for (let j = 0; j < arr.length; j++ ) {
                let flag = false
                for (let i = 0; i < newVals.length; i++) {
                    if (newVals[i].move === arr[j].move) { // found same move
                        flag = true
                        // Never overwrite server book entries with engine evals
                        if (newVals[i].is_book) continue
                        // update if new eval has more descendants (more reliable)
                        if(newVals[i].descendants < arr[j].descendants) {
                            newVals[i] = {...arr[j]}
                        }
                    }
                }
                if (!flag) newVals.push(arr[j])
            }
            hintEvalsRef.current = [...newVals]
            return newVals
        })
    }
    // error handling
    useEffect(() => {
        console.log('sensei error code:', error)
        if (error === 0) return
        if (error === 1) {
            if(senseiRef.current) senseiRef.current._sensei_stop()
            setError(0)
        } 
    },[error])
    
    
    useEffect(()=> {
        const loadWasm = async () => {
            try {
                console.log("Before importing Sensei WASM");
                // Webpack resolves this URL at build time — no need for public/ copies
                const evalsUrl = new URL('../module/pattern_evaluator.dat', import.meta.url)

                // Fetch eval data and book manifest in parallel
                const [evalResp, manifestResp] = await Promise.all([
                    fetch(evalsUrl),
                    fetch('/book-manifest.json')
                ]);
                const evalData = new Uint8Array(await evalResp.arrayBuffer());
                const bookFileNames = await manifestResp.json();

                // Fetch all book files in parallel
                const bookFiles = await Promise.all(
                    bookFileNames.map(async (name) => {
                        const resp = await fetch('/book/' + name);
                        return { name, data: new Uint8Array(await resp.arrayBuffer()) };
                    })
                );
                console.log(`Fetched ${bookFiles.length} book files`);

                const instance = await SenseiEngine({
                    // .wasm resolved automatically by Emscripten's new URL("sensei_cli_main.wasm", import.meta.url)
                    print: (text) => { 
                        parseOutput(text)
                    },
                    printErr: (text) => {
                        console.log('sensei stderr:', text)
                    },
                    arguments: [`--evals_path=./pattern_evaluator.dat`, `--book_path=./book`],
                    preRun: [(Module) => {
                        Module.FS.writeFile('./pattern_evaluator.dat', evalData);
                        Module.FS.mkdir('./book');
                        for (const { name, data } of bookFiles) {
                            Module.FS.writeFile('./book/' + name, data);
                        }
                        console.log('VFS: loaded pattern_evaluator.dat (' + evalData.length + ' bytes) and ' + bookFiles.length + ' book files');
                    }]
                })
                console.log("After importing Sensei WASM");
                senseiRef.current = instance
                setSensei(instance)
            } catch (err) {
                console.error("Error loading Sensei WASM module:", err)
            }
        } 
        loadWasm()
        
        return () => {
            console.log('sensei clean up')
            if(senseiRef.current) {
                senseiRef.current._sensei_stop()
            }
            senseiRef.current = null
            setSensei(null)
            setHintEvals([])
            hintEvalsFlag.current = 0
            evalsTable.current = [START_EVALS]
            evalsRef.current = []
            edaxBookEmpty.current = MAX_BOOK_MOVE
            askedForHint.current = false
            senseiReadyRef.current = false
            setSenseiReady(false)
            setStatus('not ready')
            thinkingRef.current = false
            retroAnalysisRef.current = []
            gameTranscriptRef.current = ''
            pendingRetroRef.current = null
            setGamePendingRef.current = false
            pendingEvalRef.current = null
            modeRef.current = 'eval'
            setRetroAnalysis([])
            setRetroStatus('idle')
            setRetroCurrentIndex(-1)
        }
    },[])

    return {
        sensei,
        status,
        senseiReady,
        hintedOnce,
        hintEvals,
        edaxBookEmpty,
        senseiHint,
        senseiStop,
        updateHintEvals,
        setHintEvals,
        hintEvalsFlag,
        evalsTable,
        evalsRef,
        editModeRef,
        xotOffsetRef,
        setHintedOnce,
        retroAnalysis,
        retroStatus,
        retroCurrentIndex,
        senseiAnalyzeGame,
        senseiSetGame,
        senseiStopRetro,
        resetRetro,
        modeRef,
        onRetroCompleteRef
    }
}