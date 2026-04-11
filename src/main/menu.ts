import { Menu, type MenuItemConstructorOptions, app, shell, BrowserWindow } from 'electron';

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

function sendToFocusedWindow(channel: string): void {
  const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
  win?.webContents.send(channel);
}
