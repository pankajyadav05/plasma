import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { SectionHeading } from '@/components/ui/view-parts';
import { Segmented } from '@/components/ui/workbench';
import { PgBinDirField } from '@/features/backup/PgBinDirField';
import { isMac } from '@/lib/platform';
import { describeUpdateStatus } from '@/lib/update-status';
import { useUpdate } from '@/lib/use-update';
import { SAFE_MODE_LABEL, SAFE_MODE_LEVELS } from '@/stores/safe-mode';
import { useSession } from '@/stores/session';
import { ROW_LIMIT_CHOICES, useWorkbench } from '@/stores/workbench';
import { cheatSheetSections, formatBinding, formatKeys } from '@shared/keymap';
import { LINT_RULES, LINT_RULE_IDS } from '@shared/pg-migration-lint';
import type { Settings } from '@shared/protocol';
import { Download, Loader2, RotateCw } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CliToolField } from './CliToolField';

type ThemeName = Settings['themeName'];
type SafeMode = Settings['safeModeDefault'];
type CsvExport = Settings['csvExport'];

// ───────────────────────── Sections ─────────────────────────

export type SettingsSectionId =
  | 'general'
  | 'editor'
  | 'table'
  | 'appearance'
  | 'security'
  | 'ai'
  | 'keymap'
  | 'advanced';

/** TablePlus-style preference sections, in sidebar order (SS1). */
export const SETTINGS_SECTIONS: ReadonlyArray<{
  id: SettingsSectionId;
  label: string;
  /** Extra words the section search matches. */
  keywords: string;
}> = [
  {
    id: 'general',
    label: 'General',
    keywords: 'launch connect reconnect restore workspace tabs sidebar',
  },
  {
    id: 'editor',
    label: 'Editor',
    keywords: 'sql font size word wrap row limit migration lint ddl',
  },
  {
    id: 'table',
    label: 'Table & grid',
    keywords: 'page size rows alternating zebra count estimate csv export delimiter null',
  },
  { id: 'appearance', label: 'Fonts & themes', keywords: 'theme palette dark light mode font' },
  {
    id: 'security',
    label: 'Security',
    keywords: 'safe mode read-only confirm timeout presentation mask pii audit retention',
  },
  { id: 'ai', label: 'AI', keywords: 'openrouter api key model assistant' },
  { id: 'keymap', label: 'Keymap', keywords: 'shortcuts keyboard bindings' },
  { id: 'advanced', label: 'Advanced', keywords: 'transaction updates version about' },
];

const PALETTES: Array<{ id: ThemeName; label: string }> = [
  { id: 'default', label: 'Plasma (default)' },
  { id: 'catppuccin', label: 'Catppuccin' },
  { id: 'claude', label: 'Claude' },
  { id: 'claymorphism', label: 'Claymorphism' },
  { id: 'neo-brutalism', label: 'Neo Brutalism' },
  { id: 'quantum-rose', label: 'Quantum Rose' },
  { id: 'forest-canopy', label: 'Forest Canopy' },
  { id: 'cyberpunk', label: 'Cyberpunk' },
  { id: 'arctic', label: 'Arctic' },
  { id: 'github', label: 'GitHub' },
  { id: 'nord', label: 'Nord' },
  { id: 'solarized', label: 'Solarized' },
  { id: 'gruvbox', label: 'Gruvbox' },
  { id: 'tokyo-night', label: 'Tokyo Night' },
  { id: 'rose-pine', label: 'Rosé Pine' },
];

/** Bundled faces (styles/fonts.ts) — every option here actually loads. */
const FONT_SANS_OPTIONS: Array<{ id: Settings['fontSans']; label: string; sample: string }> = [
  { id: 'theme', label: 'Default (system UI)', sample: '' },
  { id: 'geist', label: 'Geist', sample: "'Geist Variable', sans-serif" },
  { id: 'inter', label: 'Inter', sample: "'Inter Variable', sans-serif" },
  { id: 'outfit', label: 'Outfit', sample: "'Outfit Variable', sans-serif" },
  {
    id: 'plus-jakarta',
    label: 'Plus Jakarta Sans',
    sample: "'Plus Jakarta Sans Variable', sans-serif",
  },
  { id: 'ibm-plex', label: 'IBM Plex Sans', sample: "'IBM Plex Sans Variable', sans-serif" },
  { id: 'system', label: 'System UI', sample: 'system-ui, sans-serif' },
];

const FONT_MONO_OPTIONS: Array<{ id: Settings['fontMono']; label: string; sample: string }> = [
  { id: 'theme', label: 'Default (JetBrains Mono)', sample: '' },
  {
    id: 'jetbrains-mono',
    label: 'JetBrains Mono',
    sample: "'JetBrains Mono Variable', monospace",
  },
  { id: 'geist-mono', label: 'Geist Mono', sample: "'Geist Mono Variable', monospace" },
  { id: 'ibm-plex-mono', label: 'IBM Plex Mono', sample: "'IBM Plex Mono', monospace" },
  { id: 'system', label: 'System mono', sample: 'ui-monospace, monospace' },
];

