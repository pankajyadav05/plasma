import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Badge } from '@/components/ui/view-parts';
import { IconButton, MenuItem, Pill } from '@/components/ui/workbench';
import {
  SidebarEmpty,
  SidebarSearch,
  SidebarSearchRow,
  sidebarRowClass,
} from '@/features/sidebar/sidebar-parts';
import { cn } from '@/lib/cn';
import { useSession } from '@/stores/session';
import type { RedisBulkDeleteResult, RedisKeyMeta, RedisValueType } from '@shared/protocol';
import { keyeventPattern } from '@shared/redis-keyspace';
import {
  Activity,
  CheckSquare,
  ChevronDown,
  ChevronRight,
  Clock,
  Copy,
  Filter,
  KeyRound,
  Loader2,
  MoreHorizontal,
  Plus,
  Radio,
  RefreshCw,
  Server,
  SlidersHorizontal,
  Square,
  Terminal,
  Trash2,
  X,
} from 'lucide-react';
import { useMemo, useState } from 'react';
import { ActionDialog, CreateKeyDialog, PatternDeleteDialog, PubsubDialog } from './redis-dialogs';
import { formatTtlShort, globEscape, naturalCompare, plural } from './redis-format';
import { useRedisWriteGate } from './use-redis-write';

/**
 * Redis sidebar — keyspace browser, laid out like the Postgres items list.
 *
 *   1. Header: "Redis <version>" + database switcher (R20) + refresh
 *   2. SCAN MATCH search (Enter to scan) + a sliders menu holding the
 *      tool launchers, type filter, new key / pattern delete / bulk select
 *   3. Prefix tree of keys (24px rows, natural order, type badges, TTL)
 *   4. Bottom bar: loaded / total count + "Load more keys" while SCAN isn't done
 *
 * Write affordances follow the S1 policy: only with edit mode on and a
 * writable connection (`useRedisWriteGate`).
 */

interface KeyTreeNode {
  /** The token at this depth (e.g. "user", "42", "profile"). */
  token: string;
  /** Full key path if this node is itself a key, else null. */
  fullKey: string | null;
  meta: RedisKeyMeta | null;
  children: Map<string, KeyTreeNode>;
  /** Number of keys at or below this node. */
  keyCount: number;
}

const SEPARATOR = ':';

/** Build the prefix tree. Duplicate keys (SCAN may repeat) are counted once (R30). */
export function buildTree(keys: RedisKeyMeta[]): KeyTreeNode {
  const root: KeyTreeNode = {
    token: '',
    fullKey: null,
    meta: null,
    children: new Map(),
    keyCount: 0,
  };
  const seen = new Set<string>();
  for (const k of keys) {
    if (seen.has(k.key)) continue;
    seen.add(k.key);
    const parts = k.key.split(SEPARATOR);
    let cur = root;
    cur.keyCount++;
    for (const tok of parts) {
      let next = cur.children.get(tok);
      if (!next) {
        next = { token: tok, fullKey: null, meta: null, children: new Map(), keyCount: 0 };
        cur.children.set(tok, next);
      }
      next.keyCount++;
      cur = next;
    }
    cur.fullKey = k.key;
    cur.meta = k;
  }
  return root;
}

/** Children in natural order (F11): groups and keys interleaved by token. */
function sortedChildren(node: KeyTreeNode): KeyTreeNode[] {
  return [...node.children.values()].sort((a, b) => naturalCompare(a.token, b.token));
}

const TYPE_LABEL: Record<RedisValueType, string> = {
  string: 'str',
  list: 'list',
  set: 'set',
  zset: 'zset',
  hash: 'hash',
  stream: 'stream',
  json: 'json',
  none: 'none',
  unknown: '?',
};

const TYPE_FILTERS: { value: string | null; label: string }[] = [
  { value: null, label: 'All types' },
  { value: 'string', label: 'Strings' },
  { value: 'hash', label: 'Hashes' },
  { value: 'list', label: 'Lists' },
  { value: 'set', label: 'Sets' },
  { value: 'zset', label: 'Sorted sets' },
  { value: 'stream', label: 'Streams' },
  { value: 'ReJSON-RL', label: 'JSON' },
];

