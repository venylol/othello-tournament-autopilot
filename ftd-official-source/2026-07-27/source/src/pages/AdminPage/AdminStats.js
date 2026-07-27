import React, { useState, useEffect, useContext, useRef } from 'react'
import { AuthContext } from '../../context/AuthContext'
import { getName } from 'country-list'
import { CountryFlags } from '../elements/CountryFlags'

const formatDate = (dateStr) => {
    if (!dateStr) return ''
    const d = new Date(dateStr)
    return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })
}

const RegistrationGraph = ({ data, width }) => {
    if (!data || data.length === 0) return null

    const graphWidth = Math.min(width - 30, 470)
    const graphHeight = 220
    const padding = { top: 20, right: 15, bottom: 55, left: 40 }
    const plotWidth = graphWidth - padding.left - padding.right
    const plotHeight = graphHeight - padding.top - padding.bottom

    // Aggregate by month
    const monthly = {}
    data.forEach(d => {
        const date = new Date(d.date)
        const key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`
        monthly[key] = (monthly[key] || 0) + d.count
    })

    // Cumulative
    const months = Object.keys(monthly).sort()
    let cumulative = 0
    const points = months.map((m) => {
        cumulative += monthly[m]
        return { month: m, total: cumulative }
    })

    if (points.length < 2) return null

    const maxVal = points[points.length - 1].total
    const minVal = 0

    const getX = (i) => padding.left + (i / (points.length - 1)) * plotWidth
    const getY = (val) => padding.top + plotHeight - ((val - minVal) / (maxVal - minVal)) * plotHeight

    const pathD = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${getX(i).toFixed(1)},${getY(p.total).toFixed(1)}`).join(' ')

    // Y-axis ticks
    const yTicks = 5
    const yStep = Math.ceil(maxVal / yTicks)
    const yLabels = []
    for (let i = 0; i <= yTicks; i++) {
        const val = i * yStep
        if (val <= maxVal * 1.1) yLabels.push(val)
    }

    // X-axis labels (show every Nth month)
    const xLabelStep = Math.max(1, Math.floor(points.length / 6))

    return (
        <svg width={graphWidth} height={graphHeight} style={{ marginTop: 10 }}>
            {/* Grid lines */}
            {yLabels.map((val, i) => (
                <g key={i}>
                    <line x1={padding.left} y1={getY(val)} x2={graphWidth - padding.right} y2={getY(val)} stroke="#333" strokeWidth="0.5" />
                    <text x={padding.left - 5} y={getY(val) + 4} fill="#aca9a9" fontSize="10" textAnchor="end">{val}</text>
                </g>
            ))}

            {/* X-axis labels */}
            {points.map((p, i) => {
                if (i % xLabelStep !== 0 && i !== points.length - 1) return null
                return (
                    <text key={i} x={getX(i)} y={graphHeight - 5} fill="#aca9a9" fontSize="9" textAnchor="middle" transform={`rotate(-30, ${getX(i)}, ${graphHeight - 5})`}>
                        {p.month}
                    </text>
                )
            })}

            {/* Line */}
            <path d={pathD} fill="none" stroke="#86a94b" strokeWidth="2" />

            {/* Dots */}
            {points.map((p, i) => (
                <circle key={i} cx={getX(i)} cy={getY(p.total)} r="2" fill="#86a94b" />
            ))}
        </svg>
    )
}

export const AdminStats = ({ width }) => {
    const { socket } = useContext(AuthContext)
    const [stats, setStats] = useState(null)
    const [otbExpanded, setOtbExpanded] = useState(false)

    useEffect(() => {
        socket.emit('get-admin-stats')
        socket.on('admin-stats', (data) => {
            setStats(data)
        })
        return () => {
            socket.off('admin-stats')
        }
    }, [])

    if (!stats) return <div className='big-text-empty'>Loading...</div>

    const statusLabels = { '-1': 'Banned', '0': 'Not verified', '1': 'Verified', '2': 'TD' }

    return (
        <div className='admin-stats-container'>
            <div className='admin-stats-section'>
                <div className='admin-stats-title'>Users</div>
                <div className='admin-stats-row'>
                    <span className='admin-stats-label'>Total:</span>
                    <span className='admin-stats-value'>{stats.total}</span>
                </div>
                {stats.byStatus?.filter(s => statusLabels[s.status] !== undefined).map(s => (
                    <div className='admin-stats-row' key={s.status}>
                        <span className='admin-stats-label'>{statusLabels[s.status]}:</span>
                        <span className='admin-stats-value'>{s.count}</span>
                    </div>
                ))}
                <div className='admin-stats-row'>
                    <span className='admin-stats-label'>WOF Verified:</span>
                    <span className='admin-stats-value'>{stats.wofVerified}</span>
                </div>
                <div className='admin-stats-row'>
                    <span className='admin-stats-label'>Countries:</span>
                    <span className='admin-stats-value'>{stats.countries}</span>
                </div>
            </div>

            <div className='admin-stats-section'>
                <div className='admin-stats-title'>Users by Country</div>
                {stats.byCountry?.slice(0, 15).map(c => (
                    <div className='admin-stats-row country small' key={c.country}>
                        <CountryFlags countryName={getName(c.country)} countryCode={c.country} isWOF={true} />
                        <span className='admin-stats-label'>{getName(c.country) || c.country}</span>
                        <span className='admin-stats-value'>{c.count}</span>
                    </div>
                ))}
            </div>

            <div className='admin-stats-section'>
                <div className='admin-stats-title'>OTB Tournaments</div>
                <div className='admin-stats-row'>
                    <span className='admin-stats-label'>Total:</span>
                    <span className='admin-stats-value'>{stats.otbTotal}</span>
                </div>
                <div className='admin-stats-row'>
                    <span className='admin-stats-label'>XOT:</span>
                    <span className='admin-stats-value'>{stats.xotCount}</span>
                </div>
                <div className='admin-stats-row'>
                    <span className='admin-stats-label'>Private:</span>
                    <span className='admin-stats-value'>{stats.otbPrivate}</span>
                </div>
                <div className='admin-stats-row'>
                    <span className='admin-stats-label'>With streamed games:</span>
                    <span className='admin-stats-value'>{stats.otbStreamed}</span>
                </div>
                <div className='admin-stats-row'>
                    <span className='admin-stats-label'>Total games:</span>
                    <span className='admin-stats-value'>{stats.otbGames}</span>
                </div>
                {(otbExpanded ? stats.otbByCountry : stats.otbByCountry?.slice(0, 10))?.map(c => (
                    <div className='admin-stats-row country small' key={c.country}>
                        <CountryFlags countryName={getName(c.country)} countryCode={c.country} isWOF={true} />
                        <span className='admin-stats-label'>{getName(c.country) || c.country}</span>
                        <span className='admin-stats-value'>{c.count}/{c.games}</span>
                    </div>
                ))}
                {stats.otbByCountry?.length > 10 && (
                    <div className='admin-stats-expand' onClick={() => setOtbExpanded(!otbExpanded)}>
                        {otbExpanded ? 'Show less ▲' : `Show all ${stats.otbByCountry.length} countries ▼`}
                    </div>
                )}
            </div>

            <div className='admin-stats-section' style={{paddingBottom: 60}}>
                <div className='admin-stats-title'>Registrations over time</div>
                <RegistrationGraph data={stats.regOverTime} width={width} />
            </div>
        </div>
    )
}

export default AdminStats