const SAFE_MODE_OPTIONS: Array<{ id: SafeMode; label: string; hint: string }> =
  SAFE_MODE_LEVELS.map((id) => ({ id, ...SAFE_MODE_LABEL[id] }));

const TIMEOUT_CHOICES = [0, 5_000, 15_000, 30_000, 60_000, 300_000, 900_000];

function formatMs(ms: number): string {
  if (ms === 0) return 'No timeout';
  if (ms < 60_000) return `${ms / 1000} seconds`;
  const m = ms / 60_000;
  return `${m} minute${m === 1 ? '' : 's'}`;
}

/** True when a section matches the settings search box. */
export function sectionMatches(id: SettingsSectionId, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const s = SETTINGS_SECTIONS.find((x) => x.id === id);
  return Boolean(s && `${s.label} ${s.keywords}`.toLowerCase().includes(q));
}

/** One preferences section (rendered by SettingsCanvas). */
export function SettingsSection({ id }: { id: SettingsSectionId }) {
  switch (id) {
    case 'general':
      return <GeneralSection />;
    case 'editor':
      return <EditorSection />;
    case 'table':
      return <TableSection />;
    case 'appearance':
      return <AppearanceSection />;
    case 'security':
      return <SecuritySection />;
    case 'ai':
      return <AiSection />;
    case 'keymap':
      return <KeymapSection />;
    case 'advanced':
      return <AdvancedSection />;
  }
}

/** Every section stacked (kept for callers that want the whole form). */
export function SettingsBody() {
  return (
    <div className="flex flex-col">
      {SETTINGS_SECTIONS.map((s) => (
        <div key={s.id}>
          <SectionHeading>{s.label}</SectionHeading>
          <SettingsSection id={s.id} />
        </div>
      ))}
    </div>
  );
}

// ───────────────────────── General ─────────────────────────

function GeneralSection() {
  const settings = useSession((s) => s.settings);
  const updateSettings = useSession((s) => s.updateSettings);
  return (
    <Rows>
      <CheckRow
        id="auto-connect"
        label="On launch"
        text="Reconnect to the last connection"
        hint="Skipped after you disconnect on purpose."
        checked={settings.autoConnectOnLaunch}
        onChange={(v) => void updateSettings({ autoConnectOnLaunch: v })}
      />
      <CheckRow
        id="restore-workspace"
        label=""
        text="Restore open SQL tabs"
        hint="Reopens the last session's query tabs for each connection."
        checked={settings.restoreWorkspace}
        onChange={(v) => void updateSettings({ restoreWorkspace: v })}
      />
      <CheckRow
        id="auto-reconnect"
        label="Connection lost"
        text="Retry automatically"
        hint="Retries after 2s, 5s, 10s, 30s and 60s, and as soon as the network is back. Click the connection capsule in the toolbar to reconnect at any time."
        checked={settings.autoReconnect}
        onChange={(v) => void updateSettings({ autoReconnect: v })}
      />
      <CheckRow
        id="sidebar-collapsed"
        label="Left sidebar"
        text="Hidden"
        hint={`Same as View → Toggle sidebar (${formatBinding('toggleSidebar', isMac)}).`}
        checked={settings.sidebarCollapsed}
        onChange={(v) => void updateSettings({ sidebarCollapsed: v })}
      />
    </Rows>
  );
}

// ───────────────────────── Editor ─────────────────────────

function EditorSection() {
  const settings = useSession((s) => s.settings);
  const updateSettings = useSession((s) => s.updateSettings);
  const wordWrap = useWorkbench((s) => s.wordWrap);
  const setWordWrap = useWorkbench((s) => s.setWordWrap);
  const rowLimit = useWorkbench((s) => s.rowLimit);
  const setRowLimit = useWorkbench((s) => s.setRowLimit);
  const sizes = useMemo(() => Array.from({ length: 15 }, (_, i) => 10 + i), []);
  return (
    <Rows>
      <Row label="Font size" htmlFor="editor-font-size">
        <Choice
          id="editor-font-size"
          value={String(settings.editorFontSize)}
          onChange={(v) => void updateSettings({ editorFontSize: Number(v) })}
          options={sizes.map((n) => ({ value: String(n), label: `${n} px` }))}
          width="w-[120px]"
        />
      </Row>
      <CheckRow
        id="word-wrap"
        label="Long lines"
        text="Wrap"
        checked={wordWrap}
        onChange={setWordWrap}
      />
      <Row
        label="Row limit"
        htmlFor="row-limit"
        hint="Rows fetched per SQL statement. The SQL itself is never rewritten."
      >
        <Choice
          id="row-limit"
          value={rowLimit === null ? 'none' : String(rowLimit)}
          onChange={(v) => setRowLimit(v === 'none' ? null : Number(v))}
          options={ROW_LIMIT_CHOICES.map((n) => ({
            value: n === null ? 'none' : String(n),
            label: n === null ? 'No limit' : `${n.toLocaleString()} rows`,
          }))}
          width="w-[160px]"
        />
      </Row>
      <MigrationLintSettings />
    </Rows>
  );
}

