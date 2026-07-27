import {useState} from 'react'

export const useBell = () => {
    const [notificationsOpen, setNotificationsOpen] = useState(false)
    return {notificationsOpen, setNotificationsOpen}
}