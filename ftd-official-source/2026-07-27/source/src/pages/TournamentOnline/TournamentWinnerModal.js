import React, { useEffect, useRef, useState, useCallback, useContext } from 'react'
import { getName } from 'country-list'
import { CountryFlags } from '../elements/CountryFlags'
import { findImage, toNameCase } from '../functions/functions'
import { SFXContext } from '../../context/SFXContext'
import './tournamentWinnerModal.css'

// Medal emoji/icons for podium
const MEDALS = ['🥇', '🥈', '🥉']
const PLACE_LABELS = ['1st Place', '2nd Place', '3rd Place']

// Confetti particle system - pure canvas + JS, no dependencies
function createConfetti(canvas) {
    const ctx = canvas.getContext('2d')
    const particles = []
    const colors = ['#FFD700', '#FFA500', '#FF6347', '#00CED1', '#7B68EE', '#FF69B4', '#32CD32', '#FF4500', '#1E90FF', '#FFFF00']
    const W = canvas.width
    const H = canvas.height

    for (let i = 0; i < 150; i++) {
        particles.push({
            x: Math.random() * W,
            y: Math.random() * H - H,
            w: 4 + Math.random() * 6,
            h: 8 + Math.random() * 8,
            color: colors[Math.floor(Math.random() * colors.length)],
            speed: 1.5 + Math.random() * 3,
            angle: Math.random() * Math.PI * 2,
            spin: (Math.random() - 0.5) * 0.1,
            drift: (Math.random() - 0.5) * 1.5,
            opacity: 0.7 + Math.random() * 0.3,
        })
    }

    let animId
    function draw() {
        ctx.clearRect(0, 0, W, H)
        for (const p of particles) {
            ctx.save()
            ctx.translate(p.x, p.y)
            ctx.rotate(p.angle)
            ctx.globalAlpha = p.opacity
            ctx.fillStyle = p.color
            ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h)
            ctx.restore()

            p.y += p.speed
            p.x += p.drift
            p.angle += p.spin
            if (p.y > H + 20) {
                p.y = -20
                p.x = Math.random() * W
            }
        }
        animId = requestAnimationFrame(draw)
    }
    draw()
    return () => cancelAnimationFrame(animId)
}

