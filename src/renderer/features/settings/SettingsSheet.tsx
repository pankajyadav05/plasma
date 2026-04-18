import { useMemo, useState } from "react";
import { Check, ChevronDown, Moon, Search, Sun } from "lucide-react";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { cn } from "@/lib/cn";
import { useSession } from "@/stores/session";
import type { Settings } from "@shared/protocol";

type ThemeName = Settings["themeName"];

/** Four representative tokens per palette for the picker chips.
 *  Order: primary, secondary, accent, background — enough to convey
 *  the palette's vibe without duplicating the full theme table. */
const PALETTES: Array<{
  id: ThemeName;
  label: string;
  light: [string, string, string, string];
  dark: [string, string, string, string];
}> = [
  {
    id: "default",
    label: "Plasma (default)",
    light: ["oklch(0.7122 0.1809 21.6630)", "oklch(0.9702 0 0)", "oklch(0.9219 0 0)", "oklch(1 0 0)"],
    dark:  ["oklch(0.7122 0.1809 21.6630)", "oklch(0.2686 0 0)",  "oklch(0.2686 0 0)", "oklch(0.1448 0 0)"],
  },
  {
    id: "caffeine",
    label: "Caffeine",
    light: ["oklch(0.4341 0.0392 41.9938)", "oklch(0.9200 0.0651 74.3695)", "oklch(0.9310 0 0)", "oklch(0.9821 0 0)"],
    dark:  ["oklch(0.9247 0.0524 66.1732)", "oklch(0.3163 0.0190 63.6992)", "oklch(0.2850 0 0)", "oklch(0.1776 0 0)"],
  },
  {
    id: "sage-garden",
    label: "Sage Garden",
    light: ["oklch(0.6333 0.0309 154.9039)", "oklch(0.8596 0.0291 119.9919)", "oklch(0.8242 0.0221 136.6092)", "oklch(0.9761 0.0041 91.4461)"],
    dark:  ["oklch(0.6333 0.0309 154.9039)", "oklch(0.2178 0 0)",              "oklch(0.3709 0.0248 153.9823)", "oklch(0.1448 0 0)"],
  },
  {
    id: "supabase",
    label: "Supabase",
    light: ["oklch(0.8348 0.1302 160.9080)", "oklch(0.9940 0 0)", "oklch(0.9461 0 0)", "oklch(0.9911 0 0)"],
    dark:  ["oklch(0.4365 0.1044 156.7556)", "oklch(0.2603 0 0)", "oklch(0.3132 0 0)", "oklch(0.1822 0 0)"],
  },
  {
    id: "violet-bloom",
    label: "Violet Bloom",
    light: ["oklch(0.5393 0.2713 286.7462)", "oklch(0.9540 0.0063 255.4755)", "oklch(0.9393 0.0288 266.3680)", "oklch(0.9940 0 0)"],
    dark:  ["oklch(0.6132 0.2294 291.7437)", "oklch(0.2940 0.0130 272.9312)", "oklch(0.2795 0.0368 260.0310)", "oklch(0.2223 0.0060 271.1393)"],
  },
  {
    id: "vercel",
    label: "Vercel",
    light: ["oklch(0 0 0)", "oklch(0.9400 0 0)", "oklch(0.9700 0 0)", "oklch(1 0 0)"],
    dark:  ["oklch(1 0 0)", "oklch(0.2500 0 0)", "oklch(0.3200 0 0)", "oklch(0 0 0)"],
  },
];

export function SettingsSheet() {
  const open = useSession((s) => s.settingsOpen);
  const setOpen = useSession((s) => s.setSettingsOpen);
  const settings = useSession((s) => s.settings);
  const updateSettings = useSession((s) => s.updateSettings);

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetContent side="right" className="w-full sm:max-w-md px-0">
        <SheetHeader className="px-4">
          <SheetTitle>Settings</SheetTitle>
          <SheetDescription>Preferences persist in the local SQLite store.</SheetDescription>
        </SheetHeader>

        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          <SectionTitle>Appearance</SectionTitle>
          <Field label="Mode">
            <ModeToggle
              isDark={settings.theme === "dark"}
              onToggle={() =>
                void updateSettings({ theme: settings.theme === "dark" ? "light" : "dark" })
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
              BYO — stored in the local settings table. Never leaves your machine unless you make an AI request.
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
        </div>
      </SheetContent>
    </Sheet>
  );
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <h3 className="mt-6 border-b pb-2 text-xs font-medium uppercase tracking-wider text-muted-foreground first:mt-0">
      {children}
    </h3>
  );
}

function Field({ label, htmlFor, children }: { label: string; htmlFor?: string; children: React.ReactNode }) {
  return (
    <div className="mt-4 flex flex-col gap-2">
      <Label htmlFor={htmlFor}>{label}</Label>
      {children}
    </div>
  );
}

/** iOS-style slide toggle: track turns dark when active, knob slides right
 *  and swaps Sun → Moon icon. One control, one click, current state visible. */
function ModeToggle({ isDark, onToggle }: { isDark: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={isDark}
      onClick={onToggle}
      title={`Switch to ${isDark ? "light" : "dark"} mode`}
      className={cn(
        "relative inline-flex h-7 w-[52px] shrink-0 cursor-pointer items-center rounded-full border transition-colors",
        isDark ? "border-foreground bg-foreground" : "border-border bg-muted",
      )}
    >
      <span
        className={cn(
          "pointer-events-none absolute top-0.5 flex h-6 w-6 items-center justify-center rounded-full bg-background shadow transition-transform",
          isDark ? "translate-x-[24px]" : "translate-x-0.5",
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

/** Palette picker — searchable popover with 4-chip previews per theme,
 *  active row highlighted. Mirrors the tweakcn picker shape. */
function ThemePicker({
  value,
  mode,
  onChange,
}: {
  value: ThemeName;
  mode: "light" | "dark";
  onChange: (v: ThemeName) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return PALETTES;
    return PALETTES.filter((p) => p.label.toLowerCase().includes(q));
  }, [query]);

  const active = PALETTES.find((p) => p.id === value) ?? PALETTES[0];
  const activeChips = mode === "dark" ? active.dark : active.light;

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
            {filtered.length} {filtered.length === 1 ? "theme" : "themes"}
          </span>
        </div>
        <div className="max-h-[260px] overflow-y-auto p-1">
          {filtered.length === 0 && (
            <div className="px-3 py-6 text-center text-xs text-muted-foreground">No matches.</div>
          )}
          {filtered.map((p) => {
            const isActive = p.id === value;
            const chips = mode === "dark" ? p.dark : p.light;
            return (
              <button
                key={p.id}
                type="button"
                onClick={() => {
                  onChange(p.id);
                  setOpen(false);
                }}
                className={cn(
                  "flex w-full items-center gap-2.5 rounded-sm px-2 py-1.5 text-left text-sm transition-colors",
                  "hover:bg-accent hover:text-accent-foreground",
                  isActive && "bg-accent/60 font-medium",
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
