/**
 * Images in Assistant messages: limits, the data-URL check and the history
 * cap. Pure, so the renderer, the Zod schema and main agree on one rule set.
 */

export const AI_IMAGE_MIMES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] as const;
/** Images the user can attach to one message. */
export const AI_MAX_IMAGES_PER_MESSAGE = 6;
/** Images in a whole request; main drops the oldest ones in history beyond this. */
export const AI_MAX_IMAGES_PER_REQUEST = 12;
/** Longest accepted image data URL (characters). */
export const AI_MAX_IMAGE_DATA_URL = 4 * 1024 * 1024;
/** What the renderer aims for after downscaling and re-encoding (bytes of the data URL). */
export const AI_TARGET_IMAGE_DATA_URL = Math.floor(3.5 * 1024 * 1024);
/** The long edge, in pixels, after downscaling. */
export const AI_MAX_IMAGE_EDGE = 1568;
export const AI_IMAGE_REMOVED_TEXT = '[image removed from history]';

const DATA_URL = /^data:image\/(?:png|jpeg|webp|gif);base64,[A-Za-z0-9+/]+={0,2}$/;

/** True for a base64 data URL of an allowed image type (never http, https or file). */
export function isAiImageDataUrl(url: string): boolean {
  return url.length <= AI_MAX_IMAGE_DATA_URL && DATA_URL.test(url);
}

export type AiTextPart = { type: 'text'; text: string };
export type AiImagePart = { type: 'image_url'; image_url: { url: string } };
export type AiContentPart = AiTextPart | AiImagePart;
export type AiContent = string | AiContentPart[];

export function countImages(content: AiContent): number {
  return typeof content === 'string' ? 0 : content.filter((p) => p.type === 'image_url').length;
}

/** The text of a message, images left out. */
export function contentText(content: AiContent): string {
  if (typeof content === 'string') return content;
  return content
    .filter((p): p is AiTextPart => p.type === 'text')
    .map((p) => p.text)
    .join('\n');
}

/**
 * Keep at most `max` images in a conversation: the newest ones stay, each
 * older one becomes a short text part so the model knows something was there.
 */
export function capHistoryImages<M extends { content: AiContent }>(
  messages: readonly M[],
  max: number = AI_MAX_IMAGES_PER_REQUEST,
): M[] {
  let total = 0;
  for (const m of messages) total += countImages(m.content);
  let drop = Math.max(0, total - max);
  if (drop === 0) return [...messages];
  return messages.map((m) => {
    if (drop === 0 || typeof m.content === 'string') return m;
    const content = m.content.map((p): AiContentPart => {
      if (p.type === 'image_url' && drop > 0) {
        drop--;
        return { type: 'text', text: AI_IMAGE_REMOVED_TEXT };
      }
      return p;
    });
    return { ...m, content };
  });
}