/** Migration linter: on/off, severity threshold and the per-rule mute list. */
function MigrationLintSettings() {
  const settings = useSession((s) => s.settings);
  const updateSettings = useSession((s) => s.updateSettings);
  const enabled = settings.migrationLintEnabled !== false;
  const muted = settings.migrationLintMuted ?? [];
  return (
    <>
      <CheckRow
        id="migration-lint"
        label="Migration linter"
        text="Check DDL for unsafe migrations"
        hint="Flags blocking or rewriting DDL in Preview SQL panels and the SQL editor, with a safer alternative."
        checked={enabled}
        onChange={(v) => void updateSettings({ migrationLintEnabled: v })}
      />
      {enabled && (
        <>
          <Row label="Show findings" htmlFor="migration-lint-severity">
            <Choice
              id="migration-lint-severity"
              value={settings.migrationLintMinSeverity ?? 'info'}
              onChange={(v) =>
                void updateSettings({ migrationLintMinSeverity: v as 'info' | 'warn' | 'error' })
              }
              options={[
                { value: 'info', label: 'All (info and above)' },
                { value: 'warn', label: 'Warnings and errors' },
                { value: 'error', label: 'Errors only' },
              ]}
              width="w-[200px]"
            />
          </Row>
          <Row label="Rules" hint="Untick a rule to mute it everywhere.">
            <div className="flex max-h-[220px] flex-col gap-1.5 overflow-auto pr-2">
              {LINT_RULE_IDS.map((id) => (
                <div key={id} className="flex items-center gap-2">
                  <Checkbox
                    id={`lint-rule-${id}`}
                    checked={!muted.includes(id)}
                    onCheckedChange={(v) =>
                      void updateSettings({
                        migrationLintMuted:
                          v === true ? muted.filter((m) => m !== id) : [...new Set([...muted, id])],
                      })
                    }
                  />
                  <label
                    htmlFor={`lint-rule-${id}`}
                    className="cursor-pointer text-[12.5px] text-[var(--wb-text)]"
                  >
                    {LINT_RULES[id].title}
                    <span className="ml-1.5 text-[var(--wb-text-3)]">
                      {LINT_RULES[id].severity}
                    </span>
                  </label>
                </div>
              ))}
            </div>
          </Row>
        </>
      )}
    </>
  );
}

// ───────────────────────── Table & grid ─────────────────────────

function TableSection() {
  const settings = useSession((s) => s.settings);
  const updateSettings = useSession((s) => s.updateSettings);
  const csv = settings.csvExport;
  const setCsv = (patch: Partial<CsvExport>) =>
    void updateSettings({ csvExport: { ...csv, ...patch } });
  return (
    <>
      <Rows>
        <Row label="Page size" htmlFor="page-size" hint="Rows per page when you open a table.">
          <Choice
            id="page-size"
            value={String(settings.defaultPageSize)}
            onChange={(v) => void updateSettings({ defaultPageSize: Number(v) })}
            options={[50, 100, 250, 500, 1000].map((n) => ({
              value: String(n),
              label: `${n} rows`,
            }))}
            width="w-[140px]"
          />
        </Row>
        <CheckRow
          id="grid-zebra"
          label="Rows"
          text="Alternate row colours"
          checked={settings.gridAlternatingRows}
          onChange={(v) => void updateSettings({ gridAlternatingRows: v })}
        />
        <Row
          label="Row counts"
          htmlFor="count-threshold"
          hint="Above this many rows a table shows the planner's estimate instead of running count(*)."
        >
          <Choice
            id="count-threshold"
            value={String(settings.estimatedCountThreshold)}
            onChange={(v) => void updateSettings({ estimatedCountThreshold: Number(v) })}
            options={[
              { value: '0', label: 'Always count exactly' },
              ...[10_000, 100_000, 1_000_000, 10_000_000].map((n) => ({
                value: String(n),
                label: `Estimate above ${n.toLocaleString()}`,
              })),
            ]}
            width="w-[220px]"
          />
        </Row>
      </Rows>
      <SubHeading>CSV export defaults</SubHeading>
      <Rows>
        <Row label="Delimiter" htmlFor="csv-delimiter">
          <Choice
            id="csv-delimiter"
            value={csv.delimiter}
            onChange={(v) => setCsv({ delimiter: v as CsvExport['delimiter'] })}
            options={[
              { value: ',', label: 'Comma  ,' },
              { value: ';', label: 'Semicolon  ;' },
              { value: '\t', label: 'Tab' },
              { value: '|', label: 'Pipe  |' },
            ]}
            width="w-[160px]"
          />
        </Row>
        <Row label="Quote" htmlFor="csv-quote">
          <Choice
            id="csv-quote"
            value={csv.quote}
            onChange={(v) => setCsv({ quote: v as CsvExport['quote'] })}
            options={[
              { value: '"', label: 'Double quote  "' },
              { value: "'", label: "Single quote  '" },
            ]}
            width="w-[160px]"
          />
        </Row>
        <Row label="NULL values" htmlFor="csv-null">
          <Choice
            id="csv-null"
            value={csv.nullAs}
            onChange={(v) => setCsv({ nullAs: v as CsvExport['nullAs'] })}
            options={[
              { value: 'empty', label: 'Empty field' },
              { value: 'NULL', label: 'The word NULL' },
            ]}
            width="w-[160px]"
          />
        </Row>
        <Row label="Line endings" htmlFor="csv-eol">
          <Choice
            id="csv-eol"
            value={csv.lineEnding}
            onChange={(v) => setCsv({ lineEnding: v as CsvExport['lineEnding'] })}
            options={[
              { value: 'lf', label: 'LF (macOS, Linux)' },
              { value: 'crlf', label: 'CRLF (Windows)' },
            ]}
            width="w-[160px]"
          />
        </Row>
        <CheckRow
          id="csv-header"
          label="Header"
          text="First line has column names"
          checked={csv.header}
          onChange={(v) => setCsv({ header: v })}
        />
        <CheckRow
          id="csv-formula-guard"
          label="Spreadsheet safety"
          text="Prefix cells starting with = + - @ with an apostrophe so Excel and Sheets don't run them as formulas"
          checked={csv.formulaGuard !== false}
          onChange={(v) => setCsv({ formulaGuard: v })}
        />
      </Rows>
    </>
  );
}

