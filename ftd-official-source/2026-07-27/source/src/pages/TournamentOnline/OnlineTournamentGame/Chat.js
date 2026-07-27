import {useState, useRef, useEffect, useContext} from 'react'
import { LayoutContext } from '../../../context/LayoutContext'
import { UserContext } from '../../../context/UserContext'
import { AuthContext } from '../../../context/AuthContext'
import { useMouseMove } from '../../../hooks/mouse.hook'
import { ChatSVG, SendButtonSVG } from '../../elements/SVG'
import { useParams } from 'react-router-dom'

// import { useFullScreen } from '../../hooks/fullscreen.hook'

export const Chat = ({setPressed, pressed}) => {
    // console.log(pressed)
    const [opened, setOpened] = useState(false)
    // const [messages, setMessages] = useState([])
    const [unread, setUnread] = useState(0)
    const [messageCount, setMessageCount] = useState(0)
    const [chatHeight, setChatHeight] = useState(93.5)
    const chatRef = useRef()
    const scrollRef = useRef ()
    const inputRef = useRef()
    const inputDivRef = useRef()
    const dragRef = useRef()
    const buttonRef = useRef (null)
    const {chatOpened, setChatOpened, typing, setTyping, messages, setMessages, isFullScreen, isMobile} = useContext(UserContext)
    const {keyboard, height} = useContext(LayoutContext)
    const {socket, isAuthenticated} = useContext(AuthContext)
    const {id, gameId} = useParams()
    const defaultHeight = 93.5
    const maxHeight = height - 138

    const [touchStart, setTouchStart] = useState(null)
    const [toClose, setToClose] = useState(false)
    // const [mouseStart]
    // const {startResizing} = useMouseMove(isMobile, chatHeight, setChatHeight)

    const onTouchStart = (e) => {
        e.stopPropagation()
        setTouchStart(e.targetTouches[0].clientY)
        
        if (chatHeight === defaultHeight) {
            setToClose(true)
        }      
    }

    const onTouchMove = (e) => {
        e.stopPropagation()
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

    const startResizing = (mouseDownEvent) => {
        mouseDownEvent.stopPropagation()
        const start = mouseDownEvent.clientY
        const prevHeight = chatHeight
        chatRef.current.style.userSelect = 'none'
        if (chatHeight === defaultHeight) {
            setToClose(true)
        }
        function onMouseMove(mouseMoveEvent) {
            mouseMoveEvent.stopPropagation()
            const end = mouseMoveEvent.clientY
            setChatHeight(prev => {
                const distance = start - end + prevHeight
                if (distance < defaultHeight) {
                    setOpened(false)
                    setChatOpened(false)
                    document.body.removeEventListener("mousemove", onMouseMove)
                    return defaultHeight
                }
                if (distance >= maxHeight) {
                    chatRef.current.style.height = maxHeight + 'px'
                    chatRef.current.style.maxHeight = maxHeight + 'px'
                    chatRef.current.style.minHeight = maxHeight + 'px'
                    document.body.removeEventListener("mousemove", onMouseMove)
                    return maxHeight
                }
                chatRef.current.style.height = distance + 'px'
                chatRef.current.style.maxHeight = distance + 'px'
                chatRef.current.style.minHeight = distance + 'px'
                return distance
            })
        }

        function onMouseUp() {
            console.log('hello up')
            chatRef.current.style.userSelect = 'auto'
            document.body.removeEventListener("mousemove", onMouseMove);
        }

        document.body.addEventListener("mouseup", onMouseUp, { once: true });
        document.body.addEventListener("mousemove", onMouseMove);
        
        
      };


    useEffect (() => {
        if (pressed !== 'chat') {
            setOpened(false)
            setChatOpened(false)    
            return
        }
    }, [pressed])

    useEffect(() => {
        // if(!isAuthenticated) return
        socket.on ('chat-message', (message, nick, isTD) => {
            setMessages(prev => [...prev, {sender: nick, message: message, isTD: isTD }])
            if(!opened && nick !== 'system') {
                setUnread(prev => prev + 1)
            }   
        })
        if(opened) {
            setPressed('chat')       
        }
        
        return () => {
            socket.off ('chat-message')
        }
    },[socket, opened])

    useEffect(() => {
        setMessageCount(messages.filter(msg => msg.sender !== 'system').length)
    }, [messages])

    const handleEnter = (e) => {
        if (e.key === 'Enter') {
            const val = e.target.value
            if(val.length === 0) return
            setMessages(prev => [...prev, {sender: 'yours', message: val }])
            socket.emit('chat-message-otb', id, gameId, val)
            e.target.value = ''
        }
        // e.target.scrollLeft = e.target.scrollWidth
    }

    const sendMessage = (e) => {
        e.stopPropagation()
        const val = inputRef.current.value
        if(val.length === 0) return
        setMessages(prev => [...prev, {sender: 'yours', message: val }])
        socket.emit('chat-message-otb', id, gameId, val)
        inputRef.current.value = ''
    }

    const returnFocus = (e) => {
        e.preventDefault()
    }

    useEffect(() => {
        if (!scrollRef?.current) return
        // if (messages[messages.length - 1]?.sender === 'system') return
        scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    },[messages, opened])

    useEffect (() => {
        if (!buttonRef.current) {return}
            buttonRef.current.style.animation = 'none' 
            buttonRef.current.style.left = '50%'
            buttonRef.current.style.top = '50%'
            requestAnimationFrame(() => {
                buttonRef.current.style.animation = 'ripples-toggle 0.3s ease-in forwards'
            })
    }, [opened])

    const handleFocus = (e) => {
        setTyping(true)
    }

    const handleBlur = (e) => {
        console.log('onBlur')
        setTyping(false)
        e.target.scrollLeft = e.target.scrollWidth
    }

    const chatHandler = () => {
        setPressed('chat')
        setOpened(prev => !prev)
        setChatOpened(prev => !prev)
        setUnread(0)
    }
    useEffect(() => { // test
        // const message = `opened: ${opened}, typing ${typing}, isMobile ${isMobile}, isFullScreen ${isFullScreen}, keyboard ${keyboard}, height ${height}`
        // console.log(message)
        // setMessages(prev => [...prev, {sender: 'system', message: message }])

        if (opened ) { //&& !(typing && isMobile) change that - fires too many times
            inputDivRef.current.style.bottom = '50px'
            inputDivRef.current.style.height = '38px'
            inputRef.current.style.height = '35px'
            inputRef.current.placeholder = isAuthenticated ? 'Message' : 'Only registered users can write in chat...'
            inputRef.current.type = 'text'
            inputRef.current.inputMode = 'text'
            chatRef.current.style.maxHeight = typing ? Math.min(chatHeight, height - 88) + 'px' : chatHeight + 'px'
            chatRef.current.style.height = typing ? Math.min(chatHeight, height - 88) + 'px' : chatHeight + 'px'
            chatRef.current.style.minHeight = typing ? Math.min(chatHeight, height - 88) + 'px' : chatHeight + 'px'
            chatRef.current.style.bottom = '88px'
            dragRef.current.style.height = '30px'
        } 
        if (!opened) {
            inputDivRef.current.style.bottom = '0px'
            inputDivRef.current.style.height = '0px'
            inputRef.current.style.height = '0px'
            inputRef.current.placeholder =  ''
            inputRef.current.type = 'hidden'
            chatRef.current.style.height =  '0px'
            chatRef.current.style.minHeight =  '0px'
            chatRef.current.style.bottom = '0px'
            dragRef.current.style.height = '0px'
            return 
        }  
        if (typing && isFullScreen && isMobile) {
            inputDivRef.current.style.bottom = '0px'
            inputRef.current.style.bottom = keyboard > 0 ? keyboard  + 'px' : '0px'
            chatRef.current.style.bottom = keyboard > 0 ? keyboard + 38 + 'px' : '38px'
            
            // inputRef.current.style.bottom = '48px'
            // chatRef.current.style.bottom = '86px'
            return
        }   
        if (typing && !isFullScreen && isMobile) {
            inputDivRef.current.style.bottom = '0px'
            inputRef.current.style.bottom = '0px'
            chatRef.current.style.bottom = '38px'
            return
        }

    },[opened, typing, isMobile, isFullScreen, keyboard, height]) 

    useEffect (() => {
        if (!typing || !opened || !scrollRef?.current) return
        window.scrollTo(0,0)
        scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    },[height, opened, typing])

    return(
        <>
        {typing && isMobile ? <></> :
        <div className="game-footer-container" onClick = {chatHandler}>        
            <div className = {`game-footer chat ${opened? 'active' : ''}`} title = 'chat'>
                <ChatSVG opened = {opened} hidden = {typing && isMobile}/>
                {unread > 0 ? <span className='notification-counter'>{unread}</span> : 
                messageCount > 0 ?  <span className='notification-counter total'>{messageCount}</span> : <></>}
                <label className = {`game-footer-label ${opened? 'active' : ''}`}>Chat</label>
            </div>
            
            {pressed === 'chat' ? 
                <div className="ripple-container toggle-footer">
                    <span ref = {buttonRef} className = 'ripple'></span> 
                </div> : <></>
            }
        </div>}
        
        <div className = 'chat-extended' ref = {chatRef}>
        <div className = 'drag' ref = {dragRef} onTouchStart={onTouchStart} onTouchMove={onTouchMove} onMouseDown = {startResizing}> 
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
                                <div className= {message.isTD ? 'chat-message admin' : 'chat-message name'}>{message.sender}</div>
                                <div>{message.message}</div>
                            </div>
                        }
                    </div>
                )}
            </div>
            </>
            : <></>}            
        </div>  
        <div className = 'chat-input-otb'  ref = {inputDivRef}>
            {isAuthenticated ?
            <>
            <input className='chat-message-input-otb' type='text' inputMode='text' autoComplete='off' autoCorrect='off' onKeyUp = {handleEnter} name ='7q' ref= {inputRef} onFocus = {handleFocus} onBlur={handleBlur}></input>
            <SendButtonSVG onClick = {sendMessage} isMobile = {isMobile} returnFocus = {returnFocus}/>
            </> :
            <input className='chat-message-input-otb' type='text' autoComplete='off' autoCorrect='off' name ='7q' ref= {inputRef} disabled = {true}></input>
            }
        </div>
        </>
    )
}
