
import {useEffect, useRef} from 'react'
import Move from '../assets/sounds/move.wav'
import Tick from '../assets/sounds/timer.wav'
import Bullet from '../assets/sounds/bullet.wav'
import Gong from '../assets/sounds/round_start.wav'
import Scream from '../assets/sounds/scream.wav'
import David from '../assets/sounds/david_wins.wav'
import TournamentFinish from '../assets/sounds/applause.mp3'
import Withdraw from '../assets/sounds/withdraw.wav'


export const useAudio = () => {
    const constextRef = useRef() 
    const moveRef = useRef()
    const tickRef = useRef()
    const bulletRef = useRef()
    const gongRef = useRef()
    const screamRef = useRef()
    const davidRef = useRef()
    const tournamentFinishRef = useRef()
    const withdrawRef = useRef()
    useEffect ( () => {
        const context = new (window.AudioContext || window.webkitAudioContext)(); 
        constextRef.current = context
        
        const loadSoundEffects = async (sound, ref) => {
            try {
                const response = await fetch(sound);
                const arrayBuffer = await response.arrayBuffer();
                const audioBuffer = await context.decodeAudioData(arrayBuffer);
                ref.current = audioBuffer
            } catch (error) {
                console.error('Error loading sound effect:', error);
            }
        }
        loadSoundEffects(Bullet, bulletRef)
        loadSoundEffects(Move, moveRef)
        loadSoundEffects(Tick, tickRef)
        loadSoundEffects(Gong, gongRef)
        loadSoundEffects(Scream, screamRef)
        loadSoundEffects(David, davidRef)
        loadSoundEffects(TournamentFinish, tournamentFinishRef)
        loadSoundEffects(Withdraw, withdrawRef)
    },[])

    const playMove = () => {
        if (!moveRef.current)  return
        const gainNode = constextRef.current.createGain();
        gainNode.gain.value = 2;
        gainNode.connect(constextRef.current.destination);
        const source = constextRef.current.createBufferSource();
        source.buffer = moveRef.current;
        source.connect(gainNode);
        source.start(0);
    }

    const playBullet = () => {
        if (!bulletRef.current)  return
        const source = constextRef.current.createBufferSource();
        source.buffer = bulletRef.current;
        source.connect(constextRef.current.destination);
        source.start(0);
    }

    const playTick = () => {
        if (!tickRef.current)  return
        const source = constextRef.current.createBufferSource();
        source.buffer = tickRef.current;
        source.connect(constextRef.current.destination);
        source.start(0);
    }

    const playGong = () => {
        if (!gongRef.current)  return
        const source = constextRef.current.createBufferSource();
        source.buffer = gongRef.current;
        source.connect(constextRef.current.destination);
        source.start(0);
    }

    const playScream = () => {
        if (!screamRef.current)  return
        const source = constextRef.current.createBufferSource();
        source.buffer = screamRef.current;
        source.connect(constextRef.current.destination);
        source.start(0);
    }

    const playDavid = () => {
        if (!davidRef.current)  return
        const ctx = constextRef.current
        const gainNode = ctx.createGain()
        gainNode.gain.value = 1
        gainNode.connect(ctx.destination)
        const source = ctx.createBufferSource()
        source.buffer = davidRef.current
        source.connect(gainNode)
        source.start(0)
        return {
            stop: (fadeDuration = 1) => {
                gainNode.gain.setValueAtTime(gainNode.gain.value, ctx.currentTime)
                gainNode.gain.linearRampToValueAtTime(0, ctx.currentTime + fadeDuration)
                setTimeout(() => { try { source.stop() } catch(e) {} }, fadeDuration * 1000)
            }
        }
    }

    const playTournamentFinish = () => {
        if (!tournamentFinishRef.current)  return
        const ctx = constextRef.current
        const gainNode = ctx.createGain()
        gainNode.gain.value = 1
        gainNode.connect(ctx.destination)
        const source = ctx.createBufferSource()
        source.buffer = tournamentFinishRef.current
        source.connect(gainNode)
        source.start(0)
        return {
            stop: (fadeDuration = 1) => {
                gainNode.gain.setValueAtTime(gainNode.gain.value, ctx.currentTime)
                gainNode.gain.linearRampToValueAtTime(0, ctx.currentTime + fadeDuration)
                setTimeout(() => { try { source.stop() } catch(e) {} }, fadeDuration * 1000)
            }
        }
    }

    const playWithdraw = () => {
        if (!withdrawRef.current)  return
        const ctx = constextRef.current
        const gainNode = ctx.createGain()
        gainNode.gain.value = 1
        gainNode.connect(ctx.destination)
        const source = ctx.createBufferSource()
        source.buffer = withdrawRef.current
        source.connect(gainNode)
        source.start(0)
        return {
            stop: (fadeDuration = 1) => {
                gainNode.gain.setValueAtTime(gainNode.gain.value, ctx.currentTime)
                gainNode.gain.linearRampToValueAtTime(0, ctx.currentTime + fadeDuration)
                setTimeout(() => { try { source.stop() } catch(e) {} }, fadeDuration * 1000)
            }
        }
    }

    return {playBullet, playMove, playTick, playGong, playScream, playDavid, playTournamentFinish, playWithdraw}
}