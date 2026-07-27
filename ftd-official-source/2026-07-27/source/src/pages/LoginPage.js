import React, { useState, useEffect, useContext }  from 'react'
import { useHttp } from '../hooks/http.hooks'
import { AuthContext } from '../context/AuthContext'
import { useNavigate } from 'react-router-dom'
import { checkLogin, checkInput, checkEmail } from './functions/functions'
import { NavBar } from './elements/navbar/NavBar'
import { toast } from 'react-toastify';
import '../css/auth.css'

export const LoginPage = () => {
const {login, socket, isAuthenticated} = useContext(AuthContext)
const {loading, request, error, clearError} = useHttp()
const navigate = useNavigate()
const [form, setForm] = useState({nickname: '', password: '', email: '', 'c-password': ''})
const [validNick, setValidNick] = useState(false)
const [validPassword, setValidPassword] = useState(false)
const [confirmPassword, setConfirmPassword] = useState(false)
const [accountCreated, setAccountCreated] = useState(false)
const [reg, setReg] = useState(false)
const [forgotPassword, setForgotPassword] = useState(false)
const [recoverySent, setRecoverySent] = useState(false)

const message = (message, type) => {
    if (!message) return
    toast.clearWaitingQueue();
    if(type === 'error') {
        toast.error(message, {autoClose: 5000, pauseOnFocusLoss: false, draggable: false})
    } else {
        toast.success(message, {autoClose: 5000, pauseOnFocusLoss: false, draggable: false})
    }
}

useEffect (() => {
    message(error, 'error')
    clearError()
}, [error, message, clearError])


const changeHandler = event => {
    const name = event.target.name.toString()
    const value = JSON.parse(JSON.stringify(event.target.value)).trim()
    
    setForm(prev => ({...prev,[name]: value}))
    if (name === 'nickname') {
        value.length > 2 && ((checkInput(value) && reg) || (!reg && checkLogin(value)))? setValidNick(true) : setValidNick(false)
        return
    }
    if (name === 'email') {
        value.length > 2 && checkEmail(value) ? setValidNick(true) : setValidNick(false)
        return
    }
    if (name === 'password') {
        value.length > 7 ? setValidPassword(true) : setValidPassword(false)
        value === form['c-password'] ? setConfirmPassword(true) : setConfirmPassword(false)
        return
    }
    if (name === 'c-password') {
        value.length > 7 && value === form.password ? setConfirmPassword(true) : setConfirmPassword(false)
    }
}

const loginHandler = async () => {
    toast.dismiss()
    if (!checkLogin(form.nickname)) {
        message('Invalid login', 'error')
        return
    }
    if (form.password.length < 8 || form.nickname.length < 3) {
        message('Invalid input', 'error' )
        return
    }
    try {
        const sid = socket.id
        const data = await request('/api/auth/login', 'post', {...form, sid})
        login(data.token, data.userId, data.nick, data.status, data.sid)
        // socket.emit('login', data.token)
        navigate('/')
    }
    catch (e) {}
}

const registerHandler = async() => { 
    if (form.nickname.length < 3) {
        message('Nickname should be at least 3 characters', 'error')
        return
    }
    if (!checkInput(form.nickname)) {
        message('Invalid characters', 'error')
        return
    }

    if (form.password.length < 8) {
        message('Password should be at least 8 characters', 'error')
        return
    }

    if (!checkEmail(form.email)) {
        message('Invalid E-mail', 'error')
        return
    }

    if (form.password !== form['c-password']) {
        message(`Passwords don't match`, 'error')
        return
    }

    try {
        const sid = socket.id
        const data = await request('/api/auth/register', 'post', {...form, sid})
        message(data.message, 'info')
        login(data.token, data.userId, data.nick, data.status, data.sid)
        setAccountCreated(true)
    }
    catch (e) {}
}

const recoveryHandler = async() => {
    toast.dismiss()

    if (!checkEmail(form.email)) {
        message('Invalid E-mail', 'error')
        return
    }

    try {
        const email = form.email
        const data = await request('/api/auth/recover', 'post', {email})
        message(data.message, 'info')
        setRecoverySent(true)
    }
    catch (e) {}
}



//maxLength="20" add spell checks to input fields so it will be green/red 
//style = {params}
const switchButtons = () => {
    setReg(prev => !prev)
}

const switchForgot = () => {
    setForm({nickname: '', password: '', email: '', 'c-password': ''})
    setValidNick(false)
    setValidPassword(false)
    setConfirmPassword(false)
    setForgotPassword(prev => !prev)
}
    return (
        <>
        <NavBar game = {false}/>
        {!accountCreated && !isAuthenticated && !forgotPassword? // login and register
        <>
            <div className = {`auth-layout ${reg ? 'reg' : ''}`}>
                <div className='card-title' id = 'login-card'> 
                    <span>{reg ? 'Registration' : 'Sign in'}</span>
                </div>
                <div className="card-content">
                    <input className = {`login-input ${validNick ? 'valid' : ''}`} placeholder = "Nickname:" name = 'nickname' type = "text" autoComplete ="off" value = {form.nickname} onChange = {changeHandler} /> 
                    <input id = 'inputId' className = {`login-input ${validNick ? 'valid' : ''}`} placeholder = "Email:" name = 'email' type = {reg ? "email" : 'hidden'} value = {form.email} onChange = {changeHandler} />
                    <input className = {`login-input ${validPassword ? 'valid' : ''}`} placeholder = "Password:" name = 'password' type = "password" value = {form.password} onChange = {changeHandler} />
                    <input className = {`login-input ${confirmPassword ? 'valid' : ''}`} placeholder = "Confirm Password" name = 'c-password' type = {reg ? "password" : 'hidden'} value = {form['c-password']} onChange = {changeHandler} />
                    <div className="card-action-1" >
                        <button className="auth-btn" id = 'auth' disabled ={loading} onClick ={reg ? registerHandler : loginHandler} >{reg ? 'Register' : 'Sign in'}</button>
                    </div>
                    <div className="card-action-2" style ={{justifyContent: reg? 'center' : 'space-between'}}>
                        <span style ={{paddingLeft:5}} className='register' onClick={switchForgot}>{!reg ? 'Forgot password?' : ''}</span>
                        <span className='register' onClick={switchButtons}>{reg ? 'Sign in' : 'Register'}</span>
                    </div>
                </div>
            </div>
        </> : accountCreated  && !forgotPassword? // account created - check email message
        <>
            <div className = {`auth-layout`}>
                <div className='card-title' id = 'login-card'> 
                    <span>One Last Step!</span>
                </div>
                <div className="card-content-message">
                    <span style = {{paddingLeft: '15px', paddingRight: '15px'}}>A verification link has been sent to your email account</span>
                    <span style = {{paddingLeft: '15px', paddingRight: '15px'}}>Please check your spam folder if you can't find our email</span>
                    <div className="card-action-1" >
                        <button className="auth-btn" id = 'auth' disabled ={loading} onClick ={()=> navigate('/')} >Return</button>
                    </div>
                </div>
            </div>
        </> : forgotPassword? // password recovery form
        <>
            <div className = {`auth-layout`} style = {{height: 'fit-content'}}>
                <div className='card-title' id = 'login-card'> 
                    <span>Password Recovery</span>
                </div>
                <div className="card-content-message">
                    <input id = 'inputId' className = {`login-input ${validNick ? 'valid' : ''}`} placeholder = "Email:" name = 'email' type = {"email"} value = {form.email} onChange = {changeHandler} />
                    <span style = {{paddingLeft: '7%', paddingRight: '7%'}} >Password recovery link will be sent to your email address</span>
                    <span style = {{paddingLeft: '7%', paddingRight: '7%'}} >Please check your spam folder if you can't find our email</span>
                    <div className="card-action-2" style ={{justifyContent: 'space-between'}}>
                        <button style = {{width:'40%'}} className="auth-btn" id = 'auth' disabled ={loading || recoverySent} onClick ={recoveryHandler} >Reset</button>
                        <button style = {{width:'40%'}} className="auth-btn" id = 'return' onClick ={switchForgot} >Return</button>
                    </div>
                    
                </div>
                <div style = {{minHeight: 30}}></div>
            </div>
        </> : // you are logged in
        <>
            <div className = {`auth-layout`}>
                <div className='card-title' id = 'login-card'> 
                    <span>You are already signed in!</span>
                </div>
                <div className="card-content-message" style = {{justifyContent: 'center', display: 'flex', alignItems: 'center', height:150}}>
                    <button className="main-button" id = 'auth' disabled ={loading} onClick ={()=> navigate('/')} >Return</button>
                </div>
            </div>
        </>
        }
        </>
    )
}

export default LoginPage