import React, { useState, useEffect, useContext, useCallback, useRef } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { VariableSizeList } from 'react-window'
import { AuthContext } from '../../context/AuthContext'
import { UserContext } from '../../context/UserContext'
import { NavBar } from '../elements/navbar/NavBar'
import { CountryFlags } from '../elements/CountryFlags'
import { TimeControlTournament, WOFSVG } from '../elements/SVG'
import { findImage } from '../functions/functions'
import { WOFVerificationModal } from './WOFVerificationModal'
import { SettingsModal } from './SettingsModal'
import { LobbySettings } from '../LobbyPage/Settings'
import { CircleStats } from '../elements/CircleStats'
import { toast } from 'react-toastify'
import './profile.css'

const RATING_TYPES = [
    { key: 'bullet', label: 'Bullet', tc: 1, xot: false },
    { key: 'blitz', label: 'Blitz', tc: 5, xot: false },
    { key: 'rapid', label: 'Rapid', tc: 15, xot: false },
    { key: 'classic', label: 'Classic', tc: 25, xot: false },
    { key: 'bullet_xot', label: 'Bullet', tc: 1, xot: true },
    { key: 'blitz_xot', label: 'Blitz', tc: 5, xot: true },
    { key: 'rapid_xot', label: 'Rapid', tc: 15, xot: true },
    { key: 'classic_xot', label: 'Classic', tc: 25, xot: true },
]

