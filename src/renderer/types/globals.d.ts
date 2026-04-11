import type { PlasmaAPI } from '@shared/protocol';

/**
 * Renderer-side ambient declaration for the preload-injected globals.
 * The preload script's own `declare global` is not visible here because
 * tsconfig.web.json doesn't include src/preload/**.
 */
declare global {
  interface Window {
    plasma: PlasmaAPI;
    plasmaEvents: {
      on(channel: string, handler: () => void): () => void;
    };
  }
}

export {};
