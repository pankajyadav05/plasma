import { KEYMAP } from '@shared/keymap';
import { IpcChannel } from '@shared/protocol';
import { expect, test } from 'vitest';
import { eventChannels } from './event-channels';

/**
 * Every main → renderer push channel in `IpcChannel` (the `*Event` keys)
 * must be bridged. `plasmaEvents.on` throws on an unlisted channel, and
 * App.tsx subscribes during mount — an omission takes the whole renderer
 * down to a blank window instead of degrading one feature.
 */
test('IpcChannel event channels are all bridged by the preload', () => {
  const pushChannels = Object.entries(IpcChannel)
    .filter(([key]) => key.endsWith('Event'))
    .map(([, channel]) => channel);

  expect(pushChannels.length).toBeGreaterThan(0);
  const missing = pushChannels.filter((channel) => !eventChannels.some((c) => c === channel));
  expect(missing).toEqual([]);
});

/** Native menu items send `menuChannel`; the renderer must be able to subscribe. */
test('every keymap menu channel is bridged by the preload', () => {
  const missing = KEYMAP.flatMap((b) => (b.menuChannel ? [b.menuChannel] : [])).filter(
    (channel) => !eventChannels.some((c) => c === channel),
  );
  expect(missing).toEqual([]);
});

/** Literal `plasma:menu:*` channels sent by main/menu.ts (non-keymap items). */
test('every channel literal in the native menu is bridged and handled by the renderer', async () => {
  const { readFileSync } = await import('node:fs');
  const menu = readFileSync(new URL('../main/menu.ts', import.meta.url), 'utf8');
  const app = readFileSync(new URL('../renderer/app/App.tsx', import.meta.url), 'utf8');
  const literals = [...new Set(menu.match(/plasma:menu:[A-Za-z]+/g) ?? [])];
  expect(literals.length).toBeGreaterThan(0);
  expect(literals.filter((c) => !eventChannels.some((e) => e === c))).toEqual([]);
  expect(literals.filter((c) => !app.includes(`'${c}'`))).toEqual([]);
});
