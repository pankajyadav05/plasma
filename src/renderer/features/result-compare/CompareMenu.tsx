import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { IconButton, MenuItem } from '@/components/ui/workbench';
import { useCompare } from '@/stores/compare';
import type { QueryTab } from '@/stores/session-types';
import { GitCompare, Server } from 'lucide-react';
import { useState } from 'react';
import { useSqlConnections } from './SourceCard';
import { seedForTab } from './tab-source';

/**
 * "Compare with…" for a result: another tab's result, or this query on any
 * saved connection (staging against prod). Opens a Compare tab.
 */
export function CompareMenu({ tab }: { tab: QueryTab }) {
  const [open, setOpen] = useState(false);
  const open_ = useCompare((s) => s.open);
  const connections = useSqlConnections();
  const seed = seedForTab(tab);
  const sql =
    seed?.kind === 'query' ? seed.sql : (tab.queryResult?.sql ?? tab.queryErrorSql ?? '').trim();
  const canRunElsewhere = sql.length > 0;

  const run = (connectionId: string | null) => {
    setOpen(false);
    if (!seed) return;
    open_(seed, { kind: 'query', connectionId, sql });
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <IconButton
          label="Compare with…"
          title="Compare this result with another result, or run it on another connection"
          disabled={!seed}
          data-testid="compare-menu"
        >
          <GitCompare />
        </IconButton>
      </PopoverTrigger>
      <PopoverContent align="end" side="top" sideOffset={6} className="w-[270px] p-1" role="menu">
        <MenuItem
          icon={<GitCompare />}
          label="Compare with another result…"
          onClick={() => {
            setOpen(false);
            if (seed) open_(seed);
          }}
        />
        <div className="mx-2 my-1 h-px bg-[var(--wb-separator)]" aria-hidden />
        <p className="px-2 pb-0.5 pt-0.5 text-[11px] text-[var(--wb-text-3)]">
          Run this query read-only on…
        </p>
        {connections.length === 0 || !canRunElsewhere ? (
          <p className="px-2 py-1 text-[12px] text-[var(--wb-text-2)]">
            {canRunElsewhere ? 'No saved SQL connections.' : 'This result has no query to re-run.'}
          </p>
        ) : (
          connections.map((c) => (
            <MenuItem
              key={c.value}
              icon={<Server />}
              label={c.name}
              hint={c.hint}
              onClick={() => run(c.value === '__active' ? null : c.value)}
            />
          ))
        )}
      </PopoverContent>
    </Popover>
  );
}
