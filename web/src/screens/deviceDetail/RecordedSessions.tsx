/**
 * Recorded shell sessions for a device.
 *
 * Every shell is recorded; a session that could not be recorded is ended
 * rather than run unrecorded, so this list is the complete account of what was
 * typed against this device through the portal.
 *
 * Export CSV is metadata only (openedAt / user / target / device / file) —
 * never transcript bodies, which may hold operator commands or secrets.
 */

import {
  type TerminalSession,
  type TerminalSessionEvent,
} from '../../api/client';
import {
  Button,
  SectionHeader,
  useToast,
} from '../../nightdesk';
import { exportTableCsv } from '../../lib/csv';

/** Basename of a session recording path — keeps CSV rows short and path-safe. */
export function sessionFileLabel(file: string): string {
  const trimmed = file.trim();
  if (!trimmed) return '';
  const parts = trimmed.split(/[/\\]/);
  return parts[parts.length - 1] || trimmed;
}

/** Rows for the sessions metadata CSV (no transcript text). */
export function recordedSessionExportRows(
  sessions: readonly TerminalSession[],
): Array<Array<string>> {
  return sessions.map((s) => [
    s.openedAt ?? '',
    s.user ?? '',
    s.target ?? '',
    s.device ?? '',
    sessionFileLabel(s.file ?? ''),
  ]);
}

/** Recorded shell transcripts on file for this device. Shared by the authored
 *  profile view and the live view — every recorded session belongs to the
 *  device it was opened against, whichever mode is rendering it. */
export function RecordedSessions({
  sessions,
  sessionsError,
  expanded,
  toggleTranscript,
  deviceName,
}: {
  sessions: TerminalSession[];
  sessionsError: string | null;
  expanded: { file: string; events: TerminalSessionEvent[]; truncated: boolean } | null;
  toggleTranscript: (file: string) => void;
  /** Optional device name for the export filename. */
  deviceName?: string;
}) {
  const { toast } = useToast();

  const exportSessions = () => {
    const safe =
      (deviceName ?? sessions[0]?.device ?? 'device')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '') || 'device';
    const n = exportTableCsv(
      `device-sessions-${safe}.csv`,
      ['openedAt', 'user', 'target', 'device', 'file'],
      recordedSessionExportRows(sessions),
    );
    toast(`Exported ${n} session${n === 1 ? '' : 's'}`, {
      description: 'Metadata only — no transcript bodies.',
      tone: 'success',
    });
  };

  return (
    <div className="nt-session-stack nt-device-section nt-section-panel">
      <div className="nt-filter-bar nt-gap-8">
        <SectionHeader label="Recorded sessions" meta={sessions.length > 0 ? `${sessions.length} ON FILE` : undefined} />
        {sessions.length > 0 ? (
          <Button variant="ghost" size="sm" className="nt-ml-auto" onClick={exportSessions}>
            Export sessions
          </Button>
        ) : null}
      </div>
      {sessionsError ? (
        <div
          role="alert"
          className="nt-mono-11 nt-danger-pad-8"
        >
          {sessionsError}
        </div>
      ) : sessions.length === 0 ? (
        <div
          className="nt-hint-muted nt-pad-8-0"
        >
          No recorded sessions for this device — every session opened above is recorded to the portal.
        </div>
      ) : (
        sessions.map((s) => (
          <div key={s.file} className="nt-rule-bottom">
            <div className="nt-row-center nt-gap-10 nt-pad-8-0">
              <span
                className="nt-hint-muted"
              >
                {new Date(s.openedAt).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
              </span>
              <span
                className="nt-mono-11 nt-text-sec"
              >
                {s.user}@{s.target}
              </span>
              <Button variant="ghost" size="sm" className="nt-ml-auto" onClick={() => toggleTranscript(s.file)}>
                {expanded?.file === s.file ? 'Hide transcript' : 'View transcript'}
              </Button>
            </div>
            {expanded?.file === s.file ? (
              <div
                className="nt-service-note nt-session-log"
              >
                {expanded.events.map((e, i) => (
                  <div
                    key={i}
                    className={e.type === 'in' ? 'nt-sess-in' : e.type === 'blocked' ? 'nt-sess-blocked' : e.type === 'open' || e.type === 'close' ? 'nt-sess-quiet' : 'nt-sess-default'}
                  >
                    {e.type === 'in'
                      ? `$ ${e.text ?? ''}`
                      : e.type === 'blocked'
                        ? `% blocked — ${e.text ?? ''} (${e.reason ?? 'policy'})`
                        : e.type === 'open'
                          ? `— session opened · ${e.text ?? ''}`
                          : e.type === 'close'
                            ? `— session closed · ${e.reason ?? ''}`
                            : (e.text ?? '')}
                  </div>
                ))}
                {expanded.truncated ? (
                  <div className="nt-warning-text">— transcript truncated at the read cap —</div>
                ) : null}
              </div>
            ) : null}
          </div>
        ))
      )}
    </div>
  );
}
