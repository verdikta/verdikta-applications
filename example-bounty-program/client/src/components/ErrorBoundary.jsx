import { Component } from 'react';

/**
 * App-wide error boundary.
 *
 * Before this existed, any render-time exception on a page (e.g. the bounty
 * detail page throwing once the wallet connected and a differently-shaped
 * on-chain object reached a render expression) unmounted the entire React tree
 * and left the user staring at a blank page with no clue what happened.
 *
 * This boundary catches that, keeps the rest of the app shell alive, and shows
 * the actual error message + stack so the failure is diagnosable instead of
 * silent. "Try again" re-mounts the subtree; "Reload" does a hard refresh.
 */
class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null, info: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    // Surface in the console too, with the component stack, for debugging.
    console.error('[ErrorBoundary] Caught render error:', error, info);
    this.setState({ info });
  }

  handleReset = () => {
    this.setState({ error: null, info: null });
  };

  render() {
    if (this.state.error) {
      const { error, info } = this.state;
      const message = error?.message || String(error);
      const stack = info?.componentStack || error?.stack || '';

      return (
        <div
          style={{
            maxWidth: 760,
            margin: '3rem auto',
            padding: '1.5rem',
            border: '1px solid #f5c2c7',
            background: '#fff5f5',
            borderRadius: 8,
            color: '#842029',
          }}
        >
          <h2 style={{ marginTop: 0 }}>Something went wrong on this page</h2>
          <p>
            The page hit an unexpected error and couldn’t finish loading. The rest of
            the site still works — you can try again, reload, or go back home.
          </p>
          <p style={{ fontWeight: 600, wordBreak: 'break-word' }}>{message}</p>

          <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', margin: '1rem 0' }}>
            <button className="btn btn-primary" onClick={this.handleReset}>
              Try again
            </button>
            <button className="btn btn-secondary" onClick={() => window.location.reload()}>
              Reload page
            </button>
            <a className="btn btn-secondary" href="/">
              Go home
            </a>
          </div>

          {stack && (
            <details style={{ marginTop: '0.5rem' }}>
              <summary style={{ cursor: 'pointer' }}>Technical details</summary>
              <pre
                style={{
                  whiteSpace: 'pre-wrap',
                  fontSize: '0.75rem',
                  background: '#fff',
                  border: '1px solid #f5c2c7',
                  borderRadius: 6,
                  padding: '0.75rem',
                  marginTop: '0.5rem',
                  maxHeight: 320,
                  overflow: 'auto',
                  color: '#5c1a1a',
                }}
              >
                {stack}
              </pre>
            </details>
          )}
        </div>
      );
    }

    return this.props.children;
  }
}

export default ErrorBoundary;
