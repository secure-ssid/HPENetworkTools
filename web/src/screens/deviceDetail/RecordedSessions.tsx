/**
 * Recorded shell sessions for a device.
 *
 * Every shell is recorded; a session that could not be recorded is ended
 * rather than run unrecorded, so this list is the complete account of what was
 * typed against this device through the portal.
 */

import {
  type TerminalSession,
  type TerminalSessionEvent,
} from '../../api/client';
import {
  Button,
  SectionHeader,
} from '../../nightdesk';

/** Recorded shell transcripts on file for this device. Shared by the authored
 *  profile view and the live view — every recorded session belongs to the
 *  device it was opened against, whichever mode is rendering it. */
export function RecordedSessions({
  sessions,
  sessionsError,
  expanded,
  toggleTranscript,
}: {
  sessions: TerminalSession[];
  sessionsError: string | null;
  expanded: { file: string; events: TerminalSessionEvent[]; truncated: boolean } | null;
  toggleTranscript: (file: string) => void;
}) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 2, paddingTop: 10 }}>
      <SectionHeader label="Recorded sessions" meta={sessions.length > 0 ? `${sessions.length} ON FILE` : undefined} />
      {sessionsError ? (
        <div
          role="alert"
          className="nt-mono-11" style={{
color: 'var(--nd-danger)',
            padding: '8px 0'
}}
        >
          {sessionsError}
        </div>
      ) : sessions.length === 0 ? (
        <div
          className="nt-hint-muted" style={{ padding: '8px 0' }}
        >
          No recorded sessions for this device — every session opened above is recorded to the portal.
        </div>
      ) : (
        sessions.map((s) => (
          <div key={s.file} style={{ borderBottom: '1px solid var(--nd-border-subtle)' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 0' }}>
              <span
                className="nt-hint-muted"
              >
                {new Date(s.openedAt).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
              </span>
              <span
                className="nt-mono-11" style={{ color: 'var(--nd-text-secondary)' }}
              >
                {s.user}@{s.target}
              </span>
              <Button variant="ghost" size="sm" style={{ marginLeft: 'auto' }} onClick={() => toggleTranscript(s.file)}>
                {expanded?.file === s.file ? 'Hide transcript' : 'View transcript'}
              </Button>
            </div>
            {expanded?.file === s.file ? (
              <div
                className="nt-service-note" style={{
maxHeight: 260,
                  overflowY: 'auto',
                  margin: '0 0 10px',
                  padding: '10px 12px',
                  border: '1px solid var(--nd-border-default)',
                  background: 'var(--nd-bg-raised)',
                  whiteSpace: 'pre-wrap',
                  overflowWrap: 'anywhere'
}}
              >
                {expanded.events.map((e, i) => (
                  <div
                    key={i}
                    style={{
                      color:
                        e.type === 'in'
                          ? 'var(--nd-accent-text)'
                          : e.type === 'blocked'
                            ? 'var(--nd-warning)'
                            : e.type === 'open' || e.type === 'close'
                              ? 'var(--nd-text-muted)'
                              : 'var(--nd-text-secondary)',
                    }}
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
                  <div style={{ color: 'var(--nd-warning)' }}>— transcript truncated at the read cap —</div>
                ) : null}
              </div>
            ) : null}
          </div>
        ))
      )}
    </div>
  );
}
