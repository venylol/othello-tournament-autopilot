import {useState, useCallback, useEffect} from 'react'

const storageName = 'userSettings'

export const useSettings = () => {
    const [settings, setSettings] = useState({})
    // const changeSettings = useCallback((newSettings) => {
    //     console.log(newSettings)
    //     setSettings(newSettings)
    //     localStorage.setItem(storageName, JSON.stringify({showLegalMoves: newSettings.showLegalMoves, markLastMove: newSettings.markLastMove, sound: newSettings.sound, chat: newSettings.chat}))
    // }, [])

    useEffect (() => {
        (async () => {
            const data = await JSON.parse(localStorage.getItem(storageName))
            if (data) {
                setSettings(data)
            } else {
                setSettings({showLegalMoves: true, markLastMove: true, sound: true, chat: true, showEvalBar: false})
            }
        })()
    },[])

    useEffect (() => {
        localStorage.setItem(storageName, JSON.stringify(settings))
    }, [settings])

    return {settings, setSettings}
}