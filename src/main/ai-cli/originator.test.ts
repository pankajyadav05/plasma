import { describe, expect, it } from 'vitest';
import { codexEnv } from './proc';

describe('codex app-server environment', () => {
  it('names the client "Plasma" unless the user already set a name', () => {
    const saved = process.env.CODEX_INTERNAL_ORIGINATOR_OVERRIDE;
    try {
      Reflect.deleteProperty(process.env, 'CODEX_INTERNAL_ORIGINATOR_OVERRIDE');
      expect(codexEnv().CODEX_INTERNAL_ORIGINATOR_OVERRIDE).toBe('Plasma');
      process.env.CODEX_INTERNAL_ORIGINATOR_OVERRIDE = 'Mine';
      expect(codexEnv().CODEX_INTERNAL_ORIGINATOR_OVERRIDE).toBe('Mine');
    } finally {
      if (saved === undefined) {
        Reflect.deleteProperty(process.env, 'CODEX_INTERNAL_ORIGINATOR_OVERRIDE');
      } else {
        process.env.CODEX_INTERNAL_ORIGINATOR_OVERRIDE = saved;
      }
    }
  });
});
