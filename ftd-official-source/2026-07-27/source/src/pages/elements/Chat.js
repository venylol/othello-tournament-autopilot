import {useState, useRef, useEffect, useContext} from 'react'
import { LayoutContext } from '../../context/LayoutContext'
import { UserContext } from '../../context/UserContext'
import { AuthContext } from '../../context/AuthContext'
import { MessageBubble } from './MessageBubble'
import { GameContext } from '../../context/GameContext'
// import { useFullScreen } from '../../hooks/fullscreen.hook'

const ChatSVG = ({opened, hidden}) => {
    if (hidden) return (<></>)
    return(
        <svg viewBox="64 64 896 896" focusable="false" fill = {!opened ? "#aca9a9" : 'white'}>
        <defs>
        <style/>
        </defs>
        <path d="M573 421c-23.1 0-41 17.9-41 40s17.9 40 41 40c21.1 0 39-17.9 39-40s-17.9-40-39-40zm-280 0c-23.1 0-41 17.9-41 40s17.9 40 41 40c21.1 0 39-17.9 39-40s-17.9-40-39-40z"/>
        <path d="M894 345a343.92 343.92 0 00-189-130v.1c-17.1-19-36.4-36.5-58-52.1-163.7-119-393.5-82.7-513 81-96.3 133-92.2 311.9 6 439l.8 132.6c0 3.2.5 6.4 1.5 9.4a31.95 31.95 0 0040.1 20.9L309 806c33.5 11.9 68.1 18.7 102.5 20.6l-.5.4c89.1 64.9 205.9 84.4 313 49l127.1 41.4c3.2 1 6.5 1.6 9.9 1.6 17.7 0 32-14.3 32-32V753c88.1-119.6 90.4-284.9 1-408zM323 735l-12-5-99 31-1-104-8-9c-84.6-103.2-90.2-251.9-11-361 96.4-132.2 281.2-161.4 413-66 132.2 96.1 161.5 280.6 66 412-80.1 109.9-223.5 150.5-348 102zm505-17l-8 10 1 104-98-33-12 5c-56 20.8-115.7 22.5-171 7l-.2-.1A367.31 367.31 0 00729 676c76.4-105.3 88.8-237.6 44.4-350.4l.6.4c23 16.5 44.1 37.1 62 62 72.6 99.6 68.5 235.2-8 330z"/>
        <path d="M433 421c-23.1 0-41 17.9-41 40s17.9 40 41 40c21.1 0 39-17.9 39-40s-17.9-40-39-40z"/>
        </svg>
    )
}

