import {useState, useCallback, useEffect} from 'react'

const storageName = 'userData'

export const useAuth = (socket) => {
    const [token, setToken] = useState(null)
    const [sid, setSID] = useState(null)
    const [userId, setUserId] = useState(null)
    const [nick, setNick] = useState(null)
    const [isAdmin, setIsAdmin] = useState(null)
    const [isAuthenticated, setIsAuthenticated] = useState(null)
    const [sub, setSub] = useState(null)

    const getSubscription = async () => {
        navigator.serviceWorker.ready.then(function(registration) {
            registration.pushManager.getSubscription().then(function(subscription) {
              if (subscription) {
                setSub(subscription) 
              } else {
                // console.log('User is not subscribed to push notifications');
                setSub(null) 
              }
            }).catch(function(error) {
            //   console.error('Error retrieving subscription:', error);
            });
        });
    }

    useEffect(() => {
        getSubscription()
    },[])

    //problem: when register or login - useEffect isn't triggered
    const login = useCallback(async (jwtToken, id, nick, status, sid) => {
        setToken(jwtToken)
        setUserId(id)
        setNick(nick)
        setIsAuthenticated(true)
        status > 1 ? setIsAdmin(true) : setIsAdmin(false)
        setSID(sid)
        if (sub?.endpoint) {
            const isApp = window.matchMedia('(display-mode: standalone)').matches
            await fetch("/api/subscribe", {
                method: "POST",
                body: JSON.stringify(sub),
                headers: {
                    "Content-Type": "application/json",
                    token: jwtToken,
                    app: isApp,
                }
            })
        }
        localStorage.setItem(storageName, JSON.stringify({token: jwtToken, sid: sid}))
    }, [sub])

    const logout = useCallback( async ()=> {
        setToken(null)
        setUserId(null)
        setNick(null)
        setSID(null)
        setIsAuthenticated(false)
        setIsAdmin(false)
        localStorage.removeItem(storageName)
        if (socket) {
            socket.emit('logout', sub)
        }
    }, [sub])   

    useEffect( () => {
        socket.on('auth', async data => {
            if (data) {
                login(data.token, data.userId, data.nick, data.status, data.sid)
            } else {
                logout()
                setUserId(socket.id.substring(1,5))
            }
        })
        return () => {
            socket.off('auth')
        }
    },[login])

    return {login, logout, token, userId, socket, nick, isAuthenticated, isAdmin, sid}
}

