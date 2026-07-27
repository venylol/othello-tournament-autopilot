import { useState, useEffect } from 'react'

function detectWebView() {
    const ua = navigator.userAgent || ''
    // Telegram, Facebook, Instagram, LINE, etc. in-app browsers
    if (/TelegramBot|Telegram|FBAN|FBAV|Instagram|Line\//i.test(ua)) return true
    // Generic WebView markers
    if (/wv|WebView/i.test(ua)) return true
    // iOS standalone WKWebView without Safari marker
    if (/iPhone|iPad/.test(ua) && !/Safari/i.test(ua)) return true
    return false
}

export const usePWAInstall = () => {
    const [deferredPrompt, setDeferredPrompt] = useState(null)
    const [isInstalled, setIsInstalled] = useState(
        window.matchMedia('(display-mode: standalone)').matches
    )
    const isInWebView = detectWebView()

    useEffect(() => {
        const handler = (e) => {
            e.preventDefault()
            setDeferredPrompt(e)
        }

        const installedHandler = () => {
            setIsInstalled(true)
            setDeferredPrompt(null)
        }

        window.addEventListener('beforeinstallprompt', handler)
        window.addEventListener('appinstalled', installedHandler)

        return () => {
            window.removeEventListener('beforeinstallprompt', handler)
            window.removeEventListener('appinstalled', installedHandler)
        }
    }, [])

    const installApp = async () => {
        if (!deferredPrompt) return false
        deferredPrompt.prompt()
        const { outcome } = await deferredPrompt.userChoice
        setDeferredPrompt(null)
        if (outcome === 'accepted') {
            setIsInstalled(true)
            return true
        }
        return false
    }

    return {
        canInstall: !!deferredPrompt && !isInstalled,
        isInstalled,
        isInWebView,
        installApp
    }
}
