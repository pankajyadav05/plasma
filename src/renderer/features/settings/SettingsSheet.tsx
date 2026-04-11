import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { cn } from "@/lib/cn";
import { useSession } from "@/stores/session";

export function SettingsSheet() {
  const open = useSession((s) => s.settingsOpen);
  const setOpen = useSession((s) => s.setSettingsOpen);
  const settings = useSession((s) => s.settings);
  const updateSettings = useSession((s) => s.updateSettings);

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetContent side="right" className="w-[520px]">
        <SheetHeader>
          <SheetTitle>Settings</SheetTitle>
          <SheetDescription>Preferences persist in the local SQLite store.</SheetDescription>
        </SheetHeader>

        <div className="min-h-0 flex-1 overflow-y-auto px-8 py-6">
          <SectionTitle>Appearance</SectionTitle>
          <Field label="Theme">
            <Segmented
              options={[
                { value: "paper", label: "Paper" },
                { value: "midnight", label: "Midnight" },
              ]}
              value={settings.theme}
              onChange={(v) => void updateSettings({ theme: v as "paper" | "midnight" })}
            />
          </Field>

          <Field label="Sidebar">
            <div className="flex items-center gap-3">
              <Checkbox
                id="sidebar-collapsed"
                checked={settings.sidebarCollapsed}
                onCheckedChange={(v) => void updateSettings({ sidebarCollapsed: Boolean(v) })}
              />
              <label htmlFor="sidebar-collapsed" className="cursor-pointer font-mono text-sm text-ink">
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
              className="w-full accent-accent"
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
              <label htmlFor="txn-mode" className="cursor-pointer font-mono text-sm text-ink">
                Wrap every query in a transaction by default
              </label>
            </div>
            <p className="mt-1 font-display text-xs italic text-ink-muted">
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
            <p className="mt-1 font-display text-xs italic text-ink-muted">
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
              <label htmlFor="telemetry" className="cursor-pointer font-mono text-sm text-ink">
                Send anonymous usage statistics
              </label>
            </div>
            <p className="mt-1 font-display text-xs italic text-ink-muted">
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
    <h3
      className="mt-8 border-b border-border-soft pb-2 font-mono text-xs uppercase text-ink-muted first:mt-0"
      style={{ letterSpacing: "0.10em" }}
    >
      {children}
    </h3>
  );
}

function Field({ label, htmlFor, children }: { label: string; htmlFor?: string; children: React.ReactNode }) {
  return (
    <div className="mt-5 flex flex-col gap-2">
      <Label htmlFor={htmlFor} className="font-display text-base normal-case not-italic tracking-normal text-ink">
        {label}
      </Label>
      {children}
    </div>
  );
}

function Segmented({
  options,
  value,
  onChange,
}: {
  options: Array<{ value: string; label: string }>;
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <div className="inline-flex border border-border-strong">
      {options.map((opt) => (
        <Button
          key={opt.value}
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => onChange(opt.value)}
          className={cn(
            "h-8 rounded-none border-0 border-r border-border-strong font-mono text-xs normal-case tracking-normal text-ink last:border-r-0",
            opt.value === value && "bg-paper-selected text-ink hover:bg-paper-selected",
          )}
        >
          {opt.label}
        </Button>
      ))}
    </div>
  );
}
