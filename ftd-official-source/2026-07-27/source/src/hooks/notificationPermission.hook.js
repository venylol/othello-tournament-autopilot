import { useState, useEffect } from 'react'

function urlBase64ToUint8Array(base64String) {
    const padding = '='.repeat((4 - base64String.length % 4) % 4)
    const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/')
    const rawData = window.atob(base64)
    const outputArray = new Uint8Array(rawData.length)
    for (let i = 0; i < rawData.length; i++) {
        outputArray[i] = rawData.charCodeAt(i)
    }
    return outputArray
}

async function subscribeToPush() {
    try {
        const reg = await navigator.serviceWorker.ready
        const vapidKey = 'BAuiS658QsWQyDdLBEhsk3zDP3sBQShUm09TaCJQoLW9SHQyVhwQ9Wa4dYnFx_l6imMwjpXA8_37CmZEXE75LX8'
        const subscription = await reg.pushManager.subscribe({
            userVisibleOnly: true,
            applicationServerKey: urlBase64ToUint8Array(vapidKey),
        })
        const data = JSON.parse(localStorage.getItem('userData'))
        const isApp = window.matchMedia('(display-mode: standalone)').matches
        await fetch('/api/subscribe', {
            method: 'POST',
            body: JSON.stringify(subscription),
            headers: {
                'Content-Type': 'application/json',
                token: data?.token,
                app: isApp,
            }
        })
    } catch (err) {
        console.warn('Push subscription after permission grant failed:', err)
    }
}

export const useNotificationPermission = () => {
    const [permission, setPermission] = useState(
        'Notification' in window ? Notification.permission : 'unsupported'
    )

    useEffect(() => {
        if (!('Notification' in window)) return

        const interval = setInterval(() => {
            if (Notification.permission !== permission) {
                setPermission(Notification.permission)
            }
        }, 2000)

        return () => clearInterval(interval)
    }, [permission])

    const requestPermission = async () => {
        if (!('Notification' in window)) return 'unsupported'
        if (Notification.permission === 'granted') return 'granted'
        if (Notification.permission === 'denied') return 'denied'

        const result = await Notification.requestPermission()
        setPermission(result)

        // If user just granted permission, subscribe to push notifications
        if (result === 'granted') {
            await subscribeToPush()
        }

        return result
    }

    return {
        permission,
        canAsk: permission === 'default',
        isGranted: permission === 'granted',
        isDenied: permission === 'denied',
        isUnsupported: permission === 'unsupported',
        requestPermission
    }
}
