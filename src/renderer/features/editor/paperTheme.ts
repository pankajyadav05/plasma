import type * as MonacoType from 'monaco-editor';

/**
 * Monaco theme definitions that mirror the Paper Editor palette in
 * DESIGN.md. We register both the paper (light) and midnight (dark)
 * variants so the store can switch at runtime.
 */

export const PAPER_THEME_ID = 'plasma-paper';
export const MIDNIGHT_THEME_ID = 'plasma-midnight';

export function registerMonacoThemes(monaco: typeof MonacoType): void {
  monaco.editor.defineTheme(PAPER_THEME_ID, {
    base: 'vs',
    inherit: false,
    rules: [
      { token: '', foreground: '1C1A14', background: 'FAF7F0' },
      { token: 'keyword', foreground: '7B2D26', fontStyle: 'bold' },
      { token: 'keyword.sql', foreground: '7B2D26', fontStyle: 'bold' },
      { token: 'operator', foreground: '5C5849' },
      { token: 'operator.sql', foreground: '5C5849' },
      { token: 'string', foreground: '4A6B2E' },
      { token: 'string.sql', foreground: '4A6B2E' },
      { token: 'number', foreground: '2B4E7A', fontStyle: 'bold' },
      { token: 'number.sql', foreground: '2B4E7A', fontStyle: 'bold' },
      { token: 'comment', foreground: '8B8675', fontStyle: 'italic' },
      { token: 'identifier', foreground: '1C1A14' },
      { token: 'type', foreground: 'B47E11' },
      { token: 'delimiter', foreground: '5C5849' },
      { token: 'predefined.sql', foreground: 'B47E11' },
    ],
    colors: {
      'editor.background': '#FAF7F0',
      'editor.foreground': '#1C1A14',
      'editorGutter.background': '#FAF7F0',
      'editorLineNumber.foreground': '#B5AE9C',
      'editorLineNumber.activeForeground': '#7B2D26',
      'editor.selectionBackground': '#F3E2D8',
      'editor.inactiveSelectionBackground': '#F3E2D880',
      'editor.lineHighlightBackground': '#F4F0E380',
      'editor.lineHighlightBorder': '#00000000',
      'editorCursor.foreground': '#7B2D26',
      'editorBracketMatch.background': '#F3E2D8',
      'editorBracketMatch.border': '#7B2D26',
      'editorWidget.background': '#FFFEF9',
      'editorWidget.border': '#1C1A14',
      'editorSuggestWidget.background': '#FFFEF9',
      'editorSuggestWidget.border': '#1C1A14',
      'editorSuggestWidget.selectedBackground': '#F3E2D8',
      'editorSuggestWidget.highlightForeground': '#7B2D26',
      'editorIndentGuide.background1': '#E5DFCC',
      'editorIndentGuide.activeBackground1': '#C9C2A8',
      'scrollbarSlider.background': '#C9C2A860',
      'scrollbarSlider.hoverBackground': '#8B867580',
      'scrollbarSlider.activeBackground': '#8B8675',
    },
  });

  monaco.editor.defineTheme(MIDNIGHT_THEME_ID, {
    base: 'vs-dark',
    inherit: false,
    rules: [
      { token: '', foreground: 'FAF7F0', background: '1B1812' },
      { token: 'keyword', foreground: 'D48A82', fontStyle: 'bold' },
      { token: 'keyword.sql', foreground: 'D48A82', fontStyle: 'bold' },
      { token: 'operator', foreground: 'D4CFBF' },
      { token: 'operator.sql', foreground: 'D4CFBF' },
      { token: 'string', foreground: 'A8C98A' },
      { token: 'string.sql', foreground: 'A8C98A' },
      { token: 'number', foreground: '7FB8FF', fontStyle: 'bold' },
      { token: 'number.sql', foreground: '7FB8FF', fontStyle: 'bold' },
      { token: 'comment', foreground: '8B8675', fontStyle: 'italic' },
      { token: 'identifier', foreground: 'FAF7F0' },
      { token: 'type', foreground: 'E8B872' },
      { token: 'delimiter', foreground: 'D4CFBF' },
      { token: 'predefined.sql', foreground: 'E8B872' },
    ],
    colors: {
      'editor.background': '#1B1812',
      'editor.foreground': '#FAF7F0',
      'editorGutter.background': '#1B1812',
      'editorLineNumber.foreground': '#5C5849',
      'editorLineNumber.activeForeground': '#D48A82',
      'editor.selectionBackground': '#D48A8220',
      'editor.inactiveSelectionBackground': '#D48A8210',
      'editor.lineHighlightBackground': '#231F1880',
      'editor.lineHighlightBorder': '#00000000',
      'editorCursor.foreground': '#D48A82',
      'editorBracketMatch.background': '#D48A8220',
      'editorBracketMatch.border': '#D48A82',
      'editorWidget.background': '#231F18',
      'editorWidget.border': '#D4AC78',
      'editorSuggestWidget.background': '#231F18',
      'editorSuggestWidget.border': '#D4AC78',
      'editorSuggestWidget.selectedBackground': '#D48A8220',
      'editorSuggestWidget.highlightForeground': '#D48A82',
      'editorIndentGuide.background1': '#2E2A20',
      'editorIndentGuide.activeBackground1': '#3A352A',
    },
  });
}
