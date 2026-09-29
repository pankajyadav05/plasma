import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Segmented } from '@/components/ui/workbench';
import { Pill } from '@/components/ui/workbench';
import { cleanIpcError } from '@/lib/errors';
import { ipc } from '@/lib/ipc';
import { useSession } from '@/stores/session';
import type { RedisPatternDeleteResult, RedisValueType, RedisWriteOp } from '@shared/protocol';
import { Loader2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { plural } from './redis-format';

export const FIELD_CLASS =
  'h-[26px] w-full min-w-0 rounded-[7px] border-0 bg-[var(--wb-field)] px-2.5 font-mono text-[13px] text-[var(--wb-text)] shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--wb-text)_10%,transparent)] outline-none placeholder:text-[var(--wb-text-3)] focus:shadow-[0_0_0_2px_color-mix(in_srgb,var(--wb-accent)_55%,transparent)]';

export const TEXTAREA_CLASS =
  'w-full resize-y rounded-[7px] border-0 bg-[var(--wb-field)] px-2.5 py-2 font-mono text-[13px] leading-5 text-[var(--wb-text)] shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--wb-text)_10%,transparent)] outline-none focus:shadow-[0_0_0_2px_color-mix(in_srgb,var(--wb-accent)_55%,transparent)]';

const DIALOG_CLASS = 'max-w-[460px] gap-3 bg-[var(--wb-sidebar)] p-5';

export function errMsg(err: unknown): string {
  return cleanIpcError(err instanceof Error ? err.message : String(err));
}

function Label({ children, htmlFor }: { children: React.ReactNode; htmlFor?: string }) {
  return (
    <label htmlFor={htmlFor} className="text-[12px] text-[var(--wb-text-2)]">
      {children}
    </label>
  );
}

function ErrorLine({ error }: { error: string | null }) {
  if (!error) return null;
  return (
    <div role="alert" className="break-words text-[12px] text-destructive">
      {error}
    </div>
  );
}

/**
 * Confirmation that stays open while the action runs and shows its error
 * instead of closing as if it worked (R7). With `typeToConfirm` (prod
 * connections) the user must type the given text first.
 */
export function ActionDialog({
  open,
  onOpenChange,
  title,
  description,
  children,
  confirmLabel,
  destructive = true,
  typeToConfirm,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  title: string;
  description?: React.ReactNode;
  children?: React.ReactNode;
  confirmLabel: string;
  destructive?: boolean;
  typeToConfirm?: string | null;
  /** Throw to keep the dialog open with the message. */
  onConfirm: () => Promise<void> | void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [typed, setTyped] = useState('');
  useEffect(() => {
    if (open) {
      setError(null);
      setTyped('');
    }
  }, [open]);
  const blocked = Boolean(typeToConfirm) && typed !== typeToConfirm;
  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      await onConfirm();
      onOpenChange(false);
    } catch (err) {
      setError(errMsg(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open={open} onOpenChange={(o) => !busy && onOpenChange(o)}>
      <DialogContent className={DIALOG_CLASS}>
        <DialogHeader>
          <DialogTitle className="text-[15px]">{title}</DialogTitle>
          {description && (
            <DialogDescription className="text-[12px] text-[var(--wb-text-2)]">
              {description}
            </DialogDescription>
          )}
        </DialogHeader>
        {children}
        {typeToConfirm && (
          <div className="flex flex-col gap-1">
            <Label htmlFor="redis-type-confirm">
              Production connection — type{' '}
              <span className="font-mono text-[var(--wb-text)]">{typeToConfirm}</span> to confirm
            </Label>
            <input
              id="redis-type-confirm"
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              className={FIELD_CLASS}
              autoComplete="off"
              spellCheck={false}
            />
          </div>
        )}
        <ErrorLine error={error} />
        <DialogFooter className="gap-2">
          <Pill onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Pill>
          {destructive ? (
            <Button
              size="pill"
              variant="destructive"
              onClick={() => void run()}
              disabled={busy || blocked}
            >
              {busy && <Loader2 className="animate-spin" />}
              {confirmLabel}
            </Button>
          ) : (
            <Pill onClick={() => void run()} disabled={busy || blocked}>
              {busy && <Loader2 className="animate-spin" />}
              {confirmLabel}
            </Pill>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ───────────────────────── Create key (R21) ─────────────────────────

type CreatableType = 'string' | 'hash' | 'list' | 'set' | 'zset' | 'stream' | 'json';
const CREATE_TYPES: { value: CreatableType; label: string }[] = [
  { value: 'string', label: 'String' },
  { value: 'hash', label: 'Hash' },
  { value: 'list', label: 'List' },
  { value: 'set', label: 'Set' },
  { value: 'zset', label: 'Sorted set' },
  { value: 'stream', label: 'Stream' },
  { value: 'json', label: 'JSON' },
];

export function CreateKeyDialog({
  open,
  onOpenChange,
  initialKey = '',
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  initialKey?: string;
}) {
  const db = useSession((s) => s.redisDb as number);
  const redisKeyAdded = useSession((s) => s.redisKeyAdded);
  const openRedisKey = useSession((s) => s.openRedisKey);
  const [key, setKey] = useState(initialKey);
  const [type, setType] = useState<CreatableType>('string');
  const [field, setField] = useState('');
  const [value, setValue] = useState('');
  const [score, setScore] = useState('0');
  const [ttl, setTtl] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setKey(initialKey);
      setField('');
      setValue('');
      setScore('0');
      setTtl('');
      setError(null);
    }
  }, [open, initialKey]);

  const needsField = type === 'hash' || type === 'stream';
  const ttlN = ttl.trim() ? Number(ttl) : undefined;
  const ttlBad = ttlN !== undefined && (!Number.isInteger(ttlN) || ttlN <= 0);
  const scoreN = Number(score);
  const valid =
    key.length > 0 &&
    (!needsField || field.length > 0) &&
    !ttlBad &&
    (type !== 'zset' || Number.isFinite(scoreN)) &&
    (type !== 'json' || isJson(value));

  const submit = async () => {
    setBusy(true);
    setError(null);
    const op: RedisWriteOp = {
      kind: 'createKey',
      key,
      keyType: type,
      value,
      ...(needsField ? { field } : {}),
      ...(type === 'zset' ? { score: scoreN } : {}),
      ...(ttlN ? { ttlSeconds: ttlN } : {}),
    };
    try {
      await ipc.redis.write(op, { db });
      redisKeyAdded(
        { key, type: type as RedisValueType, ttlMs: ttlN ? ttlN * 1000 : null, sizeBytes: null },
        db,
      );
      onOpenChange(false);
      openRedisKey(key, db);
    } catch (err) {
      setError(errMsg(err));
    } finally {
      setBusy(false);
    }
  };

  const valueLabel: Record<CreatableType, string> = {
    string: 'Value',
    hash: 'Value',
    list: 'First element',
    set: 'First member',
    zset: 'First member',
    stream: 'Value',
    json: 'JSON document',
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !busy && onOpenChange(o)}>
      <DialogContent className="max-w-[520px] gap-3 bg-[var(--wb-sidebar)] p-5">
        <DialogHeader>
          <DialogTitle className="text-[15px]">New key</DialogTitle>
          <DialogDescription className="text-[12px] text-[var(--wb-text-2)]">
            Created in db{db}. Fails if the key already exists.
          </DialogDescription>
        </DialogHeader>
        <form
          id="redis-create-key"
          className="flex flex-col gap-2.5"
          onSubmit={(e) => {
            e.preventDefault();
            if (valid && !busy) void submit();
          }}
        >
          <div className="flex flex-col gap-1">
            <Label htmlFor="redis-new-key">Key</Label>
            <input
              id="redis-new-key"
              // biome-ignore lint/a11y/noAutofocus: dialog opened on explicit user action
              autoFocus
              value={key}
              onChange={(e) => setKey(e.target.value)}
              placeholder="user:42:profile"
              className={FIELD_CLASS}
              spellCheck={false}
            />
          </div>
          <Segmented<CreatableType>
            ariaLabel="Key type"
            variant="track"
            value={type}
            onChange={setType}
            options={CREATE_TYPES}
          />
          {needsField && (
            <div className="flex flex-col gap-1">
              <Label htmlFor="redis-new-field">{type === 'hash' ? 'Field' : 'Entry field'}</Label>
              <input
                id="redis-new-field"
                value={field}
                onChange={(e) => setField(e.target.value)}
                className={FIELD_CLASS}
                spellCheck={false}
              />
            </div>
          )}
          {type === 'zset' && (
            <div className="flex flex-col gap-1">
              <Label htmlFor="redis-new-score">Score</Label>
              <input
                id="redis-new-score"
                value={score}
                onChange={(e) => setScore(e.target.value)}
                inputMode="decimal"
                className={FIELD_CLASS}
              />
            </div>
          )}
          <div className="flex flex-col gap-1">
            <Label htmlFor="redis-new-value">{valueLabel[type]}</Label>
            <textarea
              id="redis-new-value"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              rows={type === 'string' || type === 'json' ? 6 : 2}
              spellCheck={false}
              className={TEXTAREA_CLASS}
            />
            {type === 'json' && value && !isJson(value) && (
              <span className="text-[12px] text-destructive">Not valid JSON</span>
            )}
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor="redis-new-ttl">Expire after (seconds, optional)</Label>
            <input
              id="redis-new-ttl"
              value={ttl}
              onChange={(e) => setTtl(e.target.value)}
              inputMode="numeric"
              placeholder="no expiry"
              className={FIELD_CLASS}
            />
            {ttlBad && (
              <span className="text-[12px] text-destructive">Use a positive whole number</span>
            )}
          </div>
        </form>
        <ErrorLine error={error} />
        <DialogFooter className="gap-2">
          <Pill onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Pill>
          <Pill type="submit" form="redis-create-key" disabled={!valid || busy}>
            {busy && <Loader2 className="animate-spin" />}
            Create key
          </Pill>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function isJson(s: string): boolean {
  try {
    JSON.parse(s);
    return true;
  } catch {
    return false;
  }
}

// ───────────────────────── Rename / copy (R21) ─────────────────────────

export function RenameCopyDialog({
  open,
  onOpenChange,
  mode,
  keyName,
  db,
  onDone,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  mode: 'rename' | 'copy';
  keyName: string;
  db: number;
  onDone: (newKey: string) => void;
}) {
  const [target, setTarget] = useState('');
  const [overwrite, setOverwrite] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (open) {
      setTarget(mode === 'copy' ? `${keyName}:copy` : keyName);
      setOverwrite(false);
      setError(null);
    }
  }, [open, mode, keyName]);
  const valid = target.length > 0 && target !== keyName;
  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await ipc.redis.write({ kind: mode, key: keyName, newKey: target, overwrite }, { db });
      onDone(target);
      onOpenChange(false);
    } catch (err) {
      setError(errMsg(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open={open} onOpenChange={(o) => !busy && onOpenChange(o)}>
      <DialogContent className={DIALOG_CLASS}>
        <DialogHeader>
          <DialogTitle className="text-[15px]">
            {mode === 'rename' ? 'Rename key' : 'Duplicate key'}
          </DialogTitle>
          <DialogDescription className="text-[12px] text-[var(--wb-text-2)]">
            {mode === 'rename'
              ? 'RENAMENX — keeps the value and TTL.'
              : 'COPY — value and TTL are copied to the new key.'}
          </DialogDescription>
        </DialogHeader>
        <form
          id="redis-rename-form"
          className="flex flex-col gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (valid && !busy) void submit();
          }}
        >
          <input
            // biome-ignore lint/a11y/noAutofocus: dialog opened on explicit user action
            autoFocus
            aria-label="New key name"
            value={target}
            onChange={(e) => setTarget(e.target.value)}
            className={FIELD_CLASS}
            spellCheck={false}
          />
          <label
            htmlFor="redis-rename-overwrite"
            className="flex cursor-pointer items-center gap-2 text-[13px] text-[var(--wb-text)]"
          >
            <Checkbox
              id="redis-rename-overwrite"
              checked={overwrite}
              onCheckedChange={(v) => setOverwrite(v === true)}
            />
            Replace the destination if it exists
          </label>
        </form>
        <ErrorLine error={error} />
        <DialogFooter className="gap-2">
          <Pill onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Pill>
          {overwrite ? (
            <Button
              size="pill"
              variant="destructive"
              type="submit"
              form="redis-rename-form"
              disabled={!valid || busy}
            >
              {busy && <Loader2 className="animate-spin" />}
              {mode === 'rename' ? 'Rename and replace' : 'Copy and replace'}
            </Button>
          ) : (
            <Pill type="submit" form="redis-rename-form" disabled={!valid || busy}>
              {busy && <Loader2 className="animate-spin" />}
              {mode === 'rename' ? 'Rename' : 'Duplicate'}
            </Pill>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ───────────────────────── Delete by pattern (R26) ─────────────────────────

export function PatternDeleteDialog({
  open,
  onOpenChange,
  initialPattern,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  initialPattern: string;
}) {
  const db = useSession((s) => s.redisDb as number);
  const prod = useSession((s) => {
    const id = s.activeConfig?.id;
    return id ? s.settings.connectionTags?.[id] === 'prod' : false;
  });
  const redisKeysRemoved = useSession((s) => s.redisKeysRemoved);
  const scanRedisKeys = useSession((s) => s.scanRedisKeys);
  const refreshRedisOverview = useSession((s) => s.refreshRedisOverview);
  const [pattern, setPattern] = useState(initialPattern);
  const [preview, setPreview] = useState<RedisPatternDeleteResult | null>(null);
  const [done, setDone] = useState<RedisPatternDeleteResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [typed, setTyped] = useState('');

  useEffect(() => {
    if (open) {
      setPattern(initialPattern);
      setPreview(null);
      setDone(null);
      setError(null);
      setTyped('');
    }
  }, [open, initialPattern]);

  const run = async (dryRun: boolean) => {
    setBusy(true);
    setError(null);
    try {
      const r = await ipc.redis.deleteByPattern({ match: pattern, db, dryRun });
      if (dryRun) setPreview(r);
      else {
        setDone(r);
        redisKeysRemoved(r.sample, db);
        void refreshRedisOverview();
        void scanRedisKeys({ cursor: '0' });
      }
    } catch (err) {
      setError(errMsg(err));
    } finally {
      setBusy(false);
    }
  };

  const confirmText = prod && preview ? String(preview.matched) : null;
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (busy) void ipc.redis.cancel().catch(() => {});
        onOpenChange(o);
      }}
    >
      <DialogContent className={DIALOG_CLASS}>
        <DialogHeader>
          <DialogTitle className="text-[15px]">Delete keys matching a pattern</DialogTitle>
          <DialogDescription className="text-[12px] text-[var(--wb-text-2)]">
            SCAN MATCH in db{db}, then UNLINK in batches. Preview first — nothing is deleted until
            you confirm.
          </DialogDescription>
        </DialogHeader>
        <input
          aria-label="Key pattern"
          value={pattern}
          onChange={(e) => {
            setPattern(e.target.value);
            setPreview(null);
            setDone(null);
          }}
          className={FIELD_CLASS}
          spellCheck={false}
          disabled={busy}
        />
        {preview && !done && (
          <div className="flex flex-col gap-1 text-[12px] text-[var(--wb-text-2)]">
            <span className="text-[13px] text-[var(--wb-text)]">
              {plural(preview.matched, 'key')} match{preview.matched === 1 ? 'es' : ''}
              {preview.capped ? ' (stopped at the limit)' : ''}
            </span>
            {preview.sample.length > 0 && (
              <span className="line-clamp-3 break-all font-mono">
                {preview.sample.slice(0, 8).join('  ')}
                {preview.matched > 8 ? '  …' : ''}
              </span>
            )}
          </div>
        )}
        {done && (
          <div className="text-[13px] text-[var(--wb-text)]">
            Deleted {plural(done.deleted, 'key')}
            {done.failed > 0 ? ` · ${done.failed} failed` : ''}.
          </div>
        )}
        {confirmText && !done && preview && preview.matched > 0 && (
          <div className="flex flex-col gap-1">
            <Label htmlFor="redis-pattern-confirm">
              Production connection — type{' '}
              <span className="font-mono text-[var(--wb-text)]">{confirmText}</span> to confirm
            </Label>
            <input
              id="redis-pattern-confirm"
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              className={FIELD_CLASS}
              autoComplete="off"
            />
          </div>
        )}
        <ErrorLine error={error} />
        <DialogFooter className="gap-2">
          <Pill onClick={() => onOpenChange(false)}>{done ? 'Close' : 'Cancel'}</Pill>
          {!done &&
            (preview && preview.matched > 0 ? (
              <Button
                size="pill"
                variant="destructive"
                onClick={() => void run(false)}
                disabled={busy || (confirmText !== null && typed !== confirmText)}
              >
                {busy && <Loader2 className="animate-spin" />}
                Delete {plural(preview.matched, 'key')}
              </Button>
            ) : (
              <Pill onClick={() => void run(true)} disabled={busy || !pattern}>
                {busy && <Loader2 className="animate-spin" />}
                Preview
              </Pill>
            ))}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ───────────────────────── Pub/sub (R29 keyspace preset) ─────────────────────────

export function PubsubDialog({
  open,
  onOpenChange,
  onSubscribe,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onSubscribe: (channel: string, pattern: boolean) => void;
}) {
  const db = useSession((s) => s.redisDb as number);
  const [channel, setChannel] = useState('');
  const [pattern, setPattern] = useState(false);
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        onOpenChange(o);
        if (!o) setChannel('');
      }}
    >
      <DialogContent className="max-w-[420px] gap-3 bg-[var(--wb-sidebar)] p-5">
        <DialogHeader>
          <DialogTitle className="text-[15px]">Subscribe to a channel</DialogTitle>
          <DialogDescription className="text-[12px] text-[var(--wb-text-2)]">
            Opens a live tail tab. Use a pattern to PSUBSCRIBE to many channels.
          </DialogDescription>
        </DialogHeader>
        <form
          id="redis-pubsub-form"
          className="flex flex-col gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            const ch = channel.trim();
            if (!ch) return;
            onSubscribe(ch, pattern);
            setChannel('');
          }}
        >
          <input
            // biome-ignore lint/a11y/noAutofocus: dialog opened on explicit user action
            autoFocus
            value={channel}
            onChange={(e) => setChannel(e.target.value)}
            placeholder={pattern ? 'news:* (PSUBSCRIBE)' : 'news.alerts (SUBSCRIBE)'}
            aria-label="Channel"
            className={FIELD_CLASS}
          />
          <label
            htmlFor="redis-pubsub-pattern"
            className="flex cursor-pointer items-center gap-2 text-[13px] text-[var(--wb-text)]"
          >
            <Checkbox
              id="redis-pubsub-pattern"
              checked={pattern}
              onCheckedChange={(v) => setPattern(v === true)}
            />
            Pattern (PSUBSCRIBE)
          </label>
          <button
            type="button"
            className="self-start text-[12px] text-[var(--wb-text-2)] underline-offset-2 hover:text-[var(--wb-text)] hover:underline"
            onClick={() => {
              setChannel(`__keyspace@${db}__:*`);
              setPattern(true);
            }}
            title="Needs notify-keyspace-events on the server (e.g. CONFIG SET notify-keyspace-events KA)"
          >
            Keyspace notifications for db{db}
          </button>
        </form>
        <DialogFooter className="gap-2">
          <Pill onClick={() => onOpenChange(false)}>Cancel</Pill>
          <Pill type="submit" form="redis-pubsub-form" disabled={!channel.trim()}>
            Subscribe
          </Pill>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
