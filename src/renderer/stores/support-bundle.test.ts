import type { SupportBundlePreview } from '@shared/support-bundle';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const preview = vi.fn();
const save = vi.fn();
vi.mock('@/lib/ipc', () => ({ ipc: { support: { preview, save } } }));

const { useSupportBundle } = await import('./support-bundle');

const bundle = (
  token: string,
  names: string[] = ['README.txt', 'system.json'],
): SupportBundlePreview => ({
  token,
  files: names.map((name) => ({ name, description: name, text: `${name} text`, bytes: 10 })),
  totalBytes: 10 * names.length,
});

const deferred = <T>() => {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
};

beforeEach(() => {
  preview.mockReset();
  save.mockReset();
  useSupportBundle.setState({
    open: false,
    loading: false,
    saving: false,
    error: null,
    redactHostsAndUsers: false,
    preview: null,
    selected: null,
    savedPath: null,
  });
});

describe('support bundle dialog state', () => {
  it('opens, loads the bundle and shows its first file', async () => {
    preview.mockResolvedValue(bundle('t1'));
    await useSupportBundle.getState().openDialog();
    const s = useSupportBundle.getState();
    expect(s.open).toBe(true);
    expect(s.loading).toBe(false);
    expect(s.selected).toBe('README.txt');
    expect(preview).toHaveBeenCalledWith({ redactHostsAndUsers: false });
  });

  it('reloads with the toggle and keeps the file being read', async () => {
    preview.mockResolvedValue(bundle('t1'));
    await useSupportBundle.getState().openDialog();
    useSupportBundle.getState().select('system.json');
    preview.mockResolvedValue(bundle('t2'));
    await useSupportBundle.getState().setRedact(true);
    expect(preview).toHaveBeenLastCalledWith({ redactHostsAndUsers: true });
    expect(useSupportBundle.getState().preview?.token).toBe('t2');
    expect(useSupportBundle.getState().selected).toBe('system.json');
  });

  it('ignores a slow answer that arrives after a newer one', async () => {
    const slow = deferred<SupportBundlePreview>();
    preview.mockReturnValueOnce(slow.promise);
    const first = useSupportBundle.getState().openDialog();
    preview.mockResolvedValueOnce(bundle('new'));
    await useSupportBundle.getState().setRedact(true);
    slow.resolve(bundle('old'));
    await first;
    expect(useSupportBundle.getState().preview?.token).toBe('new');
    expect(useSupportBundle.getState().loading).toBe(false);
  });

  it('saves exactly the bundle on screen and remembers where it went', async () => {
    preview.mockResolvedValue(bundle('t1'));
    await useSupportBundle.getState().openDialog();
    save.mockResolvedValue({ saved: true, filePath: '/tmp/plasma-support.zip', bytes: 1234 });
    await useSupportBundle.getState().save();
    expect(save).toHaveBeenCalledWith('t1');
    expect(useSupportBundle.getState().savedPath).toBe('/tmp/plasma-support.zip');
    expect(useSupportBundle.getState().saving).toBe(false);
  });

  it('a cancelled save leaves nothing marked as saved', async () => {
    preview.mockResolvedValue(bundle('t1'));
    await useSupportBundle.getState().openDialog();
    save.mockResolvedValue({ saved: false });
    await useSupportBundle.getState().save();
    expect(useSupportBundle.getState().savedPath).toBeNull();
  });

  it('shows an error from main and does not save while loading', async () => {
    preview.mockRejectedValue(new Error('disk is full'));
    await useSupportBundle.getState().openDialog();
    expect(useSupportBundle.getState().error).toBe('disk is full');
    await useSupportBundle.getState().save();
    expect(save).not.toHaveBeenCalled();
  });

  it('changing the toggle clears the "saved" note: that file no longer matches the screen', async () => {
    preview.mockResolvedValue(bundle('t1'));
    await useSupportBundle.getState().openDialog();
    save.mockResolvedValue({ saved: true, filePath: '/tmp/a.zip', bytes: 1 });
    await useSupportBundle.getState().save();
    preview.mockResolvedValue(bundle('t2'));
    await useSupportBundle.getState().setRedact(true);
    expect(useSupportBundle.getState().savedPath).toBeNull();
  });

  it('closing during a load drops the late answer', async () => {
    const slow = deferred<SupportBundlePreview>();
    preview.mockReturnValueOnce(slow.promise);
    const opening = useSupportBundle.getState().openDialog();
    useSupportBundle.getState().close();
    slow.resolve(bundle('late'));
    await opening;
    expect(useSupportBundle.getState().preview).toBeNull();
    expect(useSupportBundle.getState().open).toBe(false);
  });
});
