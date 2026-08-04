import { Alert, Button } from '../nightdesk';

export function ApiErrorState({ message }: { message: string }) {
  return (
    <div className="nt-api-error nt-callout-glass nt-section-panel">
      <div className="nt-api-error__kicker" aria-hidden>
        NightDesk · API fault
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
