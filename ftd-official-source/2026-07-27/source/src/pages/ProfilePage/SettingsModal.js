import React, { useState, useContext, useRef, useEffect, useCallback } from 'react'
import { AuthContext } from '../../context/AuthContext'
import { Close } from '../elements/SVG'
import { findImage } from '../functions/functions'

const CROP_W = 260
const CROP_H = 300

export const SettingsModal = ({ onClose, profile, nickname }) => {
    const { socket, token } = useContext(AuthContext)
    const [imgSrc, setImgSrc] = useState(null)
    const [imgEl, setImgEl] = useState(null)
    const [uploading, setUploading] = useState(false)
    const [message, setMessage] = useState(null)
    const [error, setError] = useState(null)
    const [justUploaded, setJustUploaded] = useState(false)
    const [scale, setScale] = useState(1)
    const [pos, setPos] = useState({ x: 0, y: 0 })
    const fileInputRef = useRef(null)
    const dragRef = useRef(null)
    const cropRef = useRef(null)

    const hasPending = !!profile?.pending_avatar || justUploaded
    const pendingDate = profile?.pending_avatar_date ? new Date(profile.pending_avatar_date) : justUploaded ? new Date() : null
    const cooldownActive = pendingDate && (Date.now() - pendingDate.getTime() < 24 * 60 * 60 * 1000)
    const hoursLeft = cooldownActive ? Math.ceil((24 * 60 * 60 * 1000 - (Date.now() - pendingDate.getTime())) / (60 * 60 * 1000)) : 0

    useEffect(() => {
        const onAvatarUpdated = () => {
            setMessage('Your profile picture has been approved!')
            setImgSrc(null)
            setImgEl(null)
        }
        const onAvatarDenied = () => {
            setError('Your profile picture request was denied.')
        }
        socket.on('avatar-updated', onAvatarUpdated)
        socket.on('avatar-denied', onAvatarDenied)
        return () => {
            socket.off('avatar-updated', onAvatarUpdated)
            socket.off('avatar-denied', onAvatarDenied)
        }
    }, [socket])

    // Compute display size for the crop viewport to fit inside modal
    const getDisplaySize = () => {
        const maxW = Math.min(window.innerWidth * 0.8, 400)
        const displayW = Math.min(CROP_W, maxW)
        const displayH = displayW * (CROP_H / CROP_W)
        return { displayW, displayH }
    }

    const initCrop = (img) => {
        const { displayW, displayH } = getDisplaySize()
        // Scale to fit: the image must cover the crop viewport at minimum
        const scaleX = displayW / img.naturalWidth
        const scaleY = displayH / img.naturalHeight
        const minScale = Math.max(scaleX, scaleY)
        setScale(minScale)
        // Center the image
        const imgW = img.naturalWidth * minScale
        const imgH = img.naturalHeight * minScale
        setPos({ x: (displayW - imgW) / 2, y: (displayH - imgH) / 2 })
    }

    const handleFileSelect = (e) => {
        const selected = e.target.files[0]
        if (!selected) return
        setError(null)
        setMessage(null)

        const allowed = ['image/jpeg', 'image/png', 'image/webp']
        if (!allowed.includes(selected.type)) {
            setError('Only JPG, PNG, and WebP images are allowed')
            return
        }
        if (selected.size > 2 * 1024 * 1024) {
            setError('File is too large. Maximum size is 2MB.')
            return
        }

        const reader = new FileReader()
        reader.onload = (ev) => {
            const img = new Image()
            img.onload = () => {
                if (img.naturalWidth < CROP_W || img.naturalHeight < CROP_H) {
                    setError(`Image must be at least ${CROP_W}×${CROP_H}px. Yours is ${img.naturalWidth}×${img.naturalHeight}px.`)
                    return
                }
                setImgEl(img)
                setImgSrc(ev.target.result)
                initCrop(img)
            }
            img.src = ev.target.result
        }
        reader.readAsDataURL(selected)
    }

    // Clamp position so image always covers the crop viewport
    const clampPos = useCallback((x, y, s) => {
        const { displayW, displayH } = getDisplaySize()
        const imgW = imgEl ? imgEl.naturalWidth * s : 0
        const imgH = imgEl ? imgEl.naturalHeight * s : 0
        const maxX = 0
        const minX = displayW - imgW
        const maxY = 0
        const minY = displayH - imgH
        return {
            x: Math.min(maxX, Math.max(minX, x)),
            y: Math.min(maxY, Math.max(minY, y))
        }
    }, [imgEl])

    // Drag handlers (mouse + touch)
    const onDragStart = (e) => {
        e.preventDefault()
        const startX = e.type === 'touchstart' ? e.touches[0].clientX : e.clientX
        const startY = e.type === 'touchstart' ? e.touches[0].clientY : e.clientY
        const startPos = { ...pos }

        const onMove = (ev) => {
            const cx = ev.type === 'touchmove' ? ev.touches[0].clientX : ev.clientX
            const cy = ev.type === 'touchmove' ? ev.touches[0].clientY : ev.clientY
            const newPos = clampPos(startPos.x + cx - startX, startPos.y + cy - startY, scale)
            setPos(newPos)
        }
        const onUp = () => {
            window.removeEventListener('mousemove', onMove)
            window.removeEventListener('mouseup', onUp)
            window.removeEventListener('touchmove', onMove)
            window.removeEventListener('touchend', onUp)
        }
        window.addEventListener('mousemove', onMove)
        window.addEventListener('mouseup', onUp)
        window.addEventListener('touchmove', onMove, { passive: false })
        window.addEventListener('touchend', onUp)
    }

    // Zoom with scroll wheel
    const onWheel = (e) => {
        e.preventDefault()
        if (!imgEl) return
        const { displayW, displayH } = getDisplaySize()
        const minScaleX = displayW / imgEl.naturalWidth
        const minScaleY = displayH / imgEl.naturalHeight
        const minScale = Math.max(minScaleX, minScaleY)
        const maxScale = minScale * 5

        const delta = e.deltaY < 0 ? 1.08 : 1 / 1.08
        const newScale = Math.min(maxScale, Math.max(minScale, scale * delta))

        // Zoom toward cursor position within the crop area
        const rect = cropRef.current.getBoundingClientRect()
        const cx = e.clientX - rect.left
        const cy = e.clientY - rect.top
        const newX = cx - (cx - pos.x) * (newScale / scale)
        const newY = cy - (cy - pos.y) * (newScale / scale)
        const clamped = clampPos(newX, newY, newScale)

        setScale(newScale)
        setPos(clamped)
    }

    const cropAndUpload = async () => {
        if (!imgEl || uploading) return
        setUploading(true)
        setError(null)
        setMessage(null)

        try {
            const { displayW, displayH } = getDisplaySize()
            // Map display coordinates back to original image pixels
            const realScale = scale // display pixels per image pixel
            const srcX = -pos.x / realScale
            const srcY = -pos.y / realScale
            const srcW = displayW / realScale
            const srcH = displayH / realScale

            const canvas = document.createElement('canvas')
            canvas.width = CROP_W
            canvas.height = CROP_H
            const ctx = canvas.getContext('2d')
            ctx.drawImage(imgEl, srcX, srcY, srcW, srcH, 0, 0, CROP_W, CROP_H)

            const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', 0.92))
            const formData = new FormData()
            formData.append('avatar', blob, 'avatar.jpg')

            const res = await fetch('/api/avatar/upload', {
                method: 'POST',
                headers: { 'Authorization': `Bearer ${token}` },
                body: formData
            })

            const data = await res.json()
            if (res.ok && data.success) {
                setMessage(data.message || 'Profile picture sent for approval')
                setImgSrc(null)
                setImgEl(null)
                setJustUploaded(true)
                socket.emit('get-profile', nickname)
            } else {
                setError(data.error || 'Upload failed')
            }
        } catch (e) {
            setError('Upload failed. Please try again.')
        }
        setUploading(false)
    }

    const handleCancel = () => {
        setImgSrc(null)
        setImgEl(null)
        setError(null)
        setMessage(null)
        setScale(1)
        setPos({ x: 0, y: 0 })
        if (fileInputRef.current) fileInputRef.current.value = ''
    }

    const { displayW, displayH } = getDisplaySize()

    return (
        <div className='settings-modal-overlay' onClick={onClose}>
            <div className='settings-modal' onClick={e => e.stopPropagation()}>
                <div className='settings-modal-header'>
                    <span className='settings-modal-title'>Settings</span>
                    <span className='settings-modal-close' onClick={onClose}><Close /></span>
                </div>

                <div className='settings-modal-body'>
                    <div className='settings-section'>
                        <span className='settings-section-title'>Profile Picture</span>

                        {!imgSrc ? (
                            <div className='settings-avatar-row'>
                                <img
                                    className='settings-avatar-preview'
                                    src={findImage(nickname) + (profile?.avatar ? `?v=${encodeURIComponent(profile.avatar)}` : '')}
                                    alt={nickname}
                                />
                                <div className='settings-avatar-actions'>
                                    {cooldownActive && !message ? (
                                        <div className='settings-avatar-cooldown'>
                                            {hasPending ? (
                                                <span>⏳ Your new picture is awaiting approval</span>
                                            ) : (
                                                <span>Please wait {hoursLeft}h before uploading again</span>
                                            )}
                                        </div>
                                    ) : (
                                        <>
                                            <label className='settings-upload-btn' htmlFor='avatar-upload'>
                                                Choose Image
                                            </label>
                                            <input
                                                ref={fileInputRef}
                                                id='avatar-upload'
                                                type='file'
                                                accept='image/jpeg,image/png,image/webp'
                                                onChange={handleFileSelect}
                                                style={{ display: 'none' }}
                                            />
                                            <span className='settings-upload-hint'>JPG, PNG or WebP, min {CROP_W}×{CROP_H}px, max 2MB</span>
                                        </>
                                    )}
                                </div>
                            </div>
                        ) : (
                            <div className='settings-crop-container'>
                                <div
                                    className='settings-crop-viewport'
                                    ref={cropRef}
                                    style={{ width: displayW, height: displayH }}
                                    onMouseDown={onDragStart}
                                    onTouchStart={onDragStart}
                                    onWheel={onWheel}
                                >
                                    <img
                                        ref={dragRef}
                                        src={imgSrc}
                                        alt='crop'
                                        className='settings-crop-image'
                                        draggable={false}
                                        style={{
                                            width: imgEl ? imgEl.naturalWidth * scale : 0,
                                            height: imgEl ? imgEl.naturalHeight * scale : 0,
                                            transform: `translate(${pos.x}px, ${pos.y}px)`,
                                        }}
                                    />
                                </div>
                                <span className='settings-upload-hint'>Drag to reposition • Scroll to zoom</span>
                                <div className='settings-upload-confirm'>
                                    <button
                                        className='settings-upload-btn confirm'
                                        onClick={cropAndUpload}
                                        disabled={uploading}
                                    >
                                        {uploading ? 'Uploading...' : 'Upload'}
                                    </button>
                                    <button
                                        className='settings-upload-btn cancel'
                                        onClick={handleCancel}
                                        disabled={uploading}
                                    >
                                        Cancel
                                    </button>
                                </div>
                            </div>
                        )}

                        {message && <div className='settings-message success'>{message}</div>}
                        {error && <div className='settings-message error'>{error}</div>}
                    </div>
                </div>
            </div>
        </div>
    )
}
