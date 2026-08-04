/**
 * RecordedSessions — metadata CSV export (Loop 124).
 * Transcript bodies never leave the UI via Export sessions.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import {
  RecordedSessions,
  recordedSessionExportRows,
  sessionFileLabel,
} from './RecordedSessions';
import { ToastProvider } from '../../nightdesk';
import * as csv from '../../lib/csv';
import type { TerminalSession } from '../../api/client';

const SESSIONS: TerminalSession[] = [
  {
    file: '/var/log/portal/sess-a.jsonl',
    device: 'sw-core-a',
    user: 'netops',
    target: '10.0.0.1',
    openedAt: '2026-08-04T12:00:00.000Z',
  },
  {
    file: 'sess-b.jsonl',
    device: 'sw-core-a',
    user: 'lab',
    target: 'sw-core-a',
    openedAt: '2026-08-04T13:00:00.000Z',
  },
];

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('sessionFileLabel / recordedSessionExportRows', () => {
  it('keeps basenames only and never invents columns', () => {
    expect(sessionFileLabel('/var/log/portal/sess-a.jsonl')).toBe('sess-a.jsonl');
    expect(sessionFileLabel('plain.jsonl')).toBe('plain.jsonl');
    expect(recordedSessionExportRows(SESSIONS)).toEqual([
      ['2026-08-04T12:00:00.000Z', 'netops', '10.0.0.1', 'sw-core-a', 'sess-a.jsonl'],
      ['2026-08-04T13:00:00.000Z', 'lab', 'sw-core-a', 'sw-core-a', 'sess-b.jsonl'],
    ]);
  });
});

describe('RecordedSessions Export sessions', () => {
  it('exports metadata CSV when sessions are on file', () => {
    const spy = vi.spyOn(csv, 'exportTableCsv').mockReturnValue(2);
    render(
      <ToastProvider>
        <RecordedSessions
          sessions={SESSIONS}
          sessionsError={null}
          expanded={null}
          toggleTranscript={() => undefined}
          deviceName="sw-core-a"
        />
      </ToastProvider>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Export sessions' }));
    expect(spy).toHaveBeenCalledTimes(1);
    const [filename, headers, rows] = spy.mock.calls[0]!;
    expect(filename).toBe('device-sessions-sw-core-a.csv');
    expect(headers).toEqual(['openedAt', 'user', 'target', 'device', 'file']);
    expect(rows).toEqual(recordedSessionExportRows(SESSIONS));
    /* No transcript text columns. */
    expect(headers).not.toContain('events');
    expect(headers).not.toContain('transcript');
  });

  it('hides Export sessions when the list is empty', () => {
    render(
      <ToastProvider>
        <RecordedSessions
          sessions={[]}
          sessionsError={null}
          expanded={null}
          toggleTranscript={() => undefined}
        />
      </ToastProvider>,
    );
    expect(screen.queryByRole('button', { name: 'Export sessions' })).toBeNull();
  });
});