export const ProfilePage = () => {
    const { nick: paramNick } = useParams()
    const { socket } = useContext(AuthContext)
    const { nick: myNick } = useContext(UserContext)
    const history = useNavigate()

    const [profile, setProfile] = useState(null)
    const [loading, setLoading] = useState(true)
    const [games, setGames] = useState([])
    const [gameCount, setGameCount] = useState(0)
    const [activeFilter, setActiveFilter] = useState('All')
    const [showWofModal, setShowWofModal] = useState(false)
    const [showSettingsModal, setShowSettingsModal] = useState(false)
    const [emailSending, setEmailSending] = useState(false)
    const [emailSent, setEmailSent] = useState(false)
    const [stats, setStats] = useState({ wins: 0, draws: 0, losses: 0 })
    const [searchTerm, setSearchTerm] = useState('')
    const [listHeight, setListHeight] = useState(400)
    const [challengeSettings, setChallengeSettings] = useState({})
    const [challengeBtnLabel, setChallengeBtnLabel] = useState('Invite')
    const [invited, setInvited] = useState(null)
    const [showChallenge, setShowChallenge] = useState(false)
    const headerRef = useRef(null)
    const listRef = useRef(null)
    const challengeRef = useRef(null)
    const requestIdRef = useRef(0)
    const loadingMoreRef = useRef(false)
    const debounceTimerRef = useRef(null)

    const nickname = paramNick || myNick
    const LIMIT = 25
    const WOF = 'WOF verified'

    useEffect(() => {
        if (!nickname) return
        setLoading(true)
        setGames([])
        setActiveFilter('All')
        setSearchTerm('')
        const reqId = ++requestIdRef.current
        socket.emit('get-profile', nickname)
        socket.emit('get-profile-games', nickname, 'All', 0, LIMIT, '', reqId)
        socket.emit('get-profile-game-count', nickname, 'All', '', reqId)

        const onProfileData = (data) => {
            setProfile(data)
            setLoading(false)
        }
        const onProfileGames = (data, responseId) => {
            if (typeof responseId === 'number' && responseId !== requestIdRef.current) return
            loadingMoreRef.current = false
            setGames(prev => prev.length === 0 ? data : [...prev, ...data])
        }
        const onProfileGameCount = (data, responseId) => {
            if (typeof responseId === 'number' && responseId !== requestIdRef.current) return
            setGameCount(data?.total || 0)
            setStats({ wins: data?.wins || 0, draws: data?.draws || 0, losses: data?.losses || 0 })
        }
        const onVerificationResent = (success, message) => {
            setEmailSending(false)
            if (success) {
                setEmailSent(true)
                toast.success(message, { autoClose: 3000 })
            } else {
                toast.error(message, { autoClose: 3000 })
            }
        }
        const onWofStatusUpdated = () => {
            socket.emit('get-profile', nickname)
        }
        const onAvatarUpdated = () => {
            socket.emit('get-profile', nickname)
        }

        const onInvitationDeclined = (nick) => {
            setInvited(null)
            setShowChallenge(false)
            toast.dismiss()
            toast.info(`${nick} declined your invitation`, { autoClose: 2000 })
        }

        socket.on('profile-data', onProfileData)
        socket.on('profile-games', onProfileGames)
        socket.on('profile-game-count', onProfileGameCount)
        socket.on('verification-resent', onVerificationResent)
        socket.on('wof-status-updated', onWofStatusUpdated)
        socket.on('avatar-updated', onAvatarUpdated)
        socket.on('invitation-declined', onInvitationDeclined)

        return () => {
            socket.off('profile-data', onProfileData)
            socket.off('profile-games', onProfileGames)
            socket.off('profile-game-count', onProfileGameCount)
            socket.off('verification-resent', onVerificationResent)
            socket.off('wof-status-updated', onWofStatusUpdated)
            socket.off('avatar-updated', onAvatarUpdated)
            socket.off('invitation-declined', onInvitationDeclined)
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [nickname])

    useEffect(() => {
        if (!nickname || loading) return
        const reqId = ++requestIdRef.current
        loadingMoreRef.current = false
        setGames([])
        if (listRef.current) listRef.current.scrollTo(0)
        socket.emit('get-profile-games', nickname, activeFilter, 0, LIMIT, searchTerm, reqId)
        socket.emit('get-profile-game-count', nickname, activeFilter, searchTerm, reqId)
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [activeFilter, searchTerm])

    // Calculate list height to fill remaining page space
    useEffect(() => {
        const calcHeight = () => {
            if (headerRef.current) {
                const rect = headerRef.current.getBoundingClientRect()
                setListHeight(window.innerHeight - rect.bottom)
            }
        }
        calcHeight()
        window.addEventListener('resize', calcHeight)
        return () => window.removeEventListener('resize', calcHeight)
    })

    const loadMore = () => {
        if (loadingMoreRef.current) return
        loadingMoreRef.current = true
        socket.emit('get-profile-games', nickname, activeFilter, games.length, LIMIT, searchTerm, requestIdRef.current)
    }

    const handleResendVerification = () => {
        if (emailSending || emailSent) return
        setEmailSending(true)
        socket.emit('resend-verification')
    }

    const handleWofResult = useCallback((success, message) => {
        if (success) {
            toast.success(message, { autoClose: 3000 })
            // Refresh profile
            socket.emit('get-profile', nickname)
        } else {
            toast.error(message, { autoClose: 3000 })
        }
    }, [socket, nickname])

    const handleFilterClick = (filterKey) => {
        setActiveFilter(prev => prev === filterKey ? 'All' : filterKey)
    }

    // eslint-disable-next-line react-hooks/exhaustive-deps
    const handleSearchInput = useCallback((value) => {
        if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current)
        const trimmed = value.toLowerCase().trim()
        // Only search with 3+ chars, or clear filter when empty
        if (trimmed.length === 0) {
            debounceTimerRef.current = null
            setSearchTerm('')
        } else if (trimmed.length >= 3) {
            debounceTimerRef.current = setTimeout(() => {
                debounceTimerRef.current = null
                setSearchTerm(trimmed)
            }, 300)
        }
    }, [])

    const formatDate = (dateStr) => {
        if (!dateStr) return ''
        return new Date(dateStr).toLocaleDateString('en-gb').replaceAll('/', '-')
    }

    // Build sorted rating tiles (highest rating first, skip those with 0 games)
    const getRatingTiles = () => {
        if (!profile) return []
        const tiles = RATING_TYPES.map(rt => ({
            ...rt,
            rating: profile[`rating_${rt.key}`],
            maxRating: profile[`max_rating_${rt.key}`],
            dan: profile[`dan_${rt.key}`],
            games: profile[`games_${rt.key}`],
        }))
        return tiles.filter(t => t.games > 0).sort((a, b) => (b.rating || 0) - (a.rating || 0))
    }

    const isOwnProfile = nickname === myNick

    if (loading) {
        return (
            <div className="profile-page">
                <NavBar isHome={false} text="Profile" onSettingsClick={isOwnProfile ? () => setShowSettingsModal(true) : undefined} />
                <div className="profile-loading">Loading...</div>
            </div>
        )
    }

    if (!profile) {
        return (
            <div className="profile-page">
                <NavBar isHome={false} text="Profile" onSettingsClick={isOwnProfile ? () => setShowSettingsModal(true) : undefined} />
                <div className="profile-not-found">
                    <span>User not found</span>
                </div>
            </div>
        )
    }

    const joinedDate = profile.registration_date
        ? new Date(profile.registration_date).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })
        : ''

    const isWofVerified = profile.wof_id && profile.verified === 1
    const isWofPending = profile.wof_id && profile.verified === 0
    const showWofButton = profile.isOwnProfile && !profile.wof_id

    const ratingTiles = getRatingTiles()

    return (
        <div className="profile-page">
            <NavBar isHome={false} text="Profile" onSettingsClick={isOwnProfile ? () => setShowSettingsModal(true) : undefined} />

            {/* Profile Header */}
            <div className="profile-header">
                <img
                    className="profile-avatar"
                    src={findImage(nickname) + (profile.avatar ? `?v=${encodeURIComponent(profile.avatar)}` : '')}
                    alt={nickname}
                />
                <div className="profile-info">
                    <div className="profile-name-row">
                        <span className="profile-nick">{profile.nick || nickname}</span>
                        <CountryFlags countryCode={profile.country} />
                    </div>
                    <div className="profile-joined">Joined {joinedDate}</div>
                    {isWofVerified && profile.wof_name !== WOF &&(
                        <div className="profile-wof-info" style ={{textTransform: 'capitalize'}}>
                            <WOFSVG active={true} />
                            {profile.wof_number ? 
                            <a href={`https://www.worldothello.org/ratings/player?playerID=${profile.wof_number}`} target="_blank" rel="noopener noreferrer" className="profile-wof-link">{profile.wof_name?.toLowerCase()}</a>
                            : <span className="profile-wof-link">{profile.wof_name?.toLowerCase()}</span>
                            }
                            
                        </div>
                    )}
                    {isWofVerified && profile.wof_name === WOF && (
                        <div className="profile-wof-info">
                            <WOFSVG active={true} />
                            <span className="profile-wof-link">{profile.wof_name}</span>
                        </div>
                    )}

                </div>
                <div className="profile-circle-wrapper">
                    {(stats.wins + stats.draws + stats.losses) > 0 && (
                        <CircleStats win={stats.wins} draw={stats.draws} loss={stats.losses} />
                    )}
                </div>
            </div>

            {/* Head-to-head stats and challenge button */}
            {!isOwnProfile && (
                <div className="profile-h2h-section">
                    {profile.h2h && (
                        <div className="profile-h2h-stats">
                            <span className="profile-h2h-win">{profile.h2h.wins}</span>
                            <span className="profile-h2h-draw">/</span>
                            <span className="profile-h2h-draw"> {profile.h2h.draws}</span>
                            <span className="profile-h2h-draw">/</span>
                            <span className="profile-h2h-loss"> {profile.h2h.losses}</span>
                        </div>
                    )}
                    {profile.canChallenge && (
                        <button
                            ref={challengeRef}
                            className={`profile-challenge-btn ${showChallenge ? 'cancel' : ''}`}
                            onClick={() => {
                                setShowChallenge(prev => {
                                    if (!prev) setChallengeBtnLabel('Invite')
                                    return !prev
                                })
                            }}
                        >
                            {showChallenge ? 'Cancel' : 'Challenge'}
                        </button>
                    )}
                </div>
            )}

            {/* Email verification warning */}
            {profile.showEmailWarning && (
                <div className="email-warning" onClick={handleResendVerification} style={emailSent ? {cursor: 'default'} : {}}>
                    <span className="email-warning-icon">{emailSent ? '✉️' : '⚠️'}</span>
                    <div className="email-warning-text">
                        {emailSent ? (
                            <>Verification email sent. <span style={{fontWeight: 400}}>If you haven't received the email, please contact us via support@flipthedisc.com</span></>
                        ) : (
                            <>Your email is not verified. <span>{emailSending ? 'Sending...' : 'Click to send verification email'}</span></>
                        )}
                    </div>
                </div>
            )}

            {/* WOF verification button or pending status */}
            {showWofButton && (
                <button className="wof-verify-btn" onClick={() => setShowWofModal(true)}>
                    <WOFSVG />
                    Request WOF Verification
                </button>
            )}
            {isWofPending && profile.isOwnProfile && (
                <div className="wof-pending">
                    ⏳ WOF verification is pending
                </div>
            )}

            {/* Rating Tiles */}
            <div className="rating-tiles-container">
                {ratingTiles.map(tile => (
                    <div
                        key={tile.key}
                        className={`rating-tile ${activeFilter === tile.key ? 'active' : ''}`}
                        onClick={() => handleFilterClick(tile.key)}
                    >
                        <div className="rating-tile-icon">
                            <TimeControlTournament timeControl={tile.tc} />
                        </div>
                        <div className="rating-tile-value">{tile.rating || 1200}</div>
                        <div className="rating-tile-label">
                            {tile.label} {tile.xot && 'XOT'}
                        </div>
                        {/* {tile.xot && <div className="rating-tile-xot">XOT</div>} */}
                    </div>
                ))}
            </div>

            {/* Game History */}
            <div className="profile-search-container" ref={headerRef}>
                <input
                    className="profile-search-input"
                    type="text"
                    placeholder="Search by opponent"
                    maxLength={20}
                    onChange={(e) => handleSearchInput(e.target.value)}
                />
                <div className="profile-date-range">
                    {games.length > 0 && (
                        <>
                            <span>{formatDate(games[games.length - 1].time_started)}</span>
                            <span> - </span>
                            <span>{formatDate(games[0].time_started)}</span>
                        </>
                    )}
                </div>
            </div>
            <div className="profile-game-history">
                <VariableSizeList
                    ref={listRef}
                    height={listHeight}
                    width="100%"
                    itemCount={games.length}
                    itemSize={() => 54}
                    estimatedItemSize={54}
                    onItemsRendered={({ visibleStopIndex }) => {
                        if (visibleStopIndex >= games.length - 1 && games.length < gameCount) {
                            loadMore()
                        }
                    }}
                >
                    {({ index, style }) => {
                        const game = games[index]
                        const score = game.score
                        const result = score > 32 ? 'win' : score === 32 ? 'draw' : 'loss'
                        const discColor = game.color === 'B' ? 'black' : 'white'
                        const dan = game.dan >= 0 ? `${game.dan + 1}D` : `${-game.dan}K`
                        const isAnalyzed = game.discs_lost != null
                        const isTournament = !!game.tournament_id

                        const getAdlClass = (dl) => {
                            if (dl <= 5) return 'yellow'
                            if (dl <= 15) return 'green'
                            if (dl <= 30) return 'silver'
                            return 'red'
                        }

                        const navigateToReplay = (e, autoAnalyze) => {
                            e.stopPropagation()
                            if (isTournament) {
                                history(`/tournaments/${game.tournament_id}/game/${game.round_id}`, {
                                    state: { fromProfile: nickname, autoAnalyze }
                                })
                            } else {
                                history(`/replay/${game.game_id}`, {
                                    state: { fromProfile: nickname, autoAnalyze }
                                })
                            }
                        }

                        return (
                            <div style={style}>
                                <div
                                    className="profile-game-row"
                                    onClick={(e) => navigateToReplay(e, false)}
                                >
                                    <div className="profile-game-tc">
                                        <TimeControlTournament timeControl={game.time_control} />
                                        {game.xot === 1 && <span className="profile-tc-xot">XOT</span>}
                                    </div>
                                    <div className="profile-game-opponent">
                                        <div className="profile-game-opp-name" >
                                            <span onClick={(e) => {
                                            e.stopPropagation()
                                            history(`/profile/${game.opponent}`)
                                        }}>{game.opponent}</span></div>
                                        <div className="profile-game-opp-rating" >
                                            <span onClick={(e) => {
                                            e.stopPropagation()
                                            history(`/profile/${game.opponent}`)
                                        }}>{game.rating} {dan}</span></div>
                                    </div>
                                    {isTournament && (
                                        <span className="profile-game-trophy" onClick={(e) => {
                                            e.stopPropagation()
                                            history(`/tournaments/${game.tournament_id}`)
                                        }}>🏆</span>
                                    )}
                                    <div className={`profile-disc ${discColor} ${result}`}>
                                        <span className={`profile-disc-score ${discColor}`}>{score}</span>
                                    </div>
                                    {isAnalyzed ? (
                                        <div className={`profile-adl-tile ${getAdlClass(game.discs_lost)}`}>
                                            {game.discs_lost === 0 ? '0' : `-${game.discs_lost}`}
                                        </div>
                                    ) : (
                                        <div className="profile-analyze-tile" onClick={(e) => navigateToReplay(e, true)}>
                                            <svg viewBox="64 64 896 896" focusable="false" fill="white">
                                                <path d="M909.6 854.5L649.9 594.8C690.2 542.7 712 479 712 412c0-80.2-31.3-155.4-87.9-212.1-56.6-56.7-132-87.9-212.1-87.9s-155.5 31.3-212.1 87.9C143.2 256.5 112 331.8 112 412c0 80.1 31.3 155.5 87.9 212.1C256.5 680.8 331.8 712 412 712c67 0 130.6-21.8 182.7-62l259.7 259.6a8.2 8.2 0 0011.6 0l43.6-43.5a8.2 8.2 0 000-11.6zM570.4 570.4C528 612.7 471.8 636 412 636s-116-23.3-158.4-65.6C211.3 528 188 471.8 188 412s23.3-116.1 65.6-158.4C296 211.3 352.2 188 412 188s116.1 23.2 158.4 65.6S636 352.2 636 412s-23.3 116.1-65.6 158.4z" />
                                            </svg>
                                        </div>
                                    )}
                                </div>
                            </div>
                        )
                    }}
                </VariableSizeList>
            </div>

            {/* WOF Verification Modal */}
            {showWofModal && (
                <WOFVerificationModal
                    onClose={() => setShowWofModal(false)}
                    onResult={handleWofResult}
                    userCountry={profile.country}
                />
            )}

            {/* Settings Modal */}
            {showSettingsModal && isOwnProfile && (
                <SettingsModal
                    onClose={() => setShowSettingsModal(false)}
                    profile={profile}
                    nickname={nickname}
                />
            )}

            {/* Challenge settings (LobbySettings invite modal) */}
            {!isOwnProfile && profile.canChallenge && (
                <LobbySettings
                    settings={challengeSettings}
                    setSettings={setChallengeSettings}
                    btnLabel={challengeBtnLabel}
                    setBtnLabel={setChallengeBtnLabel}
                    pressed={null}
                    invitation={nickname}
                    setInvited={(val) => {
                        setInvited(val)
                        setShowChallenge(false)
                    }}
                    bottom={0}
                    visible={showChallenge}
                    onHide={() => setShowChallenge(false)}
                    excludeRef={challengeRef}
                />
            )}
        </div>
    )
}

export default ProfilePage
