import type { PlasmaAPI } from '@shared/protocol';

/**
 * Typed facade over `window.plasma`.
 *
 * We use a Proxy so access is validated each time. If the preload failed
 * to load (common cause: renderer HMR reloaded but Electron wasn't
 * restarted after a preload edit), every call throws a clear actionable
 * message instead of a cryptic "Cannot read properties of undefined".
 */
export const ipc = new Proxy({} as PlasmaAPI, {
  get(_target, prop) {
    const plasma = (window as Window & { plasma?: PlasmaAPI }).plasma;
    if (!plasma) {
      throw new Error(
        '[plasma] window.plasma is undefined — the preload script did not load. ' +
          'Hard-restart the dev server: Ctrl+C in the terminal running `pnpm dev`, then run it again. ' +
          "If that doesn't fix it, check the terminal for a preload build error.",
      );
    }
    return plasma[prop as keyof PlasmaAPI];
  },
});
