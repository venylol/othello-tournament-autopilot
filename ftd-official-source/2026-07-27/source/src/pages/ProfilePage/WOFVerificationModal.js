import React, { useState, useCallback, useContext } from 'react'
import { debounce } from '../functions/functions'
import { AuthContext } from '../../context/AuthContext'
import { UserContext } from '../../context/UserContext'
import { CountryFlags } from '../elements/CountryFlags'
import { Close } from '../elements/SVG'
import { getNames, getCode, search } from 'country-list'

export const WOFVerificationModal = ({ onClose, onResult, userCountry }) => {
    const { socket } = useContext(AuthContext)
    const { nick } = useContext(UserContext)
    const [searchVal, setSearchVal] = useState('')
    const [results, setResults] = useState([])
    const [showNewForm, setShowNewForm] = useState(false)
    const [newName, setNewName] = useState('')
    const [newSurname, setNewSurname] = useState('')
    const [countryInput, setCountryInput] = useState('')
    const [newCountry, setNewCountry] = useState(userCountry || '')
    const [countrySuggestions, setCountrySuggestions] = useState([])
    const [submitting, setSubmitting] = useState(false)
    const [selectedPlayer, setSelectedPlayer] = useState(null)

    const allCountries = getNames()

    // Set initial country display name from code
    React.useEffect(() => {
        if (userCountry) {
            const name = allCountries.find(n => getCode(n) === userCountry)
            if (name) setCountryInput(name)
        }
    }, [userCountry])

    const handleSearch = useCallback(debounce((event) => {
        const val = event.target.value.trim()
        setSearchVal(val)
        if (val.length >= 2) {
            socket.emit('search-wof-players', val)
        } else {
            setResults([])
        }
    }), [socket])

    React.useEffect(() => {
        socket.on('wof-search-results', (data) => {
            setResults(data || [])
        })
        socket.on('wof-verification-result', (success, message) => {
            setSubmitting(false)
            onResult(success, message)
            if (success) onClose()
        })
        return () => {
            socket.off('wof-search-results')
            socket.off('wof-verification-result')
        }
    }, [socket, onClose, onResult])

    const selectPlayer = (player) => {
        setSelectedPlayer(player)
    }

    const confirmPlayer = () => {
        if (!selectedPlayer || submitting) return
        setSubmitting(true)
        socket.emit('request-wof-verification', selectedPlayer.id)
    }

    const handleCountryChange = (e) => {
        const value = e.target.value
        setCountryInput(value)
        if (value.length > 2) {
            setCountrySuggestions(search(value))
        } else {
            setCountrySuggestions([])
        }
        if (allCountries.includes(value)) {
            setNewCountry(getCode(value))
            setCountrySuggestions([])
        } else {
            setNewCountry('')
        }
    }

    const handleCountrySelect = (countryName) => {
        setCountryInput(countryName)
        setNewCountry(getCode(countryName))
        setCountrySuggestions([])
    }

    const submitNewPlayer = () => {
        const nameRegex = /^[A-Za-z\s\-']+$/
        if (!nameRegex.test(newName) || !nameRegex.test(newSurname)) return
        if (!newCountry) return
        setSubmitting(true)
        socket.emit('request-wof-new-player', newName.trim(), newSurname.trim(), newCountry)
    }

    return (
        <div className="wof-modal-overlay" onClick={onClose}>
            <div className="wof-modal" onClick={e => e.stopPropagation()}>
                <div className="wof-modal-header">
                    <h3>WOF Verification</h3>
                    <button className="wof-modal-close" onClick={onClose}>
                        <Close />
                    </button>
                </div>
                <div className="wof-modal-body">
                    {!showNewForm ? (
                        <>
                            <input
                                className="wof-search-input"
                                type="text"
                                placeholder="Search by name, surname or WOF ID..."
                                maxLength={100}
                                onChange={handleSearch}
                                autoFocus
                            />
                            <div className="wof-search-results">
                                {results.map(player => (
                                    <div
                                        key={player.id}
                                        className={`wof-search-item ${selectedPlayer?.id === player.id ? 'selected' : ''}`}
                                        onClick={() => !submitting && selectPlayer(player)}
                                    >
                                        <div className="wof-search-item-info">
                                            <div className="wof-search-item-name">
                                                {player.name} {player.surname}
                                            </div>
                                            <div className="wof-search-item-details">
                                                <CountryFlags countryCode={player.country_code} />
                                                {' '}Rating: {player.rating} | WOF ID: {player.wof_id}
                                            </div>
                                        </div>
                                    </div>
                                ))}
                            </div>
                            {selectedPlayer && (
                                <button
                                    className="wof-submit-btn"
                                    onClick={confirmPlayer}
                                    disabled={submitting}
                                >
                                    {submitting ? 'Submitting...' : 'Confirm'}
                                </button>
                            )}
                            {searchVal.length >= 2 && results.length === 0 && (
                                <button
                                    className="wof-new-player-btn"
                                    onClick={() => setShowNewForm(true)}
                                >
                                    Never played in a live tournament?
                                </button>
                            )}
                        </>
                    ) : (
                        <div className="wof-new-player-form">
                            <div className="wof-form-field">
                                <label>Name (English characters only)</label>
                                <input
                                    type="text"
                                    maxLength={50}
                                    value={newName}
                                    onChange={e => setNewName(e.target.value)}
                                    placeholder="First name"
                                    autoFocus
                                />
                            </div>
                            <div className="wof-form-field">
                                <label>Surname (English characters only)</label>
                                <input
                                    type="text"
                                    maxLength={50}
                                    value={newSurname}
                                    onChange={e => setNewSurname(e.target.value)}
                                    placeholder="Last name"
                                />
                            </div>
                            <div className="wof-form-field">
                                <label>Country</label>
                                <input
                                    type="text"
                                    placeholder="Type country name..."
                                    value={countryInput}
                                    onChange={handleCountryChange}
                                    autoComplete="off"
                                    className={newCountry ? 'valid' : ''}
                                />
                                {countrySuggestions.length > 0 && (
                                    <div className="wof-country-suggestions">
                                        {countrySuggestions.map(c => (
                                            <div key={c} className="wof-country-item" onClick={() => handleCountrySelect(c)}>
                                                <CountryFlags countryName={c} />
                                                <span>{c}</span>
                                            </div>
                                        ))}
                                    </div>
                                )}
                            </div>
                            <button
                                className="wof-submit-btn"
                                onClick={submitNewPlayer}
                                disabled={submitting || !newName.trim() || !newSurname.trim() || !newCountry}
                            >
                                {submitting ? 'Submitting...' : 'Submit Request'}
                            </button>
                            <button
                                className="wof-new-player-btn"
                                onClick={() => setShowNewForm(false)}
                            >
                                Back to search
                            </button>
                        </div>
                    )}
                </div>
            </div>
        </div>
    )
}
