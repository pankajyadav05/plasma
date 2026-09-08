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
