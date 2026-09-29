import { Checkbox } from '@/components/ui/checkbox';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
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
import type { RedisKeyMeta, RedisValueType } from '@shared/protocol';
import {
  Activity,
  CheckSquare,
  ChevronRight,
  Clock,
  KeyRound,
  Loader2,
  Plus,
  Radio,
  RefreshCw,
  SlidersHorizontal,
  Square,
  Terminal,
  Trash2,
} from 'lucide-react';
import { useMemo, useState } from 'react';

/**
 * Redis sidebar — keyspace browser, laid out like the Postgres items list.
 *
 *   1. Compact header: "Redis <version>" + role / key-count meta + refresh
 *   2. SCAN MATCH search (Enter to scan) + a sliders menu holding the
 *      tool launchers (redis-cli, analyzer, slowlog, pub/sub) and the
 *      bulk-select toggle
 *   3. Prefix tree of keys (24px rows, type badges, TTL hints)
 *   4. Bottom bar: loaded count + "Load more keys" while SCAN isn't done
 *
 * Why a prefix tree: production Redis instances commonly hold tens of
 * thousands of keys. Grouping by the conventional `:` separator turns
 * `user:42:profile` into `user → 42 → profile`, mirroring how engineers
 * think about a Redis namespace.
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

function buildTree(keys: RedisKeyMeta[]): KeyTreeNode {
  const root: KeyTreeNode = {
    token: '',
    fullKey: null,
    meta: null,
    children: new Map(),
    keyCount: 0,
  };
  for (const k of keys) {
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

const REDIS_TYPE_LABEL: Record<RedisValueType, string> = {
  string: 'STR',
  list: 'LIST',
  set: 'SET',
  zset: 'ZSET',
  hash: 'HASH',
  stream: 'STREAM',
  json: 'JSON',
  none: 'NONE',
  unknown: '?',
};

/** Compact TTL hint: 42s / 12m / 5h / 3d. */
function formatTtlShort(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86_400) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86_400)}d`;
}

const FIELD_CLASS =
  'h-[26px] w-full rounded-[7px] border-0 bg-[var(--wb-field)] px-2.5 font-mono text-[13px] text-[var(--wb-text)] shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--wb-text)_10%,transparent)] outline-none placeholder:text-[var(--wb-text-3)] focus:shadow-[0_0_0_2px_color-mix(in_srgb,var(--wb-accent)_55%,transparent)]';

export function RedisSidebar() {
  const overview = useSession((s) => s.redisOverview);
  const keys = useSession((s) => s.redisKeys);
  const loading = useSession((s) => s.redisLoading);
  const matchInput = useSession((s) => s.redisMatch);
  const setRedisMatch = useSession((s) => s.setRedisMatch);
  const scanRedisKeys = useSession((s) => s.scanRedisKeys);
  const refreshRedisOverview = useSession((s) => s.refreshRedisOverview);
  const openRedisKey = useSession((s) => s.openRedisKey);
  const openRedisCli = useSession((s) => s.openRedisCli);
  const openRedisAnalyze = useSession((s) => s.openRedisAnalyze);
  const openRedisSlowlog = useSession((s) => s.openRedisSlowlog);
  const openRedisPubsub = useSession((s) => s.openRedisPubsub);
  const activeRedisKey = useSession((s) => s.activeRedisKey);
  const bulkMode = useSession((s) => s.redisBulkMode);
  const selectedKeys = useSession((s) => s.selectedRedisKeys);
  const toggleBulkMode = useSession((s) => s.toggleRedisBulkMode);
  const toggleKeyChecked = useSession((s) => s.toggleRedisKeyChecked);
  const bulkDelete = useSession((s) => s.bulkDeleteSelectedRedisKeys);

  const [match, setMatch] = useState(matchInput ?? '');
  const [menuOpen, setMenuOpen] = useState(false);
  const [pubsubOpen, setPubsubOpen] = useState(false);
  const [confirmBulk, setConfirmBulk] = useState(false);

  const tree = useMemo(() => buildTree(keys?.keys ?? []), [keys]);
  const totalKeys = useMemo(() => {
    if (!overview) return 0;
    return overview.keyspace.reduce((acc, k) => acc + k.keys, 0);
  }, [overview]);

  const submitMatch = (raw: string) => {
    const trimmed = raw.trim();
    setRedisMatch(trimmed.length > 0 ? trimmed : null);
  };

  const onLoadMore = () => {
    if (!keys) return;
    void scanRedisKeys({ cursor: keys.cursor, match: match || undefined });
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

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <div className="flex h-9 shrink-0 items-center gap-2 pl-4 pr-2.5">
        <div className="flex min-w-0 flex-1 items-baseline gap-1.5">
          <span className="shrink-0 text-[13px] font-semibold text-[var(--wb-text)]">Redis</span>
          <span className="truncate text-[11px] text-[var(--wb-text-2)]">
            {overview
              ? [
                  overview.redisVersion,
                  overview.role,
                  overview.mode,
                  `${totalKeys.toLocaleString()} keys`,
                ].join(' · ')
              : 'connecting…'}
          </span>
        </div>
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
              active={bulkMode}
              className="[&_svg]:h-4 [&_svg]:w-4"
            >
              <SlidersHorizontal />
            </IconButton>
          </PopoverTrigger>
          <PopoverContent align="end" sideOffset={4} className="w-[230px] p-1" role="menu">
            <MenuItem icon={<Terminal />} label="redis-cli" onClick={() => runMenu(openRedisCli)} />
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
            <div className="my-1 h-px bg-[var(--wb-separator)]" />
            <MenuItem
              icon={<CheckSquare />}
              label="Bulk select"
              checked={bulkMode}
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

      {/* Bulk-mode strip */}
      {bulkMode && (
        <div className="flex h-7 shrink-0 items-center gap-1.5 px-4 pb-1 text-[12px] text-[var(--wb-text-2)]">
          <span className="flex-1 truncate">{selectedKeys.size.toLocaleString()} selected</span>
          <IconButton
            variant="plain"
            label="Delete selected"
            onClick={() => setConfirmBulk(true)}
            disabled={selectedKeys.size === 0}
            className="text-destructive hover:text-destructive"
          >
            <Trash2 />
          </IconButton>
          <Pill onClick={toggleBulkMode} aria-label="Toggle bulk select" title="Toggle bulk select">
            Done
          </Pill>
        </div>
      )}

      {/* Key tree */}
      <div className="min-h-0 flex-1 overflow-y-auto pb-1">
        {!keys && <SidebarEmpty title="Scanning…" />}
        {keys && keys.keys.length === 0 && (
          <SidebarEmpty
            title="No keys match"
            hint={matchInput ? `MATCH ${matchInput}` : 'The selected database is empty.'}
          />
        )}
        {keys && keys.keys.length > 0 && (
          <ul role="tree" aria-label="Redis keys" aria-multiselectable={bulkMode || undefined}>
            {[...tree.children.values()].map((node) => (
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
              />
            ))}
          </ul>
        )}
      </div>

      {/* Bottom bar: loaded count + pagination */}
      {keys && (
        <div className="flex h-9 shrink-0 items-center gap-2 border-t border-[var(--wb-separator)] pl-4 pr-2.5">
          <span className="min-w-0 flex-1 truncate text-[11px] tabular-nums text-[var(--wb-text-2)]">
            {scanDone
              ? `${loaded.toLocaleString()} keys`
              : `${loaded.toLocaleString()}${totalKeys ? ` of ${totalKeys.toLocaleString()}` : ''} keys`}
          </span>
          {!scanDone && (
            <Pill onClick={onLoadMore} disabled={loading}>
              {loading ? <Loader2 className="animate-spin" /> : <Plus />}
              {loading ? 'Scanning…' : 'Load more keys'}
            </Pill>
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

      <ConfirmDialog
        open={confirmBulk}
        onOpenChange={setConfirmBulk}
        title={`Delete ${selectedKeys.size} keys?`}
        description="DEL is pipelined and cannot be undone."
        confirmLabel="Delete all"
        variant="destructive"
        onConfirm={() => {
          void bulkDelete();
          setConfirmBulk(false);
        }}
      />
    </div>
  );
}

function PubsubDialog({
  open,
  onOpenChange,
  onSubscribe,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onSubscribe: (channel: string, pattern: boolean) => void;
}) {
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

function TreeNode({
  node,
  depth,
  pathPrefix,
  activeKey,
  onOpen,
  bulkMode,
  checked,
  onToggleChecked,
}: {
  node: KeyTreeNode;
  depth: number;
  pathPrefix: string;
  activeKey: string | null;
  onOpen: (key: string) => void;
  bulkMode: boolean;
  checked: Set<string>;
  onToggleChecked: (key: string) => void;
}) {
  // Only the top level starts expanded so deep namespaces like
  // `feed:user:42:posts:99:cache` don't blow out the sidebar height.
  const [open, setOpen] = useState(depth < 1);
  const hasChildren = node.children.size > 0;
  const isKey = node.fullKey !== null;
  const fullPath = pathPrefix ? `${pathPrefix}${SEPARATOR}${node.token}` : node.token;
  const isActive = isKey && activeKey === node.fullKey;
  const isChecked = node.fullKey !== null && checked.has(node.fullKey);
  const meta = node.meta;
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

  const label = isKey
    ? (node.fullKey ?? fullPath)
    : `${fullPath}${SEPARATOR}* (${node.keyCount.toLocaleString()} keys)`;

  return (
    <li
      role="treeitem"
      aria-label={label}
      aria-level={depth + 1}
      aria-selected={bulkMode ? isChecked : isActive}
      aria-expanded={hasChildren ? open : undefined}
    >
      <div
        className={cn(sidebarRowClass(isActive || (bulkMode && isChecked)), 'pr-2')}
        style={indent}
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
              title={`Expires in ${formatTtlShort(meta.ttlMs)}`}
            >
              <Clock className="h-2.5 w-2.5" />
              {formatTtlShort(meta.ttlMs)}
            </span>
          )}
          {meta && <Badge className="px-1 text-[9px]">{REDIS_TYPE_LABEL[meta.type]}</Badge>}
          {hasChildren && (
            <span className="shrink-0 font-mono text-[11px] tabular-nums text-[var(--wb-text-3)]">
              {node.keyCount.toLocaleString()}
            </span>
          )}
        </button>
      </div>
      {open && hasChildren && (
        // biome-ignore lint/a11y/useSemanticElements: WAI-ARIA tree pattern — nested groups are lists
        <ul role="group">
          {[...node.children.values()].map((child) => (
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
            />
          ))}
        </ul>
      )}
    </li>
  );
}
