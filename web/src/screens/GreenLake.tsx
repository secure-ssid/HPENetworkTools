/**
 * web/src/screens/GreenLake.tsx — the HPE GreenLake workspace surface.
 *
 * The one screen that treats GreenLake as a platform rather than as a licence
 * feed: workspace members, locations and role grants, plus the reviewed writes
 * the workspace credential is allowed to perform (invite/remove a user, create
 * /delete a location, add a device, submit a subscription key, grant/revoke a
 * role). Subscriptions themselves stay on Licences — that screen reconciles
 * them against racked hardware and this one does not duplicate it.
 *
 * HONESTY RULES THIS SCREEN ENFORCES:
 *  - A section listed in `unavailable` renders as an explicit failure with its
 *    read status, never as an empty table. "No users" and "the users feed was
 *    denied" must never look alike.
 *  - `accepted` (HTTP 202) is reported as submitted-for-validation, never as
 *    applied: the subscription endpoints validate the key asynchronously.
 *  - There is no role PICKER. GreenLake withdrew the role catalogue endpoint
 *    from its public API, so the portal cannot enumerate assignable roles and
 *    asks for the role GRN rather than pretending to offer a complete list.
 *  - Device removal is absent because GreenLake answers 405 to it; the screen
 *    does not offer an action the plane cannot perform.
 *
 * Every write is gated server-side on the declared write scope AND an explicit
 * review confirmation; `canWrite` only decides whether the controls render.
 */

import { useCallback, useEffect, useState } from 'react';
import {
  Alert,
  Badge,
  Button,
  Card,
  Input,
  SectionHeader,
  Spinner,
  Table,
  useToast,
} from '../nightdesk';
import { getGreenLakeInventory, runGreenLakeAction } from '../api/client';
import type { GreenLakeInventoryResponse } from '../api/client';
import type { GreenLakeSectionKey, GreenLakeWriteAction } from '../../../shared';
import { useSettings } from '../app/SettingsContext';
import { ScreenHeader } from './ScreenHeader';
import { ApiErrorState } from './ApiErrorState';

/** Human label per section, used by both the headers and the failure notes. */
const SECTION_LABEL: Record<GreenLakeSectionKey, string> = {
  users: 'Workspace members',
  locations: 'Locations',
  roleAssignments: 'Role grants',
};

function shortDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' });
}

/** A failed section states what happened and why — never an empty table. */
function SectionFailure({
  data,
  section,
}: {
  data: GreenLakeInventoryResponse;
  section: GreenLakeSectionKey;
}) {
  const status = data.readStatus[section];
  const message =
    status && status.state === 'failed'
      ? status.message
      : 'This section has not been read yet; run a sync to obtain its current status.';
  return (
    <Alert tone="warning" title={`${SECTION_LABEL[section]} could not be read`}>
      <span style={{ fontSize: 13 }}>{message}</span>
    </Alert>
  );
}

/** A labelled inline field for the small write forms. */
function Field({
  label,
  value,
  onChange,
  placeholder,
  width = 190,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  width?: number;
}) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <span
        style={{
          fontSize: 'var(--nd-text-10)',
          letterSpacing: '.08em',
          textTransform: 'uppercase',
          color: 'var(--nd-text-muted)',
        }}
      >
        {label}
      </span>
      <Input
        size="sm"
        value={value}
        placeholder={placeholder}
        style={{ width }}
        onChange={(e) => onChange(e.currentTarget.value)}
      />
    </label>
  );
}

