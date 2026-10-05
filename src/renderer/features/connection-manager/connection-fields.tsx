import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Pill } from '@/components/ui/workbench';
import { cn } from '@/lib/cn';
import type { OpenSearchOptions } from '@shared/protocol';
import { ChevronRight } from 'lucide-react';
import type { FormErrors, FormField } from './connection-form';

/** 26px multi-line field styled like Input. */
export const TEXTAREA_CLASS =
  'rounded-[7px] bg-[var(--wb-field)] px-2 py-1.5 font-mono text-[12px] text-[var(--wb-text)] shadow-[inset_0_0_0_1px_var(--wb-toolbar-group-edge)] outline-none placeholder:text-[var(--wb-text-3)] focus-visible:shadow-[inset_0_0_0_1px_var(--ring)] aria-[invalid=true]:shadow-[inset_0_0_0_1px_var(--destructive)]';

export function Field({
  label,
  htmlFor,
  error,
  children,
}: {
  label: string;
  htmlFor?: string;
  error?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <Label htmlFor={htmlFor}>{label}</Label>
      {children}
      {error && <FieldError id={htmlFor ? `${htmlFor}-error` : undefined}>{error}</FieldError>}
    </div>
  );
}

export function FieldError({ id, children }: { id?: string; children: React.ReactNode }) {
  return (
    <p id={id} role="alert" className="text-[12px] leading-snug text-[var(--destructive)]">
      {children}
    </p>
  );
}

export function Hint({ children }: { children: React.ReactNode }) {
  return <p className="text-[12px] leading-snug text-[var(--wb-text-2)]">{children}</p>;
}

export function FileField({
  label,
  value,
  placeholder,
  error,
  onChange,
  onBrowse,
}: {
  label: string;
  value: string;
  placeholder?: string;
  error?: string;
  onChange: (v: string) => void;
  onBrowse: () => void;
}) {
  const id = `conn-tls-${label.toLowerCase().replace(/\s+/g, '-')}`;
  return (
    <Field label={label} htmlFor={id} error={error}>
      <div className="flex gap-2">
        <Input
          id={id}
          value={value}
          aria-invalid={error ? true : undefined}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          spellCheck={false}
          className="font-mono text-[12px]"
        />
        <Pill onClick={onBrowse} className="h-[26px]">
          Browse…
        </Pill>
      </div>
    </Field>
  );
}

/** Small on/off switch. Pair it with a <label htmlFor={id}> or aria-label. */
export function Switch({
  id,
  checked,
  disabled,
  onCheckedChange,
  'aria-label': ariaLabel,
}: {
  id?: string;
  checked: boolean;
  disabled?: boolean;
  onCheckedChange: (v: boolean) => void;
  'aria-label'?: string;
}) {
  return (
    <button
      id={id}
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel}
      disabled={disabled}
      onClick={() => onCheckedChange(!checked)}
      className={cn(
        'relative h-[18px] w-[30px] shrink-0 cursor-pointer rounded-full transition-colors',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background',
        'disabled:cursor-not-allowed disabled:opacity-40',
        checked
          ? 'bg-[var(--wb-text)]'
          : 'bg-[var(--wb-field)] shadow-[inset_0_0_0_1px_var(--wb-toolbar-group-edge)]',
      )}
    >
      <span
        aria-hidden
        className={cn(
          'absolute top-[3px] h-3 w-3 rounded-full transition-[left]',
          checked ? 'left-[15px] bg-[var(--wb-content)]' : 'left-[3px] bg-[var(--wb-text-3)]',
        )}
      />
    </button>
  );
}

/** One card of the connection form. */
export function SectionCard({
  id,
  title,
  hint,
  action,
  open = true,
  onToggle,
  children,
}: {
  id: string;
  title: string;
  hint: string;
  /** Right side of the header (a switch, a link). */
  action?: React.ReactNode;
  /** Collapsible cards show a chevron button; omit `onToggle` for a fixed card. */
  open?: boolean;
  onToggle?: () => void;
  children?: React.ReactNode;
}) {
  const titleId = `${id}-title`;
  const heading = (
    <span className="flex min-w-0 flex-col gap-0.5 text-left">
      <h2 id={titleId} className="text-[13px] font-semibold text-[var(--wb-text)]">
        {title}
      </h2>
      <span className="text-[12px] text-[var(--wb-text-2)]">{hint}</span>
    </span>
  );
  return (
    <section
      id={id}
      aria-labelledby={titleId}
      data-section={id}
      className="scroll-mt-4 rounded-[10px] bg-[var(--wb-sidebar)] p-4 shadow-[inset_0_0_0_1px_var(--wb-separator)]"
    >
      <div className="flex items-start gap-3">
        {onToggle ? (
          <button
            type="button"
            onClick={onToggle}
            aria-expanded={open}
            className="flex min-w-0 flex-1 cursor-pointer items-start gap-1.5 rounded-[5px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <ChevronRight
              className={cn(
                'mt-0.5 h-3.5 w-3.5 shrink-0 text-[var(--wb-text-2)] transition-transform',
                open && 'rotate-90',
              )}
            />
            {heading}
          </button>
        ) : (
          <div className="min-w-0 flex-1">{heading}</div>
        )}
        {action && <div className="flex shrink-0 items-center gap-2">{action}</div>}
      </div>
      {open && children && <div className="mt-3 flex flex-col gap-3">{children}</div>}
    </section>
  );
}

