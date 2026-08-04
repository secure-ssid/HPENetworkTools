/**
 * Incident spine — carries alert/device/ticket context across navigations
 * so triage is one continuous path instead of disconnected screens.
 */

import { createContext, useCallback, useContext, useMemo, useState } from 'react';
import type { ReactNode } from 'react';

export type IncidentContextValue = {
  alertId?: string;
  alertTitle?: string;
  deviceName?: string;
  devicePlane?: string;
  ticketId?: string;
  sourcePath?: string;
};

type IncidentApi = {
  incident: IncidentContextValue | null;
  setIncident: (next: IncidentContextValue | null) => void;
  clearIncident: () => void;
  /** Start or extend an incident while preserving prior fields. */
  patchIncident: (patch: IncidentContextValue) => void;
};

const IncidentContext = createContext<IncidentApi | null>(null);

export function IncidentProvider({ children }: { children: ReactNode }) {
  const [incident, setIncidentState] = useState<IncidentContextValue | null>(null);

  const setIncident = useCallback((next: IncidentContextValue | null) => {
    setIncidentState(next);
  }, []);

  const clearIncident = useCallback(() => setIncidentState(null), []);

  const patchIncident = useCallback((patch: IncidentContextValue) => {
    setIncidentState((cur) => ({ ...(cur ?? {}), ...patch }));
  }, []);

  const value = useMemo(
    () => ({ incident, setIncident, clearIncident, patchIncident }),
    [incident, setIncident, clearIncident, patchIncident],
  );

  return <IncidentContext.Provider value={value}>{children}</IncidentContext.Provider>;
}

export function useIncident(): IncidentApi {
  const ctx = useContext(IncidentContext);
  if (!ctx) {
    return {
      incident: null,
      setIncident: () => undefined,
      clearIncident: () => undefined,
      patchIncident: () => undefined,
    };
  }
  return ctx;
}
