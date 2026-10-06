/**
 * The model list behind the assistant's model picker: normalising what
 * OpenRouter (or a local server) returns, grouping it for display, and
 * searching it. Pure, so it is tested without a window or a network.
 */
import { z } from 'zod';

export const AiModelSchema = z.object({
  id: z.string().min(1),
  /** Display name, vendor prefix stripped ("Claude Sonnet 5.5"). */
  name: z.string(),
  /** Id prefix ("anthropic"); "local" for a local server. */
  vendor: z.string(),
  vendorName: z.string(),
  /** Unix seconds; 0 when unknown. */
  created: z.number(),
  contextLength: z.number().nullable(),
  /** USD per 1M tokens. */
  promptPrice: z.number().nullable(),
  completionPrice: z.number().nullable(),
  tools: z.boolean(),
  vision: z.boolean(),
  free: z.boolean(),
  /** Unix seconds, or null when the model does not expire. */
  expires: z.number().nullable(),
});
export type AiModel = z.infer<typeof AiModelSchema>;

export type AiModelsResult = {
  models: AiModel[];
  /** Unix ms of the list (0 when there is none). */
  fetchedAt: number;
  source: 'live' | 'cache' | 'none';
  error?: string;
};

export type VendorInfo = { id: string; name: string };

/** The rail's main vendors, in order. Everything else is "Other". */
export const VENDORS: readonly VendorInfo[] = [
  { id: 'anthropic', name: 'Anthropic' },
  { id: 'openai', name: 'OpenAI' },
  { id: 'google', name: 'Google' },
  { id: 'x-ai', name: 'xAI' },
  { id: 'meta-llama', name: 'Meta' },
  { id: 'mistralai', name: 'Mistral' },
  { id: 'deepseek', name: 'DeepSeek' },
  { id: 'qwen', name: 'Qwen' },
];
export const OTHER_VENDOR: VendorInfo = { id: 'other', name: 'Other' };

const MAIN_VENDOR_IDS = new Set(VENDORS.map((v) => v.id));

/** Rail bucket of a model: its vendor id when main, else "other". */
export function railVendor(model: Pick<AiModel, 'vendor'>): string {
  return MAIN_VENDOR_IDS.has(model.vendor) ? model.vendor : OTHER_VENDOR.id;
}

const MONOGRAMS: Record<string, string> = {
  OpenAI: 'O',
  xAI: 'x',
  Mistral: 'Mi',
  Meta: 'M',
};

/** One or two letters for a vendor tile ("Anthropic" -> "A", "DeepSeek" -> "DS"). */
export function vendorMonogram(name: string): string {
  const fixed = MONOGRAMS[name];
  if (fixed) return fixed;
  const words = name.match(/[A-Z][a-z]*|[a-z]+|\d+/g) ?? [];
  if (words.length >= 2) return `${words[0]?.[0] ?? ''}${words[1]?.[0] ?? ''}`.toUpperCase();
  return (name.trim()[0] ?? '?').toUpperCase();
}

/** "x-ai/grok-4" -> "x-ai"; ids without a slash have no vendor. */
export function vendorOfId(id: string): string {
  const slash = id.indexOf('/');
  return slash > 0 ? id.slice(0, slash) : '';
}

/** A short id for a vendor whose prefix is unknown, to show "Other" names ("inclusionAI"). */
function prettyVendor(prefix: string, namePrefix: string | null): string {
  const known = VENDORS.find((v) => v.id === prefix);
  if (known) return known.name;
  if (namePrefix) return namePrefix;
  return prefix || 'Other';
}

const RawModel = z.object({
  id: z.string().min(1),
  name: z.string().optional(),
  created: z.number().optional().nullable(),
  context_length: z.number().optional().nullable(),
  architecture: z
    .object({
      input_modalities: z.array(z.string()).optional().nullable(),
      output_modalities: z.array(z.string()).optional().nullable(),
    })
    .optional()
    .nullable(),
  pricing: z
    .object({
      prompt: z.union([z.string(), z.number()]).optional().nullable(),
      completion: z.union([z.string(), z.number()]).optional().nullable(),
    })
    .optional()
    .nullable(),
  supported_parameters: z.array(z.string()).optional().nullable(),
  expiration_date: z.union([z.string(), z.number()]).optional().nullable(),
});

