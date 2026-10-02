import { Pill } from '@/components/ui/workbench';
import { cn } from '@/lib/cn';
import { useSession } from '@/stores/session';
import { Loader2, Sparkles } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';

/** True when an OpenRouter (or legacy) key is stored. */
export function useHasAiKey(): boolean {
  return useSession((s) => Boolean(s.settings.hasOpenrouterApiKey || s.settings.hasClaudeApiKey));
}

/** Shown in place of an AI entry point while no key is configured. */
export function AiKeyNotice({ className }: { className?: string }) {
  const setCanvasMode = useSession((s) => s.setCanvasMode);
  return (
    <div
      className={cn('flex items-center gap-2 text-[12px] text-[var(--wb-text-2)]', className)}
      data-testid="ai-key-notice"
    >
      <Sparkles className="h-3.5 w-3.5 shrink-0" />
      <span>Add an OpenRouter key in Settings to use AI.</span>
      <Pill onClick={() => setCanvasMode('settings')}>Open Settings</Pill>
    </div>
  );
}

export function AiThinking({ label = 'Thinking…' }: { label?: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-[12px] text-[var(--wb-text-2)]">
      <Loader2 className="h-3.5 w-3.5 animate-spin" />
      {label}
    </span>
  );
}

export type AiRunState<T> =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'done'; data: T }
  | { status: 'error'; message: string };

/**
 * Run one AI request at a time; a newer call (or unmount) cancels the
 * previous one. `fn` receives the abort signal for `runAiTask`.
 */
export function useAiRun<T>(): {
  state: AiRunState<T>;
  start(fn: (signal: AbortSignal) => Promise<T>): Promise<void>;
  reset(): void;
} {
  const [state, setState] = useState<AiRunState<T>>({ status: 'idle' });
  const ctl = useRef<AbortController | null>(null);

  useEffect(() => () => ctl.current?.abort(), []);

  const start = useCallback(async (fn: (signal: AbortSignal) => Promise<T>) => {
    ctl.current?.abort();
    const mine = new AbortController();
    ctl.current = mine;
    setState({ status: 'loading' });
    try {
      const data = await fn(mine.signal);
      if (!mine.signal.aborted) setState({ status: 'done', data });
    } catch (err) {
      if (mine.signal.aborted) return;
      setState({ status: 'error', message: err instanceof Error ? err.message : String(err) });
    }
  }, []);

  const reset = useCallback(() => {
    ctl.current?.abort();
    setState({ status: 'idle' });
  }, []);

  return { state, start, reset };
}
