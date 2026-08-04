import { Alert, Button } from '../nightdesk';

export function ApiErrorState({ message }: { message: string }) {
  return (
    <div className="nt-api-error nd-api-error nt-callout-glass nt-section-panel">
      <div className="nt-api-error__kicker nd-api-error__kicker nt-micro-label" aria-hidden>
        HPE Network Tools · API fault
      </div>
      <div className="nt-status-ribbon nd-status-ribbon" role="status" aria-label="HPE Network Tools API fault ribbon">
        <span className="nt-status-ribbon__mark nd-status-ribbon__mark" aria-hidden />
        <span className="nt-status-ribbon__label nd-status-ribbon__label">Portal API could not load this lane · retry stays local</span>
      </div>
      <Alert tone="danger" title="The portal API could not load this screen">
        <span>{message}</span>
      </Alert>
      <div>
        <Button variant="secondary" size="sm" onClick={() => window.location.reload()}>
          Retry
        </Button>
      </div>
    </div>
  );
}