// ───────────────────────── Fonts & themes ─────────────────────────

function AppearanceSection() {
  const settings = useSession((s) => s.settings);
  const updateSettings = useSession((s) => s.updateSettings);
  return (
    <Rows>
      <Row label="Appearance">
        <Segmented<'light' | 'dark'>
          ariaLabel="Appearance"
          variant="track"
          value={settings.theme}
          onChange={(v) => void updateSettings({ theme: v })}
          options={[
            { value: 'light', label: 'Light' },
            { value: 'dark', label: 'Dark' },
          ]}
        />
      </Row>
      <Row label="Palette" htmlFor="theme-palette" hint="Palettes change colours only.">
        <PalettePicker
          id="theme-palette"
          value={settings.themeName}
          mode={settings.theme}
          onChange={(v) => void updateSettings({ themeName: v })}
        />
      </Row>
      <Row label="Interface font" htmlFor="font-sans">
        <Choice
          id="font-sans"
          value={settings.fontSans}
          onChange={(v) => void updateSettings({ fontSans: v as Settings['fontSans'] })}
          options={FONT_SANS_OPTIONS.map((o) => ({
            value: o.id,
            label: <span style={o.sample ? { fontFamily: o.sample } : undefined}>{o.label}</span>,
          }))}
          width="w-[240px]"
        />
      </Row>
      <Row
        label="Data font"
        htmlFor="font-mono"
        hint="Result grid, column types and other monospaced data."
      >
        <Choice
          id="font-mono"
          value={settings.fontMono}
          onChange={(v) => void updateSettings({ fontMono: v as Settings['fontMono'] })}
          options={FONT_MONO_OPTIONS.map((o) => ({
            value: o.id,
            label: <span style={o.sample ? { fontFamily: o.sample } : undefined}>{o.label}</span>,
          }))}
          width="w-[240px]"
        />
      </Row>
    </Rows>
  );
}

/**
 * Reads a palette's colours from the stylesheet with an off-screen probe
 * (`.theme-x` / `.dark.theme-x` rules apply to any element), so swatches
 * can never drift from globals.css (V7). The default palette's base
 * blocks also match `.palette-default`, so its swatch reads its own values
 * even while another palette is active on <html>.
 */
function paletteChips(id: ThemeName, mode: 'light' | 'dark'): string[] {
  if (typeof document === 'undefined') return [];
  const probe = document.createElement('div');
  probe.style.display = 'none';
  probe.className = [
    mode === 'dark' ? 'dark' : '',
    id === 'default' ? 'palette-default' : `theme-${id}`,
  ]
    .filter(Boolean)
    .join(' ');
  document.body.appendChild(probe);
  const cs = getComputedStyle(probe);
  const out = ['--primary', '--secondary', '--accent', '--background'].map((v) =>
    cs.getPropertyValue(v).trim(),
  );
  probe.remove();
  return out.filter(Boolean);
}

function PalettePicker({
  id,
  value,
  mode,
  onChange,
}: {
  id: string;
  value: ThemeName;
  mode: 'light' | 'dark';
  onChange: (v: ThemeName) => void;
}) {
  // Recomputed on mode change; every swatch (default included) reads its
  // own palette through the probe class, whatever palette is active.
  const chips = useMemo(() => {
    const map = new Map<ThemeName, string[]>();
    for (const p of PALETTES) map.set(p.id, paletteChips(p.id, mode));
    return map;
  }, [mode]);

  return (
    <Choice
      id={id}
      value={value}
      onChange={(v) => onChange(v as ThemeName)}
      width="w-[240px]"
      options={PALETTES.map((p) => ({
        value: p.id,
        label: (
          <span className="flex items-center gap-2">
            <ChipRow colors={chips.get(p.id) ?? []} />
            {p.label}
          </span>
        ),
      }))}
    />
  );
}

