/**
 * Allowlist of main → renderer push channels bridged by the preload.
 *
 * Kept out of `index.ts` so it can be asserted against `IpcChannel`
 * without running contextBridge: a channel main sends but the preload
 * omits makes `plasmaEvents.on` throw, which unmounts the whole React
 * tree (blank window, no window.plasma failure to point at it).
 */
export const eventChannels = [
  'plasma:menu:newTab',
  'plasma:menu:closeTab',
  'plasma:menu:exportCsv',
  'plasma:menu:exportJson',
  'plasma:menu:toggleSidebar',
  'plasma:menu:toggleEditor',
  'plasma:menu:palette',
  'plasma:menu:toggleAi',
  'plasma:menu:cheatSheet',
  'plasma:menu:runQuery',
  'plasma:menu:runQueryAll',
  'plasma:menu:cancelQuery',
  'plasma:menu:history',
  'plasma:window:maximizedChanged',
  'plasma:update:status',
  'plasma:ai:event',
  'plasma:redis:pubsub',
  'plasma:query:chunk',
  'plasma:pg:notice',
] as const;

export type EventChannel = (typeof eventChannels)[number];
