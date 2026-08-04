/**
 * web/src/lib/DiffCode.tsx — a Nightdesk Code block with a line splitter for
 * unified-diff text: lines starting with '-' render in --nd-danger, lines
 * starting with '+' in --nd-success, everything else keeps the default code
 * colour. Used by the "Drift vs. baseline" panes (NtDeviceDetail,
 * NtCompliance); the diff text itself stays byte-for-byte the fixture copy,
 * including the `<- baseline` annotations.
 */

import { Code } from '../nightdesk';

export function DiffCode({ text }: { text: string }) {
  const lines = text.split('\n');
  return (
    <div className="nt-backup-diff nt-diff-cinema nt-code-frame">
      <Code block className="nt-diff-code">
        {lines.map((line, i) => {
          const kind = line.startsWith('-') ? 'del' : line.startsWith('+') ? 'add' : 'ctx';
          return (
            <span key={i} className={`nt-diff-line nt-diff-line--${kind}`} data-kind={kind}>
              {line + (i < lines.length - 1 ? '\n' : '')}
            </span>
          );
        })}
      </Code>
    </div>
  );
}
