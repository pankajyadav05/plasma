import { Search, X } from 'lucide-react';

/** Search field used at the top of each sidebar mode. */
export function SidebarSearch({
  value,
  onChange,
  placeholder,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
}) {
  return (
    <div className="relative min-w-0 flex-1">
      <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        aria-label={placeholder.replace(/…$/, '')}
        className="h-8 w-full rounded-md border border-sidebar-border bg-background pl-8 pr-7 text-sm text-foreground outline-none transition-colors placeholder:text-muted-foreground focus:border-primary"
      />
      {value && (
        <button
          type="button"
          onClick={() => onChange('')}
          className="absolute right-1.5 top-1/2 grid h-5 w-5 -translate-y-1/2 place-items-center rounded-sm text-muted-foreground hover:text-foreground"
          aria-label="Clear search"
        >
          <X className="h-3 w-3" />
        </button>
      )}
    </div>
  );
}

export function SidebarEmpty({ title, hint }: { title: string; hint?: string }) {
  return (
    <div className="px-4 py-3">
      <div className="font-display text-sm italic text-muted-foreground">{title}</div>
      {hint && (
        <div className="mt-1 font-display text-xs italic text-muted-foreground/80">{hint}</div>
      )}
    </div>
  );
}
