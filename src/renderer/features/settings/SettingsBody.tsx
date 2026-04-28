import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { cn } from '@/lib/cn';
import { useUpdate } from '@/lib/use-update';
import { useSession } from '@/stores/session';
import type { Settings } from '@shared/protocol';
import { Check, ChevronDown, Download, Loader2, Moon, RotateCw, Search, Sun } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';

type ThemeName = Settings['themeName'];

const PALETTES: Array<{
  id: ThemeName;
  label: string;
  light: [string, string, string, string];
  dark: [string, string, string, string];
}> = [
  {
    id: 'default',
    label: 'Plasma (default)',
    light: [
      'oklch(0.7122 0.1809 21.6630)',
      'oklch(0.9702 0 0)',
      'oklch(0.9219 0 0)',
      'oklch(1 0 0)',
    ],
    dark: [
      'oklch(0.7122 0.1809 21.6630)',
      'oklch(0.2686 0 0)',
      'oklch(0.2686 0 0)',
      'oklch(0.1448 0 0)',
    ],
  },
  {
    id: 'catppuccin',
    label: 'Catppuccin',
    light: [
      'oklch(0.5500 0.1800 260)',
      'oklch(0.9100 0.0200 65)',
      'oklch(0.8800 0.0700 30)',
      'oklch(0.9550 0.0120 65)',
    ],
    dark: [
      'oklch(0.7800 0.1400 280)',
      'oklch(0.2700 0.0300 285)',
      'oklch(0.7800 0.1700 25)',
      'oklch(0.1900 0.0250 285)',
    ],
  },
  {
    id: 'claude',
    label: 'Claude',
    light: [
      'oklch(0.5500 0.1300 35)',
      'oklch(0.9000 0.0350 55)',
      'oklch(0.8800 0.0500 60)',
      'oklch(0.9650 0.0150 60)',
    ],
    dark: [
      'oklch(0.7300 0.1300 35)',
      'oklch(0.2700 0.0250 35)',
      'oklch(0.3300 0.0500 40)',
      'oklch(0.1700 0.0180 35)',
    ],
  },
  {
    id: 'claymorphism',
    label: 'Claymorphism',
    light: [
      'oklch(0.6500 0.1500 285)',
      'oklch(0.9000 0.0500 320)',
      'oklch(0.8500 0.1000 320)',
      'oklch(0.9600 0.0220 285)',
    ],
    dark: [
      'oklch(0.7500 0.1300 285)',
      'oklch(0.2900 0.0500 285)',
      'oklch(0.3300 0.0700 320)',
      'oklch(0.1800 0.0400 285)',
    ],
  },
  {
    id: 'neo-brutalism',
    label: 'Neo Brutalism',
    light: ['oklch(0 0 0)', 'oklch(0.9300 0 0)', 'oklch(0.9000 0.2000 95)', 'oklch(1.0000 0 0)'],
    dark: [
      'oklch(0.9000 0.2000 95)',
      'oklch(0.1500 0 0)',
      'oklch(0.9000 0.2000 95)',
      'oklch(0 0 0)',
    ],
  },
  {
    id: 'quantum-rose',
    label: 'Quantum Rose',
    light: [
      'oklch(0.5500 0.2000 0)',
      'oklch(0.9100 0.0300 0)',
      'oklch(0.8800 0.0500 30)',
      'oklch(0.9700 0.0150 0)',
    ],
    dark: [
      'oklch(0.7200 0.2000 0)',
      'oklch(0.2500 0.0500 350)',
      'oklch(0.7800 0.1300 30)',
      'oklch(0.1400 0.0350 350)',
    ],
  },
  {
    id: 'forest-canopy',
    label: 'Forest Canopy',
    light: [
      'oklch(0.4500 0.1000 145)',
      'oklch(0.9000 0.0300 100)',
      'oklch(0.7500 0.1300 70)',
      'oklch(0.9600 0.0180 95)',
    ],
    dark: [
      'oklch(0.6800 0.1300 145)',
      'oklch(0.2600 0.0300 130)',
      'oklch(0.3200 0.0500 100)',
      'oklch(0.1600 0.0250 130)',
    ],
  },
  {
    id: 'cyberpunk',
    label: 'Cyberpunk',
    light: [
      'oklch(0.5500 0.2400 320)',
      'oklch(0.9100 0.0400 200)',
      'oklch(0.7500 0.1800 200)',
      'oklch(0.9700 0.0200 200)',
    ],
    dark: [
      'oklch(0.7500 0.2400 320)',
      'oklch(0.1800 0.0400 280)',
      'oklch(0.7800 0.2200 200)',
      'oklch(0.0900 0.0250 280)',
    ],
  },
  {
    id: 'arctic',
    label: 'Arctic',
    light: [
      'oklch(0.5500 0.1500 240)',
      'oklch(0.9300 0.0150 220)',
      'oklch(0.8200 0.0900 200)',
      'oklch(0.9750 0.0080 220)',
    ],
    dark: [
      'oklch(0.7800 0.1500 220)',
      'oklch(0.2300 0.0400 240)',
      'oklch(0.7200 0.1300 200)',
      'oklch(0.1300 0.0300 240)',
    ],
  },
];

