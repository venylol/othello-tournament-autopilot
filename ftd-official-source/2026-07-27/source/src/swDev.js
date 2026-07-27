const storageName = 'userData'

export const swVersion = {
    _version: null,
    _listeners: new Set(),
    subscribe(fn) {
        this._listeners.add(fn)
        if (this._version) fn(this._version)
        return () => this._listeners.delete(fn)
    },
    request() {
        if (navigator.serviceWorker?.controller) {
            navigator.serviceWorker.controller.postMessage({ type: 'GET_VERSION' })
        }
    }
}

// --- Module-scope listeners (active as soon as this module is imported) ---

if ('serviceWorker' in navigator) {
    // Reload when a new SW takes control (works for both browser and PWA)
    let refreshing = false
    navigator.serviceWorker.addEventListener('controllerchange', () => {
        if (refreshing) return
        refreshing = true
        console.log('New Service Worker activated, reloading page...')
        window.location.reload()
    })

    // Listen for version info from the SW
    navigator.serviceWorker.addEventListener('message', (event) => {
        if (event.data && event.data.type === 'SW_VERSION') {
            swVersion._version = event.data.version
            swVersion._listeners.forEach(fn => fn(event.data.version))
        }
    })
}

export default async function swDev () {

    function urlBase64ToUint8Array (base64String) {
        const padding = '='.repeat((4 - base64String.length % 4) % 4);
        const base64 = (base64String + padding).replace(/\-/g, '+').replace(/_/g, '/');
    
        const rawData = window.atob(base64);
        const outputArray = new Uint8Array(rawData.length);
    
        for (let i = 0; i< rawData.length; i++) {
            outputArray[i] = rawData.charCodeAt(i);
        }
        return outputArray;
    }
    
    function detemineAppServerKey() {
        let vapidPublicKey = 'BAuiS658QsWQyDdLBEhsk3zDP3sBQShUm09TaCJQoLW9SHQyVhwQ9Wa4dYnFx_l6imMwjpXA8_37CmZEXE75LX8'
        return urlBase64ToUint8Array(vapidPublicKey)
    }

    const swUrl = `${process.env.PUBLIC_URL}/sw.js`
    
    const register = await navigator.serviceWorker.register(swUrl, {
        scope: '/'
    });

    await navigator.serviceWorker.ready

    // Only subscribe to push if notification permission is already granted.
    // Permission will be requested later via the in-app UI.
    if (Notification.permission === 'granted') {
        try {
            const subscription = await register.pushManager.subscribe({
                userVisibleOnly: true,
                applicationServerKey: detemineAppServerKey(),
            });

            const data = await JSON.parse(localStorage.getItem(storageName))
            const isApp = window.matchMedia('(display-mode: standalone)').matches
            await fetch("/api/subscribe", {
                method: "POST",
                body: JSON.stringify(subscription),
                headers: {
                    "Content-Type": "application/json",
                    token: data?.token,
                    app: isApp,
                }
            })
        } catch (err) {
            console.warn('Push subscription failed:', err)
        }
    }
}