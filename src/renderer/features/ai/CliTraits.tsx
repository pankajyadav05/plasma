import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { cliModelOf } from '@/lib/ai-config';
import { cn } from '@/lib/cn';
import { useSession } from '@/stores/session';
import { type AiCliProvider, isAiCliProvider } from '@shared/ai-cli';
import { type CliTraits, cliTraits, findCliModel, storedOption } from '@shared/cli-models';
import type { Settings } from '@shared/protocol';
import { Brain, Check, ChevronDown, Ellipsis } from 'lucide-react';
import { type KeyboardEvent, type ReactNode, useId, useState } from 'react';
import { useCliModels } from './ModelPicker';

/**
 * Reasoning and speed of the selected Codex / Claude Code model, in the composer.
 * They write the same settings as Settings > AI, so both places always agree
 * ('' = the model's own default), and the next message uses them.
 */

/** The traits of the selected CLI model, or null for any other provider / a model with none. */
export function useCliTraitsState(): {
  provider: AiCliProvider;
  traits: CliTraits;
  setEffort: (id: string) => void;
  setTier: (id: string) => void;
} | null {
  const provider = useSession((s) => s.settings.aiProvider);
  const model = useSession((s) => cliModelOf(s.settings));
  const effort = useSession((s) =>
    s.settings.aiProvider === 'codex' ? s.settings.aiCodexEffort : s.settings.aiClaudeCodeEffort,
  );
  const tier = useSession((s) => s.settings.aiCodexServiceTier);
  const updateSettings = useSession((s) => s.updateSettings);
  const cli = isAiCliProvider(provider) ? provider : null;
  const list = useCliModels(cli ?? 'codex');
  if (!cli) return null;
  const models = list?.models ?? [];
  // A saved alias ("sonnet") or '' (the default) resolves to a listed model; a custom name has none.
  const picked =
    findCliModel(models, model) ?? (model === '' ? models.find((m) => m.isDefault) : undefined);
  const traits = cliTraits(cli, picked, { effort, serviceTier: tier });
  if (!traits.effort && !traits.tier) return null;
  const effortKey = cli === 'codex' ? 'aiCodexEffort' : 'aiClaudeCodeEffort';
  return {
    provider: cli,
    traits,
    setEffort: (id) =>
      void updateSettings({
        [effortKey]: traits.effort ? storedOption(traits.effort.options, id) : '',
      } as Partial<Settings>),
    setTier: (id) =>
      void updateSettings({
        aiCodexServiceTier: traits.tier ? storedOption(traits.tier.options, id) : '',
      }),
  };
}

const TRIGGER =
  'inline-flex h-6 shrink-0 items-center gap-1.5 rounded-[6px] px-1.5 text-[12px] leading-none text-[var(--wb-text-2)] transition-colors duration-100 hover:bg-[var(--wb-control-hover)] hover:text-[var(--wb-text)] data-[state=open]:bg-[var(--wb-control)] data-[state=open]:text-[var(--wb-text)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring';

/** The chip next to the model chip: "Medium", "High · Fast". */
export function TraitsChip({
  className,
  dense = false,
}: {
  className?: string;
  /** A tight panel: no chevron, so the model chip keeps its name. */
  dense?: boolean;
}) {
  const state = useCliTraitsState();
  const [open, setOpen] = useState(false);
  if (!state) return null;
  const { traits } = state;
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={`Reasoning and speed: ${traits.label}. Change`}
          title={`Reasoning and speed: ${traits.label}`}
          data-testid="composer-traits"
          className={cn(TRIGGER, 'max-w-[10rem]', dense && 'gap-1 px-1', className)}
        >
          <Brain aria-hidden className="h-3.5 w-3.5 shrink-0" />
          <span className="truncate">{traits.label}</span>
          {!dense && <ChevronDown aria-hidden className="h-3 w-3 shrink-0 opacity-70" />}
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        side="top"
        aria-label="Reasoning and speed"
        className="w-[236px] p-1"
        onOpenAutoFocus={focusSelected}
        onKeyDown={menuKeys}
      >
        <TraitsMenu state={state} onDone={() => setOpen(false)} />
      </PopoverContent>
    </Popover>
  );
}

/**
 * The narrow-composer fold: one "..." button whose menu holds the traits and the
 * other composer choices (`extra`), so a small panel keeps a single quiet control.
 */
export function CompactControlsMenu({
  className,
  withTraits,
  extra,
}: {
  className?: string;
  /** Include the reasoning / speed groups (the panel is too narrow for their chip). */
  withTraits: boolean;
  extra?: ReactNode;
}) {
  const found = useCliTraitsState();
  const state = withTraits ? found : null;
  const [open, setOpen] = useState(false);
  if (!state && !extra) return null;
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label="More composer controls"
          title={state ? `More controls · ${state.traits.label}` : 'More controls'}
          data-testid="composer-more"
          className={cn(TRIGGER, 'w-6 justify-center px-0', className)}
        >
          <Ellipsis aria-hidden className="h-3.5 w-3.5" />
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        side="top"
        aria-label="Composer controls"
        className="w-[236px] p-1"
        onOpenAutoFocus={focusSelected}
        onKeyDown={menuKeys}
      >
        {state && <TraitsMenu state={state} onDone={() => setOpen(false)} />}
        {state && extra && <Rule />}
        {extra}
      </PopoverContent>
    </Popover>
  );
}

