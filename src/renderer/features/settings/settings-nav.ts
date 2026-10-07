import { useSession } from '@/stores/session';
import type { SettingsSectionId } from './SettingsBody';

/** Open Settings on a given section (the connection card's "Allow AI tools…"). */
let requested: SettingsSectionId | null = null;

export function openSettingsSection(id: SettingsSectionId): void {
  requested = id;
  useSession.getState().setCanvasMode('settings');
}

/** The section someone asked for, once. */
export function takeRequestedSection(): SettingsSectionId | null {
  const r = requested;
  requested = null;
  return r;
}
