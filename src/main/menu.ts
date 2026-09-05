import { BrowserWindow, Menu, type MenuItemConstructorOptions, app, shell } from 'electron';

/**
 * Native application menu. Provides proper system shortcuts for
 * copy/paste/undo/zoom and a Help menu pointing at the project.
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
          accelerator: 'CmdOrCtrl+T',
          click: () => sendToFocusedWindow('plasma:menu:newTab'),
        },
        {
          label: 'Close Tab',
          accelerator: 'CmdOrCtrl+W',
          click: () => sendToFocusedWindow('plasma:menu:closeTab'),
        },
        {
          label: 'Reopen Closed Tab',
          accelerator: 'CmdOrCtrl+Shift+T',
          click: () => sendToFocusedWindow('plasma:menu:reopenTab'),
        },
        {
          label: 'Rename Tab',
          accelerator: 'CmdOrCtrl+R',
          click: () => sendToFocusedWindow('plasma:menu:renameTab'),
        },
        {
          label: 'Next Tab',
          accelerator: 'CmdOrCtrl+Shift+]',
          click: () => sendToFocusedWindow('plasma:menu:nextTab'),
        },
        {
          label: 'Previous Tab',
          accelerator: 'CmdOrCtrl+Shift+[',
          click: () => sendToFocusedWindow('plasma:menu:prevTab'),
        },
        { type: 'separator' },
        {
          label: 'Tab 1',
          accelerator: 'CmdOrCtrl+1',
          click: () => sendToFocusedWindow('plasma:menu:selectTab', 0),
        },
        {
          label: 'Tab 2',
          accelerator: 'CmdOrCtrl+2',
          click: () => sendToFocusedWindow('plasma:menu:selectTab', 1),
        },
        {
          label: 'Tab 3',
          accelerator: 'CmdOrCtrl+3',
          click: () => sendToFocusedWindow('plasma:menu:selectTab', 2),
        },
        {
          label: 'Tab 4',
          accelerator: 'CmdOrCtrl+4',
          click: () => sendToFocusedWindow('plasma:menu:selectTab', 3),
        },
        {
          label: 'Tab 5',
          accelerator: 'CmdOrCtrl+5',
          click: () => sendToFocusedWindow('plasma:menu:selectTab', 4),
        },
        {
          label: 'Tab 6',
          accelerator: 'CmdOrCtrl+6',
          click: () => sendToFocusedWindow('plasma:menu:selectTab', 5),
        },
        {
          label: 'Tab 7',
          accelerator: 'CmdOrCtrl+7',
          click: () => sendToFocusedWindow('plasma:menu:selectTab', 6),
        },
        {
          label: 'Tab 8',
          accelerator: 'CmdOrCtrl+8',
          click: () => sendToFocusedWindow('plasma:menu:selectTab', 7),
        },
        {
          label: 'Tab 9',
          accelerator: 'CmdOrCtrl+9',
          click: () => sendToFocusedWindow('plasma:menu:selectTab', 8),
        },
        { type: 'separator' },
        {
          label: 'Export Results as CSV…',
          accelerator: 'CmdOrCtrl+Shift+E',
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
          accelerator: 'CmdOrCtrl+B',
          click: () => sendToFocusedWindow('plasma:menu:toggleSidebar'),
        },
        {
          label: 'Toggle Query Editor',
          accelerator: 'CmdOrCtrl+J',
          click: () => sendToFocusedWindow('plasma:menu:toggleEditor'),
        },
        {
          label: 'Command Palette…',
          accelerator: 'CmdOrCtrl+K',
          click: () => sendToFocusedWindow('plasma:menu:palette'),
        },
        { type: 'separator' },
        { role: 'reload', accelerator: 'CmdOrCtrl+Shift+R' },
        { role: 'toggleDevTools' },
        { role: 'togglefullscreen' },
      ],
    },
    {
      label: 'Query',
      submenu: [
        {
          label: 'Run',
          accelerator: 'CmdOrCtrl+Return',
          click: () => sendToFocusedWindow('plasma:menu:runQuery'),
        },
        {
          label: 'Cancel',
          accelerator: 'CmdOrCtrl+.',
          click: () => sendToFocusedWindow('plasma:menu:cancelQuery'),
        },
        { type: 'separator' },
        {
          label: 'Query History…',
          accelerator: 'CmdOrCtrl+H',
          click: () => sendToFocusedWindow('plasma:menu:history'),
        },
      ],
    },
    {
      label: 'Help',
      submenu: [
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

function sendToFocusedWindow(channel: string, ...args: unknown[]): void {
  const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
  win?.webContents.send(channel, ...args);
}