const OS_AUTH_LABEL: Record<NonNullable<OpenSearchOptions['auth']>, string> = {
  basic: 'Username and password',
  apiKey: 'API key',
  sigv4: 'AWS SigV4 (Amazon OpenSearch)',
};

type OsChange = (patch: Partial<OpenSearchOptions>, field?: FormField) => void;

const keepHint = (isEditing: boolean, saved: boolean | undefined) =>
  isEditing && saved ? 'Saved — leave blank to keep' : undefined;

/** O12: how to authenticate to OpenSearch. User and password (basic) render in the caller. */
export function OpenSearchAuthFields({
  options,
  errors,
  onChange,
  isEditing,
}: {
  options: OpenSearchOptions;
  errors: FormErrors;
  onChange: OsChange;
  isEditing: boolean;
}) {
  const auth = options.auth ?? 'basic';
  return (
    <>
      <Field label="Method" htmlFor="os-auth" error={errors.osAuth}>
        <Select value={auth} onValueChange={(v) => onChange({ auth: v as typeof auth })}>
          <SelectTrigger id="os-auth" aria-label="Authentication" className="h-[26px] text-[13px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {(Object.keys(OS_AUTH_LABEL) as Array<keyof typeof OS_AUTH_LABEL>).map((m) => (
              <SelectItem key={m} value={m} className="text-[13px]">
                {OS_AUTH_LABEL[m]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>
      {auth === 'basic' && <Hint>Leave both empty for an open cluster.</Hint>}
      {auth === 'apiKey' && (
        <Field label="API key" htmlFor="os-api-key">
          <Input
            id="os-api-key"
            type="password"
            value={options.apiKey ?? ''}
            onChange={(e) => onChange({ apiKey: e.target.value })}
            placeholder={keepHint(isEditing, options.hasApiKey) ?? 'id:key or base64-encoded key'}
            spellCheck={false}
          />
        </Field>
      )}
      {auth === 'sigv4' && (
        <div className="grid grid-cols-2 gap-3">
          <Field label="AWS region" htmlFor="os-aws-region">
            <Input
              id="os-aws-region"
              value={options.awsRegion ?? ''}
              onChange={(e) => onChange({ awsRegion: e.target.value })}
              placeholder="eu-west-1"
            />
          </Field>
          <Field label="Service" htmlFor="os-aws-service">
            <Select
              value={options.awsService ?? 'es'}
              onValueChange={(v) => onChange({ awsService: v as 'es' | 'aoss' })}
            >
              <SelectTrigger
                id="os-aws-service"
                aria-label="Service"
                className="h-[26px] text-[13px]"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="es" className="text-[13px]">
                  Managed domain (es)
                </SelectItem>
                <SelectItem value="aoss" className="text-[13px]">
                  Serverless (aoss)
                </SelectItem>
              </SelectContent>
            </Select>
          </Field>
          <Field label="Access key id" htmlFor="os-aws-key-id">
            <Input
              id="os-aws-key-id"
              value={options.awsAccessKeyId ?? ''}
              onChange={(e) => onChange({ awsAccessKeyId: e.target.value })}
              spellCheck={false}
            />
          </Field>
          <Field label="Secret access key" htmlFor="os-aws-secret">
            <Input
              id="os-aws-secret"
              type="password"
              value={options.awsSecretAccessKey ?? ''}
              onChange={(e) => onChange({ awsSecretAccessKey: e.target.value })}
              placeholder={keepHint(isEditing, options.hasAwsSecretAccessKey)}
            />
          </Field>
          <div className="col-span-2">
            <Field label="Session token (optional)" htmlFor="os-aws-token">
              <Input
                id="os-aws-token"
                type="password"
                value={options.awsSessionToken ?? ''}
                onChange={(e) => onChange({ awsSessionToken: e.target.value })}
                placeholder={keepHint(isEditing, options.hasAwsSessionToken)}
              />
            </Field>
          </div>
        </div>
      )}
    </>
  );
}

/** O12: path prefix and extra nodes for OpenSearch (Server card). */
export function OpenSearchServerFields({
  options,
  errors,
  onChange,
}: {
  options: OpenSearchOptions;
  errors: FormErrors;
  onChange: OsChange;
}) {
  return (
    <>
      <Field label="Path prefix (optional)" htmlFor="os-path-prefix">
        <Input
          id="os-path-prefix"
          value={options.pathPrefix ?? ''}
          onChange={(e) => onChange({ pathPrefix: e.target.value })}
          placeholder="/search — when the cluster sits behind a reverse proxy"
          spellCheck={false}
        />
      </Field>
      <Field label="Additional nodes (optional)" htmlFor="os-nodes" error={errors.osNodes}>
        <textarea
          id="os-nodes"
          value={(options.nodes ?? []).join('\n')}
          onChange={(e) => onChange({ nodes: e.target.value.split('\n') }, 'osNodes')}
          rows={2}
          spellCheck={false}
          aria-invalid={errors.osNodes ? true : undefined}
          placeholder={'One per line: node2.example.com:9200 or https://node3:9200'}
          className={TEXTAREA_CLASS}
        />
      </Field>
    </>
  );
}
