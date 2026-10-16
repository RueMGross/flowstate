import { Component, type ReactNode } from 'react';

interface P {
  children: ReactNode;
  /** what could not be displayed ("inspector", "population tree") */
  label: string;
  /** a small message instead of the full panel (side panels, ribbon, tabs) */
  compact?: boolean;
  /** when this value changes (e.g. the workspace after Undo), the part is tried again */
  resetKey?: unknown;
  /** what to show instead (default: a message with "Try again") */
  fallback?: (error: Error, retry: () => void) => ReactNode;
}

interface S {
  error: Error | null;
  key: unknown;
}

/**
 * Keeps an error in one part of the interface (a damaged item, a bug) from blanking the whole app: the part shows
 * what failed and can be tried again; the rest of the app keeps working.
 */
export class ErrorBoundary extends Component<P, S> {
  state: S = { error: null, key: undefined };
  static getDerivedStateFromError(error: Error): Partial<S> {
    return { error };
  }
  static getDerivedStateFromProps(p: P, s: S): Partial<S> | null {
    // another workspace (undo, a file opened): try again
    if (p.resetKey !== s.key) return { key: p.resetKey, error: null };
    return null;
  }
  componentDidCatch(error: Error) {
    console.error(error);
  }
  render() {
    const err = this.state.error;
    if (!err) return this.props.children;
    const msg = String(err?.message ?? err);
    if (this.props.fallback) return this.props.fallback(err, () => this.setState({ error: null }));
    if (this.props.compact)
      return (
        <div className="boundary-compact" role="alert" style={{ padding: '6px 8px', fontSize: 12 }}>
          <span>The {this.props.label} could not be displayed ({msg.slice(0, 120)}). </span>
          <button className="btn xs" onClick={() => this.setState({ error: null })}>
            Try again
          </button>
        </div>
      );
    return (
      <div style={{ padding: 24, maxWidth: 560 }} role="alert">
        <h3 style={{ marginTop: 0 }}>The {this.props.label} could not be displayed</h3>
        <p className="hint" style={{ fontFamily: 'var(--font-mono)', whiteSpace: 'pre-wrap' }}>{msg}</p>
        <p>Your workspace is still intact. Undo the last step (Ctrl+Z) or try again.</p>
        <button className="btn primary" onClick={() => this.setState({ error: null })}>
          Try again
        </button>
      </div>
    );
  }
}