export function RedisSidebar() {
  const overview = useSession((s) => s.redisOverview);
  const keys = useSession((s) => s.redisKeys);
  const loading = useSession((s) => s.redisLoading);
  const scanning = useSession((s) => s.redisScanning as boolean);
  const redisError = useSession((s) => s.redisError as string | null);
  const matchInput = useSession((s) => s.redisMatch);
  const db = useSession((s) => s.redisDb as number);
  const typeFilter = useSession((s) => s.redisTypeFilter as string | null);
  const setRedisMatch = useSession((s) => s.setRedisMatch);
  const setRedisDb = useSession((s) => s.setRedisDb);
  const setRedisTypeFilter = useSession((s) => s.setRedisTypeFilter);
  const scanRedisKeys = useSession((s) => s.scanRedisKeys);
  const refreshRedisOverview = useSession((s) => s.refreshRedisOverview);
  const openRedisKey = useSession((s) => s.openRedisKey);
  const openRedisCli = useSession((s) => s.openRedisCli);
  const openRedisAnalyze = useSession((s) => s.openRedisAnalyze);
  const openRedisSlowlog = useSession((s) => s.openRedisSlowlog);
  const openRedisServer = useSession((s) => s.openRedisServer);
  const openRedisPubsub = useSession((s) => s.openRedisPubsub);
  const activeRedisKey = useSession((s) => s.activeRedisKey);
  const bulkMode = useSession((s) => s.redisBulkMode);
  const selectedKeys = useSession((s) => s.selectedRedisKeys);
  const toggleBulkMode = useSession((s) => s.toggleRedisBulkMode);
  const toggleKeyChecked = useSession((s) => s.toggleRedisKeyChecked);
  const bulkDelete = useSession((s) => s.bulkDeleteSelectedRedisKeys);
  const { canWrite, prod, reason } = useRedisWriteGate();

  const [match, setMatch] = useState(matchInput ?? '');
  const [menuOpen, setMenuOpen] = useState(false);
  const [dbOpen, setDbOpen] = useState(false);
  const [pubsubOpen, setPubsubOpen] = useState(false);
  const [confirmBulk, setConfirmBulk] = useState(false);
  const [bulkResult, setBulkResult] = useState<RedisBulkDeleteResult | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [createPrefix, setCreatePrefix] = useState('');
  const [patternDelete, setPatternDelete] = useState<string | null>(null);

  const tree = useMemo(() => buildTree(keys?.keys ?? []), [keys]);
  const dbTotal = useMemo(() => {
    if (!overview) return null;
    // R15: the count for the db being browsed, not the sum of all dbs.
    return overview.keyspace.find((k) => k.db === db)?.keys ?? 0;
  }, [overview, db]);

  const submitMatch = (raw: string) => {
    const trimmed = raw.trim();
    setRedisMatch(trimmed.length > 0 ? trimmed : null);
  };

  // Continuation always uses the submitted pattern the cursor belongs to (R8).
  const onLoadMore = () => {
    if (!keys) return;
    void scanRedisKeys({ cursor: keys.cursor });
  };

  const onRefresh = () => {
    void refreshRedisOverview();
    void scanRedisKeys({ cursor: '0' });
  };

  const runMenu = (fn: () => void) => {
    setMenuOpen(false);
    fn();
  };

  const loaded = keys?.keys.length ?? 0;
  const scanDone = !keys || keys.cursor === '0';
  const dbCount = overview?.dbCount ?? 16;
  const dbKeys = new Map((overview?.keyspace ?? []).map((k) => [k.db, k.keys]));

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <div className="flex h-9 shrink-0 items-center gap-1.5 pl-4 pr-2.5">
        <div className="flex min-w-0 flex-1 items-baseline gap-1.5">
          <span className="shrink-0 text-[13px] font-semibold text-[var(--wb-text)]">Redis</span>
          <span
            className="truncate text-[11px] text-[var(--wb-text-2)]"
            title={
              overview
                ? `${overview.redisVersion} · ${overview.role} · ${overview.mode}`
                : undefined
            }
          >
            {overview ? `${overview.redisVersion} · ${overview.role}` : 'connecting…'}
          </span>
        </div>
        <Popover open={dbOpen} onOpenChange={setDbOpen}>
          <PopoverTrigger asChild>
            <button
              type="button"
              aria-label={`Database db${db} — switch database`}
              title="Switch database (SELECT)"
              disabled={dbCount <= 1}
              className="flex h-6 shrink-0 items-center gap-0.5 rounded-[6px] px-1.5 font-mono text-[12px] text-[var(--wb-text)] hover:bg-[var(--wb-control-hover)] disabled:opacity-60"
            >
              db{db}
              {dbCount > 1 && <ChevronDown className="h-3 w-3 text-[var(--wb-text-2)]" />}
            </button>
          </PopoverTrigger>
          <PopoverContent
            align="end"
            sideOffset={4}
            className="max-h-[360px] w-[180px] overflow-y-auto p-1"
            role="menu"
            aria-label="Databases"
          >
            {Array.from({ length: dbCount }, (_, i) => i).map((i) => (
              <MenuItem
                key={i}
                label={<span className="font-mono">db{i}</span>}
                hint={dbKeys.has(i) ? plural(dbKeys.get(i)!, 'key') : 'empty'}
                checked={i === db}
                onClick={() => {
                  setDbOpen(false);
                  if (i !== db) setRedisDb(i);
                }}
              />
            ))}
          </PopoverContent>
        </Popover>
        <IconButton
          variant="plain"
          label="Refresh keys"
          title="Refresh"
          onClick={onRefresh}
          disabled={loading}
        >
          {loading ? <Loader2 className="animate-spin" /> : <RefreshCw />}
        </IconButton>
      </div>

      {/* SCAN MATCH + tools menu */}
      <SidebarSearchRow>
        <form
          className="flex min-w-0 flex-1"
          onSubmit={(e) => {
            e.preventDefault();
            submitMatch(match);
          }}
        >
          <SidebarSearch
            value={match}
            onChange={(v) => {
              setMatch(v);
              // The field's clear button (or erasing everything) resets the scan.
              if (v === '' && matchInput) submitMatch('');
            }}
            placeholder="MATCH pattern, e.g. user:*…"
            ariaLabel="Scan keys matching pattern (Enter to scan)"
          />
        </form>
        <Popover open={menuOpen} onOpenChange={setMenuOpen}>
          <PopoverTrigger asChild>
            <IconButton
              variant="plain"
              label="Redis tools"
              active={bulkMode || typeFilter !== null}
              className="[&_svg]:h-4 [&_svg]:w-4"
            >
              <SlidersHorizontal />
            </IconButton>
          </PopoverTrigger>
          <PopoverContent align="end" sideOffset={4} className="w-[240px] p-1" role="menu">
            <MenuItem icon={<Terminal />} label="redis-cli" onClick={() => runMenu(openRedisCli)} />
            <MenuItem
              icon={<Server />}
              label="Server info"
              onClick={() => runMenu(openRedisServer)}
            />
            <MenuItem
              icon={<Activity />}
              label="Memory analyzer"
              onClick={() => runMenu(openRedisAnalyze)}
            />
            <MenuItem icon={<Clock />} label="Slowlog" onClick={() => runMenu(openRedisSlowlog)} />
            <MenuItem
              icon={<Radio />}
              label="Pub/sub subscribe…"
              onClick={() => runMenu(() => setPubsubOpen(true))}
            />
            <MenuItem
              icon={<Radio />}
              label="Keyspace events tail"
              onClick={() => runMenu(() => openRedisPubsub(keyeventPattern(db), true))}
            />
            <div className="my-1 h-px bg-[var(--wb-separator)]" />
            {TYPE_FILTERS.map((t) => (
              <MenuItem
                key={t.label}
                icon={t.value === null ? <Filter /> : undefined}
                label={t.label}
                checked={typeFilter === t.value}
                onClick={() => runMenu(() => setRedisTypeFilter(t.value))}
              />
            ))}
            <div className="my-1 h-px bg-[var(--wb-separator)]" />
            <MenuItem
              icon={<Plus />}
              label="New key…"
              hint={canWrite ? undefined : 'edit mode'}
              disabled={!canWrite}
              onClick={() =>
                runMenu(() => {
                  setCreatePrefix('');
                  setCreateOpen(true);
                })
              }
            />
            <MenuItem
              icon={<Trash2 />}
              label="Delete keys matching…"
              disabled={!canWrite}
              onClick={() => runMenu(() => setPatternDelete(matchInput ?? ''))}
            />
            <MenuItem
              icon={<CheckSquare />}
              label="Bulk select"
              checked={bulkMode}
              disabled={!canWrite && !bulkMode}
              onClick={() => runMenu(toggleBulkMode)}
            />
            <MenuItem
              icon={<RefreshCw />}
              label="Rescan keyspace"
              onClick={() => runMenu(onRefresh)}
            />
          </PopoverContent>
        </Popover>
      </SidebarSearchRow>

      {typeFilter && (
        <div className="flex h-6 shrink-0 items-center gap-1.5 px-4 text-[12px] text-[var(--wb-text-2)]">
          <Filter className="h-3 w-3" />
          <span className="flex-1 truncate">
            {TYPE_FILTERS.find((t) => t.value === typeFilter)?.label ?? typeFilter} only
          </span>
          <IconButton
            variant="plain"
            label="Clear type filter"
            onClick={() => setRedisTypeFilter(null)}
          >
            <X />
          </IconButton>
        </div>
      )}

      {/* Bulk-mode strip */}
      {bulkMode && (
        <div className="flex h-7 shrink-0 items-center gap-1.5 px-4 pb-1 text-[12px] text-[var(--wb-text-2)]">
          <span className="flex-1 truncate">{selectedKeys.size.toLocaleString()} selected</span>
          <IconButton
            variant="plain"
            label="Delete selected"
            title={reason ?? 'Delete selected keys'}
            onClick={() => setConfirmBulk(true)}
            disabled={selectedKeys.size === 0 || !canWrite}
            className="text-destructive hover:text-destructive"
          >
            <Trash2 />
          </IconButton>
          <Pill onClick={toggleBulkMode} aria-label="Toggle bulk select" title="Toggle bulk select">
            Done
          </Pill>
        </div>
      )}

      {redisError && (
        <div
          role="alert"
          className="mx-2.5 mb-1 flex shrink-0 items-start gap-1.5 rounded-[6px] bg-[color-mix(in_srgb,var(--destructive)_14%,transparent)] px-2 py-1 text-[12px] text-[var(--wb-text)]"
        >
          <span className="min-w-0 flex-1 break-words">{redisError}</span>
          <button type="button" className="shrink-0 underline" onClick={onRefresh}>
            Retry
          </button>
        </div>
      )}

      {/* Key tree */}
      <div className="min-h-0 flex-1 overflow-y-auto pb-1">
        {!keys && (scanning || loading) && (
          <SidebarEmpty title={matchInput ? 'Searching…' : 'Scanning…'} />
        )}
        {keys && keys.keys.length === 0 && !scanDone && (
          // F10: an empty page mid-keyspace is not "no match".
          <SidebarEmpty
            title={scanning ? 'Searching…' : 'No matches yet'}
            hint={
              scanning
                ? `MATCH ${matchInput ?? '*'}`
                : 'Only part of the keyspace was scanned — keep searching.'
            }
          />
        )}
        {keys && keys.keys.length === 0 && scanDone && (
          <SidebarEmpty
            title="No keys match"
            hint={
              matchInput || typeFilter
                ? [matchInput && `MATCH ${matchInput}`, typeFilter && `TYPE ${typeFilter}`]
                    .filter(Boolean)
                    .join(' · ')
                : `db${db} is empty.`
            }
          />
        )}
        {keys && keys.keys.length > 0 && (
          <ul role="tree" aria-label="Redis keys" aria-multiselectable={bulkMode || undefined}>
            {sortedChildren(tree).map((node) => (
              <TreeNode
                key={node.token}
                node={node}
                depth={0}
                pathPrefix=""
                activeKey={activeRedisKey}
                onOpen={openRedisKey}
                bulkMode={bulkMode}
                checked={selectedKeys}
                onToggleChecked={toggleKeyChecked}
                partial={!scanDone}
                canWrite={canWrite}
                onFilterPrefix={(p) => {
                  const pattern = `${globEscape(p)}${SEPARATOR}*`;
                  setMatch(pattern);
                  setRedisMatch(pattern);
                }}
                onDeletePrefix={(p) => setPatternDelete(`${globEscape(p)}${SEPARATOR}*`)}
                onNewUnder={(p) => {
                  setCreatePrefix(`${p}${SEPARATOR}`);
                  setCreateOpen(true);
                }}
              />
            ))}
          </ul>
        )}
      </div>

      {/* Bottom bar: loaded count + pagination (R33: the count lives here) */}
      {keys && (
        <div className="flex h-9 shrink-0 items-center gap-2 border-t border-[var(--wb-separator)] pl-4 pr-2.5">
          <span className="min-w-0 flex-1 truncate text-[11px] tabular-nums text-[var(--wb-text-2)]">
            {scanDone || matchInput || typeFilter
              ? plural(loaded, 'key')
              : `${loaded.toLocaleString()}${dbTotal !== null ? ` of ${dbTotal.toLocaleString()}` : ''} keys`}
            {!scanDone && (matchInput || typeFilter) ? ' so far' : ''}
          </span>
          {!scanDone && (
            <Pill onClick={onLoadMore} disabled={loading}>
              {loading ? <Loader2 className="animate-spin" /> : <Plus />}
              {loading
                ? 'Searching…'
                : matchInput || typeFilter
                  ? 'Keep searching'
                  : 'Load more keys'}
            </Pill>
          )}
          {canWrite && (
            <IconButton
              variant="plain"
              label="New key"
              title="New key…"
              onClick={() => {
                setCreatePrefix('');
                setCreateOpen(true);
              }}
            >
              <Plus />
            </IconButton>
          )}
        </div>
      )}

      <PubsubDialog
        open={pubsubOpen}
        onOpenChange={setPubsubOpen}
        onSubscribe={(channel, pattern) => {
          openRedisPubsub(channel, pattern);
          setPubsubOpen(false);
        }}
      />

      <CreateKeyDialog open={createOpen} onOpenChange={setCreateOpen} initialKey={createPrefix} />

      <PatternDeleteDialog
        open={patternDelete !== null}
        onOpenChange={(o) => !o && setPatternDelete(null)}
        initialPattern={patternDelete ?? ''}
      />

      <ActionDialog
        open={confirmBulk}
        onOpenChange={setConfirmBulk}
        title={`Delete ${plural(selectedKeys.size, 'key')}?`}
        description={`UNLINK in db${db} — this cannot be undone.`}
        confirmLabel="Delete all"
        typeToConfirm={prod ? String(selectedKeys.size) : null}
        onConfirm={async () => {
          const res = await bulkDelete();
          if (res.failed.length > 0) setBulkResult(res);
        }}
      />

      <ActionDialog
        open={bulkResult !== null}
        onOpenChange={(o) => !o && setBulkResult(null)}
        title={`${plural(bulkResult?.failed.length ?? 0, 'key')} could not be deleted`}
        description={`${plural(bulkResult?.deleted.length ?? 0, 'key')} deleted. The failed keys stay selected.`}
        confirmLabel="OK"
        destructive={false}
        onConfirm={() => {}}
      >
        <ul className="max-h-40 overflow-y-auto font-mono text-[12px] text-[var(--wb-text-2)]">
          {bulkResult?.failed.slice(0, 50).map((f) => (
            <li key={f.key} className="break-all">
              {f.key} — {f.error}
            </li>
          ))}
        </ul>
      </ActionDialog>
    </div>
  );
}

