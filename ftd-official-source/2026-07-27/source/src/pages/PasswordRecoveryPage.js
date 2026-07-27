import React, { useState, useEffect, useContext }  from 'react'
import { useHttp } from '../hooks/http.hooks'
import { AuthContext } from '../context/AuthContext'
import { useNavigate, useParams } from 'react-router-dom'
import { NavBar } from './elements/navbar/NavBar'
import { toast } from 'react-toastify';
import '../css/auth.css'

export const PasswordRecoveryPage = () => {
const {login, socket, token, isAuthenticated} = useContext(AuthContext)
const {loading, request, error, clearError} = useHttp()
const navigate = useNavigate()
const recoveryToken = useParams().token 
const [form, setForm] = useState({password: ''})
const [nick, setNick] = useState()
const [validPassword, setValidPassword] = useState(false)
const [confirmPassword, setConfirmPassword] = useState(false)

useEffect(() => {
    async function fetchMyAPI() {
        const data = await request(`/api/recover/${recoveryToken}`, 'get')
        setNick(data.nick)
    }
    fetchMyAPI()
},[])

const message = (message, type) => {
    if (!message) return
    toast.clearWaitingQueue();
    if(type === 'error') {
        toast.error(message, {autoClose: 1000, pauseOnFocusLoss: false, draggable: false})
    } else {
        toast.info(message, {autoClose: 1000, pauseOnFocusLoss: false, draggable: false})
    }
}

useEffect (() => {
    message(error, 'error')
    if(error) {setTimeout(()=>navigate('/'), 3000)}
    clearError()
}, [error, message, clearError])


const changeHandler = event => {
    const name = event.target.name.toString()
    const value = JSON.parse(JSON.stringify(event.target.value)).trim()
    
    setForm(prev => ({...prev,[name]: value}))
    if (name === 'password') {
        value.length > 7 ? setValidPassword(true) : setValidPassword(false)
        value === form['c-password'] ? setConfirmPassword(true) : setConfirmPassword(false)
        return
    }
    if (name === 'c-password') {
        value.length > 7 && value === form.password ? setConfirmPassword(true) : setConfirmPassword(false)
    }
}

const ResetHandler = async () => {
    toast.dismiss()
    if (form.password.length < 8) {
        message('Password should be at least 8 characters', 'error')
        return
    }

    if (form.password !== form['c-password']) {
        message(`Passwords don't match`, 'error')
        return
    }

    try {
        const sid = socket.id
        const data = await request('/api/recover/newpassword', 'post', {...form, sid, recoveryToken})
        message(data.message, 'info')
        setTimeout(() => login(data.token, data.userId, nick, data.status, data.sid), 2000)
    }
    catch (e) {}
}

    return (
        <>
        <NavBar game = {false}/>
        {!isAuthenticated && nick?
        <>
            <div className = 'auth-layout'>
                <div className='card-title' id = 'login-card'> 
                    <span>{`${nick}, reset your password`}</span>
                </div>
                <div className="card-content">
                <input className = {`login-input ${validPassword ? 'valid' : ''}`} placeholder = "New Password:" name = 'password' type = "password" onChange = {changeHandler} />
                <input className = {`login-input ${confirmPassword ? 'valid' : ''}`} placeholder = "Confirm Password" name = 'c-password' type = "password" onChange = {changeHandler} />
                    <div className="card-action-1" >
                        <button className="auth-btn" id = 'auth' disabled = {loading} onClick ={ResetHandler} >Confirm</button>
                    </div>
                </div>
            </div>
        </> : isAuthenticated && !nick ?
        <>
            <div className = {`auth-layout`}>
                <div className='card-title' id = 'login-card'> 
                    <span>You are already signed in!</span>
                </div>
                <div className="card-content-message" style = {{justifyContent: 'center', display: 'flex', alignItems: 'center', height:150}}>
                    <button className="main-button" id = 'auth' disabled ={loading} onClick ={()=> navigate('/')} >Return</button>
                </div>
            </div>
        </> : 
        <></>
        }
        </>
    )
}

export default PasswordRecoveryPage