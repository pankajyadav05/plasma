import { useMigrationDialog } from '@/features/migration/migration-dialog-store';
import { useSession } from '@/stores/session';
import { parseServerMajor } from '@shared/pg-backup';
import { lintOptionsFromSettings } from '@shared/pg-migration-check';
import { type LintFinding, type LintSeverity, lintMigration } from '@shared/pg-migration-lint';
import type * as MonacoType from 'monaco-editor';

const OWNER = 'plasma-migration-lint';
const DEBOUNCE_MS = 400;

/** Findings per model, so the quick-fix provider can find the edits. */
const findingsByModel = new Map<string, LintFinding[]>();
let providerRegistered = false;

function markerSeverity(monaco: typeof MonacoType, s: LintSeverity): MonacoType.MarkerSeverity {
  return s === 'error'
    ? monaco.MarkerSeverity.Error
    : s === 'warn'
      ? monaco.MarkerSeverity.Warning
      : monaco.MarkerSeverity.Info;
}

/** Lint the model's script into Monaco markers (squiggle + hover with the safer alternative). */
export function lintModel(monaco: typeof MonacoType, model: MonacoType.editor.ITextModel): void {
  const state = useSession.getState();
  const engine = state.activeConfig?.engine ?? 'postgres';
  const key = model.uri.toString();
  if (engine !== 'postgres' || state.connectionState !== 'connected') {
    findingsByModel.delete(key);
    monaco.editor.setModelMarkers(model, OWNER, []);
    return;
  }
  const major = state.serverVersion ? parseServerMajor(state.serverVersion) : null;
  const { findings } = lintMigration(model.getValue(), {
    ...lintOptionsFromSettings(state.settings),
    ...(major ? { pgVersion: major } : {}),
  });
  findingsByModel.set(key, findings);
  const len = model.getValueLength();
  monaco.editor.setModelMarkers(
    model,
    OWNER,
    findings.map((f) => {
      const a = model.getPositionAt(Math.min(f.start, len));
      const b = model.getPositionAt(Math.min(Math.max(f.end, f.start + 1), len));
      return {
        severity: markerSeverity(monaco, f.severity),
        source: 'Plasma migration lint',
        code: { value: f.ruleId, target: monaco.Uri.parse(f.docs) },
        message: `${f.title}\n${f.message}\nSafer: ${f.alternative}`,
        startLineNumber: a.lineNumber,
        startColumn: a.column,
        endLineNumber: b.lineNumber,
        endColumn: b.column,
      };
    }),
  );
}

function registerQuickFixes(monaco: typeof MonacoType): void {
  if (providerRegistered) return;
  providerRegistered = true;
  monaco.languages.registerCodeActionProvider('sql', {
    provideCodeActions(model, range) {
      const findings = findingsByModel.get(model.uri.toString()) ?? [];
      const actions: MonacoType.languages.CodeAction[] = [];
      for (const f of findings) {
        if (!f.fix) continue;
        const a = model.getPositionAt(f.start);
        const b = model.getPositionAt(Math.max(f.end, f.start + 1));
        const hit = monaco.Range.areIntersectingOrTouching(
          range,
          new monaco.Range(a.lineNumber, a.column, b.lineNumber, b.column),
        );
        if (!hit) continue;
        actions.push({
          title: `${f.fix.title} (${f.title})`,
          kind: 'quickfix',
          isPreferred: f.severity === 'error',
          edit: {
            edits: f.fix.edits.map((e) => {
              const s = model.getPositionAt(e.start);
              const t = model.getPositionAt(e.end);
              return {
                resource: model.uri,
                versionId: model.getVersionId(),
                textEdit: {
                  range: new monaco.Range(s.lineNumber, s.column, t.lineNumber, t.column),
                  text: e.text,
                },
              };
            }),
          },
        });
      }
      return { actions, dispose() {} };
    },
  });
}

/**
 * Wire migration lint into a Monaco editor: markers on content / settings /
 * connection change, quick fixes (add CONCURRENTLY / NOT VALID / lock_timeout)
 * and a "Check migration" context-menu action. Returns a disposer.
 */
export function attachMigrationLint(
  monaco: typeof MonacoType,
  editor: MonacoType.editor.IStandaloneCodeEditor,
): () => void {
  registerQuickFixes(monaco);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const run = () => {
    const model = editor.getModel();
    if (model) lintModel(monaco, model);
  };
  const schedule = () => {
    clearTimeout(timer);
    timer = setTimeout(run, DEBOUNCE_MS);
  };
  run();
  const action = editor.addAction({
    id: 'plasma.checkMigration',
    label: 'Check Migration…',
    contextMenuGroupId: '9_cutcopypaste',
    contextMenuOrder: 10,
    run: () => useMigrationDialog.getState().show(),
  });
  const disposables = [
    editor.onDidChangeModelContent(schedule),
    editor.onDidChangeModel(run),
    action,
  ];
  // Settings / connection changes re-lint immediately.
  let last = lintInputsKey();
  const unsub = useSession.subscribe(() => {
    const k = lintInputsKey();
    if (k !== last) {
      last = k;
      schedule();
    }
  });
  return () => {
    clearTimeout(timer);
    unsub();
    for (const d of disposables) d.dispose();
    const model = editor.getModel();
    if (model) {
      findingsByModel.delete(model.uri.toString());
      monaco.editor.setModelMarkers(model, OWNER, []);
    }
  };
}

function lintInputsKey(): string {
  const s = useSession.getState();
  return [
    s.connectionState,
    s.activeConfig?.engine ?? '',
    s.serverVersion ?? '',
    s.settings.migrationLintEnabled,
    s.settings.migrationLintMinSeverity,
    (s.settings.migrationLintMuted ?? []).join(','),
  ].join('|');
}
