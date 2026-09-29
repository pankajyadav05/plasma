import { Button } from '@/components/ui/button';
import { RotateCw } from 'lucide-react';
import { Component, type ErrorInfo, type ReactNode } from 'react';

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
      <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-[var(--wb-window)] p-8">
        <div className="w-full max-w-2xl rounded-[10px] border border-[var(--wb-toolbar-group-edge)] bg-[var(--wb-content)] text-[13px] text-[var(--wb-text)] shadow-xl">
          <header className="border-b border-[var(--wb-separator)] px-6 py-5">
            <h1 className="text-[17px] font-semibold leading-tight text-destructive" role="alert">
              Something broke.
            </h1>
            <p className="mt-1 text-[13px] text-[var(--wb-text-2)]">
              Plasma hit an unhandled error. Nothing is lost — your saved connections and query
              history are on disk.
            </p>
          </header>

          <div className="grid gap-4 px-6 py-5">
            <div className="rounded-[7px] border-l-4 border-destructive bg-[var(--wb-control)] px-4 py-3 font-mono text-[12px] text-[var(--wb-text)]">
              {this.state.error.message}
            </div>
            <details className="font-mono text-[12px] text-[var(--wb-text-2)]">
              <summary className="cursor-pointer">Stack trace</summary>
              <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-words">
                {this.state.error.stack ?? '(no stack)'}
              </pre>
            </details>
          </div>

          <footer className="flex items-center justify-end gap-2 border-t border-[var(--wb-separator)] px-6 py-3">
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