function ChipRow({ colors }: { colors: readonly string[] }) {
  if (colors.length === 0) return null;
  return (
    <span className="flex shrink-0 items-center gap-0.5" aria-hidden>
      {colors.map((c, i) => (
        <span
          // biome-ignore lint/suspicious/noArrayIndexKey: static-length chip row
          key={i}
          className="inline-block h-3 w-3 rounded-full shadow-[inset_0_0_0_1px_rgb(0_0_0/0.15)]"
          style={{ background: c }}
        />
      ))}
    </span>
  );
}

// ───────────────────────── Security ─────────────────────────

function SecuritySection() {
  const settings = useSession((s) => s.settings);
  const updateSettings = useSession((s) => s.updateSettings);
  const current = SAFE_MODE_OPTIONS.find((o) => o.id === settings.safeModeDefault);
  return (
    <Rows>
      <Row
        label="Safe mode"
        htmlFor="safe-mode"
        hint={`${current?.hint ?? ''} Default for connections without their own setting. Connections tagged PROD always confirm writes; read-only connections never write.`}
      >
        <Choice
          id="safe-mode"
          value={settings.safeModeDefault}
          onChange={(v) => void updateSettings({ safeModeDefault: v as SafeMode })}
          options={SAFE_MODE_OPTIONS.map((o) => ({ value: o.id, label: o.label }))}
          width="w-[260px]"
        />
      </Row>
      <Row
        label="Safe Run warning"
        htmlFor="safe-run-threshold"
        hint="Safe Run (dry run of INSERT / UPDATE / DELETE) warns, and Commit turns red, above this many rows."
      >
        <Choice
          id="safe-run-threshold"
          value={String(settings.safeRunRowThreshold ?? 1000)}
          onChange={(v) => void updateSettings({ safeRunRowThreshold: Number(v) })}
          options={[
            ...([10, 100, 1000, 10_000, 100_000].includes(settings.safeRunRowThreshold ?? 1000)
              ? []
              : [settings.safeRunRowThreshold ?? 1000]),
            10,
            100,
            1000,
            10_000,
            100_000,
          ].map((n) => ({ value: String(n), label: `Above ${n.toLocaleString()} rows` }))}
          width="w-[180px]"
        />
      </Row>
      <Row
        label="Safe Run timeout"
        htmlFor="safe-run-timeout"
        hint="A Safe Run left undecided this long rolls back by itself, so it never holds locks open."
      >
        <Choice
          id="safe-run-timeout"
          value={String(settings.safeRunTimeoutSec ?? 300)}
          onChange={(v) => void updateSettings({ safeRunTimeoutSec: Number(v) })}
          options={[
            ...([30, 60, 300, 900, 1800].includes(settings.safeRunTimeoutSec ?? 300)
              ? []
              : [settings.safeRunTimeoutSec ?? 300]),
            30,
            60,
            300,
            900,
            1800,
          ].map((n) => ({
            value: String(n),
            label: n < 60 ? `${n} seconds` : `${n / 60} minutes`,
          }))}
          width="w-[160px]"
        />
      </Row>
      <Row
        label="Query timeout"
        htmlFor="query-timeout"
        hint="Sets statement_timeout for every query you run. Long exports and monitoring are not affected."
      >
        <Choice
          id="query-timeout"
          value={String(settings.queryTimeoutMs)}
          onChange={(v) => void updateSettings({ queryTimeoutMs: Number(v) })}
          options={[
            ...(TIMEOUT_CHOICES.includes(settings.queryTimeoutMs) ? [] : [settings.queryTimeoutMs]),
            ...TIMEOUT_CHOICES,
          ].map((ms) => ({ value: String(ms), label: formatMs(ms) }))}
          width="w-[160px]"
        />
      </Row>
      <CheckRow
        id="presentation-mode"
        label="Presentation mode"
        text="Mask sensitive data on screen"
        hint="Hides emails, phones, card numbers, IPs and columns named like password, token or address in the grid, details, cell viewer, clipboard and AI context, and the host name in the title and capsule. Display only: nothing stored changes."
        checked={settings.presentationMode === true}
        onChange={(v) => void updateSettings({ presentationMode: v })}
      />
      <Row
        label="Masking style"
        htmlFor="mask-style"
        hint="Passwords, tokens and secrets are always fully masked."
      >
        <Choice
          id="mask-style"
          value={settings.maskStyle ?? 'initial'}
          onChange={(v) => void updateSettings({ maskStyle: v as Settings['maskStyle'] })}
          options={[
            { value: 'initial', label: 'First letter  (a•••@example.com)' },
            { value: 'last4', label: 'Last four  (•••• 4242)' },
            { value: 'full', label: 'Everything  (•••)' },
          ]}
          width="w-[260px]"
        />
      </Row>
      <CheckRow
        id="audit-all"
        label="Audit log"
        text="Record every connection, not only Prod"
        hint="Statements run on Prod-tagged connections are always appended to a local, hash-chained audit log (History → Audit)."
        checked={settings.auditAllConnections === true}
        onChange={(v) => void updateSettings({ auditAllConnections: v })}
      />
      <Row
        label="Audit retention"
        htmlFor="audit-retention"
        hint="Older audit entries are deleted. The remaining log still verifies."
      >
        <Choice
          id="audit-retention"
          value={String(settings.auditRetentionDays ?? 90)}
          onChange={(v) => void updateSettings({ auditRetentionDays: Number(v) })}
          options={[
            ...([30, 90, 180, 365, 1095].includes(settings.auditRetentionDays ?? 90)
              ? []
              : [settings.auditRetentionDays ?? 90]),
            30,
            90,
            180,
            365,
            1095,
          ].map((n) => ({ value: String(n), label: `${n} days` }))}
          width="w-[160px]"
        />
      </Row>
    </Rows>
  );
}