// Manual canvas renderer for standings image — draws circles matching the Standings tab
function renderStandingsToCanvas(standings, totalRounds, tournamentName, endDate, verifiedOnly, viewerVerified) {
    const DISC_R = 15          // disc radius (30px diameter like CSS)
    const DISC_GAP = 4         // margin between discs
    const DISC_CELL = DISC_R * 2 + DISC_GAP
    const ROW_H = 40
    const HEADER_H = 32
    const TITLE_H = 44
    const COL_PLACE = 30
    const COL_RATING = 44
    const COL_SCORE = 44
    const COL_MBQ = 44
    const PAD = 12
    const FONT = '-apple-system, BlinkMacSystemFont, Segoe UI, Roboto, sans-serif'

    // Measure the widest player name to size the column dynamically
    const measureCanvas = document.createElement('canvas')
    const measureCtx = measureCanvas.getContext('2d')
    measureCtx.font = `11px ${FONT}`
    let maxNameW = 80 // minimum
    for (const player of standings) {
        const nick = (verifiedOnly && viewerVerified && player.wof_name) ? toNameCase(player.wof_name) : (player.nick || '?')
        const w = measureCtx.measureText(nick).width
        if (w > maxNameW) maxNameW = w
    }
    const COL_NAME = Math.ceil(maxNameW) + 16 // 16px padding

    const roundsW = totalRounds * DISC_CELL
    const tableW = COL_PLACE + COL_NAME + COL_RATING + roundsW + COL_SCORE + COL_MBQ + PAD * 2
    const tableH = TITLE_H + HEADER_H + standings.length * ROW_H + PAD * 2

    const scale = 2
    const canvas = document.createElement('canvas')
    canvas.width = tableW * scale
    canvas.height = tableH * scale
    const ctx = canvas.getContext('2d')
    ctx.scale(scale, scale)

    // Background
    ctx.fillStyle = '#1f1e1b'
    ctx.fillRect(0, 0, tableW, tableH)

    // Title
    ctx.fillStyle = '#FFD700'
    ctx.font = `bold 14px ${FONT}`
    ctx.textAlign = 'center'
    const dateStr = endDate ? new Date(endDate).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' }) : ''
    const titleText = dateStr ? `${tournamentName} — ${dateStr}` : tournamentName
    ctx.fillText(titleText, tableW / 2, PAD + 18)

    // Header row
    const headerY = TITLE_H + PAD
    ctx.fillStyle = '#312e2b'
    ctx.fillRect(PAD, headerY, tableW - PAD * 2, HEADER_H)

    ctx.fillStyle = '#aca9a9'
    ctx.font = `bold 10px ${FONT}`
    ctx.textAlign = 'center'

    let x = PAD
    ctx.fillText('#', x + COL_PLACE / 2, headerY + 20)
    x += COL_PLACE
    ctx.textAlign = 'left'
    ctx.fillText('Player', x + 4, headerY + 20)
    x += COL_NAME
    ctx.textAlign = 'center'
    ctx.fillText('Rtg', x + COL_RATING / 2, headerY + 20)
    x += COL_RATING
    for (let r = 1; r <= totalRounds; r++) {
        ctx.fillText(`R${r}`, x + DISC_CELL / 2, headerY + 20)
        x += DISC_CELL
    }
    ctx.fillText('Pts', x + COL_SCORE / 2, headerY + 20)
    x += COL_SCORE
    ctx.fillText('MBQ', x + COL_MBQ / 2, headerY + 20)

    // Body rows
    const bodyStartY = headerY + HEADER_H
    for (let i = 0; i < standings.length; i++) {
        const player = standings[i]
        const rowY = bodyStartY + i * ROW_H
        const isWithdrawn = player.left_after_round && player.left_after_round <= totalRounds

        // Alternating row bg (matching standings tab)
        ctx.fillStyle = i % 2 === 0 ? '#262421' : '#1f1d1a'
        ctx.fillRect(PAD, rowY, tableW - PAD * 2, ROW_H)

        // Row bottom border
        ctx.fillStyle = '#312e2b'
        ctx.fillRect(PAD, rowY + ROW_H - 1, tableW - PAD * 2, 1)

        const rowCy = rowY + ROW_H / 2  // vertical center of row

        // Place
        x = PAD
        ctx.fillStyle = '#d8d0d0'
        ctx.font = `bold 11px ${FONT}`
        ctx.textAlign = 'center'
        ctx.fillText(String(i + 1), x + COL_PLACE / 2, rowCy + 4)

        // Name (with strikethrough + grey for withdrawn, matching standings tab)
        x += COL_PLACE
        ctx.fillStyle = isWithdrawn ? '#666' : (i === 0 ? '#FFD700' : '#f0f0f0')
        ctx.font = `${isWithdrawn ? 'italic' : 'normal'} 11px ${FONT}`
        ctx.textAlign = 'left'
        const nick = (verifiedOnly && viewerVerified && player.wof_name) ? toNameCase(player.wof_name) : (player.nick || '?')
        const nickX = x + 4
        ctx.fillText(nick, nickX, rowCy + 4)
        if (isWithdrawn) {
            const nickW = ctx.measureText(nick).width
            ctx.fillRect(nickX, rowCy + 1, nickW, 1)
        }

        // Rating
        x += COL_NAME
        ctx.fillStyle = '#aca9a9'
        ctx.font = `10px ${FONT}`
        ctx.textAlign = 'center'
        ctx.fillText(player.rating || '-', x + COL_RATING / 2, rowCy + 4)

        // Round discs — draw actual circles!
        x += COL_RATING
        for (let r = 0; r < totalRounds; r++) {
            const rd = player.rounds?.[r]
            const cx = x + r * DISC_CELL + DISC_CELL / 2
            const cy = rowCy

            if (!rd || !rd.played) {
                // Not played — dashed circle with "-"
                ctx.beginPath()
                ctx.arc(cx, cy, DISC_R - 1, 0, Math.PI * 2)
                ctx.setLineDash([3, 3])
                ctx.strokeStyle = '#555'
                ctx.lineWidth = 1
                ctx.stroke()
                ctx.setLineDash([])
                ctx.fillStyle = '#555'
                ctx.font = `10px ${FONT}`
                ctx.textAlign = 'center'
                ctx.fillText('-', cx, cy + 4)
            } else if (rd.bye) {
                // BYE — solid gray circle
                ctx.beginPath()
                ctx.arc(cx, cy, DISC_R - 1, 0, Math.PI * 2)
                ctx.fillStyle = '#444'
                ctx.fill()
                ctx.strokeStyle = '#555'
                ctx.lineWidth = 1
                ctx.stroke()
                ctx.fillStyle = '#aca9a9'
                ctx.font = `bold 9px ${FONT}`
                ctx.textAlign = 'center'
                ctx.fillText('BYE', cx, cy + 3)
            } else {
                // Actual game disc
                const isBlack = rd.color === 'black'
                const discBg = isBlack ? '#1a1a1a' : '#e8e8e8'
                const textColor = isBlack ? '#fff' : '#1a1a1a'

                // Glow/shadow for result
                let glowColor = 'transparent'
                if (rd.result === 2) glowColor = isBlack ? '#149e14' : '#01fa0a'      // win
                else if (rd.result === 1) glowColor = 'rgba(255,255,255,0.6)'          // draw
                else if (rd.result === 0) glowColor = 'red'                            // loss

                // Draw glow
                if (glowColor !== 'transparent') {
                    ctx.shadowColor = glowColor
                    ctx.shadowBlur = 5
                }

                // Disc fill
                ctx.beginPath()
                ctx.arc(cx, cy, DISC_R - 1, 0, Math.PI * 2)
                ctx.fillStyle = discBg
                ctx.fill()

                // Border for white discs
                if (!isBlack) {
                    ctx.strokeStyle = '#1a1a1a'
                    ctx.lineWidth = 1
                    ctx.stroke()
                }

                ctx.shadowColor = 'transparent'
                ctx.shadowBlur = 0

                // Disc count (top text)
                ctx.fillStyle = textColor
                ctx.font = `bold 12px ${FONT}`
                ctx.textAlign = 'center'
                ctx.fillText(rd.discs ?? '', cx, cy + 1)

                // Opponent place (bottom small text)
                ctx.globalAlpha = 0.8
                ctx.fillStyle = textColor
                ctx.font = `9px ${FONT}`
                ctx.fillText(rd.opponentPlace ?? '', cx, cy + 10)
                ctx.globalAlpha = 1
            }
        }

        // Score
        x += roundsW
        ctx.fillStyle = '#f0f0f0'
        ctx.font = `bold 12px ${FONT}`
        ctx.textAlign = 'center'
        ctx.fillText(player.score ?? '-', x + COL_SCORE / 2, rowCy + 4)

        // MBQ
        x += COL_SCORE
        ctx.fillStyle = '#aca9a9'
        ctx.font = `10px ${FONT}`
        ctx.fillText(player.mbq ?? '-', x + COL_MBQ / 2, rowCy + 4)
    }

    return canvas
}

