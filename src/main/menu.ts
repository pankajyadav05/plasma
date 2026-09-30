import { KEYMAP, type KeyId, accelerator } from '@shared/keymap';
import { BrowserWindow, Menu, type MenuItemConstructorOptions, app, shell } from 'electron';

/**
 * Native application menu. Provides proper system shortcuts for
 * copy/paste/undo/zoom and a Help menu pointing at the project.
 * Accelerators come from `@shared/keymap` so they stay in lockstep
 * with renderer DOM listeners and the ⌘/ cheat-sheet.
 *
 * K1 — no native role may steal an app chord:
 * - macOS "Close Window" moves to ⇧⌘W (⌘W is Close Tab);
 * - ⌘R is the app's Refresh, so Reload is never on ⌘R, and Reload /
 *   DevTools exist only in development builds;
 * - Query History avoids ⌘H (macOS Hide) — see `history` in keymap.ts.
 */

const REPO_URL = 'https://github.com/pankajyadav05/plasma';

export function buildAppMenu(): void {
  Menu.setApplicationMenu(Menu.buildFromTemplate(appMenuTemplate()));
}

/** Menu item for a keymap binding with a menu channel (skipped when absent). */
function keyItem(id: KeyId, label: string): MenuItemConstructorOptions[] {
  const binding = KEYMAP.find((b) => b.id === id);
  const channel = binding?.menuChannel;
  if (!binding || !channel) return [];
  return [{ label, accelerator: accelerator(id), click: () => sendToFocusedWindow(channel) }];
}

export function appMenuTemplate(
  isMac = process.platform === 'darwin',
  isDev = !app.isPackaged,
): MenuItemConstructorOptions[] {
  return [
    ...(isMac
      ? ([
          {
            label: app.name,
            submenu: [
              { role: 'about' },
              { type: 'separator' },
              ...keyItem('settings', 'Settings…'),
              { type: 'separator' },
              { role: 'services' },
              { type: 'separator' },
              { role: 'hide' },
              { role: 'hideOthers' },
              { role: 'unhide' },
              { type: 'separator' },
              { role: 'quit' },
            ],
          },
        ] as MenuItemConstructorOptions[])
      : []),
    {
      label: 'File',
      submenu: [
        ...keyItem('newTab', 'New Query Tab'),
        ...keyItem('openFile', 'Open SQL File…'),
        { type: 'separator' },
        ...keyItem('commitEdits', 'Save'),
        ...keyItem('saveFileAs', 'Save SQL As…'),
        { type: 'separator' },
        {
          label: 'Export Results as CSV…',
          accelerator: accelerator('exportCsv'),
          click: () => sendToFocusedWindow('plasma:menu:exportCsv'),
        },
        {
          label: 'Export Results as JSON…',
          click: () => sendToFocusedWindow('plasma:menu:exportJson'),
        },
        { type: 'separator' },
        ...keyItem('closeTab', 'Close Tab'),
        ...(isMac
          ? ([{ role: 'close', accelerator: 'Shift+CmdOrCtrl+W' }] as MenuItemConstructorOptions[])
          : ([
              { type: 'separator' },
              ...keyItem('settings', 'Settings…'),
              { type: 'separator' },
              { role: 'quit' },
            ] as MenuItemConstructorOptions[])),
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
      ],
    },
    {
      label: 'View',
      submenu: [
        ...keyItem('toggleSidebar', 'Toggle Sidebar'),
        ...keyItem('toggleEditor', 'Toggle Query Editor'),
        ...keyItem('palette', 'Command Palette…'),
        ...keyItem('toggleAi', 'Toggle AI Panel'),
        {
          label: 'Split Pane Right',
          click: () => sendToFocusedWindow('plasma:menu:splitPane'),
        },
        { type: 'separator' },
        ...keyItem('refresh', 'Refresh'),
        { type: 'separator' },
        // Reload loses every open tab and DevTools expose the IPC bridge —
        // development builds only, and never on ⌘R.
        ...(isDev
          ? ([
              { role: 'reload', accelerator: 'CmdOrCtrl+Alt+R' },
              { role: 'toggleDevTools' },
              { type: 'separator' },
            ] as MenuItemConstructorOptions[])
          : []),
        { role: 'togglefullscreen' },
      ],
    },
    {
      label: 'Database',
      submenu: [
        {
          label: 'Back Up Database…',
          click: () => sendToFocusedWindow('plasma:menu:backup'),
        },
        {
          label: 'Restore Database…',
          click: () => sendToFocusedWindow('plasma:menu:restore'),
        },
        { type: 'separator' },
        {
          label: 'Roles and Privileges…',
          click: () => sendToFocusedWindow('plasma:menu:roles'),
        },
        {
          label: 'Search in Database…',
          click: () => sendToFocusedWindow('plasma:menu:dbSearch'),
        },
        {
          label: 'Show Diagram',
          click: () => sendToFocusedWindow('plasma:menu:erDiagram'),
        },
      ],
    },
    {
      label: 'Query',
      submenu: [
        ...keyItem('runQuery', 'Run'),
        ...keyItem('runQueryAll', 'Run All'),
        ...keyItem('cancelQuery', 'Cancel'),
        { type: 'separator' },
        ...keyItem('history', 'Query History…'),
      ],
    },
    {
      label: 'Help',
      submenu: [
        ...keyItem('cheatSheet', 'Keyboard Shortcuts…'),
        { type: 'separator' },
        {
          label: 'Plasma on GitHub',
          click: () => void shell.openExternal(REPO_URL),
        },
        {
          label: 'Report a Bug',
          click: () => void shell.openExternal(`${REPO_URL}/issues`),
        },
      ],
    },
  ];
}

function sendToFocusedWindow(channel: string): void {
  const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
  win?.webContents.send(channel);
}