// ───────────────────────── AI ─────────────────────────

function AiSection() {
  const settings = useSession((s) => s.settings);
  const clearAiApiKey = useSession((s) => s.clearAiApiKey);
  const updateSettings = useSession((s) => s.updateSettings);
  const local = settings.aiProvider === 'local';
  return (
    <Rows>
      <Row
        label="Provider"
        hint={
          local
            ? 'A model on this machine: no key, no account, and no data leaves your computer.'
            : 'OpenRouter reaches Claude, GPT, Gemini, Qwen and more with one key. Or run a model on this machine.'
        }
      >
        <Segmented<'openrouter' | 'local'>
          ariaLabel="AI provider"
          variant="track"
          value={local ? 'local' : 'openrouter'}
          onChange={(v) => void updateSettings({ aiProvider: v })}
          options={[
            { value: 'openrouter', label: 'OpenRouter' },
            { value: 'local', label: 'Local model' },
          ]}
        />
      </Row>
      {local ? (
        <>
          <Row
            label="Server URL"
            htmlFor="ai-local-url"
            hint={
              <>
                Ollama: <code>http://127.0.0.1:11434/v1</code>. LM Studio:{' '}
                <code>http://127.0.0.1:1234/v1</code>. Only localhost addresses are accepted.
              </>
            }
          >
            <DebouncedSettingsInput
              id="ai-local-url"
              value={settings.aiLocalUrl}
              onCommit={(v) => void updateSettings({ aiLocalUrl: v })}
              placeholder="http://127.0.0.1:11434/v1"
            />
          </Row>
          <Row
            label="Model"
            htmlFor="ai-local-model"
            hint={
              <>
                The model name your server knows, e.g. <code>llama3.1</code> or <code>qwen2.5</code>
                . Pick one that supports tool calling for the agent.
              </>
            }
          >
            <DebouncedSettingsInput
              id="ai-local-model"
              value={settings.aiLocalModel}
              onCommit={(v) => void updateSettings({ aiLocalModel: v })}
              placeholder="llama3.1"
            />
          </Row>
        </>
      ) : (
        <>
          <Row
            label="OpenRouter API key"
            htmlFor="openrouter-key"
            hint={
              <>
                Bring your own key — encrypted with the OS keychain and never shown again. One key
                gives access to Claude, GPT, Gemini, Qwen and more. The schema is sent as a system
                prompt (see below). Row data is only sent when you enable &quot;Allow AI tools to
                read row data&quot; on a connection (off by default); tool results are capped by
                rows and bytes.
              </>
            }
          >
            <div className="flex items-center gap-2">
              <DebouncedSettingsInput
                id="openrouter-key"
                type="password"
                value={settings.openrouterApiKey}
                onCommit={(v) => void updateSettings({ openrouterApiKey: v })}
                placeholder={
                  settings.hasOpenrouterApiKey || settings.hasClaudeApiKey
                    ? 'Saved — paste a new key to replace'
                    : 'sk-or-…'
                }
              />
              {(settings.hasOpenrouterApiKey || settings.hasClaudeApiKey) && (
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => void clearAiApiKey()}
                  aria-label="Remove saved API key"
                >
                  Remove key
                </Button>
              )}
            </div>
          </Row>
          <Row
            label="Model"
            htmlFor="openrouter-model"
            hint={
              <>
                Any OpenRouter model id, e.g. <code>anthropic/claude-sonnet-4.5</code>,{' '}
                <code>openai/gpt-4o</code>, <code>google/gemini-2.5-pro</code>.
              </>
            }
          >
            <DebouncedSettingsInput
              id="openrouter-model"
              value={settings.openrouterModel}
              onCommit={(v) => void updateSettings({ openrouterModel: v })}
              placeholder="anthropic/claude-sonnet-4.5"
            />
          </Row>
        </>
      )}
      <CheckRow
        id="ai-send-schema"
        label="Schema context"
        text="Send table / column names, sample Redis keys and cluster summaries"
        hint="Included in the AI system prompt so answers fit your database. Production-tagged connections send it only after you enable AI access on that connection."
        checked={settings.aiSendSchema !== false}
        onChange={(v) => void updateSettings({ aiSendSchema: v })}
      />
      <CheckRow
        id="ai-auto-apply-views"
        label="Agent"
        text="Apply view changes without asking"
        hint="When the agent shows a table with new columns, sort, filters or page size, apply it at once (with Undo). Running queries and changing data always ask first."
        checked={settings.aiAutoApplyViews === true}
        onChange={(v) => void updateSettings({ aiAutoApplyViews: v })}
      />
    </Rows>
  );
}

