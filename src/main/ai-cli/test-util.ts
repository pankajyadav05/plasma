import { fileURLToPath } from 'node:url';

/** Helpers shared by the CLI provider tests. */
export const FAKE_CLI = fileURLToPath(new URL('./fake-cli.mjs', import.meta.url));

export function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function waitDead(pid: number, ms = 5000): Promise<void> {
  const end = Date.now() + ms;
  while (alive(pid) && Date.now() < end) await new Promise((r) => setTimeout(r, 25));
}

export function unsetEnv(...names: string[]): void {
  for (const n of names) Reflect.deleteProperty(process.env, n);
}
