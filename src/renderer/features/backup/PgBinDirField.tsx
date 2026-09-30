import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ipc } from '@/lib/ipc';
import { useSession } from '@/stores/session';
import type { ToolInfo } from '@shared/pg-backup';
import { useEffect, useState } from 'react';

/** Settings → Advanced: folder holding pg_dump / pg_restore / psql, with what was found there. */
export function PgBinDirField({ id }: { id: string }) {
  const saved = useSession((s) => s.settings.pgBinDir ?? '');
  const updateSettings = useSession((s) => s.updateSettings);
  const [value, setValue] = useState(saved);
  const [tools, setTools] = useState<ToolInfo[] | null>(null);

  useEffect(() => setValue(saved), [saved]);
  useEffect(() => {
    let alive = true;
    ipc.admin
      .tools(saved || undefined)
      .then((t) => alive && setTools(t))
      .catch(() => alive && setTools([]));
    return () => {
      alive = false;
    };
  }, [saved]);

  const commit = (next: string) => {
    if (next.trim() !== saved) void updateSettings({ pgBinDir: next.trim() });
  };
  const browse = async () => {
    const dir = await ipc.admin.pickPath({
      mode: 'directory',
      title: 'Folder with pg_dump, pg_restore and psql',
      defaultPath: value || undefined,
    });
    if (dir) {
      setValue(dir);
      commit(dir);
    }
  };

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex gap-2">
        <Input
          id={id}
          value={value}
          placeholder="Use PATH"
          onChange={(e) => setValue(e.target.value)}
          onBlur={() => commit(value)}
          onKeyDown={(e) => e.key === 'Enter' && commit(value)}
        />
        <Button variant="secondary" onClick={() => void browse()}>
          Browse…
        </Button>
      </div>
      {tools && (
        <ul className="text-[12px] text-[var(--wb-text-2)]">
          {tools.map((t) => (
            <li key={t.tool}>
              {t.tool}:{' '}
              {t.path ? (
                (t.version ?? t.path)
              ) : (
                <span className="text-[var(--wb-text-3)]">not found</span>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