/** USD per token (string) -> USD per 1M tokens; null when absent or negative (routers). */
function perMillion(v: string | number | null | undefined): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : Number.parseFloat(v);
  if (!Number.isFinite(n) || n < 0) return null;
  return Number((n * 1_000_000).toPrecision(6));
}

function expiryOf(v: string | number | null | undefined): number | null {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number') return v > 1e11 ? Math.floor(v / 1000) : v;
  const ms = Date.parse(v);
  return Number.isNaN(ms) ? null : Math.floor(ms / 1000);
}

/**
 * OpenRouter's `/models` body -> picker models. A bad item is dropped, never
 * the whole list. Dropped on purpose: `:batch` ids (not for streaming chat),
 * models that do not output text, and expired ones.
 */
export function normalizeOpenRouterModels(raw: unknown, now: number = Date.now()): AiModel[] {
  const data = (raw as { data?: unknown } | null)?.data;
  if (!Array.isArray(data)) return [];
  const out: AiModel[] = [];
  const seen = new Set<string>();
  for (const item of data) {
    const parsed = RawModel.safeParse(item);
    if (!parsed.success) continue;
    const m = parsed.data;
    if (seen.has(m.id) || m.id.endsWith(':batch')) continue;
    const outputs = m.architecture?.output_modalities;
    if (outputs && !outputs.includes('text')) continue;
    const expires = expiryOf(m.expiration_date);
    if (expires !== null && expires * 1000 <= now) continue;
    seen.add(m.id);

    const vendor = vendorOfId(m.id);
    const rawName = (m.name ?? '').trim() || m.id.slice(m.id.indexOf('/') + 1);
    const colon = rawName.indexOf(': ');
    const namePrefix = colon > 0 ? rawName.slice(0, colon) : null;
    let name = colon > 0 ? rawName.slice(colon + 2) : rawName;
    const promptPrice = perMillion(m.pricing?.prompt);
    const completionPrice = perMillion(m.pricing?.completion);
    const free = m.id.endsWith(':free') || (promptPrice === 0 && completionPrice === 0);
    name = name.replace(/\s*\(free\)\s*$/i, '').trim() || name;
    out.push({
      id: m.id,
      name,
      vendor,
      vendorName: prettyVendor(vendor, namePrefix),
      created: m.created ?? 0,
      contextLength: m.context_length ?? null,
      promptPrice,
      completionPrice,
      tools: m.supported_parameters?.includes('tools') ?? false,
      vision: m.architecture?.input_modalities?.includes('image') ?? false,
      free,
      expires,
    });
  }
  return out;
}

/**
 * A local server's `GET /models` ({data:[{id}]}, Ollama and LM Studio both).
 * Nothing is known about tool support, so none is claimed missing.
 */
export function normalizeLocalModels(raw: unknown): AiModel[] {
  const data = (raw as { data?: unknown } | null)?.data;
  if (!Array.isArray(data)) return [];
  const out: AiModel[] = [];
  const seen = new Set<string>();
  for (const item of data) {
    const id = (item as { id?: unknown } | null)?.id;
    if (typeof id !== 'string' || id.trim() === '' || seen.has(id)) continue;
    seen.add(id);
    out.push({
      id,
      name: id,
      vendor: 'local',
      vendorName: 'Local',
      created: 0,
      contextLength: null,
      promptPrice: null,
      completionPrice: null,
      tools: true,
      vision: false,
      free: true,
      expires: null,
    });
  }
  return out;
}

/**
 * The model's family: its name without version numbers, dates and
 * "preview" / "latest". "Claude Opus 5.5" -> "Claude Opus",
 * "GPT-6.1 Sol Pro" -> "GPT Sol Pro".
 */
