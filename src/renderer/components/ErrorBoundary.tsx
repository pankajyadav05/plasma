import { Component, type ErrorInfo, type ReactNode } from 'react';
import { RotateCw } from 'lucide-react';
import { Button } from '@/components/ui/button';

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
  info: ErrorInfo | null;
}

/**
 * Top-level React error boundary. Shows a Paper-themed crash screen
 * instead of leaving the window blank on an uncaught render error.
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null, info: null };

  static getDerivedStateFromError(error: Error): State {
    return { error, info: null };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // eslint-disable-next-line no-console
    console.error('[plasma] uncaught error boundary:', error, info);
    this.setState({ info });
  }

  reset = () => {
    this.setState({ error: null, info: null });
  };

  reload = () => {
    window.location.reload();
  };

  copyError = () => {
    const text = [
      'Plasma crash report',
      `When: ${new Date().toISOString()}`,
      `Platform: ${window.plasma?.platform ?? 'unknown'}`,
      '',
      `Error: ${this.state.error?.message ?? 'unknown'}`,
      '',
      'Stack:',
      this.state.error?.stack ?? '(no stack)',
      '',
      'Component stack:',
      this.state.info?.componentStack ?? '(no component stack)',
    ].join('\n');
    void navigator.clipboard?.writeText(text);
  };

  render() {
    if (!this.state.error) return this.props.children;

    return (
      <div
        className="fixed inset-0 z-[9999] flex items-center justify-center bg-paper p-8"
        style={{ fontFamily: '"DM Sans", system-ui, sans-serif' }}
      >
        <div className="w-full max-w-2xl border-2 border-border-strong bg-paper-canvas shadow-offset-lg">
          <header className="border-b-2 border-border-strong px-8 py-6">
            <h1
              className="font-display text-2xl italic leading-tight text-accent"
              style={{ fontWeight: 500 }}
            >
              Something broke.
            </h1>
            <p className="font-display text-base italic text-ink-muted">
              Plasma hit an unhandled error. Nothing is lost — your saved
              connections and query history are on disk.
            </p>
          </header>

          <div className="grid gap-4 px-8 py-6">
            <div className="border-l-[3px] border-accent bg-[var(--bg-hover)] px-4 py-2 font-mono text-sm text-ink">
              {this.state.error.message}
            </div>
            <details className="font-mono text-xs text-ink-2">
              <summary className="cursor-pointer">stack trace</summary>
              <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-words">
                {this.state.error.stack ?? '(no stack)'}
              </pre>
            </details>
          </div>

          <footer className="flex items-center justify-end gap-3 border-t-2 border-border-strong px-8 py-5">
            <Button variant="secondary" onClick={this.copyError}>
              Copy report
            </Button>
            <Button variant="secondary" onClick={this.reset}>
              Try again
            </Button>
            <Button variant="primary" size="lg" onClick={this.reload}>
              <RotateCw />
              Reload
            </Button>
          </footer>
        </div>
      </div>
    );
  }
}
