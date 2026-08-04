import { useState } from 'react';
import {
  Alert,
  AppShell,
  Avatar,
  Badge,
  Breadcrumbs,
  Button,
  Card,
  Checkbox,
  Code,
  ConfirmDialog,
  Divider,
  Drawer,
  EmptyState,
  FormField,
  Heading,
  Input,
  Kbd,
  Menu,
  MenuItem,
  MenuSeparator,
  Modal,
  PageSkeleton,
  Pagination,
  Progress,
  SectionHeader,
  SegmentedControl,
  Select,
  Skeleton,
  Spinner,
  Stack,
  Stat,
  Switch,
  Table,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  Text,
  Textarea,
  Tooltip,
  useToast,
} from '../nightdesk';

const DEVICES = [
  { name: 'sw-core-a', model: 'CX 8325', site: 'Campus-01 — Meridian HQ', plane: 'LOCAL', clients: 412, state: 'up', tone: 'success' as const },
  { name: 'ap-3f-12', model: 'AP-635', site: 'Campus-02 Research', plane: 'MIST', clients: 86, state: 'degraded', tone: 'warning' as const },
  { name: 'mm-lake-1', model: 'MM-VA-10K', site: 'Lakeshore Medical Center', plane: 'AOS-8', clients: 744, state: 'degraded', tone: 'warning' as const },
  { name: 'gw-edge-1', model: 'CX 9240', site: 'Campus-01 — Meridian HQ', plane: 'AOS-10', clients: 0, state: 'up', tone: 'success' as const },
  { name: 'uxi-cam01-2', model: 'UXI-G5', site: 'Campus-01 — Meridian HQ', plane: 'UXI', clients: 0, state: 'offline', tone: 'danger' as const },
  { name: 'cppm-01', model: 'C3000V', site: 'Core services', plane: 'CLEARPASS', clients: 0, state: 'up', tone: 'success' as const },
];

const mono = { fontFamily: 'var(--nd-font-mono)' } as const;

const subtitle = {
  fontFamily: 'var(--nd-font-display)',
  fontStyle: 'italic',
  fontSize: 15,
  color: 'var(--nd-text-secondary)',
  marginTop: 6,
} as const;

