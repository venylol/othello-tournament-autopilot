
import { useEffect, useRef } from 'react'
import { openDB } from 'idb'

export const useIDB = () => {
    const dbRef = useRef(null)
    const dbName = 'Notifications'
    const storeName = 'notifications'
    const version = 1
    const limit = 30

    const getDb = async () => {
        const db = await openDB(dbName, version, {
            upgrade(db) {
                const store = db.createObjectStore(storeName, {
                    keyPath: 'id',
                    autoIncrement: false,
                })
                store.createIndex('date', 'date')
            }
        })
        dbRef.current = db
        return db
    }

    useEffect(() => {
        getDb()
    },[])

    const addNotification = async (data) => {
        const db = dbRef.current? dbRef.current : await getDb()
        const notifications = await db.getAllFromIndex(storeName, 'date')
        if (notifications.length >= limit) {
            for (let i = 0; i <= notifications.length - limit; i++) {
                await db.delete(storeName, notifications[i].id)
            }
        }
        await db.add(storeName, {...data})
    }

    const deleteNotification = async (id) => {
        const db = dbRef.current? dbRef.current : await getDb()
        await db.delete(storeName, id)
    }

    const updateNotification = async (id) => {
        const db = dbRef.current? dbRef.current : await getDb()
        const notification = await db.get(storeName, id)
        if(!notification) return
        notification.read = true
        notification.active = false
        // console.log('update notification', notification)
        await db.put(storeName, {...notification})
    }

    const getNotificationById = async (id) => {
        const db = dbRef.current? dbRef.current : await getDb()
        const notification = await db.get(storeName, id)
        return notification
    }

    const getNotifications = async () => {
        const db = dbRef.current? dbRef.current : await getDb()
        const notifications = await db.getAllFromIndex(storeName, 'date')
        notifications.sort((a,b) => b.date - a.date)
        // console.log ('getNotifications', notifications)
        return notifications

    }

    const getUnreadNotifications = async () => {
        const db = dbRef.current? dbRef.current : await getDb()
        const notifications = await db.getAllFromIndex(storeName, 'date')
        const unread = notifications.filter(notification => !notification.read)
        // console.log(notifications.length, unread)
        return unread.length
    }

    const markReadAll = async () => {
        const db = dbRef.current? dbRef.current : await getDb()
        const tx = db.transaction(storeName, 'readwrite');
            for await (const cursor of tx.store) {
                const notification = {...cursor.value}
                notification.read = true
                cursor.update(notification)
            }
    }

    const clearAllNotifications = async () => {
        const db = dbRef.current ? dbRef.current : await getDb()
        await db.clear(storeName)
    }

    const updateList = async (arr) => {
        const db = dbRef.current? dbRef.current : await getDb()
        const notificationsCheck = await db.getAllFromIndex(storeName, 'date')
        if (notificationsCheck.length >= limit) {
            for (let i = 0; i <= notificationsCheck.length - limit; i++) {
                await db.delete(storeName, notificationsCheck[i].id)
            }
        }
        const notifications = await db.getAllFromIndex(storeName, 'date')
        for (let i = 0; i < notifications.length; i++) {
            if (notifications[i].oppNick && notifications[i].active) {
                let flag = false
                for (let j = 0; j < arr.length; j++) {
                    if (notifications[i].id === arr[j]) {
                        flag = true
                        break
                    }
                }
                if (!flag) {
                    const notification = await db.get(storeName, notifications[i].id)
                    if(!notification) continue
                    notification.active = false
                    await db.put(storeName, {...notification})  
                }
            } 
        }
    }
    
    return {addNotification, deleteNotification, updateNotification, getNotifications, getUnreadNotifications, markReadAll, getNotificationById, updateList, clearAllNotifications}
}