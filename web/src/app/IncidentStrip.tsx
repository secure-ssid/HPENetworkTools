/**
 * Active incident spine — keeps alert → device → ticket context visible
 * while the operator moves across screens.
 */
import { useNavigate } from 'react-router-dom';
import { Button } from '../nightdesk';
import { useIncident } from './IncidentContext';
import { deviceDetailPath } from './nav';

export function IncidentStrip() {
  const { incident, clearIncident } = useIncident();
  const navigate = useNavigate();
  if (!incident) return null;
  if (!incident.alertTitle && !incident.deviceName && !incident.ticketId) return null;

  const crumbs = [
    incident.alertTitle ? `Alert · ${incident.alertTitle}` : null,
    incident.deviceName ? `Device · ${incident.deviceName}` : null,
    incident.ticketId ? `Ticket · ${incident.ticketId}` : null,
  ].filter(Boolean);

  return (
    <div
      className="nt-incident-strip nt-toolbar-glass"
      role="region"
      aria-label="Active incident"
      data-has-alert={incident.alertTitle ? '1' : '0'}
      data-has-device={incident.deviceName ? '1' : '0'}
      data-has-ticket={incident.ticketId ? '1' : '0'}
    >
      {/* The strip used to open with the product name and a static
          "alert → device → ticket" legend, then print the real spine —
          Alert · … → Device · … → Ticket · … — immediately after. The two
          decorations took 350px of a 1450px bar and squeezed the only line
          that carried anything into three wrapped rows. */}
      <span className="nt-incident-strip__title">{crumbs.join('  →  ')}</span>
      <div className="nt-incident-strip__actions">
        {incident.deviceName ? (
          <Button
            variant="ghost"
            size="sm"
            onClick={() =>
              navigate(
                deviceDetailPath({
                  name: incident.deviceName!,
                  plane: incident.devicePlane,
                }),
              )
            }
          >
            Open device
          </Button>
        ) : null}
        {incident.sourcePath ? (
          <Button variant="ghost" size="sm" onClick={() => navigate(incident.sourcePath!)}>
            Back to source
          </Button>
        ) : null}
        <Button variant="ghost" size="sm" onClick={() => navigate('/tickets')}>
          Tickets
        </Button>
        <Button variant="ghost" size="sm" onClick={clearIncident}>
          Clear
        </Button>
      </div>
    </div>
  );
}