function focusSelected(e: Event) {
  e.preventDefault();
  const root = e.currentTarget as HTMLElement;
  (
    root.querySelector<HTMLElement>('[role="menuitemradio"][aria-checked="true"]') ??
    root.querySelector<HTMLElement>('[role="menuitemradio"]')
  )?.focus();
}

export const Rule = () => <div aria-hidden className="my-1 h-px bg-[var(--wb-separator)]" />;

/** Arrow keys, Home and End move between the radio items of a menu. */
export function menuKeys(e: KeyboardEvent<HTMLElement>) {
  const keys = ['ArrowDown', 'ArrowUp', 'Home', 'End'];
  if (!keys.includes(e.key)) return;
  const items = Array.from(
    e.currentTarget.querySelectorAll<HTMLElement>('[role="menuitemradio"]:not(:disabled)'),
  );
  if (items.length === 0) return;
  e.preventDefault();
  const at = items.indexOf(document.activeElement as HTMLElement);
  let next = at;
  if (e.key === 'Home') next = 0;
  else if (e.key === 'End') next = items.length - 1;
  else if (e.key === 'ArrowDown') next = at < 0 ? 0 : (at + 1) % items.length;
  else next = at < 0 ? items.length - 1 : (at - 1 + items.length) % items.length;
  items[next]?.focus();
}

function TraitsMenu({
  state,
  onDone,
}: {
  state: NonNullable<ReturnType<typeof useCliTraitsState>>;
  onDone: () => void;
}) {
  const { traits, setEffort, setTier } = state;
  return (
    <div role="menu" aria-label="Reasoning and speed">
      {traits.effort && (
        <Group label="Reasoning" testId="composer-traits-effort-group">
          {traits.effort.options.map((o) => (
            <Item
              key={o.id}
              testId={`composer-traits-effort-${o.id}`}
              selected={o.id === traits.effort?.value}
              label={o.label}
              isDefault={o.isDefault === true}
              description={o.description}
              onSelect={() => {
                setEffort(o.id);
                onDone();
              }}
            />
          ))}
        </Group>
      )}
      {traits.effort && traits.tier && <Rule />}
      {traits.tier && (
        <Group label="Speed" testId="composer-traits-tier-group">
          {traits.tier.options.map((o) => (
            <Item
              key={o.id}
              testId={`composer-traits-tier-${o.id}`}
              selected={o.id === traits.tier?.value}
              label={o.label}
              isDefault={o.isDefault === true}
              description={o.description}
              onSelect={() => {
                setTier(o.id);
                onDone();
              }}
            />
          ))}
        </Group>
      )}
    </div>
  );
}

/** A titled group of radio items (also used for the folded Views / Row data choices). */
export function Group({
  label,
  children,
  testId,
}: {
  label: string;
  children: ReactNode;
  testId?: string;
}) {
  const id = useId();
  return (
    // biome-ignore lint/a11y/useSemanticElements: a menu group, not a fieldset
    <div role="group" aria-labelledby={id} data-testid={testId}>
      <div id={id} className="px-2 pb-0.5 pt-1.5 text-[11px] font-medium text-[var(--wb-text-3)]">
        {label}
      </div>
      {children}
    </div>
  );
}

export function Item({
  selected,
  label,
  isDefault,
  description,
  onSelect,
  testId,
}: {
  selected: boolean;
  label: string;
  isDefault?: boolean;
  description?: string | undefined;
  onSelect: () => void;
  testId?: string;
}) {
  return (
    <button
      type="button"
      role="menuitemradio"
      aria-checked={selected}
      data-testid={testId}
      tabIndex={-1}
      onClick={onSelect}
      className={cn(
        'flex w-full cursor-pointer items-start gap-2 rounded-[6px] px-2 py-1 text-left transition-colors duration-100',
        'hover:bg-[var(--wb-control-hover)] focus-visible:bg-[var(--wb-selected)] focus-visible:outline-none',
      )}
    >
      <span className="min-w-0 flex-1">
        <span className="flex items-baseline gap-1.5 text-[12.5px] leading-[18px] text-[var(--wb-text)]">
          <span className={cn('truncate', selected && 'font-medium')}>{label}</span>
          {isDefault && <span className="text-[11px] text-[var(--wb-text-3)]">Default</span>}
        </span>
        {description && (
          <span className="block text-pretty text-[11px] leading-[15px] text-[var(--wb-text-3)]">
            {description}
          </span>
        )}
      </span>
      <Check
        aria-hidden
        className={cn(
          'mt-[3px] h-3.5 w-3.5 shrink-0 text-[var(--wb-accent-text)]',
          !selected && 'invisible',
        )}
      />
    </button>
  );
}
