import React from 'react'

/**
 * React Error Boundary — catches render errors and prevents them from
 * unmounting the entire component tree. Without this, any unhandled
 * render error in Game.js (or any page) would tear down the whole tree,
 * firing all cleanup effects (including socket.emit('left-table', ...)),
 * which can cause instant abandonment losses in tournament games.
 */
export class ErrorBoundary extends React.Component {
    constructor(props) {
        super(props)
        this.state = { hasError: false, error: null }
    }

    static getDerivedStateFromError(error) {
        return { hasError: true, error }
    }

    componentDidCatch(error, errorInfo) {
        console.error('ErrorBoundary caught:', error, errorInfo)
    }

    render() {
        if (this.state.hasError) {
            return (
                <div style={{
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'center',
                    justifyContent: 'center',
                    height: '100vh',
                    padding: '20px',
                    textAlign: 'center',
                    fontFamily: 'sans-serif',
                    color: '#ccc',
                    background: '#1a1a2e'
                }}>
                    <h2 style={{ color: '#ff4444', marginBottom: '10px' }}>Something went wrong</h2>
                    <p style={{ marginBottom: '20px', maxWidth: '400px' }}>
                        An error occurred. Your game connection is still active.
                    </p>
                    <button
                        onClick={() => this.setState({ hasError: false, error: null })}
                        style={{
                            padding: '10px 24px',
                            fontSize: '16px',
                            background: '#3a86ff',
                            color: 'white',
                            border: 'none',
                            borderRadius: '6px',
                            cursor: 'pointer',
                            marginBottom: '10px'
                        }}
                    >
                        Try Again
                    </button>
                    <button
                        onClick={() => window.location.reload()}
                        style={{
                            padding: '8px 20px',
                            fontSize: '14px',
                            background: 'transparent',
                            color: '#888',
                            border: '1px solid #555',
                            borderRadius: '6px',
                            cursor: 'pointer'
                        }}
                    >
                        Reload Page
                    </button>
                </div>
            )
        }

        return this.props.children
    }
}

export default ErrorBoundary