// ───────────────────────── Keymap ─────────────────────────

/** Read-only list generated from `@shared/keymap` (rebinding comes later). */
function KeymapSection() {
  const [filter, setFilter] = useState('');
  const sections = cheatSheetSections(filter, isMac);
  return (
    <div className="flex flex-col gap-3 px-4">
      <Input
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
        placeholder="Search shortcuts…"
        aria-label="Search shortcuts"
        className="max-w-[320px]"
      />
      {sections.length === 0 && (
        <div className="text-[13px] text-[var(--wb-text-2)]">No shortcuts match.</div>
      )}
      {sections.map((sec) => (
        <div key={sec.category}>
          <div className="pb-1 text-[12px] font-medium text-[var(--wb-text-2)]">{sec.category}</div>
          <dl className="overflow-hidden rounded-[7px] shadow-[inset_0_0_0_1px_var(--wb-toolbar-group-edge)]">
            {sec.items.map((b, i) => (
              <div
                key={b.id}
                className={
                  i % 2 === 0
                    ? 'flex h-[26px] items-center px-2.5'
                    : 'flex h-[26px] items-center bg-[var(--grid-row-a)] px-2.5'
                }
              >
                <dt className="flex-1 truncate text-[13px] text-[var(--wb-text)]">{b.label}</dt>
                <dd className="font-mono text-[12px] text-[var(--wb-text-2)]">
                  {b.keys ? formatKeys(b.keys, isMac) : formatBinding(b.id, isMac)}
                </dd>
              </div>
            ))}
          </dl>
        </div>
      ))}
      <p className="text-[12px] text-[var(--wb-text-3)]">Shortcuts can't be changed yet.</p>
    </div>
  );
}

// ───────────────────────── Advanced ─────────────────────────

function AdvancedSection() {
  const settings = useSession((s) => s.settings);
  const updateSettings = useSession((s) => s.updateSettings);
  return (
    <>
      <Rows>
        <CheckRow
          id="txn-mode"
          label="Transactions"
          text="Wrap every query in a transaction"
          hint="Commit or roll back from the toolbar. Edit batches use their own transaction (or a savepoint if one is already open)."
          checked={settings.transactionMode}
          onChange={(v) => void updateSettings({ transactionMode: v })}
        />
        <Row
          label="PostgreSQL tools"
          htmlFor="pg-bin-dir"
          hint="Folder with pg_dump, pg_restore and psql for backup and restore. Leave empty to use PATH."
        >
          <PgBinDirField id="pg-bin-dir" />
        </Row>
        <Row
          label="Command line"
          hint={
            'Adds "plasma open <url | file.sqlite | folder>" and "plasma import <file> --into <url> --table <name>" to your terminal.'
          }
        >
          <CliToolField />
        </Row>
      </Rows>
      <SubHeading>About</SubHeading>
      <div className="px-4">
        <UpdateField />
        <p className="mt-2 text-[12px] text-[var(--wb-text-3)]">
          Preferences are stored locally on this computer.
        </p>
      </div>
    </>
  );
}

// ───────────────────────── Form parts ─────────────────────────

function Rows({ children }: { children: React.ReactNode }) {
  return <div className="flex flex-col gap-3.5 px-4 pb-2">{children}</div>;
}

function SubHeading({ children }: { children: React.ReactNode }) {
  return (
    <h4 className="px-4 pb-2 pt-5 text-[13px] font-semibold text-[var(--wb-text)]">{children}</h4>
  );
}

/** Label column (180px, right-aligned like macOS preferences) + control. */
function Row({
  label,
  htmlFor,
  hint,
  children,
}: {
  label: string;
  htmlFor?: string;
  hint?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="grid grid-cols-[180px_1fr] items-start gap-x-4">
      <label htmlFor={htmlFor} className="pt-[5px] text-right text-[13px] text-[var(--wb-text-2)]">
        {label}
      </label>
      <div className="min-w-0">
        {children}
        {hint && <p className="mt-1 text-[12px] leading-snug text-[var(--wb-text-3)]">{hint}</p>}
      </div>
    </div>
  );
}