function TreeNode({
  node,
  depth,
  pathPrefix,
  activeKey,
  onOpen,
  bulkMode,
  checked,
  onToggleChecked,
  partial,
  canWrite,
  onFilterPrefix,
  onDeletePrefix,
  onNewUnder,
}: {
  node: KeyTreeNode;
  depth: number;
  pathPrefix: string;
  activeKey: string | null;
  onOpen: (key: string) => void;
  bulkMode: boolean;
  checked: Set<string>;
  onToggleChecked: (key: string) => void;
  /** SCAN not finished: folder counts are lower bounds ("171+", F11). */
  partial: boolean;
  canWrite: boolean;
  onFilterPrefix: (prefix: string) => void;
  onDeletePrefix: (prefix: string) => void;
  onNewUnder: (prefix: string) => void;
}) {
  // Only the top level starts expanded so deep namespaces like
  // `feed:user:42:posts:99:cache` don't blow out the sidebar height.
  const [open, setOpen] = useState(depth < 1);
  const [menuOpen, setMenuOpen] = useState(false);
  const hasChildren = node.children.size > 0;
  const isKey = node.fullKey !== null;
  const fullPath = pathPrefix ? `${pathPrefix}${SEPARATOR}${node.token}` : node.token;
  const isActive = isKey && activeKey === node.fullKey;
  const isChecked = node.fullKey !== null && checked.has(node.fullKey);
  const meta = node.meta;
  const count = `${node.keyCount.toLocaleString()}${partial ? '+' : ''}`;
  // Chevron column (12px) + 12px indent per level, inside the row's px-1.
  const indent = { paddingLeft: 4 + depth * 12 };

  const activate = () => {
    if (isKey && node.fullKey) {
      if (bulkMode) onToggleChecked(node.fullKey);
      else onOpen(node.fullKey);
    } else {
      setOpen((v) => !v);
    }
  };

  const label = isKey ? (node.fullKey ?? fullPath) : `${fullPath}${SEPARATOR}* (${count} keys)`;

  const copy = (text: string) => {
    void navigator.clipboard?.writeText(text);
    setMenuOpen(false);
  };

  return (
    <li
      role="treeitem"
      aria-label={label}
      aria-level={depth + 1}
      aria-selected={bulkMode ? isChecked : isActive}
      aria-expanded={hasChildren ? open : undefined}
    >
      <Popover open={menuOpen} onOpenChange={setMenuOpen}>
        <div
          className={cn(sidebarRowClass(isActive || (bulkMode && isChecked)), 'group/row pr-1')}
          style={indent}
          onContextMenu={(e) => {
            e.preventDefault();
            setMenuOpen(true);
          }}
        >
          {/* Chevron column — toggles groups (also for keys that are a prefix of others). */}
          {hasChildren ? (
            <button
              type="button"
              tabIndex={-1}
              aria-hidden
              onClick={() => setOpen((v) => !v)}
              className="grid h-full w-3.5 shrink-0 place-items-center text-[var(--wb-text-2)]"
            >
              <ChevronRight className={cn('h-3 w-3 transition-transform', open && 'rotate-90')} />
            </button>
          ) : (
            <span className="w-3.5 shrink-0" />
          )}
          <button
            type="button"
            onClick={activate}
            title={isKey ? (node.fullKey ?? undefined) : `${fullPath}${SEPARATOR}*`}
            className="flex h-full min-w-0 flex-1 cursor-default items-center gap-1.5 pl-0.5 text-left outline-none focus-visible:underline"
          >
            {isKey ? (
              bulkMode ? (
                isChecked ? (
                  <CheckSquare className="h-3.5 w-3.5 shrink-0 text-[var(--wb-text)]" />
                ) : (
                  <Square className="h-3.5 w-3.5 shrink-0 text-[var(--wb-text-2)]" />
                )
              ) : (
                <KeyRound className="h-3.5 w-3.5 shrink-0 text-[var(--wb-text-2)]" />
              )
            ) : null}
            <span className={cn('min-w-0 flex-1 truncate', !isKey && 'font-medium')}>
              {node.token === '' ? (
                <span className="text-[var(--wb-text-3)]">(empty)</span>
              ) : (
                node.token
              )}
            </span>
            {meta && meta.ttlMs !== null && meta.ttlMs >= 0 && (
              <span
                className="flex shrink-0 items-center gap-0.5 font-mono text-[10px] tabular-nums text-[var(--wb-text-3)]"
                title={`Expires in ${formatTtlShort(meta.ttlMs)} (at scan time)`}
              >
                <Clock className="h-2.5 w-2.5" />
                {formatTtlShort(meta.ttlMs)}
              </span>
            )}
            {meta && <Badge className="px-1 text-[10px]">{TYPE_LABEL[meta.type]}</Badge>}
            {hasChildren && (
              <span
                className="shrink-0 font-mono text-[11px] tabular-nums text-[var(--wb-text-3)]"
                title={partial ? 'Loaded so far — the scan has not finished' : undefined}
              >
                {count}
              </span>
            )}
          </button>
          <PopoverTrigger asChild>
            <button
              type="button"
              aria-label={`Actions for ${label}`}
              className="grid h-5 w-5 shrink-0 place-items-center rounded-[4px] text-[var(--wb-text-2)] opacity-0 hover:bg-[var(--wb-control-hover)] focus-visible:opacity-100 group-hover/row:opacity-100 data-[state=open]:opacity-100"
            >
              <MoreHorizontal className="h-3.5 w-3.5" />
            </button>
          </PopoverTrigger>
        </div>
        <PopoverContent align="start" sideOffset={2} className="w-[230px] p-1" role="menu">
          {isKey && node.fullKey && (
            <>
              <MenuItem
                icon={<KeyRound />}
                label="Open"
                onClick={() => {
                  setMenuOpen(false);
                  onOpen(node.fullKey!);
                }}
              />
              <MenuItem icon={<Copy />} label="Copy key name" onClick={() => copy(node.fullKey!)} />
            </>
          )}
          {hasChildren && (
            <>
              {isKey && <div className="my-1 h-px bg-[var(--wb-separator)]" />}
              <MenuItem
                icon={<Copy />}
                label="Copy pattern"
                onClick={() => copy(`${fullPath}${SEPARATOR}*`)}
              />
              <MenuItem
                icon={<Filter />}
                label="Scan only this prefix"
                onClick={() => {
                  setMenuOpen(false);
                  onFilterPrefix(fullPath);
                }}
              />
              <MenuItem
                icon={<Plus />}
                label="New key here…"
                disabled={!canWrite}
                onClick={() => {
                  setMenuOpen(false);
                  onNewUnder(fullPath);
                }}
              />
              <MenuItem
                icon={<Trash2 />}
                label="Delete all under prefix…"
                disabled={!canWrite}
                onClick={() => {
                  setMenuOpen(false);
                  onDeletePrefix(fullPath);
                }}
              />
            </>
          )}
        </PopoverContent>
      </Popover>
      {open && hasChildren && (
        // biome-ignore lint/a11y/useSemanticElements: WAI-ARIA tree pattern — nested groups are lists
        <ul role="group">
          {sortedChildren(node).map((child) => (
            <TreeNode
              key={child.token}
              node={child}
              depth={depth + 1}
              pathPrefix={fullPath}
              activeKey={activeKey}
              onOpen={onOpen}
              bulkMode={bulkMode}
              checked={checked}
              onToggleChecked={onToggleChecked}
              partial={partial}
              canWrite={canWrite}
              onFilterPrefix={onFilterPrefix}
              onDeletePrefix={onDeletePrefix}
              onNewUnder={onNewUnder}
            />
          ))}
        </ul>
      )}
    </li>
  );
}
