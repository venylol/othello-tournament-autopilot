import {useState} from 'react'

export const useChat = () => {
    const [chatOpened, setChatOpened] = useState(false)
    const [typing, setTyping] = useState(false)
    const [messages, setMessages] = useState([])
    return {chatOpened, setChatOpened, typing, setTyping, messages, setMessages}
}