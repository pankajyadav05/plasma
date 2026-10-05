import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { cn } from '@/lib/cn';
import { ENGINE_ICON } from '@/lib/engine-meta';
import { useSession } from '@/stores/session';
import { type ParsedConnectionUrl, parseConnectionUrl } from '@shared/connection-url';
import type { ConnectionEngine } from '@shared/protocol';
import { Link2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { ENGINE_DEFAULTS } from './connection-defaults';

interface EngineCard {
  engine: ConnectionEngine;
  label: string;
  description: string;
}

const CARDS: EngineCard[] = [
  { engine: 'postgres', label: 'PostgreSQL', description: 'Relational database with SQL.' },
  { engine: 'mysql', label: 'MySQL · MariaDB', description: 'Relational database with SQL.' },
  { engine: 'sqlite', label: 'SQLite', description: 'One file on your disk.' },
  { engine: 'clickhouse', label: 'ClickHouse', description: 'Column store for analytics.' },
  { engine: 'duckdb', label: 'DuckDB', description: 'Analytics on local files.' },
  { engine: 'redis', label: 'Redis', description: 'Key-value store and cache.' },
  { engine: 'opensearch', label: 'OpenSearch', description: 'Search and document index.' },
];

const COLUMNS = 3;

function portLabel(engine: ConnectionEngine): string {
  return engine === 'sqlite' || engine === 'duckdb'
    ? 'Local file'
    : String(ENGINE_DEFAULTS[engine].port);
}

/**
 * First step of a new connection: paste a URL, or pick an engine. The cards
 * are a radio group - arrows move, Enter or Space chooses.
 */
export function EnginePicker({
  current,
  focusNonce,
  onPickEngine,
  onPickUrl,
}: {
  /** The engine of the form being edited, when the user came back to change it. */
  current?: ConnectionEngine;
  /** Bumps to move focus to the URL field. */
  focusNonce: number;
  onPickEngine: (engine: ConnectionEngine) => void;
  onPickUrl: (parsed: ParsedConnectionUrl) => void;
}) {
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const urlRef = useRef<HTMLInputElement>(null);
  const cardRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const [active, setActive] = useState(() =>
    Math.max(
      0,
      CARDS.findIndex((c) => c.engine === current),
    ),
  );

  // biome-ignore lint/correctness/useExhaustiveDependencies: focusNonce is the trigger.
  useEffect(() => {
    urlRef.current?.focus();
  }, [focusNonce]);

  const tryUrl = (value: string) => {
    if (!value.trim()) return;
    try {
      onPickUrl(parseConnectionUrl(value));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const move = (to: number) => {
    const next = (to + CARDS.length) % CARDS.length;
    setActive(next);
    cardRefs.current[next]?.focus();
  };

  const onCardKey = (e: React.KeyboardEvent, i: number) => {
    const step: Record<string, number> = {
      ArrowRight: 1,
      ArrowDown: COLUMNS,
      ArrowLeft: -1,
      ArrowUp: -COLUMNS,
    };
    const delta = step[e.key];
    if (delta !== undefined) {
      e.preventDefault();
      const to = i + delta;
      // Vertical moves stop at the edge instead of wrapping to the far side.
      if (Math.abs(delta) === COLUMNS && (to < 0 || to >= CARDS.length)) return;
      move(to);
    } else if (e.key === 'Home') {
      e.preventDefault();
      move(0);
    } else if (e.key === 'End') {
      e.preventDefault();
      move(CARDS.length - 1);
    }
  };

  return (
    <div className="mx-auto flex w-full max-w-[720px] flex-col gap-6 px-6 py-8">
      <div className="flex flex-col gap-1">
        <h2 className="text-[20px] font-semibold text-[var(--wb-text)]">Add a connection</h2>
        <p className="text-[13px] text-[var(--wb-text-2)]">
          Paste a connection URL, or choose a database.
        </p>
      </div>

      <div className="flex flex-col gap-1">
        <Label htmlFor="conn-picker-url">Paste a connection URL</Label>
        <div className="relative">
          <Link2 className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[var(--wb-text-3)]" />
          <Input
            id="conn-picker-url"
            ref={urlRef}
            value={text}
            spellCheck={false}
            autoComplete="off"
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? 'conn-picker-url-error' : undefined}
            onChange={(e) => {
              setText(e.target.value);
              setError(null);
            }}
            onPaste={(e) => {
              const pasted = e.clipboardData.getData('text');
              if (!pasted.trim()) return;
              e.preventDefault();
              setText(pasted);
              tryUrl(pasted);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                tryUrl(text);
              } else if (e.key === 'Escape' && text === '') {
                // The field has focus when the picker opens, so Esc on an
                // empty field must still leave the screen.
                e.preventDefault();
                useSession.getState().closeDialog();
              }
            }}
            placeholder="postgres://user:password@host:5432/db"
            className="pl-7 font-mono text-[12px]"
          />
        </div>
        {error ? (
          <p
            id="conn-picker-url-error"
            role="alert"
            className="text-[12px] leading-snug text-[var(--destructive)]"
          >
            {error}
          </p>
        ) : (
          <p className="text-[12px] text-[var(--wb-text-3)]">
            postgres, mysql, mariadb, clickhouse, redis, rediss, or https for OpenSearch.
          </p>
        )}
      </div>

      <div className="flex flex-col gap-2">
        <span id="conn-engine-label" className="text-[13px] font-medium text-[var(--wb-text)]">
          Or choose a database
        </span>
        <div
          role="radiogroup"
          aria-labelledby="conn-engine-label"
          data-testid="engine-picker"
          className="grid grid-cols-3 gap-3"
        >
          {CARDS.map((card, i) => {
            const Icon = ENGINE_ICON[card.engine];
            const checked = current === card.engine;
            return (
              <button
                key={card.engine}
                ref={(el) => {
                  cardRefs.current[i] = el;
                }}
                type="button"
                // biome-ignore lint/a11y/useSemanticElements: a card is a button with radio semantics and roving focus.
                role="radio"
                aria-checked={checked}
                tabIndex={i === active ? 0 : -1}
                data-testid={`engine-${card.engine}`}
                onFocus={() => setActive(i)}
                onKeyDown={(e) => onCardKey(e, i)}
                onClick={() => onPickEngine(card.engine)}
                className={cn(
                  'group flex min-h-[112px] cursor-pointer flex-col items-start gap-1 rounded-[10px] bg-[var(--wb-sidebar)] p-3 text-left',
                  'shadow-[inset_0_0_0_1px_var(--wb-toolbar-group-edge)] transition-[transform,box-shadow] duration-150',
                  'hover:-translate-y-0.5 hover:shadow-[inset_0_0_0_1px_var(--wb-text-3)]',
                  'focus-visible:outline-none focus-visible:shadow-[inset_0_0_0_2px_var(--ring)]',
                  checked && 'shadow-[inset_0_0_0_2px_var(--ring)]',
                )}
              >
                <span className="mb-1 grid h-8 w-8 place-items-center rounded-[8px] bg-[var(--wb-control)] text-[var(--wb-text)]">
                  <Icon className="h-4 w-4" />
                </span>
                <span className="text-[13px] font-semibold text-[var(--wb-text)]">
                  {card.label}
                </span>
                <span className="text-[12px] leading-snug text-[var(--wb-text-2)]">
                  {card.description}
                </span>
                <span className="mt-auto pt-1 font-mono text-[11px] text-[var(--wb-text-3)]">
                  {portLabel(card.engine)}
                </span>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
