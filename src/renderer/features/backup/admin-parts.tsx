import { Checkbox } from '@/components/ui/checkbox';
import { cn } from '@/lib/cn';
import type { AdminJobEvent } from '@shared/pg-backup';
import { useCallback, useEffect, useRef, useState } from 'react';

/** Label column + control, used by the admin dialogs. */
export function FormRow({
  label,
  children,
  hint,
}: {
  label: string;
  children: React.ReactNode;
  hint?: React.ReactNode;
}) {
  return (
    <div className="grid grid-cols-[120px_1fr] items-start gap-x-3 gap-y-1">
      <span className="pt-[5px] text-right text-[13px] text-[var(--wb-text-2)]">{label}</span>
      <div className="min-w-0">
        {children}
        {hint && <p className="mt-1 text-[12px] text-[var(--wb-text-3)]">{hint}</p>}
      </div>
    </div>
  );
}

export function CheckLine({
  id,
  checked,
  onChange,
  label,
  disabled,
}: {
  id: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  label: React.ReactNode;
  disabled?: boolean;
}) {
  return (
    <label
      htmlFor={id}
      className={cn(
        'flex items-center gap-2 text-[13px] text-[var(--wb-text)]',
        disabled && 'opacity-40',
      )}
    >
      <Checkbox
        id={id}
        checked={checked}
        disabled={disabled}
        onCheckedChange={(v) => onChange(v === true)}
      />
      {label}
    </label>
  );
}

/** Monospace log output that follows the tail. */
export function LogPane({ lines, className }: { lines: readonly string[]; className?: string }) {
  const ref = useRef<HTMLPreElement>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: scroll on every new line
  useEffect(() => {
    const el = ref.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [lines.length]);
  return (
    <pre
      ref={ref}
      aria-label="Log"
      className={cn(
        'h-40 overflow-auto whitespace-pre-wrap break-all rounded-[7px] bg-[var(--wb-field)] p-2 font-mono text-[11.5px] leading-[1.45] text-[var(--wb-text-2)] shadow-[inset_0_0_0_1px_var(--wb-toolbar-group-edge)]',
        className,
      )}
    >
      {lines.length === 0 ? 'Output appears here.' : lines.join('\n')}
    </pre>
  );
}

const MAX_LOG_LINES = 5000;

export interface JobState {
  running: boolean;
  log: string[];
  result: Extract<AdminJobEvent, { type: 'done' }> | null;
  command: string | null;
  error: string | null;
}

const IDLE: JobState = { running: false, log: [], result: null, command: null, error: null };

/**
 * Runs one backup / restore job and follows its pushed log events.
 * Events can arrive before the start call resolves, so any event is
 * accepted while a job is being started or is running (one at a time).
 */
export function useAdminJob() {
  const [state, setState] = useState<JobState>(IDLE);
  const jobRef = useRef<string | null>(null);
  const activeRef = useRef(false);

  useEffect(() => {
    const off = window.plasmaEvents.on('plasma:admin:jobEvent', (payload) => {
      if (!activeRef.current) return;
      const ev = payload as AdminJobEvent;
      if (jobRef.current && ev.jobId !== jobRef.current) return;
      if (ev.type === 'log') {
        setState((s) => ({ ...s, log: [...s.log, ev.text].slice(-MAX_LOG_LINES) }));
      } else {
        activeRef.current = false;
        setState((s) => ({ ...s, running: false, result: ev }));
      }
    });
    return off;
  }, []);

  const start = useCallback(async (run: () => Promise<{ jobId: string; command: string }>) => {
    activeRef.current = true;
    jobRef.current = null;
    setState({ ...IDLE, running: true });
    try {
      const { jobId, command } = await run();
      jobRef.current = jobId;
      setState((s) => ({ ...s, command }));
    } catch (err) {
      activeRef.current = false;
      setState({ ...IDLE, error: err instanceof Error ? err.message : String(err) });
    }
  }, []);

  const cancel = useCallback(() => {
    if (jobRef.current) void window.plasma.admin.cancel(jobRef.current);
  }, []);

  const reset = useCallback(() => {
    activeRef.current = false;
    jobRef.current = null;
    setState(IDLE);
  }, []);

  return { state, start, cancel, reset };
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v < 10 ? 1 : 0)} ${units[i]}`;
}
