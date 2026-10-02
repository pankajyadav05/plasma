import { IconButton } from '@/components/ui/workbench';
import { cn } from '@/lib/cn';
import { useActiveTab, useSession } from '@/stores/session';
import {
  BUILTIN_SNIPPETS,
  type SnippetDef,
  type StoredSnippet,
  dedupeImports,
  exportSnippetsJson,
  parseSnippetImport,
  previewBody,
  removeSnippet,
  upsertSnippet,
} from '@shared/snippets';
import { ChevronRight, Download, FileCode2, Pencil, Plus, Trash2, Upload } from 'lucide-react';
import { useState } from 'react';
import { sidebarRowClass } from '../sidebar/sidebar-parts';
import { insertSnippetIntoEditor } from './editor-registry';
import { useSnippetEditor } from './snippet-editor-store';
import { pickSnippetFile, saveSnippetFile } from './snippet-files';

/**
 * Snippets section of the sidebar Queries tab: your own snippets (create,
 * edit, delete, import/export as JSON) and the built-in set. Clicking a row
 * inserts it at the caret of the SQL editor with live tab stops.
 */
export function SnippetsPanel({ filter }: { filter: string }) {
  const snippets = useSession((s) => s.settings.snippets) as StoredSnippet[];
  const updateSettings = useSession((s) => s.updateSettings);
  const addTab = useSession((s) => s.addTab);
  const setSql = useSession((s) => s.setSql);
  const tab = useActiveTab();
  const openEditor = useSnippetEditor((s) => s.open);
  const [open, setOpen] = useState(false);
  const [showBuiltin, setShowBuiltin] = useState(false);
  const [status, setStatus] = useState<string | null>(null);

  const q = filter.trim().toLowerCase();
  const match = (s: SnippetDef) =>
    !q || `${s.name} ${s.prefix} ${s.description}`.toLowerCase().includes(q);
  const mine = snippets.filter(match);
  const builtin = BUILTIN_SNIPPETS.filter(match);
  const expanded = open || q.length > 0;

  const insert = (s: SnippetDef) => {
    if (insertSnippetIntoEditor(s.body)) return;
    // No editor focused yet: put the snippet (placeholders as defaults) in a SQL tab.
    if (!tab || tab.kind !== 'sql' || tab.sql.trim()) addTab();
    setSql(previewBody(s.body));
  };

  const doExport = async () => {
    const ok = await saveSnippetFile(exportSnippetsJson(snippets), 'plasma-snippets.json');
    setStatus(ok ? `Exported ${snippets.length} snippet${snippets.length === 1 ? '' : 's'}` : null);
  };

  const doImport = async () => {
    const text = await pickSnippetFile();
    if (text === null) return;
    const parsed = parseSnippetImport(text);
    const { fresh, duplicates } = dedupeImports(parsed.snippets, snippets);
    // An imported prefix that collides with one of yours gets a numeric suffix.
    let next = snippets;
    const used = new Set(snippets.map((s) => s.prefix.toLowerCase()));
    let n = 0;
    for (const s of fresh) {
      let prefix = s.prefix;
      for (let i = 2; used.has(prefix.toLowerCase()); i++) prefix = `${s.prefix}${i}`;
      used.add(prefix.toLowerCase());
      next = upsertSnippet(
        next,
        { ...s, prefix },
        Date.now(),
        () => `sn-${Date.now().toString(36)}-${n++}`,
      );
    }
    if (fresh.length > 0) await updateSettings({ snippets: next });
    const bits = [`Imported ${fresh.length}`];
    if (duplicates > 0) bits.push(`${duplicates} already present`);
    if (parsed.skipped.length > 0)
      bits.push(`${parsed.skipped.length} skipped (${parsed.skipped[0]})`);
    setStatus(bits.join(' · '));
  };

  return (
    <div className="shrink-0 border-t border-[var(--wb-separator)]">
      <div className="flex h-8 items-center gap-1 pr-1.5">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={expanded}
          className="flex h-full min-w-0 flex-1 items-center gap-1.5 pl-2.5 text-left text-[13px] font-medium text-[var(--wb-text)]"
        >
          <ChevronRight
            className={cn(
              'h-3 w-3 shrink-0 text-[var(--wb-text-2)] transition-transform',
              expanded && 'rotate-90',
            )}
          />
          Snippets
          <span className="text-[11px] font-normal tabular-nums text-[var(--wb-text-3)]">
            {snippets.length + BUILTIN_SNIPPETS.length}
          </span>
        </button>
        <IconButton
          variant="plain"
          label="New snippet"
          onClick={() => {
            setOpen(true);
            openEditor({ name: '', prefix: '', description: '', body: '' });
          }}
        >
          <Plus />
        </IconButton>
        <IconButton variant="plain" label="Import snippets (JSON)" onClick={() => void doImport()}>
          <Upload />
        </IconButton>
        <IconButton
          variant="plain"
          label="Export your snippets (JSON)"
          disabled={snippets.length === 0}
          onClick={() => void doExport()}
        >
          <Download />
        </IconButton>
      </div>
      {status && (
        <output className="block px-3 pb-1 text-[11px] text-[var(--wb-text-2)]">{status}</output>
      )}
      {expanded && (
        <div className="max-h-[260px] overflow-y-auto pb-1.5">
          {snippets.length === 0 && !q && (
            <div className="px-3 pb-1 text-[11px] text-[var(--wb-text-3)]">
              Select SQL in the editor, right-click, “Save Selection as Snippet…”.
            </div>
          )}
          {mine.map((s) => (
            <div key={s.id} className={cn('group/snip gap-1', sidebarRowClass())}>
              <button
                type="button"
                onClick={() => insert(s)}
                title={`${s.description || s.name}\n\n${previewBody(s.body)}`}
                className="flex h-full min-w-0 flex-1 items-center gap-1.5 px-1 text-left"
              >
                <FileCode2 className="h-4 w-4 shrink-0 text-[var(--wb-text-2)]" />
                <span className="min-w-0 flex-1 truncate">{s.name}</span>
                <span className="shrink-0 font-mono text-[11px] text-[var(--wb-text-3)]">
                  {s.prefix}
                </span>
              </button>
              <IconButton
                variant="plain"
                label={`Edit ${s.name}`}
                className="hidden group-hover/snip:inline-flex"
                onClick={() => openEditor({ ...s })}
              >
                <Pencil />
              </IconButton>
              <IconButton
                variant="plain"
                label={`Delete ${s.name}`}
                className="hidden group-hover/snip:inline-flex"
                onClick={() => void updateSettings({ snippets: removeSnippet(snippets, s.id) })}
              >
                <Trash2 />
              </IconButton>
            </div>
          ))}
          <button
            type="button"
            onClick={() => setShowBuiltin((v) => !v)}
            className="mt-1 flex h-6 w-full items-center gap-1.5 pl-3 text-left text-[12px] text-[var(--wb-text-2)] hover:text-[var(--wb-text)]"
          >
            <ChevronRight
              className={cn('h-3 w-3 transition-transform', (showBuiltin || q) && 'rotate-90')}
            />
            Built-in ({builtin.length})
          </button>
          {(showBuiltin || q.length > 0) &&
            builtin.map((s) => (
              <button
                key={s.prefix}
                type="button"
                onClick={() => insert(s)}
                title={`${s.description}\n\n${previewBody(s.body)}`}
                className={cn('gap-1.5 px-2 text-left', sidebarRowClass())}
              >
                <span className="min-w-0 flex-1 truncate text-[var(--wb-text-2)]">{s.name}</span>
                <span className="shrink-0 font-mono text-[11px] text-[var(--wb-text-3)]">
                  {s.prefix}
                </span>
              </button>
            ))}
        </div>
      )}
    </div>
  );
}
