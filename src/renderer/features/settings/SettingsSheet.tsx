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
      <SheetContent side="right" className="w-full sm:max-w-md">
        <SheetHeader>
          <SheetTitle>Settings</SheetTitle>
          <SheetDescription>Preferences persist in the local SQLite store.</SheetDescription>
        </SheetHeader>

        <div className="min-h-0 flex-1 overflow-y-auto py-4">
          <SectionTitle>Appearance</SectionTitle>
          <Field label="Theme">
            <Segmented
              options={[
                { value: "light", label: "Light" },
                { value: "dark", label: "Dark" },
              ]}
              value={settings.theme}
              onChange={(v) => void updateSettings({ theme: v as "light" | "dark" })}
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
    <div className="inline-flex rounded-md border p-0.5">
      {options.map((opt) => (
        <Button
          key={opt.value}
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => onChange(opt.value)}
          className={cn(
            "h-7 px-3 text-xs",
            opt.value === value && "bg-primary text-primary-foreground hover:bg-primary/90 hover:text-primary-foreground",
          )}
        >
          {opt.label}
        </Button>
      ))}
    </div>
  );
}
