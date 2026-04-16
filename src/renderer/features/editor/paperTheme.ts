import type * as MonacoType from 'monaco-editor';

/**
 * Monaco theme definitions mirroring the app palette (light/dark).
 * Colors use bold primary red + neutral greyscale, matching the
 * shadcn/oklch token system in globals.css.
 */

export const LIGHT_THEME_ID = 'plasma-light';
export const DARK_THEME_ID = 'plasma-dark';

export function registerMonacoThemes(monaco: typeof MonacoType): void {
  monaco.editor.defineTheme(LIGHT_THEME_ID, {
    base: 'vs',
    inherit: false,
    rules: [
      { token: '', foreground: '000000', background: 'FFFFFF' },
      { token: 'keyword', foreground: 'DC0000', fontStyle: 'bold' },
      { token: 'keyword.sql', foreground: 'DC0000', fontStyle: 'bold' },
      { token: 'operator', foreground: '555555' },
      { token: 'operator.sql', foreground: '555555' },
      { token: 'string', foreground: '3F6D1F' },
      { token: 'string.sql', foreground: '3F6D1F' },
      { token: 'number', foreground: '1C4480', fontStyle: 'bold' },
      { token: 'number.sql', foreground: '1C4480', fontStyle: 'bold' },
      { token: 'comment', foreground: '888888', fontStyle: 'italic' },
      { token: 'identifier', foreground: '000000' },
      { token: 'type', foreground: 'B47E11' },
      { token: 'delimiter', foreground: '555555' },
      { token: 'predefined.sql', foreground: 'B47E11' },
    ],
    colors: {
      'editor.background': '#FFFFFF',
      'editor.foreground': '#252525',
      'editorGutter.background': '#FFFFFF',
      'editorLineNumber.foreground': '#A0A0A0',
      'editorLineNumber.activeForeground': '#EB5E4E',
      'editor.selectionBackground': '#EBEBEB',
      'editor.inactiveSelectionBackground': '#EBEBEB80',
      'editor.lineHighlightBackground': '#F7F7F780',
      'editor.lineHighlightBorder': '#00000000',
      'editorCursor.foreground': '#EB5E4E',
      'editorBracketMatch.background': '#EBEBEB',
      'editorBracketMatch.border': '#EB5E4E',
      // Hover / parameter hint / widget surfaces — match app popover
      'editorWidget.background': '#FFFFFF',
      'editorWidget.foreground': '#252525',
      'editorWidget.border': '#EBEBEB',
      'widget.shadow': '#00000014',
      // Completion suggest widget — full shadcn-flavored palette
      'editorSuggestWidget.background': '#FFFFFF',
      'editorSuggestWidget.foreground': '#252525',
      'editorSuggestWidget.border': '#EBEBEB',
      'editorSuggestWidget.selectedBackground': '#F4F4F4',
      'editorSuggestWidget.selectedForeground': '#252525',
      'editorSuggestWidget.selectedIconForeground': '#EB5E4E',
      'editorSuggestWidget.highlightForeground': '#EB5E4E',
      'editorSuggestWidget.focusHighlightForeground': '#EB5E4E',
      // List tokens (the suggest widget is backed by a Monaco list)
      'list.focusBackground': '#F4F4F4',
      'list.focusForeground': '#252525',
      'list.hoverBackground': '#F7F7F7',
      'list.hoverForeground': '#252525',
      'list.activeSelectionBackground': '#F4F4F4',
      'list.activeSelectionForeground': '#252525',
      'editorIndentGuide.background1': '#E5E5E5',
      'editorIndentGuide.activeBackground1': '#BEBEBE',
      'scrollbarSlider.background': '#00000022',
      'scrollbarSlider.hoverBackground': '#00000055',
      'scrollbarSlider.activeBackground': '#00000088',
    },
  });

  monaco.editor.defineTheme(DARK_THEME_ID, {
    base: 'vs-dark',
    inherit: false,
    rules: [
      { token: '', foreground: 'FFFFFF', background: '000000' },
      { token: 'keyword', foreground: 'EF4444', fontStyle: 'bold' },
      { token: 'keyword.sql', foreground: 'EF4444', fontStyle: 'bold' },
      { token: 'operator', foreground: 'C0C0C0' },
      { token: 'operator.sql', foreground: 'C0C0C0' },
      { token: 'string', foreground: 'A3D977' },
      { token: 'string.sql', foreground: 'A3D977' },
      { token: 'number', foreground: '7FB8FF', fontStyle: 'bold' },
      { token: 'number.sql', foreground: '7FB8FF', fontStyle: 'bold' },
      { token: 'comment', foreground: '888888', fontStyle: 'italic' },
      { token: 'identifier', foreground: 'FFFFFF' },
      { token: 'type', foreground: 'E8B872' },
      { token: 'delimiter', foreground: 'C0C0C0' },
      { token: 'predefined.sql', foreground: 'E8B872' },
    ],
    colors: {
      'editor.background': '#252525',
      'editor.foreground': '#FBFBFB',
      'editorGutter.background': '#252525',
      'editorLineNumber.foreground': '#555555',
      'editorLineNumber.activeForeground': '#EB5E4E',
      'editor.selectionBackground': '#EB5E4E30',
      'editor.inactiveSelectionBackground': '#EB5E4E15',
      'editor.lineHighlightBackground': '#33333380',
      'editor.lineHighlightBorder': '#00000000',
      'editorCursor.foreground': '#EB5E4E',
      'editorBracketMatch.background': '#EB5E4E30',
      'editorBracketMatch.border': '#EB5E4E',
      // Hover / parameter hint / widget surfaces
      'editorWidget.background': '#252525',
      'editorWidget.foreground': '#FBFBFB',
      'editorWidget.border': '#3A3A3A',
      'widget.shadow': '#00000060',
      // Completion suggest widget
      'editorSuggestWidget.background': '#252525',
      'editorSuggestWidget.foreground': '#FBFBFB',
      'editorSuggestWidget.border': '#3A3A3A',
      'editorSuggestWidget.selectedBackground': '#3A3A3A',
      'editorSuggestWidget.selectedForeground': '#FBFBFB',
      'editorSuggestWidget.selectedIconForeground': '#EB5E4E',
      'editorSuggestWidget.highlightForeground': '#EB5E4E',
      'editorSuggestWidget.focusHighlightForeground': '#EB5E4E',
      'list.focusBackground': '#3A3A3A',
      'list.focusForeground': '#FBFBFB',
      'list.hoverBackground': '#333333',
      'list.hoverForeground': '#FBFBFB',
      'list.activeSelectionBackground': '#3A3A3A',
      'list.activeSelectionForeground': '#FBFBFB',
      'editorIndentGuide.background1': '#3A3A3A',
      'editorIndentGuide.activeBackground1': '#555555',
    },
  });
}
