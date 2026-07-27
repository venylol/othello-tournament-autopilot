import React, {Suspense, lazy} from 'react'
import {Routes, Route, Navigate, useParams} from 'react-router-dom'
import { ModalLoading } from './pages/elements/ModalLoading';

//mport {Replayer} from './pages/Replayer' 

const ArchiveRedirect = () => { const { id } = useParams(); return <Navigate to={`/profile/${id}`} replace /> }

//const RatingPage = lazy(() => import('./pages/RatingPage'))  
const Homepage = lazy(() => import('./pages/HomePage'))
const LoginPage = lazy(() => import('./pages/LoginPage'))
const PasswordRecoveryPage = lazy(() => import('./pages/PasswordRecoveryPage'))
const EmailVerificationPage = lazy(() => import('./pages/EmailVerificationPage'))
const LobbyPage = lazy(() => import('./pages/LobbyPage/LobbyPage'))
const Game = lazy(() => import('./pages/Game'))
const Invitation = lazy(() => import('./pages/Invitation'))
const CreateOTB = lazy(() => import('./pages/TournamentOTB/CreateOTB'))
const CreateTournament = lazy(() => import('./pages/TournamentOnline/CreateTournament'))
const OTBTournament = lazy(() => import('./pages/TournamentOTB/OTBTournament'))
const OnlineTournament = lazy(() => import('./pages/TournamentOnline/OnlineTournament'))
const GameOTB = lazy(() => import('./pages/TournamentOTB/GameOTB/GameOTB_new'))
const OTBTournamentList = lazy(() => import('./pages/TournamentOTB/OTBTournamentList'))
const OnlineTournamentList = lazy(() => import('./pages/TournamentOnline/OnlineTournamentList'))
const OnlineTournamentGame = lazy(() => import('./pages/TournamentOnline/OnlineTournamentGame/OnlineTournamentGame'))
const UsersList = lazy(() => import('./pages/AdminPage/UsersList'))
const ProfilePage = lazy(() => import('./pages/ProfilePage/ProfilePage'))

// const TestPage = lazy(() => import('./pages/TestPage'))

export const useRoutes = (isAuthenticated, isAdmin) => {
    // const {isAuthenticated} = useContext(AuthContext)
    
    if (!isAuthenticated) { // not auth
    return (   
        <Suspense fallback={<ModalLoading/>}> 
            <Routes>
                <Route path="/" element={<Homepage/>} />
                <Route path="/invite/:id" element={<Invitation/>} />
                <Route path="/login" element={<LoginPage/>} />
                <Route path="/recover/:token" element={<PasswordRecoveryPage/>} />
                <Route path="/verification/:token" element={<EmailVerificationPage/>} />
                {/* <Route path="/rating_list" element={<RatingPage isAuthenticated = {isAuthenticated} userId = {userId} socket = {socket}/>} />*/}
                <Route path="/archive/:id" element={<ArchiveRedirect/>} />
                <Route path="/profile/:nick" element={<ProfilePage/>} />
                <Route path="/lobby" element={<LobbyPage/>} /> 
                <Route path="/live" element={<OTBTournamentList/>} />
                <Route path="/live/:id" element={<OTBTournament/>}/>
                <Route path="/live/:id/:gameId" element={<GameOTB/>}/>
                {/* <Route path="/live/:id/:playerId" element={<RoundsByPlayer/>}/> */}
                <Route path="/game/:id" element={<Game/>} /> 

                <Route path="/tournaments" element={<OnlineTournamentList/>} /> 
                <Route path="/tournaments/:id" element={<OnlineTournament/>} /> 
                <Route path="/tournaments/:id/player/:nick" element={<OnlineTournament/>} />
                <Route path="/tournaments/:id/game/:gameId" element={<OnlineTournamentGame/>} />
                <Route path="/replay/:gameId" element={<OnlineTournamentGame/>} />
                {/* <Route path="/test" element = {<TestPage/>} /> */}
                <Route path="*" element={<Navigate to="/" />} />            
            </Routes>
        </Suspense>
        )
    }
    return ( // auth
        <Suspense fallback={<ModalLoading/>}>
            <Routes>            
                <Route path="/" element={<Homepage/>} />
                <Route path="/invite/:id" element={<Invitation/>} />
                {/* <Route path="/rating_list" element={<RatingPage isAuthenticated = {isAuthenticated} userId = {userId} socket = {socket}/>} /> */}
                <Route path="/lobby" element={<LobbyPage/>} />
                <Route path="/verification/:token" element={<EmailVerificationPage/>} />
                {/* {isAdmin ? <Route path="/live" element={<CreateOTB/>} /> : <></>} */}
                <Route path="/live" element={<OTBTournamentList/>} />
                <Route path="/live/create" element={<CreateOTB/>} />
                <Route path="/live/:id" element={<OTBTournament/>}/>
                <Route path="/live/:id/:gameId" element={<GameOTB/>}/>
                <Route path="/archive/:id" element={<ArchiveRedirect/>} />
                <Route path="/profile/:nick" element={<ProfilePage/>} />
                <Route path="/tournaments/create" element={<CreateTournament/>} />
                <Route path="/tournaments" element={<OnlineTournamentList/>} /> 
                <Route path="/tournaments/:id" element={<OnlineTournament/>} /> 
                <Route path="/tournaments/:id/player/:nick" element={<OnlineTournament/>} />
                <Route path="/tournaments/:id/game/:gameId" element={<OnlineTournamentGame/>} /> 
                <Route path="/replay/:gameId" element={<OnlineTournamentGame/>} />

                <Route path="/users" element={<UsersList/>} />
                
                
                {/* <Route path="/test" element = {<TestPage/>} /> */}
                <Route path="/login" element={<LoginPage/>} />

                <Route path="/game/:id" element={<Game/>} />
                <Route path="*" element={<Navigate to="/" />} />   
            </Routes>
        </Suspense>
    )
}

