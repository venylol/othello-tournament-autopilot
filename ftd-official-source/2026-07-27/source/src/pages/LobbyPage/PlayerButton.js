
export const PlayerButton = ({watchHandler, showSettings, cancelInvitation, index, playing, isInvited, isAuthenticated}) => {

    if (playing) return (
        <>
            <button onClick = {() => watchHandler(index)} >Watch</button>
        </>
    )
    if (isInvited) return (
        <>
            <button onClick = {() => cancelInvitation(index)} style = {{backgroundColor: '#8b0100'}}>Cancel</button>
        </>
    )

    if (isAuthenticated) return (
        <>
            <button onClick = {() => showSettings (index)}>Invite</button>
        </>
    )
    
    return (
        <>
            <></>
        </>
    )
}
