import { accelerator } from '@shared/keymap';
import { BrowserWindow, Menu, type MenuItemConstructorOptions, app, shell } from 'electron';

/**
 * Native application menu. Provides proper system shortcuts for
 * copy/paste/undo/zoom and a Help menu pointing at the project.
 * Accelerators come from `@shared/keymap` so they stay in lockstep
 * with renderer DOM listeners and the ⌘/ cheat-sheet.
 */
export function buildAppMenu(): void {
  const isMac = process.platform === 'darwin';

  const template: MenuItemConstructorOptions[] = [
    ...(isMac
      ? ([
          {
            label: app.name,
            submenu: [
              { role: 'about' },
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
        {
          label: 'New Query Tab',
          accelerator: accelerator('newTab'),
          click: () => sendToFocusedWindow('plasma:menu:newTab'),
        },
        {
          label: 'Close Tab',
          accelerator: accelerator('closeTab'),
          click: () => sendToFocusedWindow('plasma:menu:closeTab'),
        },
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
        isMac ? { role: 'close' } : { role: 'quit' },
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
        {
          label: 'Toggle Sidebar',
          accelerator: accelerator('toggleSidebar'),
          click: () => sendToFocusedWindow('plasma:menu:toggleSidebar'),
        },
        {
          label: 'Toggle Query Editor',
          accelerator: accelerator('toggleEditor'),
          click: () => sendToFocusedWindow('plasma:menu:toggleEditor'),
        },
        {
          label: 'Command Palette…',
          accelerator: accelerator('palette'),
          click: () => sendToFocusedWindow('plasma:menu:palette'),
        },
        {
          label: 'Toggle AI Panel',
          accelerator: accelerator('toggleAi'),
          click: () => sendToFocusedWindow('plasma:menu:toggleAi'),
        },
        { type: 'separator' },
        { role: 'reload' },
        { role: 'toggleDevTools' },
        { role: 'togglefullscreen' },
      ],
    },
    {
      label: 'Query',
      submenu: [
        {
          label: 'Run',
          accelerator: accelerator('runQuery'),
          click: () => sendToFocusedWindow('plasma:menu:runQuery'),
        },
        {
          label: 'Run All',
          accelerator: accelerator('runQueryAll'),
          click: () => sendToFocusedWindow('plasma:menu:runQueryAll'),
        },
        {
          label: 'Cancel',
          accelerator: accelerator('cancelQuery'),
          click: () => sendToFocusedWindow('plasma:menu:cancelQuery'),
        },
        { type: 'separator' },
        {
          label: 'Query History…',
          accelerator: accelerator('history'),
          click: () => sendToFocusedWindow('plasma:menu:history'),
        },
      ],
    },
    {
      label: 'Help',
      submenu: [
        {
          label: 'Keyboard Shortcuts…',
          accelerator: accelerator('cheatSheet'),
          click: () => sendToFocusedWindow('plasma:menu:cheatSheet'),
        },
        { type: 'separator' },
        {
          label: 'Plasma on GitHub',
          click: () => void shell.openExternal('https://github.com'),
        },
        {
          label: 'Report a Bug',
          click: () => void shell.openExternal('https://github.com'),
        },
      ],
    },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function sendToFocusedWindow(channel: string): void {
  const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
  win?.webContents.send(channel);
}
