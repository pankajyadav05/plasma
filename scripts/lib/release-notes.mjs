/**
 * Release notes from commit subjects (Conventional Commits). Only what a user
 * would notice makes it in: `feat`, `fix` and `perf`. Tests, CI, docs, chores,
 * merges, version bumps and "review findings" follow-ups are left out.
 */

const SECTIONS = [
  { type: 'feat', title: 'New' },
  { type: 'perf', title: 'Faster' },
  { type: 'fix', title: 'Fixed' },
];

const SUBJECT = /^([a-z]+(?:,[a-z]+)*)(?:\(([^)]*)\))?!?:\s*(.+)$/;

/** Internal follow-ups that fix work shipped in the same release. */
const INTERNAL = /\breview (findings|fixes)\b|\baddress review\b/i;

/** `{ section, scope, text }` for a subject worth a line, else null. */
export function parseSubject(subject) {
  const m = SUBJECT.exec(subject.trim());
  if (!m) return null;
  const types = m[1].split(',');
  const section = SECTIONS.find((s) => types.includes(s.type));
  if (!section || INTERNAL.test(m[3])) return null;
  const text = m[3].trim();
  return {
    section: section.type,
    scope: m[2]?.trim() || null,
    text: text.charAt(0).toUpperCase() + text.slice(1),
  };
}

/**
 * Markdown body for the GitHub release. `subjects` are newest first (git log
 * order); the notes list them oldest first within each section.
 */
export function releaseNotes({ version, previous, subjects }) {
  const entries = subjects.map(parseSubject).filter(Boolean).reverse();
  const seen = new Set();
  const lines = [];
  for (const { type, title } of SECTIONS) {
    const items = entries.filter((e) => {
      if (e.section !== type) return false;
      const key = `${e.section}\0${e.text.toLowerCase()}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    if (items.length === 0) continue;
    lines.push(`## ${title}`, '');
    for (const e of items) lines.push(e.scope ? `- **${e.scope}:** ${e.text}` : `- ${e.text}`);
    lines.push('');
  }
  if (lines.length === 0) {
    lines.push(
      previous
        ? `Maintenance release: no user-facing changes since ${previous}.`
        : 'First release.',
      '',
    );
  }
  lines.push(
    '## Install',
    '',
    'Plasma updates itself: open it and click **Restart to update** when the badge appears.',
    '',
    `New install: download the file for your system below. macOS: \`Plasma-${version}-arm64.dmg\`; ` +
      `Windows: \`Plasma-Setup-${version}-x64.exe\`; Linux: the \`.AppImage\` or \`.deb\`.`,
    '',
  );
  return lines.join('\n');
}