const FONT_SANS_OPTIONS: Array<{ id: Settings['fontSans']; label: string; sample: string }> = [
  { id: 'theme', label: 'Theme default', sample: '' },
  { id: 'geist', label: 'Geist', sample: "'Geist', sans-serif" },
  { id: 'inter', label: 'Inter', sample: "'Inter', sans-serif" },
  { id: 'outfit', label: 'Outfit', sample: "'Outfit', sans-serif" },
  { id: 'plus-jakarta', label: 'Plus Jakarta Sans', sample: "'Plus Jakarta Sans', sans-serif" },
  { id: 'ibm-plex', label: 'IBM Plex Sans', sample: "'IBM Plex Sans', sans-serif" },
  { id: 'system', label: 'System UI', sample: 'system-ui, sans-serif' },
];

const FONT_MONO_OPTIONS: Array<{ id: Settings['fontMono']; label: string; sample: string }> = [
  { id: 'theme', label: 'Theme default', sample: '' },
  { id: 'jetbrains-mono', label: 'JetBrains Mono', sample: "'JetBrains Mono', monospace" },
  { id: 'geist-mono', label: 'Geist Mono', sample: "'Geist Mono', monospace" },
  { id: 'ibm-plex-mono', label: 'IBM Plex Mono', sample: "'IBM Plex Mono', monospace" },
  { id: 'system', label: 'System mono', sample: 'ui-monospace, monospace' },
];

