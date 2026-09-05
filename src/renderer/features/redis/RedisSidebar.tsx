import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Input } from '@/components/ui/input';
import { useSession } from '@/stores/session';
import type { RedisKeyMeta, RedisValueType } from '@shared/protocol';
import {
  Activity,
  CheckSquare,
  ChevronDown,
  ChevronRight,
  Clock,
  KeyRound,
  Layers,
  Loader2,
  Plus,
  Radio,
  RefreshCw,
  Search,
  Square,
  Terminal,
  Trash2,
  X,
} from 'lucide-react';
import { useMemo, useState } from 'react';

/**
 * Redis sidebar — keyspace browser.
 *
 * Layout:
 *   1. Compact header: redis version + role badge + key count
 *   2. SCAN MATCH input (debounced via Enter)
 *   3. "redis-cli" launcher
 *   4. Tree of keys grouped by `:` prefix tokens
 *   5. "Load more" button when SCAN cursor !== '0'
 *
 * Why a prefix tree: production Redis instances commonly hold tens of
 * thousands of keys. Naively rendering them flat is slow + unreadable.
 * Grouping by the conventional `:` separator turns `user:42:profile`
 * into `user → 42 → profile`, mirroring how engineers actually think
 * about a Redis namespace.
 */

interface KeyTreeNode {
  /** The token at this depth (e.g. "user", "42", "profile"). */
  token: string;
  /** Full key path if this node is a leaf, else null. */
  fullKey: string | null;
  meta: RedisKeyMeta | null;
  children: Map<string, KeyTreeNode>;
}

const SEPARATOR = ':';

function buildTree(keys: RedisKeyMeta[]): KeyTreeNode {
  const root: KeyTreeNode = {
    token: '',
    fullKey: null,
    meta: null,
    children: new Map(),
  };
  for (const k of keys) {
    const parts = k.key.split(SEPARATOR);
    let cur = root;
    for (let i = 0; i < parts.length; i++) {
      const tok = parts[i];
      let next = cur.children.get(tok);
      if (!next) {
        next = { token: tok, fullKey: null, meta: null, children: new Map() };
        cur.children.set(tok, next);
      }
      cur = next;
    }
    cur.fullKey = k.key;
    cur.meta = k;
  }
  return root;
}

const TYPE_TONE: Record<RedisValueType, string> = {
  string: 'text-type-str',
  list: 'text-type-int',
  set: 'text-type-bool',
  zset: 'text-type-num',
  hash: 'text-type-uuid',
  stream: 'text-type-date',
  json: 'text-type-jsonb',
  none: 'text-muted-foreground',
  unknown: 'text-muted-foreground',
};