export function DsGallery() {
  const { toast } = useToast();
  const [density, setDensity] = useState<'comfortable' | 'compact'>('comfortable');
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [page, setPage] = useState(1);
  const [unacked, setUnacked] = useState(true);
  const [q, setQ] = useState('');
  const [sev, setSev] = useState('all');
  const [note, setNote] = useState('Escalate to on-call if tunnel flaps recur.');
  const [brokered, setBrokered] = useState(true);
  const [readInventory, setReadInventory] = useState(true);
  const [modalOpen, setModalOpen] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [galleryTab, setGalleryTab] = useState('queue');

  const sidebar = (
    <>
      <div>
        <div className="nd-micro-label" style={{ color: 'var(--nd-accent-text)', marginBottom: 4 }}>
          HPE
        </div>
        <div
          style={{
            fontFamily: 'var(--nd-font-display)',
            fontStyle: 'italic',
            fontSize: 19,
            color: 'var(--nd-text-primary)',
          }}
        >
          NightDesk
        </div>
      </div>
      <Stack gap={16}>
        <Stack gap={4}>
          <div className="nd-micro-label" style={{ padding: '0 8px 4px' }}>
            Operate
          </div>
          <AppShell.NavItem label="Overview" onClick={() => toast('Overview — not built yet')} />
          <AppShell.NavItem label="Alerts" onClick={() => toast('Alerts — not built yet')} />
          <AppShell.NavItem label="Clients" onClick={() => toast('Clients — not built yet')} />
        </Stack>
        <Stack gap={4}>
          <div className="nd-micro-label" style={{ padding: '0 8px 4px' }}>
            Inventory
          </div>
          <AppShell.NavItem label="Sites" onClick={() => toast('Sites — not built yet')} />
          <AppShell.NavItem label="Devices" onClick={() => toast('Devices — not built yet')} />
        </Stack>
        <Stack gap={4}>
          <div className="nd-micro-label" style={{ padding: '0 8px 4px' }}>
            Design
          </div>
          <AppShell.NavItem label="Design gallery" active />
        </Stack>
      </Stack>
      <div
        style={{
          marginTop: 'auto',
          padding: '12px 8px 0',
          borderTop: '1px solid var(--nd-border-subtle)',
        }}
      >
        <Stack gap={6}>
          <span className="nd-micro-label">Workspace</span>
          <Text size={12}>
            Meridian Health{' '}
            <Text as="span" size={10} mono tone="muted">
              GLK
            </Text>
          </Text>
          <Text size={10} mono tone="muted">
            6 of 7 systems linked
          </Text>
        </Stack>
      </div>
    </>
  );

  const topbar = (
    <>
      <Breadcrumbs
        items={[{ label: 'Meridian Health' }, { label: 'Design' }, { label: 'Gallery' }]}
      />
      <div style={{ marginLeft: 'auto', position: 'relative', width: 420 }}>
        <Input
          mono
          placeholder="Jump to a site, device, MAC, IP or ticket…"
          style={{ paddingRight: 74 }}
          aria-label="Global search"
        />
        <div
          style={{
            position: 'absolute',
            right: 8,
            top: 7,
            display: 'flex',
            gap: 4,
            alignItems: 'center',
            pointerEvents: 'none',
          }}
        >
          <Kbd>⌘</Kbd>
          <Kbd>K</Kbd>
        </div>
      </div>
      <Stack direction="row" gap={10} align="center">
        <div style={{ textAlign: 'right' }}>
          <Text as="div" size={12}>
            R. Okafor
          </Text>
          <div className="nd-micro-label">NetOps</div>
        </div>
        <Avatar name="R. Okafor" size="sm" />
      </Stack>
    </>
  );

  return (
    <AppShell sidebar={sidebar} topbar={topbar}>
      <Stack gap={22}>
        <div
          style={{
            display: 'flex',
            alignItems: 'flex-end',
            justifyContent: 'space-between',
            gap: 24,
            flexWrap: 'wrap',
          }}
        >
          <div>
            <Heading level={2} overline="Meridian Health / Design system">
              Design gallery
            </Heading>
            <div style={subtitle}>Every primitive, exercised against network-ops content.</div>
          </div>
          <Stack direction="row" gap={8} align="center">
            <span style={{ ...mono, fontSize: 10, color: 'var(--nd-text-muted)', letterSpacing: '.08em' }}>
              SYNCED 09:41 · AUTO 60s
            </span>
            <Button variant="ghost" size="sm">
              Acknowledge
            </Button>
            <Button variant="secondary" size="sm">
              Raise ticket
            </Button>
            <Button
              variant="primary"
              size="sm"
              onClick={() =>
                toast('Baseline push queued', { description: 'Ticket CHG-4182 · 15m lease' })
              }
            >
              Push baseline
            </Button>
          </Stack>
        </div>

        <Alert tone="danger" title="Riverside Clinic is dark — and its plane is stale" dismissible>
          WAN down 12 minutes. Central Classic last synced 6h ago, so device state there cannot be
          trusted. The local collector still answers on 10.51.0.0/24 — inspect sw-riv-1 over SSH
          instead.
        </Alert>
        <Alert tone="info" title="Brokered writes only">
          Changes need a ticket reference, hold a 15-minute lease, and are recorded with a rollback
          snapshot.
        </Alert>

        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(5, minmax(0, 1fr))',
            gap: 18,
          }}
        >
          <Stat label="Devices reachable" value="404 / 418" delta="▼ 3 since 08:00" deltaTone="negative" />
          <Stat label="Open alerts" value="7" delta="▲ 2 critical" deltaTone="negative" />
          <Stat label="Config drift" value="12" delta="▼ 4 this week" deltaTone="positive" />
          <Stat label="Licences ≤60d" value="34" delta="▲ 12 renewals due" deltaTone="neutral" />
          <Stat label="Planes linked" value="6 / 7" delta="Classic degraded" deltaTone="negative" />
        </div>

        <Divider variant="flair" />

        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'minmax(0, 1.5fr) minmax(0, 1fr)',
            gap: 34,
            alignItems: 'start',
          }}
        >
          <Stack gap={26}>
            <Stack gap={2}>
              <SectionHeader
                label="Devices"
                meta={
                  <span className="nt-row">
                    <span>6 of 418</span>
                    <SegmentedControl
                      ariaLabel="Table density"
                      value={density}
                      onValueChange={(v) => setDensity(v as 'comfortable' | 'compact')}
                      options={[
                        { value: 'comfortable', label: 'Comfortable' },
                        { value: 'compact', label: 'Compact' },
                      ]}
                    />
                  </span>
                }
              />
              <Table density={density}>
                <Table.Head>
                  <Table.Row>
                    <Table.HeaderCell>Device</Table.HeaderCell>
                    <Table.HeaderCell>Model</Table.HeaderCell>
                    <Table.HeaderCell>Site</Table.HeaderCell>
                    <Table.HeaderCell>Plane</Table.HeaderCell>
                    <Table.HeaderCell numeric>Clients</Table.HeaderCell>
                    <Table.HeaderCell>State</Table.HeaderCell>
                  </Table.Row>
                </Table.Head>
                <Table.Body>
                  {DEVICES.map((d) => (
                    <Table.Row
                      key={d.name}
                      interactive
                      onClick={() =>
                        toast(`Opening ${d.name}`, { description: 'Device detail — not built yet' })
                      }
                    >
                      <Table.Cell>
                        <span style={{ ...mono, fontSize: 'var(--nd-text-12)', color: 'var(--nd-accent-text)' }}>
                          {d.name}
                        </span>
                      </Table.Cell>
                      <Table.Cell>
                        <span style={{ ...mono, fontSize: 'var(--nd-text-11)', color: 'var(--nd-text-secondary)' }}>
                          {d.model}
                        </span>
                      </Table.Cell>
                      <Table.Cell>{d.site}</Table.Cell>
                      <Table.Cell>
                        <Badge plane>{d.plane}</Badge>
                      </Table.Cell>
                      <Table.Cell numeric>{d.clients}</Table.Cell>
                      <Table.Cell>
                        <Badge tone={d.tone} dot>
                          {d.state}
                        </Badge>
                      </Table.Cell>
                    </Table.Row>
                  ))}
                </Table.Body>
              </Table>
            </Stack>

            <Stack gap={16}>
              <SectionHeader label="Form controls" />
              <div
                style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 16 }}
              >
                <FormField label="Filter text" help="matches title, detail and site">
                  <Input
                    size="sm"
                    mono
                    placeholder="filter text…"
                    value={q}
                    onChange={(e) => setQ(e.target.value)}
                  />
                </FormField>
                <FormField label="Severity" htmlFor="gallery-sev">
                  <Select
                    id="gallery-sev"
                    size="sm"
                    value={sev}
                    onValueChange={setSev}
                    options={[
                      { value: 'all', label: 'All severities' },
                      { value: 'P1', label: 'P1 — critical' },
                      { value: 'P2', label: 'P2 — major' },
                      { value: 'P3', label: 'P3 — minor' },
                    ]}
                  />
                </FormField>
              </div>
              <FormField label="Ticket note" help="mirrors to ServiceNow on save">
                <Textarea value={note} onChange={(e) => setNote(e.target.value)} />
              </FormField>
              <Stack gap={10}>
                <Checkbox
                  label="Brokered write — config push, requires a ticket reference"
                  checked={brokered}
                  onChange={(e) => setBrokered(e.target.checked)}
                />
                <Checkbox
                  label="Read inventory, sites and topology"
                  checked={readInventory}
                  onChange={(e) => setReadInventory(e.target.checked)}
                />
                <Switch label="Unacknowledged only" checked={unacked} onCheckedChange={setUnacked} />
              </Stack>
              <Stack direction="row" gap={8} align="center" wrap>
                <Button variant="primary" size="sm">
                  Queue the change
                </Button>
                <Button variant="secondary" size="sm">
                  Dry run
                </Button>
                <Button variant="ghost" size="sm">
                  Cancel
                </Button>
                <Button variant="secondary" size="md">
                  Sync all
                </Button>
                <Button variant="primary" size="lg">
                  Connect a system
                </Button>
                <Button variant="ghost" size="md" disabled>
                  Disabled until ticket
                </Button>
              </Stack>
            </Stack>

            <Stack gap={14}>
              <SectionHeader label="Typography & code" />
              <Stack gap={10}>
                <Heading level={1}>Display 44</Heading>
                <Heading level={3}>Section 18</Heading>
                <Heading level={4}>Subsection 16</Heading>
              </Stack>
              <Stack gap={6}>
                <Text size={14}>Interface prose 14 — every plane's alarms in one queue.</Text>
                <Text size={12} tone="secondary">
                  Secondary 12.5 — de-duplicated and aged.
                </Text>
                <Text size={12} tone="muted">
                  Muted 12.5 — used sparingly.
                </Text>
                <Text size={11} mono tone="secondary">
                  mono 11 — sw-core-a · 10.42.8.11 · up 41d 04:12:33
                </Text>
                <Text size={14}>
                  Run <Code>show vlan 812</Code> on the core, or press <Kbd>⌘</Kbd> <Kbd>K</Kbd> to
                  jump anywhere.
                </Text>
              </Stack>
              <Code block>{`vlan 812
   name "MRDN-Imaging"
   tagged 1/1/14
   exit
! pushed via central api · POST /configuration/v2/vlan · classic stays read-only`}</Code>
            </Stack>
          </Stack>

          <Stack gap={26}>

            <Stack gap={12}>
              <SectionHeader label="Overlays" meta="NightDesk 2.0 primitives" />
              <Stack direction="row" gap={8} wrap>
                <Button variant="secondary" size="sm" onClick={() => setModalOpen(true)}>
                  Open modal
                </Button>
                <Button variant="danger" size="sm" onClick={() => setConfirmOpen(true)}>
                  Confirm dialog
                </Button>
                <Tooltip content="State owns hue · planes stay monochrome">
                  <Button variant="ghost" size="sm">
                    Hover tooltip
                  </Button>
                </Tooltip>
                <Menu
                  open={menuOpen}
                  onOpenChange={setMenuOpen}
                  align="start"
                  trigger={
                    <Button variant="secondary" size="sm">
                      Menu ▾
                    </Button>
                  }
                >
                  <MenuItem
                    onSelect={() => {
                      setMenuOpen(false);
                      toast('Inspect', { tone: 'info' });
                    }}
                  >
                    Inspect
                  </MenuItem>
                  <MenuItem
                    onSelect={() => {
                      setMenuOpen(false);
                      toast('Silence', { tone: 'warning' });
                    }}
                  >
                    Silence
                  </MenuItem>
                  <MenuSeparator />
                  <MenuItem
                    danger
                    onSelect={() => {
                      setMenuOpen(false);
                      toast('Retire', { tone: 'danger' });
                    }}
                  >
                    Retire plane
                  </MenuItem>
                </Menu>
              </Stack>
              <Tabs value={galleryTab} onValueChange={setGalleryTab}>
                <TabsList>
                  <TabsTrigger value="queue">Queue</TabsTrigger>
                  <TabsTrigger value="silences">Silences</TabsTrigger>
                  <TabsTrigger value="rules">Rules</TabsTrigger>
                </TabsList>
                <TabsContent value="queue">
                  <Text size={12} tone="secondary">
                    Active alert firings — the NOC default.
                  </Text>
                </TabsContent>
                <TabsContent value="silences">
                  <Text size={12} tone="secondary">
                    Time-boxed hush with reason — never invisible.
                  </Text>
                </TabsContent>
                <TabsContent value="rules">
                  <Text size={12} tone="secondary">
                    Correlation and escalation policy (read path).
                  </Text>
                </TabsContent>
              </Tabs>
              <Stack gap={8}>
                <Text size={11} mono tone="muted">
                  Plane chips stay monochrome
                </Text>
                <Stack direction="row" gap={6} wrap>
                  <Badge plane>CENTRAL</Badge>
                  <Badge plane>MIST</Badge>
                  <Badge plane>CLEARPASS</Badge>
                  <Badge tone="danger" dot>
                    P1
                  </Badge>
                </Stack>
              </Stack>
              <div style={{ border: '1px solid var(--nd-border-subtle)', borderRadius: 12, padding: 12 }}>
                <Text size={11} mono tone="muted">
                  Page skeleton
                </Text>
                <PageSkeleton variant="list" />
              </div>
              <Modal
                open={modalOpen}
                onOpenChange={setModalOpen}
                title="Brokered write"
                description="Review the blast radius before the plane accepts the change."
                footer={
                  <>
                    <Button variant="ghost" size="sm" onClick={() => setModalOpen(false)}>
                      Cancel
                    </Button>
                    <Button variant="primary" size="sm" onClick={() => setModalOpen(false)}>
                      Commit
                    </Button>
                  </>
                }
              >
                <Text size={12} tone="secondary">
                  NightDesk never pretends a write landed when the plane is behind.
                </Text>
              </Modal>
              <ConfirmDialog
                open={confirmOpen}
                onOpenChange={setConfirmOpen}
                title="Retire Classic?"
                description="Stored credentials are cleared. Devices stay on the plane."
                confirmLabel="Retire"
                onConfirm={() => toast('Retired', { tone: 'success' })}
              />
            </Stack>

            <Stack gap={12}>
              <SectionHeader label="Badges" meta="live state with dot" />
              <Stack direction="row" gap={6} wrap>
                <Badge tone="success" dot>
                  healthy
                </Badge>
                <Badge tone="warning" dot>
                  degraded
                </Badge>
                <Badge tone="danger" dot>
                  P1
                </Badge>
                <Badge tone="info" dot>
                  P3
                </Badge>
                <Badge tone="neutral">CLASSIC</Badge>
                <Badge tone="accent">brokered</Badge>
              </Stack>
            </Stack>

            <Stack gap={12}>
              <SectionHeader label="Progress" />
              <Progress label="Connection quality score" note="target ≥ 80" value={87} tone="success" />
              <Progress
                label="DHCP pool utilisation"
                note="1,842 of 2,046 leases"
                value={92}
                tone="warning"
              />
              <Progress
                label="Auth failures — vlan.tunnel.mtu"
                note="24 of 60"
                value={24}
                max={60}
                tone="danger"
              />
            </Stack>

            <Alert tone="warning" title="Classic throttled">
              429s every third poll — inventory 6h stale. Devices read unverified, not up.
            </Alert>
            <Alert tone="success" title="Connection succeeded">
              Found 96 switches answering on the local collector.
            </Alert>

            <Stack gap={12}>
              <SectionHeader label="Feedback" />
              <Stack direction="row" gap={16} align="center">
                <Spinner />
                <Spinner size="md" />
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() =>
                    toast('Sync queued', {
                      description: 'Classic will lag ~6h behind.',
                      tone: 'info',
                    })
                  }
                >
                  Show toast
                </Button>
                <Button variant="secondary" size="sm" onClick={() => setDrawerOpen(true)}>
                  Open drawer
                </Button>
              </Stack>
              <Divider />
              <Stack gap={8}>
                <Skeleton height={12} />
                <Skeleton height={12} width="72%" />
                <Skeleton height={12} width="48%" />
              </Stack>
            </Stack>

            <Stack gap={12}>
              <SectionHeader label="Cards — last resort" />
              <Card variant="soft">
                <Text size={12} tone="secondary">
                  soft — the only surface card
                </Text>
              </Card>
              <Card variant="plain">
                <Text size={12} tone="muted">
                  plain — no surface at all
                </Text>
              </Card>
            </Stack>

            <Stack gap={12}>
              <SectionHeader label="Pagination" meta="page 1 of 8" />
              <Pagination page={page} total={8} onChange={setPage} />
            </Stack>

            <EmptyState
              title="Nothing matches that filter"
              description="Loosen the severity or plane filter to see the rest of the queue."
            />
          </Stack>
        </div>
      </Stack>

      <Drawer
        open={drawerOpen}
        onOpenChange={setDrawerOpen}
        width="lg"
        title="ap-3f-12"
        description="Access point · Campus-02 Research · managed by Mist — read only"
      >
        <Stack gap={22}>
          <Stack direction="row" gap={8} align="center" wrap>
            <Badge tone="warning" dot>
              degraded
            </Badge>
            <Badge tone="neutral">MIST</Badge>
            <Text size={11} mono tone="muted">
              session 4d 02:17
            </Text>
          </Stack>
          <Alert tone="info" title="Read-only plane">
            Mist accepts no writes from the portal. The change below is handed off to the Mist
            console pre-filled.
          </Alert>
          <FormField label="VLAN" help="1 – 4094">
            <Input mono defaultValue="812" />
          </FormField>
          <FormField label="Band" htmlFor="drawer-band">
            <Select
              id="drawer-band"
              defaultValue="dual"
              options={[
                { value: 'dual', label: 'Dual band' },
                { value: '5', label: '5 GHz only' },
                { value: '6', label: '6 GHz only' },
              ]}
            />
          </FormField>
          <Switch label="Broadcast SSID" defaultChecked />
          <Stack gap={6}>
            <span className="nd-micro-label">What gets pushed</span>
            <Code block>{`wlan ssid-profile "MRDN-Imaging"
   essid "MRDN-Imaging"
   vlan 812
! hand-off: mist console · pre-filled payload`}</Code>
          </Stack>
          <Progress
            label="Blast radius — sessions re-authenticating"
            note="86 clients"
            value={22}
            tone="warning"
          />
          <Stack direction="row" gap={8}>
            <Button variant="primary" size="sm">
              Open in Mist ↗
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setDrawerOpen(false)}>
              Cancel
            </Button>
          </Stack>
        </Stack>
      </Drawer>
    </AppShell>
  );
}
