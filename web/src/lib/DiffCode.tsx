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
    <Code block>
      {lines.map((line, i) => {
        const color = line.startsWith('-')
          ? 'var(--nd-danger)'
          : line.startsWith('+')
            ? 'var(--nd-success)'
            : undefined;
        return (
          <span key={i} style={color ? { color } : undefined}>
            {line + (i < lines.length - 1 ? '\n' : '')}
          </span>
        );
      })}
    </Code>
  );
}
