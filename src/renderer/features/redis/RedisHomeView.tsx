import { useSession } from '@/stores/session';
import { ArrowRight, KeyRound, Terminal } from 'lucide-react';

/**
 * Empty-state body for a connected Redis instance — no key tab open.
 * Presents the cluster summary inline and points at the two main entry
 * points (keys browser in the sidebar, redis-cli for raw commands) so
 * a Postgres-trained eye knows where to look.
 */
export function RedisHomeView() {
  const overview = useSession((s) => s.redisOverview);
  const openRedisCli = useSession((s) => s.openRedisCli);

  return (
    <main className="flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto bg-background">
      <div className="mx-auto w-full max-w-3xl px-8 py-12">
        <div className="mb-8">
          <p className="font-display text-sm uppercase tracking-[0.25em] text-muted-foreground">
            Redis instance
          </p>
          <h1 className="mt-2 font-display text-4xl italic">
            {overview ? overview.redisVersion : 'connecting…'}
          </h1>
          {overview && (
            <p className="mt-1 font-mono text-xs text-muted-foreground">
              role: <span className="text-foreground">{overview.role}</span> · mode:{' '}
              <span className="text-foreground">{overview.mode}</span>
            </p>
          )}
        </div>

        {overview && overview.keyspace.length > 0 && (
          <section className="mb-8">
            <h2 className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
              Keyspace
            </h2>
            <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-4">
              {overview.keyspace.map((k) => (
                <div key={k.db} className="rounded-md border border-border bg-muted/30 p-3">
                  <div className="font-mono text-xs text-muted-foreground">db{k.db}</div>
                  <div className="mt-1 font-display text-2xl">{k.keys.toLocaleString()}</div>
                  <div className="font-display text-[11px] italic text-muted-foreground">
                    {k.expires.toLocaleString()} with TTL
                  </div>
                </div>
              ))}
            </div>
          </section>
        )}

        <section className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <CardLink
            icon={<KeyRound className="h-4 w-4" />}
            title="Browse keys"
            body="Use the sidebar to scan the keyspace. Filter with `prefix:*` patterns."
          />
          <button
            type="button"
            onClick={openRedisCli}
            className="group flex cursor-pointer flex-col items-start gap-2 rounded-md border border-border bg-muted/30 p-4 text-left transition-colors hover:border-foreground/50"
          >
            <Terminal className="h-4 w-4" />
            <div>
              <div className="text-sm font-semibold">redis-cli</div>
              <p className="mt-1 font-display text-[12px] italic text-muted-foreground">
                Run any command — `INFO`, `MEMORY USAGE`, `CONFIG GET`, even Lua scripts.
              </p>
            </div>
            <span className="mt-auto flex items-center gap-1 text-xs text-muted-foreground transition-colors group-hover:text-foreground">
              Open <ArrowRight className="h-3 w-3" />
            </span>
          </button>
        </section>
      </div>
    </main>
  );
}

function CardLink({
  icon,
  title,
  body,
}: {
  icon: React.ReactNode;
  title: string;
  body: string;
}) {
  return (
    <div className="flex flex-col gap-2 rounded-md border border-border bg-muted/30 p-4">
      <div className="text-muted-foreground">{icon}</div>
      <div className="text-sm font-semibold">{title}</div>
      <p className="font-display text-[12px] italic text-muted-foreground">{body}</p>
    </div>
  );
}
