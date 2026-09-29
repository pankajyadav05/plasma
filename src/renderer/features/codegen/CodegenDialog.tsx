import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { EmptyState } from '@/components/ui/view-parts';
import { cn } from '@/lib/cn';
import { useActiveTabSelect, useSession } from '@/stores/session';
import type { SchemaInfo } from '@shared/protocol';
import { Check, Copy, Search } from 'lucide-react';
import { useEffect, useId, useMemo, useRef, useState } from 'react';

type Target = 'ts' | 'zod' | 'prisma' | 'drizzle' | 'sqlalchemy' | 'sql';

const TARGETS: Array<{ id: Target; label: string }> = [
  { id: 'ts', label: 'TypeScript interfaces' },
  { id: 'zod', label: 'Zod schemas' },
  { id: 'prisma', label: 'Prisma model' },
  { id: 'drizzle', label: 'Drizzle (pg-core)' },
  { id: 'sqlalchemy', label: 'SQLAlchemy 2.0' },
  { id: 'sql', label: 'CREATE TABLE (DDL)' },
];

/**
 * Generate type / model code for selected tables in the introspected
 * schema. Pure-function generators — no AI, no extra deps. Picks live
 * in the dialog so the user can mix tables across schemas in one shot.
 */
export function CodegenDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const schema = useSession((s) => s.schema);
  const [target, setTarget] = useState<Target>('ts');
  const [filter, setFilter] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [copied, setCopied] = useState(false);
  const idBase = useId();
  // The table open in the active tab, preselected when the dialog opens (F30).
  const activeTableKey = useActiveTabSelect((t) =>
    t?.kind === 'table' && t.tableSchema && t.tableName ? `${t.tableSchema}.${t.tableName}` : null,
  );

  const tables = schema?.tables ?? [];

  // Preselect on the closed → open transition only, so unticking the
  // active table while the dialog is open sticks.
  const wasOpen = useRef(false);
  useEffect(() => {
    const opening = open && !wasOpen.current;
    wasOpen.current = open;
    if (!opening || !activeTableKey) return;
    if (!tables.some((t) => `${t.schema}.${t.name}` === activeTableKey)) return;
    setSelected((prev) => (prev.has(activeTableKey) ? prev : new Set(prev).add(activeTableKey)));
  }, [open, activeTableKey, tables]);
  const visible = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return q ? tables.filter((t) => `${t.schema}.${t.name}`.toLowerCase().includes(q)) : tables;
  }, [tables, filter]);

  const toggle = (key: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const code = useMemo(() => {
    if (!schema || selected.size === 0) return '';
    const picked = tables.filter((t) => selected.has(`${t.schema}.${t.name}`));
    return generate(target, schema, picked);
  }, [schema, selected, tables, target]);

  const handleCopy = () => {
    if (!code) return;
    void navigator.clipboard?.writeText(code).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-4xl">
        <DialogHeader>
          <DialogTitle>Generate code</DialogTitle>
          <DialogDescription className="sr-only">
            Pick tables and a target to generate type or model code.
          </DialogDescription>
        </DialogHeader>

        <div className="grid grid-cols-[280px_1fr] gap-3">
          <div className="flex min-w-0 flex-col overflow-hidden rounded-[7px] border border-[var(--wb-separator)] bg-[var(--wb-sidebar)]">
            <div className="relative border-b border-[var(--wb-separator)] p-1.5">
              <Search className="pointer-events-none absolute left-3.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[var(--wb-text-3)]" />
              <Input
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                placeholder="Filter tables…"
                aria-label="Filter tables"
                className="pl-7"
              />
            </div>
            <div className="max-h-[360px] min-h-0 flex-1 overflow-y-auto p-1">
              {visible.length === 0 && (
                <EmptyState
                  className="min-h-[120px]"
                  title="No tables"
                  hint={filter.trim() ? 'No tables match the filter.' : undefined}
                />
              )}
              {visible.map((t, i) => {
                const key = `${t.schema}.${t.name}`;
                const on = selected.has(key);
                const id = `${idBase}-t${i}`;
                return (
                  <div
                    key={key}
                    className={cn(
                      'flex w-full min-w-0 items-center gap-2 rounded-[5px] px-2 py-1 font-mono text-[12px] text-[var(--wb-text)]',
                      on ? 'bg-[var(--wb-selected)]' : 'hover:bg-[var(--wb-control-hover)]',
                    )}
                  >
                    <Checkbox
                      id={id}
                      checked={on}
                      onCheckedChange={() => toggle(key)}
                      className="shrink-0"
                    />
                    <label
                      htmlFor={id}
                      className="min-w-0 flex-1 cursor-default truncate"
                      title={key}
                    >
                      {key}
                    </label>
                  </div>
                );
              })}
            </div>
            <div className="flex h-7 items-center justify-between border-t border-[var(--wb-separator)] px-2 text-[12px] text-[var(--wb-text-2)]">
              <span>{selected.size} selected</span>
              {selected.size > 0 && (
                <Button variant="ghost" size="xs" onClick={() => setSelected(new Set())}>
                  Clear
                </Button>
              )}
            </div>
          </div>

          <div className="flex min-h-0 min-w-0 flex-col overflow-hidden rounded-[7px] border border-[var(--wb-separator)]">
            <div className="flex items-center gap-2 border-b border-[var(--wb-separator)] bg-[var(--wb-sidebar)] px-2 py-1.5">
              <Select value={target} onValueChange={(v) => setTarget(v as Target)}>
                <SelectTrigger className="w-[200px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {TARGETS.map((t) => (
                    <SelectItem key={t.id} value={t.id}>
                      {t.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <div className="flex-1" />
              <Button
                variant="ghost"
                size="icon-xs"
                onClick={handleCopy}
                title="Copy"
                aria-label="Copy code"
              >
                {copied ? <Check /> : <Copy />}
              </Button>
            </div>
            <pre className="max-h-[400px] min-h-[260px] flex-1 overflow-auto bg-[var(--wb-content)] p-3 font-mono text-[12px] leading-relaxed text-[var(--wb-text)]">
              {code || '// pick tables on the left'}
            </pre>
          </div>
        </div>

        <div className="flex justify-end pt-2">
          <Button variant="secondary" onClick={() => onOpenChange(false)}>
            Close
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ─── generators ───────────────────────────────────────────────────────

type Tables = SchemaInfo['tables'];

function generate(target: Target, schema: SchemaInfo, tables: Tables): string {
  switch (target) {
    case 'ts':
      return tables.map((t) => generateTs(schema, t)).join('\n\n');
    case 'zod':
      return [`import { z } from 'zod';`, '', ...tables.map((t) => generateZod(schema, t))].join(
        '\n',
      );
    case 'prisma':
      return tables.map((t) => generatePrisma(schema, t)).join('\n\n');
    case 'drizzle':
      return [
        `import { pgTable, text, integer, boolean, timestamp, numeric, uuid, jsonb, varchar } from 'drizzle-orm/pg-core';`,
        '',
        ...tables.map((t) => generateDrizzle(schema, t)),
      ].join('\n');
    case 'sqlalchemy':
      return [
        'from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column',
        'from sqlalchemy import String, Integer, Boolean, DateTime, Numeric, JSON',
        '',
        'class Base(DeclarativeBase): ...',
        '',
        ...tables.map((t) => generateSqlAlchemy(schema, t)),
      ].join('\n');
    case 'sql':
      return tables.map((t) => generateDdl(schema, t)).join('\n\n');
  }
}

function colsFor(schema: SchemaInfo, t: Tables[number]) {
  return schema.columns
    .filter((c) => c.schema === t.schema && c.table === t.name)
    .sort((a, b) => a.ordinal - b.ordinal);
}

function pascal(s: string): string {
  return s.replace(/(^|[_\W])(\w)/g, (_, __, c: string) => c.toUpperCase());
}

function generateTs(schema: SchemaInfo, t: Tables[number]): string {
  const cols = colsFor(schema, t);
  const lines = cols.map((c) => {
    const name = c.name;
    const ts = pgTypeToTs(c.dataType);
    const opt = c.isNullable ? ' | null' : '';
    return `  ${name}: ${ts}${opt};`;
  });
  return `export interface ${pascal(t.name)} {\n${lines.join('\n')}\n}`;
}

function generateZod(schema: SchemaInfo, t: Tables[number]): string {
  const cols = colsFor(schema, t);
  const lines = cols.map((c) => {
    const z = pgTypeToZod(c.dataType);
    const ext = c.isNullable ? '.nullable()' : '';
    return `  ${JSON.stringify(c.name)}: ${z}${ext},`;
  });
  return `export const ${pascal(t.name)} = z.object({\n${lines.join('\n')}\n});\nexport type ${pascal(t.name)} = z.infer<typeof ${pascal(t.name)}>;`;
}

function generatePrisma(schema: SchemaInfo, t: Tables[number]): string {
  const cols = colsFor(schema, t);
  const lines = cols.map((c) => {
    const ty = pgTypeToPrisma(c.dataType);
    const nullable = c.isNullable ? '?' : '';
    const id = c.isPrimaryKey ? ' @id' : '';
    return `  ${c.name} ${ty}${nullable}${id}`;
  });
  return `model ${pascal(t.name)} {\n${lines.join('\n')}\n  @@map("${t.name}")\n}`;
}

function generateDrizzle(schema: SchemaInfo, t: Tables[number]): string {
  const cols = colsFor(schema, t);
  const lines = cols.map((c) => {
    const fn = pgTypeToDrizzle(c.dataType);
    const chain = [c.isPrimaryKey ? '.primaryKey()' : '', c.isNullable ? '' : '.notNull()']
      .filter(Boolean)
      .join('');
    return `  ${c.name}: ${fn}('${c.name}')${chain},`;
  });
  return `export const ${pascal(t.name)} = pgTable('${t.name}', {\n${lines.join('\n')}\n});`;
}

function generateSqlAlchemy(schema: SchemaInfo, t: Tables[number]): string {
  const cols = colsFor(schema, t);
  const lines = cols.map((c) => {
    const py = pgTypeToPy(c.dataType);
    const args: string[] = [py];
    if (c.isPrimaryKey) args.push('primary_key=True');
    if (!c.isNullable) args.push('nullable=False');
    return `    ${c.name}: Mapped[${pyHint(c)}] = mapped_column(${args.join(', ')})`;
  });
  return `class ${pascal(t.name)}(Base):\n    __tablename__ = "${t.name}"\n${lines.join('\n')}`;
}

function generateDdl(schema: SchemaInfo, t: Tables[number]): string {
  const cols = colsFor(schema, t);
  const colLines = cols.map((c) => {
    const parts = [`  "${c.name}"`, c.dataType];
    if (!c.isNullable) parts.push('NOT NULL');
    return parts.join(' ');
  });
  const pks = cols.filter((c) => c.isPrimaryKey).map((c) => `"${c.name}"`);
  const pk = pks.length > 0 ? [`,\n  PRIMARY KEY (${pks.join(', ')})`] : [];
  return `CREATE TABLE "${t.schema}"."${t.name}" (\n${colLines.join(',\n')}${pk.join('')}\n);`;
}

// ─── type mappers (compact, not exhaustive) ───────────────────────────

function pgTypeToTs(t: string): string {
  const lo = t.toLowerCase();
  if (/(int|serial|bigint|smallint|numeric|decimal|float|double|real)/.test(lo)) return 'number';
  if (/bool/.test(lo)) return 'boolean';
  if (/(json|jsonb)/.test(lo)) return 'unknown';
  if (/(timestamp|date|time)/.test(lo)) return 'Date';
  if (/uuid/.test(lo)) return 'string';
  return 'string';
}

function pgTypeToZod(t: string): string {
  const lo = t.toLowerCase();
  if (/(int|serial|bigint|smallint|numeric|decimal|float|double|real)/.test(lo))
    return 'z.number()';
  if (/bool/.test(lo)) return 'z.boolean()';
  if (/(json|jsonb)/.test(lo)) return 'z.unknown()';
  if (/(timestamp|date|time)/.test(lo)) return 'z.coerce.date()';
  if (/uuid/.test(lo)) return 'z.string().uuid()';
  return 'z.string()';
}

function pgTypeToPrisma(t: string): string {
  const lo = t.toLowerCase();
  if (/uuid/.test(lo)) return 'String';
  if (/bigint/.test(lo)) return 'BigInt';
  if (/(int|serial|smallint)/.test(lo)) return 'Int';
  if (/(numeric|decimal)/.test(lo)) return 'Decimal';
  if (/(float|double|real)/.test(lo)) return 'Float';
  if (/bool/.test(lo)) return 'Boolean';
  if (/(json|jsonb)/.test(lo)) return 'Json';
  if (/timestamp/.test(lo)) return 'DateTime';
  if (/date/.test(lo)) return 'DateTime';
  return 'String';
}

function pgTypeToDrizzle(t: string): string {
  const lo = t.toLowerCase();
  if (/uuid/.test(lo)) return 'uuid';
  if (/varchar/.test(lo)) return 'varchar';
  if (/(text|char)/.test(lo)) return 'text';
  if (/(int|serial|smallint|bigint)/.test(lo)) return 'integer';
  if (/(numeric|decimal)/.test(lo)) return 'numeric';
  if (/bool/.test(lo)) return 'boolean';
  if (/jsonb/.test(lo)) return 'jsonb';
  if (/timestamp/.test(lo)) return 'timestamp';
  return 'text';
}

function pgTypeToPy(t: string): string {
  const lo = t.toLowerCase();
  if (/(int|serial|bigint|smallint)/.test(lo)) return 'Integer';
  if (/(numeric|decimal|float|double|real)/.test(lo)) return 'Numeric';
  if (/bool/.test(lo)) return 'Boolean';
  if (/(json|jsonb)/.test(lo)) return 'JSON';
  if (/timestamp/.test(lo)) return 'DateTime';
  return 'String';
}

function pyHint(c: SchemaInfo['columns'][number]): string {
  const lo = c.dataType.toLowerCase();
  let base = 'str';
  if (/(int|serial|bigint|smallint)/.test(lo)) base = 'int';
  else if (/(numeric|decimal|float|double|real)/.test(lo)) base = 'float';
  else if (/bool/.test(lo)) base = 'bool';
  else if (/(timestamp|date)/.test(lo)) base = 'datetime';
  return c.isNullable ? `${base} | None` : base;
}
