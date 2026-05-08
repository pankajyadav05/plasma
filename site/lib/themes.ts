// 9 themes mirrored from the Plasma app. Used by ThemeCycler to retint
// the MockSurface above it. Hex values shaped for SVG/Canvas tinting —
// the cycler tweens these via CSS variables namespaced under `--mock-*`
// so they don't fight the page theme.

export interface MockTheme {
  id: string;
  name: string;
  bg: string;
  fg: string;
  ox: string;
  swatch: [string, string, string, string];
}

export const MOCK_THEMES: MockTheme[] = [
  { id: 'paper',     name: 'Paper',      bg: '#f5efe4', fg: '#1c1a14', ox: '#b54836', swatch: ['#f5efe4', '#ebe3d2', '#1c1a14', '#b54836'] },
  { id: 'ink',       name: 'Ink',        bg: '#0f0e0a', fg: '#ededf2', ox: '#eb5e4e', swatch: ['#0f0e0a', '#1c1a14', '#ededf2', '#eb5e4e'] },
  { id: 'rosewood',  name: 'Rosewood',   bg: '#1a0f12', fg: '#f3e0d6', ox: '#e07a5f', swatch: ['#1a0f12', '#2b1418', '#f3e0d6', '#e07a5f'] },
  { id: 'glacier',   name: 'Glacier',    bg: '#0c1218', fg: '#dee9f5', ox: '#7fb3d5', swatch: ['#0c1218', '#1a2330', '#dee9f5', '#7fb3d5'] },
  { id: 'meadow',    name: 'Meadow',     bg: '#0e1410', fg: '#e0eadf', ox: '#9aa830', swatch: ['#0e1410', '#1a2218', '#e0eadf', '#9aa830'] },
  { id: 'amber',     name: 'Amber',      bg: '#171008', fg: '#f4e8d4', ox: '#d4a056', swatch: ['#171008', '#241910', '#f4e8d4', '#d4a056'] },
  { id: 'plum',      name: 'Plum',       bg: '#15101a', fg: '#ede4f2', ox: '#a37ec0', swatch: ['#15101a', '#231a2c', '#ede4f2', '#a37ec0'] },
  { id: 'newsprint', name: 'Newsprint',  bg: '#ebe6dc', fg: '#231f1a', ox: '#8a3a2a', swatch: ['#ebe6dc', '#dad3c4', '#231f1a', '#8a3a2a'] },
  { id: 'bone',      name: 'Bone',       bg: '#1c1a14', fg: '#e8e2d3', ox: '#c97a4f', swatch: ['#1c1a14', '#2a2620', '#e8e2d3', '#c97a4f'] },
];
