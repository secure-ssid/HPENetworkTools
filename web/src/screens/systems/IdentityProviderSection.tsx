/**
 * Identity provider: read, test and save the OIDC configuration.
 *
 * Every network plane already had a card here with credentials and a real
 * connection test. The identity provider — the one system that decides who may
 * touch any of the others — did not: it could only be configured by editing
 * settings.json by hand, with no feedback until a sign-in failed.
 *
 * Two honesty rules shape this component:
 *
 *   1. **Configured is not active.** The server installs its auth guard once,
 *      at boot. Saving a provider into a process that started without one is a
 *      real change that is *not yet in force*, and the badge says exactly that
 *      rather than turning green. A portal claiming to be protected while it
 *      still serves every route unauthenticated would be the worst possible
 *      version of the green-badge-over-a-failure this codebase refuses.
 *   2. **A passing discovery is not a passing credential.** The test reports
 *      what was actually proven — that the provider answered, and separately
 *      whether it accepted the client id and secret — instead of collapsing
 *      both into one tick.
 */

import { useEffect, useState } from 'react';
import {
  getAuthConfig,
  removeAuthConfig,
  saveAuthConfig,
  testAuthConfig,
  type AuthConfigView,
  type AuthTestResult,
} from '../../api/auth';
import { Alert, Badge, Button, FormField, Input, SectionHeader, useToast } from '../../nightdesk';
import { buildSystemsSectionUrl, systemsSectionDomId } from './share';

interface Draft {
  issuer: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  allowedGroups: string;
}

const EMPTY: Draft = { issuer: '', clientId: '', clientSecret: '', redirectUri: '', allowedGroups: '' };

function draftFrom(cfg: AuthConfigView): Draft {
  return {
    issuer: cfg.issuer ?? '',
    clientId: cfg.clientId ?? '',
    // The stored secret arrives masked. Keeping the mask in the field means
    // "unchanged" round-trips correctly — the server treats it as such.
    clientSecret: cfg.clientSecret ?? '',
    redirectUri: cfg.redirectUri ?? defaultRedirectUri(),
    allowedGroups: (cfg.allowedGroups ?? []).join(', '),
  };
}

/** The callback this build actually serves, on whatever origin it is served from. */
function defaultRedirectUri(): string {
  return `${window.location.origin}/api/auth/callback`;
}

