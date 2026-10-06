import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { cn } from '@/lib/cn';
import { useSession } from '@/stores/session';
import {
  ArrowUp,
  Check,
  ChevronDown,
  Database,
  Eye,
  Hand,
  Lock,
  LockOpen,
  Square,
} from 'lucide-react';
import { type KeyboardEvent, type ReactNode, useLayoutEffect, useRef } from 'react';
import { ModelPicker } from './ModelPicker';

/**
 * The Assistant's input: one rounded card holding the text area and a control
 * row (model, how views apply, row-data access, send), and under it a quiet
 * tray that says what the next message sends.
 */
export function AiComposer({
  draft,
  onDraft,
  onSubmit,
  onStop,
  pending,
  enabled,
  placeholder,
  agent,
  sends,
  context,
}: {
  draft: string;
  onDraft: (v: string) => void;
  onSubmit: () => void;
  onStop: () => void;
  pending: boolean;
  /** AI is configured (a key or a local model). */
  enabled: boolean;
  placeholder: string;
  /** SQL engines: the agent can act, so the view-apply control is shown. */
  agent: boolean;
  /** Exact "what is sent" text, also the tray's tooltip. */
  sends: string;
  /** Left side of the tray: the connection and the tab the agent sees. */
  context: string;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);

  // Grow with the text up to ~8 lines, then scroll.
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-measure on every draft change
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 168)}px`;
  }, [draft]);

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      onSubmit();
    }
  };

  const canSend = enabled && draft.trim().length > 0;

  return (
    <div className="shrink-0 px-2.5 pb-2.5 pt-1">
      <div
        className={cn(
          'relative z-[1] flex flex-col rounded-[14px] bg-[var(--wb-field)] transition-shadow duration-150',
          'shadow-[inset_0_0_0_1px_color-mix(in_oklab,var(--wb-text)_11%,transparent),0_1px_2px_color-mix(in_oklab,black_6%,transparent)]',
          'focus-within:shadow-[inset_0_0_0_1px_color-mix(in_oklab,var(--wb-accent)_55%,transparent),0_0_0_3px_color-mix(in_oklab,var(--wb-accent)_14%,transparent)]',
          !enabled && 'opacity-70',
        )}
      >
        <textarea
          ref={ref}
          value={draft}
          onChange={(e) => onDraft(e.target.value)}
          onKeyDown={onKey}
          placeholder={placeholder}
          disabled={!enabled}
          rows={2}
          aria-label="Message the assistant"
          className="min-h-[52px] w-full resize-none border-0 bg-transparent px-3.5 pb-1 pt-3 text-[13px] leading-[1.5] text-[var(--wb-text)] outline-none placeholder:text-[var(--wb-text-3)] disabled:cursor-not-allowed"
        />
        <div className="@container/controls flex min-w-0 items-center gap-0.5 px-2 pb-2">
          <div className="flex min-w-0 flex-1 items-center gap-0.5 overflow-hidden">
            <ModelPicker className="min-w-0 shrink" />
            {agent && (
              <>
                <Divider />
                <ViewsControl />
              </>
            )}
            <Divider />
            <RowDataControl />
          </div>
          {pending ? (
            <RoundButton label="Stop" onClick={onStop} tone="stop">
              <Square className="h-2.5 w-2.5 fill-current" />
            </RoundButton>
          ) : (
            <RoundButton label="Send (Enter)" onClick={onSubmit} disabled={!canSend}>
              <ArrowUp className="h-3.5 w-3.5" strokeWidth={2.4} />
            </RoundButton>
          )}
        </div>
      </div>
      <div
        className="mx-2 -mt-2 flex min-w-0 items-center gap-2 rounded-b-[10px] bg-[var(--wb-window)] px-2.5 pb-1.5 pt-3.5 text-[11px] leading-none text-[var(--wb-text-3)] shadow-[inset_0_0_0_1px_color-mix(in_oklab,var(--wb-text)_8%,transparent)]"
        data-testid="ai-what-is-sent"
        title={`Sent with the next message: ${sends}`}
      >
        <Database className="h-3 w-3 shrink-0" aria-hidden />
        <span className="min-w-0 truncate">{context}</span>
        <span className="ml-auto shrink-0 truncate">{trayRight(sends)}</span>
        <span className="sr-only">Sent: {sends}</span>
      </div>
    </div>
  );
}

/** The tray's right side: the schema and tab parts of the sends line. */
function trayRight(sends: string): string {
  const parts = sends.split(' · ');
  const schema = parts.find((p) => p.startsWith('Schema:') || p.startsWith('Overview:'));
  if (!schema) return '';
  if (schema === 'Schema: off' || schema === 'Overview: off') return 'Schema off';
  if (schema.startsWith('Overview:')) return 'Overview';
  // "Schema: 2 tables" → "2 tables", plus "+ tab" when the current tab goes too.
  const tables = schema.replace('Schema: ', '');
  return parts.includes('Current tab: sent') ? `${tables} + tab` : tables;
}

function Divider() {
  return <span aria-hidden className="mx-0.5 h-4 w-px shrink-0 bg-[var(--wb-separator)]" />;
}

function RoundButton({
  label,
  onClick,
  disabled,
  tone = 'send',
  children,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  tone?: 'send' | 'stop';
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      disabled={disabled}
      className={cn(
        'ml-1 grid h-7 w-7 shrink-0 cursor-pointer place-items-center rounded-full transition-[background-color,opacity,transform] duration-150 active:scale-95',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-[var(--wb-field)]',
        tone === 'stop'
          ? 'bg-[var(--wb-text)] text-[var(--wb-field)] hover:opacity-85'
          : 'bg-[var(--wb-accent-fill)] text-white hover:brightness-110',
        'disabled:cursor-default disabled:bg-[var(--wb-control)] disabled:text-[var(--wb-text-3)] disabled:hover:brightness-100 disabled:active:scale-100',
      )}
    >
      {children}
    </button>
  );
}

/** A quiet control-row chip that opens a small menu. */
function Chip({
  icon,
  label,
  ariaLabel,
  children,
  testId,
}: {
  icon: ReactNode;
  label: string;
  ariaLabel: string;
  children: ReactNode;
  testId?: string;
}) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={ariaLabel}
          title={label}
          data-testid={testId}
          className={cn(
            'inline-flex h-6 shrink-0 items-center gap-1.5 rounded-[6px] px-1.5 text-[12px] leading-none text-[var(--wb-text-2)] transition-colors duration-100',
            'hover:bg-[var(--wb-control-hover)] hover:text-[var(--wb-text)]',
            'data-[state=open]:bg-[var(--wb-control)] data-[state=open]:text-[var(--wb-text)]',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
          )}
        >
          <span className="shrink-0 [&_svg]:h-3.5 [&_svg]:w-3.5">{icon}</span>
          {/* Narrow panel: icon only (the tooltip and aria-label still say it). */}
          <span className="hidden min-w-0 truncate @[400px]/controls:inline">{label}</span>
          <ChevronDown
            className="hidden h-3 w-3 shrink-0 opacity-70 @[400px]/controls:block"
            aria-hidden
          />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" side="top" className="w-[280px] p-1.5">
        {children}
      </PopoverContent>
    </Popover>
  );
}

function Option({
  selected,
  title,
  detail,
  onSelect,
  icon,
}: {
  selected: boolean;
  title: string;
  detail: string;
  onSelect: () => void;
  icon: ReactNode;
}) {
  return (
    <button
      type="button"
      role="menuitemradio"
      aria-checked={selected}
      onClick={onSelect}
      className={cn(
        'flex w-full cursor-pointer items-start gap-2.5 rounded-[6px] px-2 py-1.5 text-left transition-colors duration-100',
        'hover:bg-[var(--wb-control-hover)] focus-visible:bg-[var(--wb-control-hover)] focus-visible:outline-none',
      )}
    >
      <span className="mt-0.5 shrink-0 text-[var(--wb-text-2)] [&_svg]:h-3.5 [&_svg]:w-3.5">
        {icon}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-[13px] text-[var(--wb-text)]">{title}</span>
        <span className="mt-0.5 block text-[11.5px] leading-snug text-[var(--wb-text-3)]">
          {detail}
        </span>
      </span>
      <Check
        aria-hidden
        className={cn(
          'mt-0.5 h-3.5 w-3.5 shrink-0 text-[var(--wb-accent-text)]',
          !selected && 'invisible',
        )}
      />
    </button>
  );
}

/** How the agent's view changes (columns, sort, filters, rows) apply. */
function ViewsControl() {
  const auto = useSession((s) => s.settings.aiAutoApplyViews === true);
  const updateSettings = useSession((s) => s.updateSettings);
  return (
    <Chip
      icon={auto ? <Eye /> : <Hand />}
      label={auto ? 'Views: apply' : 'Views: ask'}
      ariaLabel={`View changes: ${auto ? 'applied at once' : 'ask first'}. Change`}
      testId="ai-views-control"
    >
      <div role="menu" aria-label="View changes">
        <Option
          selected={!auto}
          icon={<Hand />}
          title="Ask first"
          detail="The agent shows a card. Nothing changes until you approve it."
          onSelect={() => void updateSettings({ aiAutoApplyViews: false })}
        />
        <Option
          selected={auto}
          icon={<Eye />}
          title="Apply view changes at once"
          detail="Columns, sort, filters and row count change right away, with Undo. Queries and data changes still ask."
          onSelect={() => void updateSettings({ aiAutoApplyViews: true })}
        />
      </div>
    </Chip>
  );
}

/** Per-connection opt-in: may tool results and query results carry rows to the model? */
function RowDataControl() {
  const id = useSession((s) => s.activeConfig?.id ?? null);
  const name = useSession((s) => s.activeConfig?.name ?? 'this connection');
  const prod = useSession((s) => (id ? s.settings.connectionTags?.[id] === 'prod' : false));
  const map = useSession((s) => s.settings.connectionAiRowData);
  const on = id ? map?.[id] === true : false;
  const updateSettings = useSession((s) => s.updateSettings);
  const set = (v: boolean) => {
    if (!id) return;
    void updateSettings({ connectionAiRowData: { ...(map ?? {}), [id]: v } });
  };
  return (
    <Chip
      icon={on ? <LockOpen /> : <Lock />}
      label={on ? 'Row data on' : 'Row data off'}
      ariaLabel={`Row data for the AI: ${on ? 'on' : 'off'} for ${name}. Change`}
      testId="ai-rowdata-control"
    >
      <div role="menu" aria-label="Row data">
        <Option
          selected={!on}
          icon={<Lock />}
          title="Names only"
          detail="The AI sees table and column names, never the values in your rows."
          onSelect={() => set(false)}
        />
        <Option
          selected={on}
          icon={<LockOpen />}
          title="Let the AI read rows"
          detail={`Results of the agent's queries go to the model, masked and capped at 50 rows. Only for ${name}.`}
          onSelect={() => set(true)}
        />
        {prod && (
          <p className="mx-2 mb-1 mt-1.5 rounded-[6px] bg-[color-mix(in_oklab,var(--status-warn)_14%,transparent)] px-2 py-1.5 text-[11.5px] leading-snug text-[var(--wb-text)]">
            This connection is tagged production. Turning this on also sends its schema names.
          </p>
        )}
      </div>
    </Chip>
  );
}