/** Settings form body, shared between SettingsSheet (overlay) and SettingsCanvas (full page). */
export function SettingsBody() {
  const settings = useSession((s) => s.settings);
  const updateSettings = useSession((s) => s.updateSettings);

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-1 py-2">
      <SectionTitle>Appearance</SectionTitle>
      <Field label="Mode">
        <ModeToggle
          isDark={settings.theme === 'dark'}
          onToggle={() =>
            void updateSettings({ theme: settings.theme === 'dark' ? 'light' : 'dark' })
          }
        />
      </Field>

      <Field label="Palette">
        <ThemePicker
          value={settings.themeName}
          mode={settings.theme}
          onChange={(v) => void updateSettings({ themeName: v })}
        />
      </Field>

      <Field label="UI font (sans)">
        <Select
          value={settings.fontSans}
          onValueChange={(v) => void updateSettings({ fontSans: v as Settings['fontSans'] })}
        >
          <SelectTrigger className="w-[260px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {FONT_SANS_OPTIONS.map((o) => (
              <SelectItem key={o.id} value={o.id}>
                <span style={o.sample ? { fontFamily: o.sample } : undefined}>{o.label}</span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <p className="mt-1 font-display text-xs italic text-muted-foreground">
          Body + UI text. "Theme default" follows the active palette. SQL editor keeps its own mono
          font.
        </p>
      </Field>

      <Field label="UI font (mono)">
        <Select
          value={settings.fontMono}
          onValueChange={(v) => void updateSettings({ fontMono: v as Settings['fontMono'] })}
        >
          <SelectTrigger className="w-[260px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {FONT_MONO_OPTIONS.map((o) => (
              <SelectItem key={o.id} value={o.id}>
                <span style={o.sample ? { fontFamily: o.sample } : undefined}>{o.label}</span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <p className="mt-1 font-display text-xs italic text-muted-foreground">
          Used by the result grid, version label, and table column types.
        </p>
      </Field>

      <Field label="Sidebar">
        <div className="flex items-center gap-3">
          <Checkbox
            id="sidebar-collapsed"
            checked={settings.sidebarCollapsed}
            onCheckedChange={(v) => void updateSettings({ sidebarCollapsed: Boolean(v) })}
          />
          <label htmlFor="sidebar-collapsed" className="cursor-pointer text-sm text-foreground">
            Collapse sidebar by default
          </label>
        </div>
      </Field>

      <SectionTitle>Editor</SectionTitle>
      <Field label={`Font size · ${settings.editorFontSize}px`}>
        <input
          type="range"
          min={10}
          max={22}
          step={1}
          value={settings.editorFontSize}
          onChange={(e) => void updateSettings({ editorFontSize: Number(e.target.value) })}
          className="w-full accent-primary"
        />
      </Field>

      <SectionTitle>Query</SectionTitle>
      <Field label="Default page size">
        <Select
          value={String(settings.defaultPageSize)}
          onValueChange={(v) => void updateSettings({ defaultPageSize: Number(v) })}
        >
          <SelectTrigger className="w-[160px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {[50, 100, 250, 500, 1000].map((n) => (
              <SelectItem key={n} value={String(n)}>
                {n} rows
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>

      <Field label="Transaction mode">
        <div className="flex items-center gap-3">
          <Checkbox
            id="txn-mode"
            checked={settings.transactionMode}
            onCheckedChange={(v) => void updateSettings({ transactionMode: Boolean(v) })}
          />
          <label htmlFor="txn-mode" className="cursor-pointer text-sm text-foreground">
            Wrap every query in a transaction by default
          </label>
        </div>
        <p className="mt-1 font-display text-xs italic text-muted-foreground">
          Requires you to explicitly commit or rollback — see the status bar.
        </p>
      </Field>

      <SectionTitle>AI (Claude API)</SectionTitle>
      <Field label="Claude API key" htmlFor="claude-key">
        <Input
          id="claude-key"
          type="password"
          value={settings.claudeApiKey}
          onChange={(e) => void updateSettings({ claudeApiKey: e.target.value })}
          placeholder="sk-ant-…"
        />
        <p className="mt-1 font-display text-xs italic text-muted-foreground">
          BYO — stored in the local settings table. Never leaves your machine unless you make an AI
          request.
        </p>
      </Field>

      <SectionTitle>Privacy</SectionTitle>
      <Field label="Telemetry">
        <div className="flex items-center gap-3">
          <Checkbox
            id="telemetry"
            checked={settings.telemetryEnabled}
            onCheckedChange={(v) => void updateSettings({ telemetryEnabled: Boolean(v) })}
          />
          <label htmlFor="telemetry" className="cursor-pointer text-sm text-foreground">
            Send anonymous usage statistics
          </label>
        </div>
        <p className="mt-1 font-display text-xs italic text-muted-foreground">
          Off by default. We never capture SQL, connection strings, or row data.
        </p>
      </Field>

      <SectionTitle>About</SectionTitle>
      <UpdateField />
    </div>
  );
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  // Padding top inside the heading rather than sibling margin-top —
  // adjacent shadow-glow trigger buttons get clipped by margin-collapsed
  // gaps in some browsers, but padding lives inside the box and never
  // bites neighbouring shadows.
  return (
    <h3 className="border-b pb-2 pt-4 text-xs font-medium uppercase tracking-wider text-muted-foreground first:pt-0">
      {children}
    </h3>
  );
}

function Field({
  label,
  htmlFor,
  children,
}: {
  label: string;
  htmlFor?: string;
  children: React.ReactNode;
}) {
  // No mt-4 — parent SettingsBody now uses flex+gap so shadows on
  // children (palette trigger glow, etc) never run into margin gaps.
  return (
    <div className="flex flex-col gap-2">
      <Label htmlFor={htmlFor}>{label}</Label>
      {children}
    </div>
  );
}

function ModeToggle({ isDark, onToggle }: { isDark: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={isDark}
      onClick={onToggle}
      title={`Switch to ${isDark ? 'light' : 'dark'} mode`}
      className={cn(
        'relative inline-flex h-7 w-[52px] shrink-0 cursor-pointer items-center rounded-full border transition-colors',
        isDark ? 'border-foreground bg-foreground' : 'border-border bg-muted',
      )}
    >
      <span
        className={cn(
          'pointer-events-none absolute top-0.5 flex h-6 w-6 items-center justify-center rounded-full bg-background shadow transition-transform',
          isDark ? 'translate-x-[24px]' : 'translate-x-0.5',
        )}
      >
        {isDark ? (
          <Moon className="h-3 w-3 text-foreground" />
        ) : (
          <Sun className="h-3 w-3 text-foreground" />
        )}
      </span>
    </button>
  );
}

