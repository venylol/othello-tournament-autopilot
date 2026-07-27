import React, { useState, useEffect, useContext }  from 'react'
import { useHttp } from '../hooks/http.hooks'
import { AuthContext } from '../context/AuthContext'
import { useNavigate, useParams } from 'react-router-dom'
import { NavBar } from './elements/navbar/NavBar'
import { toast } from 'react-toastify';
import '../css/auth.css'

export const EmailVerificationPage = () => {
const {login, socket, token, isAuthenticated} = useContext(AuthContext)
const {loading, request, error, clearError} = useHttp()
const navigate = useNavigate()
const verificationToken = useParams().token 
const [nick, setNick] = useState()

useEffect(() => {
    console.log(socket.id)
    async function fetchMyAPI() {
        const sid = socket.id
        
        const data = await request(`/api/verification/`, 'post', {verificationToken, sid})
        if(!data.userId) {
            navigate('/')
        }
        setNick(data.nick)
        setTimeout(() => login(data.token, data.userId, nick, data.status, data.sid), 2000)
    }
    if(socket.id) {
        fetchMyAPI()
    }
},[socket.id])

const message = (message, type) => {
    if (!message) return
    toast.clearWaitingQueue();
    if(type === 'error') {
        toast.error(message, {autoClose: 1000, pauseOnFocusLoss: false, draggable: false})
    } else {
        toast.success(message, {autoClose: 1000, pauseOnFocusLoss: false, draggable: false})
    }
}

useEffect (() => {
    message(error, 'error')
    if(error) {setTimeout(()=>navigate('/'), 3000)}
    clearError()
}, [error, message, clearError])

    return (
        <>
        <NavBar game = {false}/>
        {nick?
        <>
            <div className = 'auth-layout' style = {{height: 170}}>
                <div className='card-title' id = 'login-card'> 
                    <span>{`${nick}, `}</span>
                </div>
                <div className="card-content-message">
                    <span>your email has been verified!</span>
                    <div className="card-action-1">
                        <button style = {{width:'40%'}} className="auth-btn" id = 'auth' onClick ={()=> navigate('/')} >Return</button>
                    </div>
                </div>
            </div>
        </> :
        <></>
        }
        </>
    )
}

export default EmailVerificationPage