export function IdentityProviderSection() {
  const { toast } = useToast();
  const [cfg, setCfg] = useState<AuthConfigView | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft>(EMPTY);
  const [test, setTest] = useState<AuthTestResult | null>(null);
  const [busy, setBusy] = useState<'test' | 'save' | 'remove' | null>(null);

  const apply = (res: AuthConfigView | { error: string }) => {
    if ('error' in res) {
      setLoadError(res.error);
      setCfg(null);
      return;
    }
    setLoadError(null);
    setCfg(res);
    setDraft(draftFrom(res));
  };

  const load = async () => apply(await getAuthConfig());

  useEffect(() => {
    // Loaded once; every later change goes through save/remove, which re-read.
    let live = true;
    void getAuthConfig().then((res) => {
      if (live) apply(res);
    });
    return () => {
      live = false;
    };
  }, []);

  const set = (key: keyof Draft) => (e: { target: { value: string } }) =>
    setDraft((d) => ({ ...d, [key]: e.target.value }));

  const payload = () => ({
    issuer: draft.issuer.trim(),
    clientId: draft.clientId.trim(),
    clientSecret: draft.clientSecret.trim(),
    redirectUri: draft.redirectUri.trim(),
    allowedGroups: draft.allowedGroups
      .split(',')
      .map((g) => g.trim())
      .filter(Boolean),
  });

  const runTest = async () => {
    setBusy('test');
    setTest(null);
    const result = await testAuthConfig(payload());
    setTest(result);
    setBusy(null);
  };

  const runSave = async () => {
    setBusy('save');
    const result = await saveAuthConfig(payload());
    setBusy(null);
    if (!result.ok) {
      toast(result.message, { tone: 'danger' });
      return;
    }
    // The server's note is the honest one — it distinguishes saved-and-enforced
    // from saved-but-this-process-is-still-open.
    toast('Identity provider saved', {
      description: result.message,
      tone: result.restartRequired ? 'warning' : 'success',
    });
    await load();
  };

  const runRemove = async () => {
    setBusy('remove');
    const result = await removeAuthConfig();
    setBusy(null);
    if (!result.ok) {
      toast(result.message, { tone: 'danger' });
      return;
    }
    toast('Identity provider removed', {
      description: result.message,
      tone: result.restartRequired ? 'warning' : 'info',
    });
    await load();
  };

  const editable = cfg?.editable ?? false;
  const disabled = !editable || busy !== null;

  const copySectionLink = () => {
    const url = buildSystemsSectionUrl('identity');
    void navigator.clipboard.writeText(url).then(
      () =>
        toast('Identity section link copied', {
          description: 'section=identity',
          tone: 'success',
        }),
      () => toast('Could not copy link', { description: url, tone: 'warning' }),
    );
  };

  return (
    <div id={systemsSectionDomId('identity')} className="nt-systems-section nt-section-panel nt-stack-14">
      <div className="nt-filter-bar nt-gap-8">
        <SectionHeader label="Identity provider" meta="OIDC · WHO MAY USE THIS PORTAL" />
        <Button variant="ghost" size="sm" className="nt-ml-auto" onClick={copySectionLink}>
          Copy section link
        </Button>
      </div>
      <div className="nt-status-ribbon nt-idp-ribbon" role="status" aria-label="Identity provider status ribbon">
        <span className="nt-status-ribbon__item">identity · entry gate</span>
        <span className="nt-status-ribbon__item">who may enter</span>
        <span className="nt-status-ribbon__item">broker path</span>
      </div>

      <div className="nt-row-wrap-8">
        {cfg ? (
          <>
            <Badge tone={cfg.active ? 'success' : cfg.configured ? 'warning' : 'danger'} dot>
              {cfg.active
                ? 'enforced'
                : cfg.configured
                  ? 'configured — not in force until restart'
                  : 'no identity provider — every route is open'}
            </Badge>
            {cfg.source !== 'none' ? <Badge tone="neutral">{`from ${cfg.source}`}</Badge> : null}
            {cfg.allowedGroups?.length ? (
              <Badge tone="neutral">{`groups: ${cfg.allowedGroups.join(', ')}`}</Badge>
            ) : cfg.configured ? (
              <Badge tone="neutral">any authenticated account</Badge>
            ) : null}
          </>
        ) : (
          <span
            className="nt-hint-muted"
          >
            {loadError ?? 'reading identity provider…'}
          </span>
        )}
      </div>

      {cfg && !cfg.configured ? (
        <Alert tone="warning" title="No identity provider is configured">
          Every API route is open and every audit line is attributed to
          &lsquo;operator&rsquo; rather than naming who made the change. The server refuses to
          bind a network-reachable address in this state.
        </Alert>
      ) : null}

      {cfg?.configured && !cfg.active ? (
        <Alert tone="warning" title="Saved, but not yet enforced">
          This server process started without an identity provider and installs its guard
          only at startup. It is still serving every route unauthenticated. Restart the
          server to put this configuration in force.
        </Alert>
      ) : null}

      {cfg && !cfg.editable ? (
        <Alert tone="info" title="Configured through the environment">
          The HPE_OIDC_* variables own this configuration, so it cannot be changed here.
          Change those and restart instead.
        </Alert>
      ) : null}

      <div className="nt-grid-2-14">
        <FormField
          label="OIDC issuer"
          help="Authentik has no server-wide discovery document — use https://<host>/application/o/<slug>/ including the trailing slash."
        >
          <Input
            value={draft.issuer}
            onChange={set('issuer')}
            disabled={disabled}
            mono
            placeholder="https://id.example.com/application/o/portal/"
            aria-label="OIDC issuer"
          />
        </FormField>
        <FormField label="OIDC redirect URI" help="Must match a redirect URI registered on the provider exactly.">
          <Input
            value={draft.redirectUri}
            onChange={set('redirectUri')}
            disabled={disabled}
            mono
            placeholder={defaultRedirectUri()}
            aria-label="OIDC redirect URI"
          />
        </FormField>
        <FormField label="OIDC client ID">
          <Input value={draft.clientId} onChange={set('clientId')} disabled={disabled} mono aria-label="OIDC client ID" />
        </FormField>
        <FormField label="OIDC client secret" help="Stored masked; leave the mask to keep the saved value.">
          <Input
            value={draft.clientSecret}
            onChange={set('clientSecret')}
            disabled={disabled}
            type="password"
            mono
            aria-label="OIDC client secret"
          />
        </FormField>
        <FormField
          label="OIDC allowed groups"
          help="Comma separated. Leave empty to admit any account the provider authenticates."
        >
          <Input
            value={draft.allowedGroups}
            onChange={set('allowedGroups')}
            disabled={disabled}
            placeholder="net-admins, noc"
            aria-label="OIDC allowed groups"
          />
        </FormField>
      </div>

      <div className="nt-row nt-gap-8 nt-flex-wrap">
        <Button onClick={() => void runTest()} disabled={busy !== null || !draft.issuer.trim()}>
          {busy === 'test' ? 'Testing…' : 'Test provider'}
        </Button>
        <Button variant="primary" onClick={() => void runSave()} disabled={disabled}>
          {busy === 'save' ? 'Saving…' : 'Save provider'}
        </Button>
        {cfg?.configured && editable ? (
          <Button variant="danger" onClick={() => void runRemove()} disabled={busy !== null}>
            {busy === 'remove' ? 'Removing…' : 'Remove provider'}
          </Button>
        ) : null}
      </div>

      {test ? (
        <Alert
          tone={test.ok ? 'success' : 'danger'}
          title={test.ok ? 'Provider answered' : 'Test failed'}
        >
          <div>
            {test.message}
            {typeof test.ms === 'number' ? ` (${test.ms}ms)` : ''}
          </div>
          {test.hint ? <div className="nt-mt-6">{test.hint}</div> : null}
          {test.endpoints ? (
            <div
              className="nt-hint-muted nt-mt-6-break"
            >
              <div>authorize: {test.endpoints.authorization}</div>
              <div>token: {test.endpoints.token}</div>
              <div>jwks: {test.endpoints.jwks}</div>
            </div>
          ) : null}
          {test.cautions?.length ? (
            <ul className="nt-ul-indent">
              {test.cautions.map((c) => (
                <li key={c}>{c}</li>
              ))}
            </ul>
          ) : null}
        </Alert>
      ) : null}
    </div>
  );
}