function ThemePicker({
  value,
  mode,
  onChange,
}: {
  value: ThemeName;
  mode: 'light' | 'dark';
  onChange: (v: ThemeName) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return PALETTES;
    return PALETTES.filter((p) => p.label.toLowerCase().includes(q));
  }, [query]);

  const active = PALETTES.find((p) => p.id === value) ?? PALETTES[0];
  const activeChips = mode === 'dark' ? active.dark : active.light;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="inline-flex h-9 w-[260px] items-center gap-2.5 rounded-md border border-input bg-background px-3 text-sm shadow-sm transition-colors hover:bg-accent/40"
        >
          <ChipRow colors={activeChips} />
          <span className="flex-1 truncate text-left">{active.label}</span>
          <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-[300px] p-0">
        <div className="flex items-center gap-2 border-b px-3 py-2">
          <Search className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search themes…"
            className="h-6 flex-1 border-0 bg-transparent text-sm outline-none focus:outline-none focus-visible:outline-none focus-visible:ring-0 placeholder:text-muted-foreground"
          />
        </div>
        <div className="flex items-center justify-between px-3 py-1.5 text-xs text-muted-foreground">
          <span>
            {filtered.length} {filtered.length === 1 ? 'theme' : 'themes'}
          </span>
        </div>
        <div className="max-h-[260px] overflow-y-auto p-1">
          {filtered.length === 0 && (
            <div className="px-3 py-6 text-center text-xs text-muted-foreground">No matches.</div>
          )}
          {filtered.map((p) => {
            const isActive = p.id === value;
            const chips = mode === 'dark' ? p.dark : p.light;
            return (
              <button
                key={p.id}
                type="button"
                onClick={() => {
                  onChange(p.id);
                  setOpen(false);
                }}
                className={cn(
                  'flex w-full items-center gap-2.5 rounded-sm px-2 py-1.5 text-left text-sm transition-colors',
                  'hover:bg-accent hover:text-accent-foreground',
                  isActive && 'bg-accent/60 font-medium',
                )}
              >
                <ChipRow colors={chips} />
                <span className="flex-1 truncate">{p.label}</span>
                {isActive && <Check className="h-3.5 w-3.5 shrink-0 text-primary" />}
              </button>
            );
          })}
        </div>
      </PopoverContent>
    </Popover>
  );
}

function ChipRow({ colors }: { colors: readonly string[] }) {
  return (
    <span className="flex shrink-0 items-center gap-0.5">
      {colors.map((c, i) => (
        <span
          // biome-ignore lint/suspicious/noArrayIndexKey: static-length chip row
          key={i}
          aria-hidden
          className="inline-block h-3.5 w-3.5 rounded-full border border-border/60"
          style={{ background: c }}
        />
      ))}
    </span>
  );
}

/**
 * About section — current app version + "Check for updates" button +
 * status line that mirrors whatever electron-updater is doing right
 * now. Restart-to-install lives here too, plus a duplicate of the
 * StatusBar pill so users who never glance at the StatusBar still
 * find the action.
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

  const statusLine = describeStatus(status);

  return (
    <div className="flex flex-col gap-3 rounded-md border border-border bg-muted/40 p-4">
      <div className="flex items-baseline justify-between">
        <div>
          <div className="font-display text-sm italic text-foreground">Plasma</div>
          <div className="font-mono text-xs text-muted-foreground tabular-nums">
            v{appVersion || '—'}
          </div>
        </div>
        {status.kind === 'downloaded' ? (
          <Button variant="primary" size="sm" onClick={() => void install()}>
            <Download />
            Restart & install v{status.version}
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
      <p className="font-display text-xs italic text-muted-foreground">{statusLine}</p>
    </div>
  );
}

function describeStatus(status: ReturnType<typeof useUpdate>['status']): string {
  switch (status.kind) {
    case 'idle':
      return 'Click "Check for updates" to fetch the latest manifest.';
    case 'checking':
      return 'Checking for updates…';
    case 'not-available':
      return `You are on the latest version (v${status.version}).`;
    case 'available':
      return `Update v${status.version} found — downloading in the background.`;
    case 'downloading':
      return `Downloading update — ${Math.round(status.percent)}% (${formatBytes(status.bytesPerSecond)}/s)`;
    case 'downloaded':
      return `Update v${status.version} downloaded — restart to install.`;
    case 'error':
      return `Update check failed: ${status.message}`;
  }
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
