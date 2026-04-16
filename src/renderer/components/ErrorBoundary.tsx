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
      <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-background p-8">
        <div className="w-full max-w-2xl rounded-lg border bg-card text-card-foreground shadow-lg">
          <header className="border-b px-8 py-6">
            <h1 className="font-display text-3xl italic leading-tight text-destructive">Something broke.</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              Plasma hit an unhandled error. Nothing is lost — your saved connections and query history are on disk.
            </p>
          </header>

          <div className="grid gap-4 px-8 py-6">
            <div className="rounded-md border-l-4 border-destructive bg-muted px-4 py-3 font-mono text-sm text-foreground">
              {this.state.error.message}
            </div>
            <details className="font-mono text-xs text-muted-foreground">
              <summary className="cursor-pointer">Stack trace</summary>
              <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-words">
                {this.state.error.stack ?? '(no stack)'}
              </pre>
            </details>
          </div>

          <footer className="flex items-center justify-end gap-2 border-t px-8 py-4">
            <Button variant="outline" onClick={this.copyError}>
              Copy report
            </Button>
            <Button variant="outline" onClick={this.reset}>
              Try again
            </Button>
            <Button variant="primary" onClick={this.reload}>
              <RotateCw />
              Reload
            </Button>
          </footer>
        </div>
      </div>
    );
  }
}
