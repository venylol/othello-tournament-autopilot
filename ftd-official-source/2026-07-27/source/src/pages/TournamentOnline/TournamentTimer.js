import React from "react"
import Countdown from 'react-countdown';

export const TournamentTimer = ({currentRound, nextRoundStartTime, setNextRoundStartTime, playersTab = false, tournamentStatus = 1}) => {
    // console.log('TournamentTimer', currentRound, nextRoundStartTime)

    const renderer = ({ days, hours, minutes, seconds, completed }) => {
        if (completed) {
        // Render a completed state
            return <></>;
        } else {
            const hh = (hours < 10) ? "0" + hours : hours;
            const mm = (minutes < 10) ? "0" + minutes : minutes;
            const ss = (seconds < 10) ? "0" + seconds : seconds;
            if (days > 0) return <span>{` ${days}d ${hh}h:${mm}m`}</span>;
            if (hours > 0) return <span>{` ${hh}h:${mm}m`}</span>;
            return <span>{` ${mm}m:${ss}s`}</span>;
        }
    };

    const onStop = () => {
        setNextRoundStartTime(null)
        console.log('setting nextRoundStartTime to null')
    }

    // Show "Tournament Cancelled" message when status is 2 (cancelled)
    if (tournamentStatus === 2) {
        return (
            <div>
                <div className = 'big-text' style = {{textTransform: 'none', whiteSpace: 'pre', borderTop: playersTab ? 'none' :'1px solid #aca9a9', color: '#d32f2f'}}>
                    <span>Tournament Cancelled</span>
                </div>
            </div>
        )
    }

    return (
        <div>
            {nextRoundStartTime ? 
                <div className = 'big-text' style = {{textTransform: 'none', whiteSpace: 'pre', borderTop: playersTab ? 'none' :'1px solid #aca9a9'}}>
                    {currentRound === 0 ?
                        <span>Tournament starts in</span>
                        :
                        <span>Next round starts in</span>
                    }
                    <Countdown
                        date = {nextRoundStartTime}
                        renderer={renderer}
                        // ref = {ref}
                        autoStart = {true}
                        intervalDelay={100}
                        precision={1}
                        onStop = {onStop}
                    />
                </div>
            : <></>}
        </div>
    )
}