export const Chat = ({setPressed, pressed}) => {
    const [opened, setOpened] = useState(false)
    const [messages, setMessages] = useState([])
    const [unread, setUnread] = useState(0)
    const [bubbleMessage, setBubbleMessage] = useState (false)
    const [chatHeight, setChatHeight] = useState(93.5)
    const chatRef = useRef()
    const scrollRef = useRef ()
    const inputRef = useRef()
    const dragRef = useRef()
    // const {chatOpened, setChatOpened, typing, setTyping} = useContext(UserContext)
    // const {keyboard, isMobile, height, isFullScreen} = useContext(LayoutContext)
    const {chatOpened, setChatOpened, typing, setTyping, isMobile, isFullScreen} = useContext(UserContext)
    const {keyboard, height} = useContext(LayoutContext)
    const {opponent, round} = useContext(GameContext)
    const {socket, isAuthenticated} = useContext(AuthContext)
    const prevRoundRef = useRef(null)
    const defaultHeight = 93.5
    const maxHeight = height - 138
    const bubbleTimeout = 2000
    

    const [touchStart, setTouchStart] = useState(null)
    const [toClose, setToClose] = useState(false)

    const onTouchStart = (e) => {
        setTouchStart(e.targetTouches[0].clientY)
        if (chatHeight === defaultHeight) {
            setToClose(true)
        }       
    }

    const onTouchMove = (e) => {
        const end = e.targetTouches[0].clientY
        if (!touchStart || !end) return
        const distance = touchStart - end

        if (chatHeight === defaultHeight && distance < 0 && toClose) {
            setOpened(false)
            setChatOpened(false)
            return
        }

        if (chatHeight + distance <= defaultHeight) {
            chatRef.current.style.height = defaultHeight + 'px'
            chatRef.current.style.maxHeight = defaultHeight + 'px'
            chatRef.current.style.minHeight = defaultHeight + 'px'
            setChatHeight(defaultHeight)
            setTouchStart(end)
            return
        }

        if (chatHeight + distance >= maxHeight) {
            chatRef.current.style.height = maxHeight + 'px'
            chatRef.current.style.maxHeight = maxHeight + 'px'
            chatRef.current.style.minHeight = maxHeight + 'px'
            setChatHeight(maxHeight)
            setTouchStart(end)
            setToClose(false)
            return
        }
       
        chatRef.current.style.height = chatHeight + distance + 'px'
        chatRef.current.style.maxHeight = chatHeight + distance + 'px'
        chatRef.current.style.minHeight = chatHeight + distance + 'px'
        setChatHeight(prev => prev + distance)
        setTouchStart(end)
        setToClose(false)
    }

    useEffect (() => {
        if (pressed !== 'chat') {
            setOpened(false)
            setChatOpened(false)    
            return
        }
    }, [pressed])

    // Clear chat when a new tournament round starts (round changes from one number to another)
    useEffect(() => {
        if (round && prevRoundRef.current && round !== prevRoundRef.current) {
            setMessages([])
            setUnread(0)
        }
        prevRoundRef.current = round
    }, [round])

    useEffect(() => {
        // console.log(opponent)
        if(!isAuthenticated) return
        socket.on ('chat-message', (message, nick) => {
            setMessages(prev => [...prev, {sender: nick, message: message }])
            if(!opened && nick !== 'system') {
                setUnread(prev => prev + 1)
            }
            if (nick === opponent?.nick) {
                setBubbleMessage(message)
                setTimeout(() => {
                    setBubbleMessage(null)
                }, bubbleTimeout)
            }
            
        })
        if(opened) {
            setPressed('chat')       
        }
        return () => {
            socket.off ('chat-message')
        }
    },[socket, opened, isAuthenticated, opponent])

    const handleEnter = (e) => {
        if (e.key === 'Enter') {
            const val = e.target.value
            if(val.length === 0) return
            setMessages(prev => [...prev, {sender: 'yours', message: val }])
            socket.emit('chat-message', val)
            e.target.value = ''
        }
        
    }

    useEffect(() => {
        if (!scrollRef?.current) return
        if (messages[messages.length - 1]?.sender === 'system') return
        scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    },[messages, opened])

    const handleFocus = () => {
        setTyping(true)
    }

    const handleBlur = (e) => {
        setTyping(false)
        e.target.scrollLeft = e.target.scrollWidth
    }

    const chatHandler = () => {
        if (isAuthenticated) {
            setOpened(prev => !prev)
            setChatOpened(prev => !prev)
            setUnread(0)
        }
    }
    useEffect(() => { // test
        // const message = `opened: ${opened}, typing ${typing}, isMobile ${isMobile}, isFullScreen ${isFullScreen}, keyboard ${keyboard}, height ${height}`
        // console.log(message)
        // setMessages(prev => [...prev, {sender: 'system', message: message }])

        if (opened) {
            inputRef.current.style.height = '35px' 
            inputRef.current.placeholder =  'Message'
            inputRef.current.type = 'text'
            inputRef.current.inputMode = 'text'
            chatRef.current.style.maxHeight = typing ? Math.min(chatHeight, height - 88) + 'px' : chatHeight + 'px'
            chatRef.current.style.height = typing ? Math.min(chatHeight, height - 88) + 'px' : chatHeight + 'px'
            chatRef.current.style.minHeight = typing ? Math.min(chatHeight, height - 88) + 'px' : chatHeight + 'px'
            inputRef.current.style.bottom = '50px'
            chatRef.current.style.bottom = '88px'
            dragRef.current.style.height = '30px'
        } 
        if (!opened) {
            inputRef.current.style.height = '0px'
            inputRef.current.placeholder =  ''
            inputRef.current.type = 'hidden'
            inputRef.current.style.bottom = '0px'
            chatRef.current.style.height =  '0px'
            chatRef.current.style.minHeight =  '0px'
            chatRef.current.style.bottom = '0px'
            chatRef.current.style.bottom = '0px'
            dragRef.current.style.height = '0px'
            return 
        }  
        if (typing && isFullScreen && isMobile) {
            inputRef.current.style.bottom = keyboard > 0 ? keyboard  + 'px' : '0px'
            chatRef.current.style.bottom = keyboard > 0 ? keyboard + 38 + 'px' : '38px'
            // inputRef.current.style.bottom = '48px'
            // chatRef.current.style.bottom = '86px'
            return
        }   
        if (typing && !isFullScreen && isMobile) {
            inputRef.current.style.bottom = '0px'
            chatRef.current.style.bottom = '38px'
            return
        }

    },[opened, typing, isMobile, isFullScreen, keyboard, height]) 

    useEffect (() => {
        if (!typing || !opened || !scrollRef?.current) return
        // console.log('hey')
        window.scrollTo(0,0)
        scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    },[height, opened, typing])

    return(
        <>
        <div className="game-footer-container" onClick = {chatHandler}>
            {typing && isMobile ? <></> :
                <div className = 'game-footer chat' title = 'chat'>
                    <ChatSVG opened = {opened} hidden = {typing && isMobile}/>
                    {unread > 0 ? <span className='notification-counter'>{unread}</span> : <></>}
                    <label className = {`game-footer-label ${opened? 'active' : ''}`}>Chat</label>
            </div>
            }
        </div>
        
        <div className = 'chat-extended' ref = {chatRef}>
        <div className = 'drag' ref = {dragRef} onTouchStart={onTouchStart} onTouchMove={onTouchMove} > 
            <div className = 'drag-bar'></div>
        </div>
        {opened ?
            <>
            <div className='chat-container' ref = {scrollRef}>
                {messages.map((message, idx) => 
                    <div key = {message.message.toString() + idx.toString()} className = {message.sender === 'yours'? 'chat-message-bubble yours' : `chat-message-bubble opp`}>
                        {message.sender === 'yours' ? 
                            <span className= 'chat-message yours'>{message.message}</span> :
                        message.sender === 'system' ? 
                        <span className= 'chat-message system'>{message.message}</span> :
                            <div className= 'chat-message opp'>
                                <div className= 'chat-message name'>{message.sender}</div>
                                <div>{message.message}</div>
                            </div>
                        }
                    </div>
                )}
            </div>
            </>
            : <></>}            
        </div>  

        <input className='chat-message-input' type='text' inputMode='text' autoComplete='off' autoCorrect='off' onKeyUp = {handleEnter} name ='7q' ref= {inputRef} onFocus = {handleFocus} onBlur={handleBlur}></input>
        <MessageBubble message = {bubbleMessage}/>
        </>
    )
}