function CheckRow({
  id,
  label,
  text,
  hint,
  checked,
  onChange,
}: {
  id: string;
  label: string;
  text: string;
  hint?: React.ReactNode;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <div className="grid grid-cols-[180px_1fr] items-start gap-x-4">
      <span className="pt-[1px] text-right text-[13px] text-[var(--wb-text-2)]">{label}</span>
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <Checkbox id={id} checked={checked} onCheckedChange={(v) => onChange(v === true)} />
          <label htmlFor={id} className="cursor-pointer text-[13px] text-[var(--wb-text)]">
            {text}
          </label>
        </div>
        {hint && (
          <p className="mt-1 pl-[22px] text-[12px] leading-snug text-[var(--wb-text-3)]">{hint}</p>
        )}
      </div>
    </div>
  );
}

function Choice({
  id,
  value,
  onChange,
  options,
  width,
}: {
  id: string;
  value: string;
  onChange: (v: string) => void;
  options: Array<{ value: string; label: React.ReactNode }>;
  width: string;
}) {
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger id={id} className={width}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {options.map((o) => (
          <SelectItem key={o.value} value={o.value}>
            {o.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

/** Debounce delay for text settings (API key / model) — U18. */
const TEXT_SETTING_DEBOUNCE_MS = 300;

/**
 * Locally-buffered text input that commits to settings after a short idle
 * period (and on blur / unmount). Instant controls (checkboxes, selects)
 * still call `updateSettings` directly.
 */
function DebouncedSettingsInput({
  id,
  value,
  onCommit,
  type = 'text',
  placeholder,
}: {
  id: string;
  value: string;
  onCommit: (value: string) => void;
  type?: string;
  placeholder?: string;
}) {
  const [local, setLocal] = useState(value);
  const localRef = useRef(local);
  localRef.current = local;
  const valueRef = useRef(value);
  valueRef.current = value;
  const onCommitRef = useRef(onCommit);
  onCommitRef.current = onCommit;

  // Adopt external updates (e.g. settings reload) without clobbering in-flight typing.
  useEffect(() => {
    setLocal(value);
  }, [value]);

  useEffect(() => {
    if (local === value) return;
    const timer = window.setTimeout(() => {
      onCommitRef.current(local);
    }, TEXT_SETTING_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [local, value]);

  // Flush a pending edit if the field unmounts mid-debounce (section switch).
  useEffect(() => {
    return () => {
      const pending = localRef.current;
      if (pending !== valueRef.current) {
        onCommitRef.current(pending);
      }
    };
  }, []);

  const flush = useCallback(() => {
    const pending = localRef.current;
    if (pending !== valueRef.current) {
      onCommitRef.current(pending);
    }
  }, []);

  return (
    <Input
      id={id}
      type={type}
      value={local}
      onChange={(e) => setLocal(e.target.value)}
      onBlur={flush}
      placeholder={placeholder}
      className="max-w-[360px]"
    />
  );
}

/**
 * About — app version, "Check for updates" and a restart-to-install
 * action that mirrors the toolbar's update badge.
 */
function UpdateField() {
  const { status, check, install } = useUpdate();
  const [appVersion, setAppVersion] = useState<string>('');
  const [checking, setChecking] = useState(false);

  useEffect(() => {
    void window.plasma.app.meta().then((m) => setAppVersion(m.version));
  }, []);

  const onCheck = async () => {
    setChecking(true);
    try {
      await check();
    } finally {
      setChecking(false);
    }
  };

  const statusLine = describeUpdateStatus(status, appVersion);

  return (
    <div className="flex flex-col gap-2 rounded-[8px] bg-[var(--wb-control)] px-3 py-2.5">
      <div className="flex items-center justify-between gap-3">
        <div>
          <div className="text-[13px] font-semibold text-[var(--wb-text)]">Plasma</div>
          <div className="font-mono text-[12px] tabular-nums text-[var(--wb-text-2)]">
            v{appVersion || '—'}
          </div>
        </div>
        {status.kind === 'downloaded' ? (
          <Button variant="primary" size="sm" onClick={() => void install()}>
            <Download />
            Restart & install v{status.version}
          </Button>
        ) : status.kind === 'available-manual' ? (
          <Button
            variant="primary"
            size="sm"
            onClick={() => void install()}
            title="Opens the .dmg in your browser — unsigned macOS builds cannot self-install"
          >
            <Download />
            Download v{status.version}
          </Button>
        ) : (
          <Button
            variant="outline"
            size="sm"
            onClick={() => void onCheck()}
            disabled={checking || status.kind === 'checking' || status.kind === 'downloading'}
          >
            {checking || status.kind === 'checking' ? (
              <Loader2 className="animate-spin" />
            ) : (
              <RotateCw />
            )}
            Check for updates
          </Button>
        )}
      </div>
      <p className="text-[12px] text-[var(--wb-text-2)]" aria-live="polite">
        {statusLine}
      </p>
    </div>
  );
}