export const TournamentWinnerModal = ({ standings, totalRounds, tournamentName, endDate, onClose, verifiedOnly = false, viewerVerified = false }) => {
    const canvasRef = useRef(null)
    const soundPlayedRef = useRef(false)
    const soundHandleRef = useRef(null)
    const [copied, setCopied] = useState(false)
    const { playTournamentFinish, playDavid } = useContext(SFXContext)

    const top3 = (standings || []).slice(0, 3)

    // Check if the winner is Shimgar / David Hand
    const isShimgarWinner = top3.length > 0 && (
        top3[0].nick?.toLowerCase() === 'shimgar' ||
        top3[0].name?.toLowerCase() === 'david hand'
    )

    // Play sounds on mount — only once; fade out and stop on unmount
    useEffect(() => {
        if (soundPlayedRef.current) return
        soundPlayedRef.current = true
        if (isShimgarWinner) {
            soundHandleRef.current = playDavid()
        } else {
            soundHandleRef.current = playTournamentFinish()
        }
        return () => {
            if (soundHandleRef.current?.stop) {
                soundHandleRef.current.stop(1)
            }
        }
    }, []) // eslint-disable-line react-hooks/exhaustive-deps

    // Start confetti
    useEffect(() => {
        const canvas = canvasRef.current
        if (!canvas) return
        canvas.width = window.innerWidth
        canvas.height = window.innerHeight
        const cleanup = createConfetti(canvas)
        return cleanup
    }, [])

    const copyStandingsImage = useCallback(async () => {
        if (!standings?.length) return
        try {
            const canvas = renderStandingsToCanvas(standings, totalRounds, tournamentName, endDate, verifiedOnly, viewerVerified)
            const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'))
            if (!blob) return

            if (navigator.clipboard?.write) {
                try {
                    await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })])
                    setCopied(true)
                    setTimeout(() => setCopied(false), 2500)
                    return
                } catch {
                    // fall through to download
                }
            }
            // Fallback - download
            const a = document.createElement('a')
            a.href = URL.createObjectURL(blob)
            a.download = `${tournamentName || 'tournament'}_standings.png`
            a.click()
            URL.revokeObjectURL(a.href)
            setCopied(true)
            setTimeout(() => setCopied(false), 2500)
        } catch (err) {
            console.error('Failed to copy standings image:', err)
        }
    }, [standings, totalRounds, tournamentName, endDate, verifiedOnly, viewerVerified])

    // Podium order: 2nd (left), 1st (center), 3rd (right)
    const podiumOrder = top3.length >= 3 ? [top3[1], top3[0], top3[2]] : top3
    const podiumPlaceOrder = top3.length >= 3 ? [1, 0, 2] : top3.map((_, i) => i)

    return (
        <div className="winner-modal-overlay" data-testid="winner-modal">
            <canvas ref={canvasRef} className="winner-confetti-canvas" />

            <div className="winner-modal-content">
                {/* Close button */}
                <button className="winner-modal-close" onClick={onClose} aria-label="Close" data-testid="winner-modal-close">✕</button>

                {/* Trophy header */}
                <div className="winner-trophy-header">
                    <div className="winner-trophy-icon">🏆</div>
                    <h2 className="winner-title">Tournament Complete!</h2>
                    <p className="winner-tournament-name">{tournamentName}</p>
                </div>

                {/* Podium */}
                <div className="winner-podium" data-testid="winner-podium">
                    {podiumOrder.map((player, idx) => {
                        const actualPlace = podiumPlaceOrder[idx]
                        const countryName = getName(player?.country_code)
                        const podiumHeight = actualPlace === 0 ? 'podium-1st' : actualPlace === 1 ? 'podium-2nd' : 'podium-3rd'
                        return (
                            <div key={player?.player_id || idx} className={`podium-slot ${podiumHeight}`} data-testid={`podium-place-${actualPlace + 1}`}>
                                <div className="podium-medal">{MEDALS[actualPlace]}</div>
                                <div className="podium-avatar">
                                    <img src={findImage(player?.nick)} alt={player?.nick || ''} className="podium-avatar-img" />
                                    <span className="podium-avatar-flag">
                                        <CountryFlags countryName={countryName} countryCode={player?.country_code} />
                                    </span>
                                </div>
                                <div className="podium-nick">{(verifiedOnly && viewerVerified && player?.wof_name) ? toNameCase(player.wof_name) : (player?.nick || '—')}</div>
                                <div className="podium-score">{player?.score != null ? `${player.score} pts` : ''}</div>
                                <div className="podium-label">{PLACE_LABELS[actualPlace]}</div>
                                <div className={`podium-block ${podiumHeight}`}>
                                    <span className="podium-block-number">{actualPlace + 1}</span>
                                </div>
                            </div>
                        )
                    })}
                </div>

                {/* Copy standings button */}
                <div className="winner-actions">
                    <button
                        className="winner-btn winner-btn-copy"
                        onClick={copyStandingsImage}
                        data-testid="winner-copy-standings"
                    >
                        {copied ? '✓ Copied!' : '📋 Copy Standings Image'}
                    </button>
                </div>
            </div>
        </div>
    )
}

export default TournamentWinnerModal
