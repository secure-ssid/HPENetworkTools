import { Alert, Button } from '../nightdesk';

export function ApiErrorState({ message }: { message: string }) {
  return (
    <div style={{ maxWidth: 760, margin: '48px auto', display: 'flex', flexDirection: 'column', gap: 16 }}>
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