export default function GreenLake() {
  const { density } = useSettings();
  const { toast } = useToast();
  const [data, setData] = useState<GreenLakeInventoryResponse | null>(null);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);

  // Write form state — one flat bag keeps the small inline forms simple.
  const [inviteEmail, setInviteEmail] = useState('');
  const [locName, setLocName] = useState('');
  const [locStreet, setLocStreet] = useState('');
  const [locCity, setLocCity] = useState('');
  const [locPostal, setLocPostal] = useState('');
  const [locCountry, setLocCountry] = useState('');
  const [locContact, setLocContact] = useState('');
  const [locPhone, setLocPhone] = useState('');
  const [devSerial, setDevSerial] = useState('');
  const [devMac, setDevMac] = useState('');
  const [subKey, setSubKey] = useState('');
  const [rolePrincipal, setRolePrincipal] = useState('');
  const [roleGrn, setRoleGrn] = useState('');

  const load = useCallback(async () => {
    const d = await getGreenLakeInventory();
    if (d === null) {
      setFailed(true);
      return;
    }
    setFailed(false);
    setData(d);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  /**
   * Run one reviewed action, then reload. The toast distinguishes `applied`
   * from `accepted` so a 202 is never reported as a completed change.
   */
  const run = async (
    action: GreenLakeWriteAction,
    fields: Record<string, unknown>,
    onDone?: () => void,
  ) => {
    setBusy(true);
    const r = await runGreenLakeAction(action, fields);
    setBusy(false);
    if (!r.ok) {
      toast('GreenLake refused the change', { description: r.message, tone: 'danger' });
      return;
    }
    if (r.outcome === 'accepted') {
      toast('Submitted to GreenLake', {
        description: `${r.message}. The workspace validates this asynchronously — it is not applied yet.`,
      });
    } else {
      toast('Applied in GreenLake', { description: r.message });
    }
    onDone?.();
    // The platform sections are cached on a 5-minute cadence, so a fresh row
    // may not appear until the next pull; say so rather than imply staleness
    // is a failure.
    await load();
  };

  if (failed) {
    return (
      <ApiErrorState message="The GreenLake workspace could not be read. It may not be linked — connect it from Connected systems." />
    );
  }
  if (!data) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', padding: 96 }}>
        <Spinner size="md" />
      </div>
    );
  }

  const has = (s: GreenLakeSectionKey) => !data.unavailable.includes(s);
  const readOnly = !data.canWrite;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      <ScreenHeader
        overline="Govern / GreenLake"
        title="GreenLake workspace"
        subtitle="Workspace members, locations and role grants, plus the reviewed changes this credential may make. Subscriptions are reconciled on Licences."
        actions={
          <>
            <span
              style={{
                fontFamily: 'var(--nd-font-mono)',
                fontSize: 'var(--nd-text-10)',
                color: 'var(--nd-text-muted)',
                letterSpacing: '.08em',
              }}
            >
              {data.source.toUpperCase()}
            </span>
            <Badge tone={readOnly ? 'neutral' : 'accent'}>
              {readOnly ? 'read only — no write scope' : 'reviewed writes'}
            </Badge>
            <Button variant="ghost" size="sm" onClick={() => void load()}>
              Refresh
            </Button>
          </>
        }
      />

      {data.unavailable.length > 0 ? (
        <Alert
          tone="warning"
          title={`${data.unavailable.length} of 3 GreenLake sections could not be read`}
        >
          <span style={{ fontSize: 13 }}>
            {data.unavailable.map((s) => SECTION_LABEL[s]).join(', ')} returned no data because the
            read failed — the tables below show what was actually readable, not an empty workspace.
          </span>
        </Alert>
      ) : null}

      {readOnly ? (
        <Alert tone="info" title="This workspace credential is read-only">
          <span style={{ fontSize: 13 }}>
            No write scope is declared for the GreenLake credential, so member, location, device,
            subscription and role changes are hidden. Declare a write scope on the GreenLake
            connection in Connected systems to enable them.
          </span>
        </Alert>
      ) : null}

      {/* -- Members ---------------------------------------------------- */}
      <SectionHeader
        label="Workspace members"
        meta={has('users') ? `${data.users.length} MEMBERS` : 'UNAVAILABLE'}
      />
      {has('users') ? (
        <Table density={density}>
          <Table.Head>
            <Table.Row>
              <Table.HeaderCell>Member</Table.HeaderCell>
              <Table.HeaderCell>Name</Table.HeaderCell>
              <Table.HeaderCell>Status</Table.HeaderCell>
              <Table.HeaderCell numeric>Last login</Table.HeaderCell>
              {readOnly ? null : <Table.HeaderCell> </Table.HeaderCell>}
            </Table.Row>
          </Table.Head>
          <Table.Body>
            {data.users.map((u) => (
              <Table.Row key={u.id}>
                <Table.Cell>
                  <span style={{ fontFamily: 'var(--nd-font-mono)', fontSize: 12 }}>
                    {u.username}
                  </span>
                </Table.Cell>
                <Table.Cell>{[u.firstName, u.lastName].filter(Boolean).join(' ') || '—'}</Table.Cell>
                <Table.Cell>
                  <Badge tone={u.status === 'VERIFIED' ? 'success' : 'warning'}>
                    {u.status ?? 'unknown'}
                  </Badge>
                </Table.Cell>
                <Table.Cell numeric>
                  <span style={{ fontFamily: 'var(--nd-font-mono)', fontSize: 12 }}>
                    {shortDate(u.lastLogin)}
                  </span>
                </Table.Cell>
                {readOnly ? null : (
                  <Table.Cell>
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={busy}
                      onClick={() => void run('deleteUser', { id: u.id })}
                    >
                      Remove
                    </Button>
                  </Table.Cell>
                )}
              </Table.Row>
            ))}
          </Table.Body>
        </Table>
      ) : (
        <SectionFailure data={data} section="users" />
      )}

      {readOnly ? null : (
        <Card>
          <div style={{ display: 'flex', gap: 12, alignItems: 'flex-end', flexWrap: 'wrap' }}>
            <Field
              label="Invite by email"
              value={inviteEmail}
              onChange={setInviteEmail}
              placeholder="person@example.com"
              width={260}
            />
            <Button
              variant="primary"
              size="sm"
              disabled={busy || inviteEmail.trim() === ''}
              onClick={() => void run('inviteUser', { email: inviteEmail.trim() }, () => setInviteEmail(''))}
            >
              Send invite
            </Button>
            <span style={{ fontSize: 12, color: 'var(--nd-text-muted)' }}>
              GreenLake emails the invitation immediately — this is not a draft.
            </span>
          </div>
        </Card>
      )}

      {/* -- Role grants ------------------------------------------------ */}
      <SectionHeader
        label="Role grants"
        meta={has('roleAssignments') ? `${data.roleAssignments.length} GRANTS` : 'UNAVAILABLE'}
      />
      {has('roleAssignments') ? (
        <Table density={density}>
          <Table.Head>
            <Table.Row>
              <Table.HeaderCell>Principal</Table.HeaderCell>
              <Table.HeaderCell>Role</Table.HeaderCell>
              <Table.HeaderCell>Scope</Table.HeaderCell>
              {readOnly ? null : <Table.HeaderCell> </Table.HeaderCell>}
            </Table.Row>
          </Table.Head>
          <Table.Body>
            {data.roleAssignments.map((a) => (
              <Table.Row key={a.id}>
                <Table.Cell>
                  {/* An unresolved principal shows its raw handle and type
                      rather than being dressed up as a named person. */}
                  {a.principalName ?? (
                    <span style={{ fontFamily: 'var(--nd-font-mono)', fontSize: 12 }}>
                      {a.principal}
                    </span>
                  )}
                  {a.principalName ? null : <Badge tone="neutral">{a.principalType}</Badge>}
                </Table.Cell>
                <Table.Cell>
                  <span style={{ fontFamily: 'var(--nd-font-mono)', fontSize: 12 }}>{a.role}</span>
                </Table.Cell>
                <Table.Cell>
                  <span style={{ fontSize: 12, color: 'var(--nd-text-muted)' }}>
                    {a.scope.length === 1 && a.scope[0].includes('/workspaces/')
                      ? 'this workspace'
                      : `${a.scope.length} scope${a.scope.length === 1 ? '' : 's'}`}
                  </span>
                </Table.Cell>
                {readOnly ? null : (
                  <Table.Cell>
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={busy}
                      onClick={() => void run('removeRoleAssignment', { id: a.id })}
                    >
                      Revoke
                    </Button>
                  </Table.Cell>
                )}
              </Table.Row>
            ))}
          </Table.Body>
        </Table>
      ) : (
        <SectionFailure data={data} section="roleAssignments" />
      )}

      {readOnly ? null : (
        <Card>
          <div style={{ display: 'flex', gap: 12, alignItems: 'flex-end', flexWrap: 'wrap' }}>
            <Field
              label="Principal"
              value={rolePrincipal}
              onChange={setRolePrincipal}
              placeholder="user:6aec904ab3a1…"
              width={230}
            />
            <Field
              label="Role GRN"
              value={roleGrn}
              onChange={setRoleGrn}
              placeholder="grn:glp/providers/authorization/roles/ccs.operator"
              width={330}
            />
            <Button
              variant="primary"
              size="sm"
              disabled={busy || rolePrincipal.trim() === '' || roleGrn.trim() === ''}
              onClick={() =>
                void run('assignRole', { principal: rolePrincipal.trim(), role: roleGrn.trim() }, () => {
                  setRolePrincipal('');
                  setRoleGrn('');
                })
              }
            >
              Grant role
            </Button>
          </div>
          <span style={{ fontSize: 12, color: 'var(--nd-text-muted)' }}>
            GreenLake withdrew its role-catalogue endpoint from the public API, so the portal cannot
            offer a role picker — copy the role GRN from the GreenLake console. Grants apply to this
            workspace.
          </span>
        </Card>
      )}

      {/* -- Locations -------------------------------------------------- */}
      <SectionHeader
        label="Locations"
        meta={has('locations') ? `${data.locations.length} LOCATIONS` : 'UNAVAILABLE'}
      />
      {has('locations') ? (
        data.locations.length === 0 ? (
          <Alert tone="info" title="This workspace has no locations">
            <span style={{ fontSize: 13 }}>
              The locations feed was read successfully and returned nothing — the workspace genuinely
              has none defined yet.
            </span>
          </Alert>
        ) : (
          <Table density={density}>
            <Table.Head>
              <Table.Row>
                <Table.HeaderCell>Location</Table.HeaderCell>
                <Table.HeaderCell>Address</Table.HeaderCell>
                <Table.HeaderCell>Country</Table.HeaderCell>
                {readOnly ? null : <Table.HeaderCell> </Table.HeaderCell>}
              </Table.Row>
            </Table.Head>
            <Table.Body>
              {data.locations.map((l) => (
                <Table.Row key={l.id}>
                  <Table.Cell>{l.name}</Table.Cell>
                  <Table.Cell>
                    <span style={{ fontSize: 12, color: 'var(--nd-text-muted)' }}>
                      {l.address ?? '—'}
                    </span>
                  </Table.Cell>
                  <Table.Cell>{l.country ?? '—'}</Table.Cell>
                  {readOnly ? null : (
                    <Table.Cell>
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={busy}
                        onClick={() => void run('deleteLocation', { id: l.id })}
                      >
                        Delete
                      </Button>
                    </Table.Cell>
                  )}
                </Table.Row>
              ))}
            </Table.Body>
          </Table>
        )
      ) : (
        <SectionFailure data={data} section="locations" />
      )}

      {readOnly ? null : (
        <Card>
          <div style={{ display: 'flex', gap: 12, alignItems: 'flex-end', flexWrap: 'wrap' }}>
            <Field label="Name" value={locName} onChange={setLocName} placeholder="Campus-01" />
            <Field
              label="Street"
              value={locStreet}
              onChange={setLocStreet}
              placeholder="1 Example Way"
            />
            <Field label="City" value={locCity} onChange={setLocCity} placeholder="Houston" />
            <Field
              label="Postal code"
              value={locPostal}
              onChange={setLocPostal}
              placeholder="77001"
              width={120}
            />
            <Field
              label="Country"
              value={locCountry}
              onChange={setLocCountry}
              placeholder="United States"
              width={150}
            />
            <Field
              label="Primary contact"
              value={locContact}
              onChange={setLocContact}
              placeholder="user@example.com"
              width={200}
            />
            <Field
              label="Contact phone"
              value={locPhone}
              onChange={setLocPhone}
              placeholder="+15550000000"
              width={150}
            />
            <Button
              variant="primary"
              size="sm"
              disabled={
                busy ||
                [locName, locStreet, locCity, locPostal, locCountry, locContact, locPhone].some(
                  (v) => v.trim() === '',
                )
              }
              onClick={() =>
                void run(
                  'createLocation',
                  {
                    name: locName.trim(),
                    streetAddress: locStreet.trim(),
                    city: locCity.trim(),
                    postalCode: locPostal.trim(),
                    country: locCountry.trim(),
                    contactName: locContact.trim(),
                    contactEmail: locContact.trim(),
                    contactPhone: locPhone.trim(),
                  },
                  () => {
                    setLocName('');
                    setLocStreet('');
                    setLocCity('');
                    setLocPostal('');
                    setLocCountry('');
                    setLocContact('');
                    setLocPhone('');
                  },
                )
              }
            >
              Create location
            </Button>
          </div>
          {/* Both constraints cost a failed round-trip to discover, so the form
              states them rather than letting GreenLake reject the submission. */}
          <p style={{ margin: '8px 0 0', fontSize: 12, color: 'var(--muted, #8b93a7)' }}>
            Country must be the full name (“United States”, not “US”). The primary contact must be
            an existing workspace member’s username — GreenLake rejects the location otherwise.
          </p>
        </Card>
      )}

      {/* -- Devices & subscriptions ------------------------------------ */}
      {readOnly ? null : (
        <>
          <SectionHeader label="Add to the workspace" meta="DEVICES & SUBSCRIPTIONS" />
          <Card>
            <div style={{ display: 'flex', gap: 12, alignItems: 'flex-end', flexWrap: 'wrap' }}>
              <Field
                label="Device serial"
                value={devSerial}
                onChange={setDevSerial}
                placeholder="CNXXXXXXXX"
              />
              <Field
                label="MAC address"
                value={devMac}
                onChange={setDevMac}
                placeholder="00:11:22:33:44:55"
              />
              <Button
                variant="primary"
                size="sm"
                disabled={busy || devSerial.trim() === '' || devMac.trim() === ''}
                onClick={() =>
                  void run(
                    'addDevices',
                    { serialNumber: devSerial.trim(), macAddress: devMac.trim() },
                    () => {
                      setDevSerial('');
                      setDevMac('');
                    },
                  )
                }
              >
                Add device
              </Button>
            </div>
            <span style={{ fontSize: 12, color: 'var(--nd-text-muted)' }}>
              GreenLake does not allow devices to be removed through its API, so an added device
              cannot be deleted from here.
            </span>
          </Card>
          <Card>
            <div style={{ display: 'flex', gap: 12, alignItems: 'flex-end', flexWrap: 'wrap' }}>
              <Field
                label="Subscription key"
                value={subKey}
                onChange={setSubKey}
                placeholder="Subscription key from HPE"
                width={260}
              />
              <Button
                variant="primary"
                size="sm"
                disabled={busy || subKey.trim() === ''}
                onClick={() => void run('addSubscription', { key: subKey.trim() }, () => setSubKey(''))}
              >
                Submit key
              </Button>
              <span style={{ fontSize: 12, color: 'var(--nd-text-muted)' }}>
                GreenLake validates subscription keys asynchronously — a submitted key is not an
                added subscription until it appears on Licences.
              </span>
            </div>
          </Card>
        </>
      )}
    </div>
  );
}