const TYPE_GLYPH: Record<RedisValueType, string> = {
  string: 'str',
  list: 'lst',
  set: 'set',
  zset: 'zst',
  hash: 'hsh',
  stream: 'stm',
  json: 'jsn',
  none: '—',
  unknown: '?',
};

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
  const [pubsubOpen, setPubsubOpen] = useState(false);
  const [pubsubChannel, setPubsubChannel] = useState('');
  const [pubsubPattern, setPubsubPattern] = useState(false);
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

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <div className="border-b border-sidebar-border px-3 py-2">
        <div className="flex items-center gap-2">
          <Layers className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          <span className="font-semibold text-sm">Redis</span>
          <span className="font-display text-[11px] italic text-muted-foreground">
            {overview ? overview.redisVersion : '—'}
          </span>
          <div className="flex-1" />
          <Button
            variant="ghost"
            size="icon-xs"
            title="Refresh"
            onClick={() => {
              void refreshRedisOverview();
              void scanRedisKeys({ cursor: '0' });
            }}
          >
            {loading ? <Loader2 className="animate-spin" /> : <RefreshCw />}
          </Button>
        </div>
        {overview && (
          <div className="mt-1 flex flex-wrap items-center gap-2 font-display text-[11px] italic text-muted-foreground">
            <span className="rounded-sm border border-border px-1 py-0.5 not-italic">
              {overview.role}
            </span>
            <span className="rounded-sm border border-border px-1 py-0.5 not-italic">
              {overview.mode}
            </span>
            <span>· {totalKeys.toLocaleString()} keys total</span>
          </div>
        )}
      </div>

      {/* MATCH input */}
      <div className="border-b border-sidebar-border px-3 py-2">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            submitMatch(match);
          }}
          className="relative"
        >
          <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={match}
            onChange={(e) => setMatch(e.target.value)}
            placeholder="user:* (Enter to scan)"
            className="h-7 pl-7 pr-7 font-mono text-xs"
          />
          {match && (
            <button
              type="button"
              onClick={() => {
                setMatch('');
                submitMatch('');
              }}
              className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded-sm p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
              aria-label="Clear filter"
            >
              <X className="h-3 w-3" />
            </button>
          )}
        </form>
        <div className="mt-2 grid grid-cols-4 gap-1">
          <ToolButton title="redis-cli" icon={<Terminal />} onClick={openRedisCli} />
          <ToolButton title="Memory analyzer" icon={<Activity />} onClick={openRedisAnalyze} />
          <ToolButton title="Slowlog" icon={<Clock />} onClick={openRedisSlowlog} />
          <ToolButton
            title="Pub/sub subscribe"
            icon={<Radio />}
            onClick={() => setPubsubOpen((v) => !v)}
            active={pubsubOpen}
          />
        </div>
        {pubsubOpen && (
          <form
            className="mt-2 flex flex-col gap-1.5 rounded-md border border-border bg-muted/20 p-2"
            onSubmit={(e) => {
              e.preventDefault();
              const ch = pubsubChannel.trim();
              if (!ch) return;
              openRedisPubsub(ch, pubsubPattern);
              setPubsubOpen(false);
              setPubsubChannel('');
            }}
          >
            <Input
              value={pubsubChannel}
              onChange={(e) => setPubsubChannel(e.target.value)}
              placeholder={pubsubPattern ? 'news:* (PSUBSCRIBE)' : 'news.alerts (SUBSCRIBE)'}
              className="h-7 font-mono text-xs"
              autoFocus
            />
            <label className="flex cursor-pointer items-center gap-1.5 font-display text-[11px] italic text-muted-foreground">
              <input
                type="checkbox"
                checked={pubsubPattern}
                onChange={(e) => setPubsubPattern(e.target.checked)}
                className="h-3 w-3 cursor-pointer"
              />
              pattern (PSUBSCRIBE)
            </label>
            <div className="flex justify-end gap-1">
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={() => setPubsubOpen(false)}
              >
                Cancel
              </Button>
              <Button type="submit" size="sm" variant="primary">
                Subscribe
              </Button>
            </div>
          </form>
        )}
      </div>

      {/* Bulk-mode toolbar */}
      <div className="flex shrink-0 items-center gap-1 border-b border-sidebar-border px-3 py-1.5">
        <button
          type="button"
          onClick={toggleBulkMode}
          className={
            bulkMode
              ? 'flex cursor-pointer items-center gap-1 rounded-sm border border-foreground bg-muted px-1.5 py-0.5 font-mono text-[10px] uppercase text-foreground'
              : 'flex cursor-pointer items-center gap-1 rounded-sm border border-border px-1.5 py-0.5 font-mono text-[10px] uppercase text-muted-foreground hover:border-foreground hover:text-foreground'
          }
          title="Toggle bulk select"
        >
          <CheckSquare className="h-3 w-3" />
          select
        </button>
        {bulkMode && (
          <>
            <span className="font-display text-[11px] italic text-muted-foreground">
              {selectedKeys.size.toLocaleString()} chosen
            </span>
            <div className="flex-1" />
            <Button
              variant="ghost"
              size="icon-xs"
              onClick={() => setConfirmBulk(true)}
              disabled={selectedKeys.size === 0}
              title="Delete selected"
              className="text-destructive hover:bg-destructive/10 hover:text-destructive disabled:text-muted-foreground"
            >
              <Trash2 />
            </Button>
          </>
        )}
      </div>

      {/* Key tree */}
      <div className="min-h-0 flex-1 overflow-y-auto">
        {!keys && (
          <div className="px-4 py-3 font-display text-sm italic text-muted-foreground">
            scanning…
          </div>
        )}
        {keys && keys.keys.length === 0 && (
          <div className="px-4 py-3 font-display text-sm italic text-muted-foreground">
            no keys match
          </div>
        )}
        {keys && keys.keys.length > 0 && (
          <ul className="py-1" role="tree" aria-label="Redis keys">
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

      {/* Pagination */}
      {keys && keys.cursor !== '0' && (
        <div className="shrink-0 border-t border-sidebar-border p-2">
          <Button
            variant="outline"
            size="sm"
            onClick={onLoadMore}
            disabled={loading}
            className="w-full"
          >
            {loading ? <Loader2 className="animate-spin" /> : <Plus />}
            {loading ? 'Scanning…' : 'Load more keys'}
          </Button>
        </div>
      )}

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

function ToolButton({
  title,
  icon,
  onClick,
  active,
}: {
  title: string;
  icon: React.ReactNode;
  onClick: () => void;
  active?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-label={title}
      className={
        active
          ? 'flex cursor-pointer items-center justify-center rounded-md border border-foreground bg-muted px-2 py-1.5 text-foreground'
          : 'flex cursor-pointer items-center justify-center rounded-md border border-border bg-background px-2 py-1.5 text-muted-foreground transition-colors hover:border-foreground hover:text-foreground'
      }
    >
      <span className="[&>svg]:h-3.5 [&>svg]:w-3.5">{icon}</span>
    </button>
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
  // Auto-expand the first two levels — anything past that gets the
  // collapse treatment so a `feed:user:42:posts:99:cache` namespace
  // doesn't blow out the sidebar height by default.
  const [open, setOpen] = useState(depth < 1);
  const hasChildren = node.children.size > 0;
  const isLeaf = node.fullKey !== null;
  const fullPath = pathPrefix ? `${pathPrefix}${SEPARATOR}${node.token}` : node.token;
  const isActive = activeKey === node.fullKey;
  const isChecked = node.fullKey !== null && checked.has(node.fullKey);

  return (
    <li
      className="leading-tight"
      role="treeitem"
      aria-level={depth + 1}
      aria-selected={isActive}
      aria-expanded={hasChildren ? open : undefined}
    >
      {isLeaf && !hasChildren ? (
        <button
          type="button"
          onClick={() => {
            if (bulkMode && node.fullKey) {
              onToggleChecked(node.fullKey);
            } else {
              onOpen(node.fullKey ?? fullPath);
            }
          }}
          className={
            isActive
              ? 'flex w-full cursor-pointer items-center gap-1.5 bg-sidebar-accent px-2 py-1 text-left text-xs text-sidebar-accent-foreground'
              : 'flex w-full cursor-pointer items-center gap-1.5 px-2 py-1 text-left text-xs text-sidebar-foreground transition-colors hover:bg-sidebar-accent/50 hover:text-sidebar-accent-foreground'
          }
          style={{ paddingLeft: 8 + depth * 12 }}
          title={node.fullKey ?? ''}
        >
          {bulkMode ? (
            isChecked ? (
              <CheckSquare className="h-3 w-3 shrink-0 text-foreground" />
            ) : (
              <Square className="h-3 w-3 shrink-0 text-muted-foreground" />
            )
          ) : (
            <KeyRound className="h-3 w-3 shrink-0 text-muted-foreground" />
          )}
          <span className="truncate font-mono">{node.token}</span>
          <div className="flex-1" />
          {node.meta && (
            <span
              className={`shrink-0 font-mono text-[9px] uppercase tracking-wider ${TYPE_TONE[node.meta.type]}`}
            >
              {TYPE_GLYPH[node.meta.type]}
            </span>
          )}
        </button>
      ) : (
        <button
          type="button"
          onClick={() => {
            if (isLeaf) {
              onOpen(node.fullKey ?? fullPath);
            } else {
              setOpen((v) => !v);
            }
          }}
          className="flex w-full cursor-pointer items-center gap-1.5 px-2 py-1 text-left text-xs text-foreground transition-colors hover:bg-sidebar-accent/30"
          style={{ paddingLeft: 8 + depth * 12 }}
        >
          {open ? (
            <ChevronDown className="h-3 w-3 shrink-0 text-muted-foreground" />
          ) : (
            <ChevronRight className="h-3 w-3 shrink-0 text-muted-foreground" />
          )}
          <span className="truncate font-mono font-medium">{node.token}</span>
          <div className="flex-1" />
          <span className="shrink-0 font-display text-[10px] italic text-muted-foreground">
            {node.children.size}
          </span>
        </button>
      )}
      {open && hasChildren && (
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