export function modelFamily(model: Pick<AiModel, 'name'>): string {
  const family = model.name
    .replace(/\([^)]*\)/g, ' ')
    .replace(/\b(preview|latest)\b/gi, ' ')
    // A trailing number glued to a word: "Qwen3" -> "Qwen".
    .replace(/([A-Za-z])\d+(?:\.\d+)*(?=$|[\s-])/g, '$1')
    // A standalone version, size or date: " 5.5", "-6.1", " 70B", " 2025-05-14".
    .replace(/(^|[\s-])v?\d+(?:[.\-_]\d+)*[a-z]{0,2}(?=$|[\s-])/gi, ' ')
    .replace(/\s*-\s*(?=\s|$)/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return family || model.name;
}

const DAY_S = 86_400;

/** Created within the last 30 days. */
export function isNew(model: Pick<AiModel, 'created'>, now: number = Date.now()): boolean {
  if (!model.created) return false;
  return now / 1000 - model.created <= 30 * DAY_S;
}

/**
 * One vendor's models split for display. Latest: per family the two newest,
 * and only from the last 12 months. Everything else is legacy. Newest first.
 */
export function groupForVendor(
  models: readonly AiModel[],
  now: number = Date.now(),
): { latest: AiModel[]; legacy: AiModel[] } {
  const sorted = [...models].sort((a, b) => b.created - a.created || a.id.localeCompare(b.id));
  const cutoff = now / 1000 - 365 * DAY_S;
  const perFamily = new Map<string, number>();
  const latest: AiModel[] = [];
  const legacy: AiModel[] = [];
  for (const m of sorted) {
    // A free variant is its own line, so it does not use up the paid slots.
    const key = `${modelFamily(m)}${m.free ? ' (free)' : ''}`;
    const n = perFamily.get(key) ?? 0;
    if (n < 2 && m.created >= cutoff) {
      perFamily.set(key, n + 1);
      latest.push(m);
    } else {
      legacy.push(m);
    }
  }
  return { latest, legacy };
}

/** Case-insensitive; every word must appear in the name, id or vendor name. */
export function searchModels(models: readonly AiModel[], query: string): AiModel[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [...models];
  return models.filter((m) => {
    const hay = `${m.name} ${m.id} ${m.vendorName}`.toLowerCase();
    return words.every((w) => hay.includes(w));
  });
}

/** "vendor/model" shaped text the user may mean as an id. */
export function looksLikeModelId(text: string): boolean {
  return /^[\w.-]+\/[^\s/][^\s]*$/.test(text.trim());
}

/** 1048576 -> "1M", 200000 -> "200K". */
export function formatContext(n: number | null | undefined): string {
  if (!n || n <= 0) return '';
  if (n >= 1_000_000) return `${Number((n / 1_000_000).toFixed(1))}M`;
  if (n >= 1000) return `${Math.round(n / 1000)}K`;
  return String(n);
}

function priceText(p: number): string {
  return p === 0 ? '0' : String(Number(p.toFixed(p < 1 ? 3 : 2)));
}

/** "$3 / $15 per 1M", "Free", or "" when the price is unknown. */
export function formatPrice(
  model: Pick<AiModel, 'free' | 'promptPrice' | 'completionPrice'>,
): string {
  if (model.free) return 'Free';
  if (model.promptPrice === null || model.completionPrice === null) return '';
  return `$${priceText(model.promptPrice)} / $${priceText(model.completionPrice)} per 1M`;
}

/** "2 h ago", "just now", "3 d ago". */
export function formatAgo(ms: number, now: number = Date.now()): string {
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86_400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86_400)} d ago`;
}

/** Push `id` to the front of the recents, de-duplicated, at most `max`. */
export function pushRecent(recents: readonly string[], id: string, max = 5): string[] {
  return [id, ...recents.filter((r) => r !== id)].slice(0, max);
}

/** A model known only by its id (a favourite or recent that is not in the list, a typed id). */
export function stubModel(id: string): AiModel {
  const vendor = vendorOfId(id);
  const tail = vendor ? id.slice(vendor.length + 1) : id;
  return {
    id,
    name: tail || id,
    vendor,
    vendorName: prettyVendor(vendor, null),
    created: 0,
    contextLength: null,
    promptPrice: null,
    completionPrice: null,
    // Unknown: do not claim the model cannot call tools.
    tools: true,
    vision: false,
    free: false,
    expires: null,
  };
}
