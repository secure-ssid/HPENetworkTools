/**
 * server/tests/smtp.test.ts — the minimal SMTP client against an in-process
 * mock server (the repo's capture-server pattern, one level down: raw TCP).
 *
 * The mock records the full transcript and speaks just enough RFC 5321 to be
 * a real counterpart: greeting, multiline EHLO, STARTTLS with an ACTUAL TLS
 * upgrade (a self-signed test-only certificate, generated for this suite),
 * AUTH LOGIN, MAIL/RCPT/DATA with the dot terminator.
 *
 * Covered:
 *   happy path     — EHLO → MAIL → RCPT → DATA → QUIT, both recipients, the
 *                    message on the wire (headers, MIME parts, base64 bodies);
 *   multiline      — '250-' continuations are consumed, not read as commands;
 *   STARTTLS       — upgrade + second EHLO inside TLS; default verification
 *                    REFUSES the self-signed cert (surfaced, not retried);
 *   AUTH LOGIN     — base64 credentials on the wire; a 535 fails honestly and
 *                    NEVER carries the password in the error;
 *   encoding       — non-ASCII subject goes RFC 2047; dotStuff() doubles
 *                    leading dots and normalizes newlines;
 *   failures       — connection refused, a 550 at MAIL FROM, and a silent
 *                    server's timeout all produce honest credential-free
 *                    errors.
 */

import * as net from 'node:net';
import * as tls from 'node:tls';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { SmtpError, buildMessage, dotStuff, sendMail } from '../src/services/smtp';
import type { SmtpConfig } from '@hpe/shared';

/**
 * Test-only self-signed certificate for 127.0.0.1/localhost (SANs included),
 * generated with openssl for this suite. It exists so the STARTTLS path has
 * something to verify against; it is not, and must never become, a real
 * credential.
 */
const TEST_CERT = `-----BEGIN CERTIFICATE-----
MIIDJzCCAg+gAwIBAgIUE6Co1dMDnP1sl0EHMNbB/qVjAsUwDQYJKoZIhvcNAQEL
BQAwFDESMBAGA1UEAwwJbG9jYWxob3N0MCAXDTI2MDgwMjA2MjcyMFoYDzIxMjYw
NzA5MDYyNzIwWjAUMRIwEAYDVQQDDAlsb2NhbGhvc3QwggEiMA0GCSqGSIb3DQEB
AQUAA4IBDwAwggEKAoIBAQC8AyZz5GfFajhp0NUW8VOUul/kKe6BNoQJKqp1iIb8
N57CF+KiUOZkXKfrrmHRYsfXzqfdneGznSWFEq2yIQC+FL+3xdsrMJUIGINrUswK
Trr0vekkrIYZEjO9F/arpbXQaZUgyRBhM7LrhxWmMyVKSs6jP8MgchEYYHv2IJ7A
O/nu787nEZd9avWnLhX/BoATctOwhzQiTbC/6mchYS8sNREXtnPCcOzBqBKTqNmW
C5/wHtP69AEOD+Uex42cTIiIexLvI5Yrd4+WpeNWEJJBT4UBsx26N1n5gajvKBJF
Bd3dj2zIsXG2CMRsL8wmd1gF7CyIJtAdnT17IHdg6uDRAgMBAAGjbzBtMB0GA1Ud
DgQWBBRI1eTv7nY7DxpPkuEd0zR0zGl9MTAfBgNVHSMEGDAWgBRI1eTv7nY7DxpP
kuEd0zR0zGl9MTAPBgNVHRMBAf8EBTADAQH/MBoGA1UdEQQTMBGHBH8AAAGCCWxv
Y2FsaG9zdDANBgkqhkiG9w0BAQsFAAOCAQEAUj5b9dJu8IjlbLDr7bb90DuEl29p
81CbwLsm1DzBR+kqQr8lAMzQ3wrzjwfwGFbCYiEFJWfZiHuqox9LdueKcn+nJasP
SFmL0Td/4LS7oE13CImiVxzR18+AIQvI53bnck9GiKKoseAPEcPKzaDjhV3i15Fu
iV2RM3n0cYsUthhc/e0aHzkwlyZHl90u81B8glB0Liovzi8XgqHkZINAHr78/T/1
n8BFCdp8ZqTYQw3SNAu4IXwEEsUSWaP5GHgu7NV4haM5UtdSYvr27Mr2Moicxns5
JKB33RoDUGXjaBzYiKcQ3MIYT6rmq7S7oLPqU6A7GdyaFR8gntHX42/4Aw==
-----END CERTIFICATE-----`;

const TEST_KEY = `-----BEGIN PRIVATE KEY-----
MIIEvgIBADANBgkqhkiG9w0BAQEFAASCBKgwggSkAgEAAoIBAQC8AyZz5GfFajhp
0NUW8VOUul/kKe6BNoQJKqp1iIb8N57CF+KiUOZkXKfrrmHRYsfXzqfdneGznSWF
Eq2yIQC+FL+3xdsrMJUIGINrUswKTrr0vekkrIYZEjO9F/arpbXQaZUgyRBhM7Lr
hxWmMyVKSs6jP8MgchEYYHv2IJ7AO/nu787nEZd9avWnLhX/BoATctOwhzQiTbC/
6mchYS8sNREXtnPCcOzBqBKTqNmWC5/wHtP69AEOD+Uex42cTIiIexLvI5Yrd4+W
peNWEJJBT4UBsx26N1n5gajvKBJFBd3dj2zIsXG2CMRsL8wmd1gF7CyIJtAdnT17
IHdg6uDRAgMBAAECggEACYs0ZL4jqWEEt5Re+MDrz/ks/HFHdt4sUiXNDNXPGlb9
c1dQjRJDu7T7XiqWMxGLWPBX05db2WkA+lISKKBlwABgIgVEZJsc+ZH6+9PyYRSR
h3Jrdw3d6cBjiXYBssFg6xEs/YLPVsvPyYZsKile+3g0KJPIRSmdJgphyILr5BCh
Cqco2100cF4LNf0M5ietrGcQR4plEeFskQ3eciC4Px1WJzUoQLw8X/woxEj/33Dt
hCZlc2jpOyOvJvU1aOzKw7cYpc61P6Vm2GX3ukw1lmrjRH1LY/OlJTpvVhOA5/rb
TD8s+c2ONx0xU0xxMI+Q9DeagJfIV/4fDti38K1zsQKBgQDktHt01aJr4dCy+Z79
vCCBBD8CDFKu7M5/HA52MQBDzFOrp/jM8RKTFDYgGHPYWTVjEmno462P4yran2i5
CJRx+BPQtuk9zyo/exu4AwwNABCYH7PJ9N/8w3AsrASmMAl+Vm+UTdwP2rc5lhQq
Q9K3mKwguayou5UY155YVTPwqQKBgQDSc2cYmXEvrkPHlz31Itx3rOWy2kUOeFlv
DKdJai5LcU2+Ri6ew/D5TCL+jDs+uhKDgIFfOfPhiGXa/O2k6gsug8s/w7vU8BOj
WLYx/6oNlbPW8RM/b8SXB/fHSiJTtW4Chf3L5louRD/n3zmzxsRKkKTHUsscuR/5
oAFDKdl/6QKBgG4o3Npe2JgcMdkzUTioeAOM1wiWhPEK0T/6dKDLY3REo/ynsLiO
WcMMVjHJdWs9NPDeerMZj40h/49Efz24+z+WHX1HzTrfYVsoYiaVGSXd5SBRDNl3
ILhwLsTlqmud8cSvv5jwk9HzKJQNTPM6rfGPEUHGDXtMtzk7CmNDzvvZAoGBAIiW
W9hMZnjCyrz0vUKnsJ1/usk8/sroc2sutDhi0M8oJ4QR+toSZAj5UFETZLROgguV
UOIkM9Qx+aGKvRZmzIERCs5E1FjcxHIk9oM24wDUI5eieZKXkOlRQ5C13dekjlTW
8CTxSaBzrWJpsAKtQ+L9Q+UWKDtpL4aNQaR8uexZAoGBAMqP8UilkSO81gxlhERS
Iaosuv416gEnomrlZFkCMLYIL7vOH7nT4Mv6/1shLBtOS/OinlVZV8ogaV456ZKT
r95YWeq4mhRmPfYwufx3GsnBQkFtso9MFlOp//4N6gcPXL7ATOskdHYN6xfgF1DJ
9yzP7XgQuKURy96guwOydWvH
-----END PRIVATE KEY-----`;

interface Script {
  greeting?: string | null; // null = silent server (timeout tests)
  ehlo?: string[];
  starttls?: string;
  starttlsUpgrade?: boolean;
  authLogin?: string;
  authUser?: string;
  authPass?: string;
  mailFrom?: string;
  rcpt?: string;
  data?: string;
  dataEnd?: string;
  quit?: string;
}

/** Just enough SMTP server to be a real counterpart. */
class MockSmtp {
  readonly transcript: string[] = [];
  readonly dataBlocks: string[] = [];
  private readonly server: net.Server;
  private readonly sockets = new Set<net.Socket>();

  constructor(private readonly script: Script = {}) {
    this.server = net.createServer((socket) => this.handle(socket));
  }

  listen(): Promise<number> {
    return new Promise((resolve) => {
      this.server.listen(0, '127.0.0.1', () => resolve((this.server.address() as AddressInfo).port));
    });
  }

  async close(): Promise<void> {
    for (const s of this.sockets) s.destroy();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  private handle(socket: net.Socket): void {
    this.sockets.add(socket);
    let stream: net.Socket | tls.TLSSocket = socket;
    let buffer = '';
    let stage: 'cmd' | 'authuser' | 'authpass' | 'data' = 'cmd';
    let dataLines: string[] = [];

    const sendLine = (l: string) => {
      stream.write(`${l}\r\n`);
    };
    const onLine = (line: string): void => {
      if (stage === 'data') {
        if (line === '.') {
          stage = 'cmd';
          this.dataBlocks.push(dataLines.join('\r\n'));
          dataLines = [];
          sendLine(this.script.dataEnd ?? '250 2.0.0 Ok: queued');
        } else {
          dataLines.push(line);
        }
        return;
      }
      this.transcript.push(line);
      if (stage === 'authuser') {
        stage = 'authpass';
        sendLine(this.script.authUser ?? '334 UGFzc3dvcmQ6');
        return;
      }
      if (stage === 'authpass') {
        stage = 'cmd';
        sendLine(this.script.authPass ?? '235 2.7.0 Authentication successful');
        return;
      }
      const verb = (line.split(' ')[0] ?? '').toUpperCase();
      if (verb === 'EHLO' || verb === 'HELO') {
        for (const l of this.script.ehlo ?? ['250-mock greets you', '250 STARTTLS']) sendLine(l);
      } else if (verb === 'STARTTLS') {
        sendLine(this.script.starttls ?? '220 Ready to start TLS');
        if (this.script.starttlsUpgrade) {
          const upgraded = new tls.TLSSocket(stream, {
            isServer: true,
            secureContext: tls.createSecureContext({ key: TEST_KEY, cert: TEST_CERT }),
          });
          this.sockets.add(upgraded);
          stream = upgraded;
          attach();
        }
      } else if (verb === 'AUTH') {
        stage = 'authuser';
        sendLine(this.script.authLogin ?? '334 VXNlcm5hbWU6');
      } else if (verb === 'MAIL') {
        sendLine(this.script.mailFrom ?? '250 2.1.0 Ok');
      } else if (verb === 'RCPT') {
        sendLine(this.script.rcpt ?? '250 2.1.5 Ok');
      } else if (verb === 'DATA') {
        stage = 'data';
        sendLine(this.script.data ?? '354 End data with <CR><LF>.<CR><LF>');
      } else if (verb === 'QUIT') {
        sendLine(this.script.quit ?? '221 2.0.0 Bye');
        stream.end();
      } else {
        sendLine('502 5.5.2 command not recognized');
      }
    };
    const attach = (): void => {
      stream.setEncoding('utf8');
      stream.on('data', (chunk: string) => {
        buffer += chunk;
        let idx: number;
        while ((idx = buffer.indexOf('\r\n')) !== -1) {
          const line = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          onLine(line);
        }
      });
    };
    attach();
    if (this.script.greeting !== null) sendLine(this.script.greeting ?? '220 mock ESMTP ready');
  }
}

const config = (over: Partial<SmtpConfig> = {}): SmtpConfig => ({
  host: '127.0.0.1',
  port: 0,
  from: 'reports@example.com',
  tls: false,
  updatedAt: '2026-08-02T00:00:00.000Z',
  ...over,
});

const mail = {
  to: ['noc@example.com', 'netops@example.com'],
  subject: 'Fleet Summary Report — 2026-08-02',
  text: 'Devices\n  switch 12 total',
  html: '<p>Devices</p>',
};

let servers: MockSmtp[] = [];
afterEach(async () => {
  for (const s of servers) await s.close();
  servers = [];
});

/** sendMail expecting rejection — the Error, typed. */
async function failSend(cfg: SmtpConfig, opts: { timeoutMs?: number; tlsOptions?: import('node:tls').ConnectionOptions } = {}): Promise<Error> {
  try {
    await sendMail(cfg, mail, opts);
  } catch (err) {
    return err as Error;
  }
  throw new Error('expected sendMail to reject, but it resolved');
}

async function mock(script: Script = {}): Promise<{ server: MockSmtp; port: number }> {
  const server = new MockSmtp(script);
  const port = await server.listen();
  servers.push(server);
  return { server, port };
}

describe('sendMail', () => {
  it('runs the whole conversation: EHLO, MAIL, both RCPTs, DATA, QUIT', async () => {
    const { server, port } = await mock();
    const result = await sendMail(config({ port }), mail, { timeoutMs: 5000 });
    expect(result.code).toBe(250);
    const verbs = server.transcript.map((l) => l.split(' ')[0]);
    expect(verbs).toEqual(['EHLO', 'MAIL', 'RCPT', 'RCPT', 'DATA', 'QUIT']);
    expect(server.transcript[1]).toBe('MAIL FROM:<reports@example.com>');
    expect(server.transcript[2]).toBe('RCPT TO:<noc@example.com>');
    expect(server.transcript[3]).toBe('RCPT TO:<netops@example.com>');
    expect(server.dataBlocks).toHaveLength(1);
    const block = server.dataBlocks[0]!;
    expect(block).toContain('From: reports@example.com');
    expect(block).toContain('To: noc@example.com, netops@example.com');
    expect(block).toContain('MIME-Version: 1.0');
    expect(block).toContain('Content-Type: multipart/alternative');
    // Both parts ride base64 — decode them back out of the wire payload.
    expect(block).toContain(Buffer.from(mail.text, 'utf8').toString('base64'));
    expect(block).toContain(Buffer.from(mail.html, 'utf8').toString('base64'));
  });

  it('consumes multiline EHLO replies without desyncing the exchange', async () => {
    const { server, port } = await mock({ ehlo: ['250-mock greets you', '250-STARTTLS', '250 AUTH LOGIN'] });
    await sendMail(config({ port }), mail, { timeoutMs: 5000 });
    // A single-line reader would have answered MAIL with '250-STARTTLS' and
    // RCPT with '250 AUTH LOGIN', and the rest of the exchange would be junk.
    expect(server.dataBlocks).toHaveLength(1);
    expect(server.transcript.map((l) => l.split(' ')[0])).toEqual(['EHLO', 'MAIL', 'RCPT', 'RCPT', 'DATA', 'QUIT']);
  });

  it('upgrades with STARTTLS and says EHLO again inside TLS', async () => {
    const { server, port } = await mock({ starttlsUpgrade: true });
    const result = await sendMail(config({ port, tls: true }), mail, {
      timeoutMs: 5000,
      tlsOptions: { ca: [TEST_CERT] },
    });
    expect(result.code).toBe(250);
    const verbs = server.transcript.map((l) => l.split(' ')[0]);
    // The second EHLO arrives on the TLS socket — the mock only re-attaches
    // its line reader after the upgrade, so seeing it IS seeing the upgrade.
    expect(verbs).toEqual(['EHLO', 'STARTTLS', 'EHLO', 'MAIL', 'RCPT', 'RCPT', 'DATA', 'QUIT']);
  });

  it('refuses an unverifiable STARTTLS certificate by default, with the reason', async () => {
    const { port } = await mock({ starttlsUpgrade: true });
    await expect(sendMail(config({ port, tls: true }), mail, { timeoutMs: 5000 })).rejects.toThrow(/certificate/i);
  });

  it('authenticates with AUTH LOGIN — base64 user then password on the wire', async () => {
    const { server, port } = await mock();
    await sendMail(config({ port, user: 'svc-reports', password: 's3cret!' }), mail, { timeoutMs: 5000 });
    const verbs = server.transcript.map((l) => l.split(' ')[0]);
    // The two entries after AUTH are the credentials themselves, base64'd —
    // deterministic, so asserted verbatim.
    expect(verbs).toEqual([
      'EHLO',
      'AUTH',
      Buffer.from('svc-reports').toString('base64'),
      Buffer.from('s3cret!').toString('base64'),
      'MAIL',
      'RCPT',
      'RCPT',
      'DATA',
      'QUIT',
    ]);
    // The two lines after AUTH LOGIN are the credentials, base64'd.
    const authIdx = server.transcript.findIndex((l) => l === 'AUTH LOGIN');
    expect(Buffer.from(server.transcript[authIdx + 1]!, 'base64').toString('utf8')).toBe('svc-reports');
    expect(Buffer.from(server.transcript[authIdx + 2]!, 'base64').toString('utf8')).toBe('s3cret!');
  });

  it('a 535 fails the send honestly — and never carries the password', async () => {
    const { server, port } = await mock({ authPass: '535 5.7.8 authentication failed' });
    const err = await failSend(config({ port, user: 'svc-reports', password: 's3cret!' }), { timeoutMs: 5000 });
    expect(err).toBeInstanceOf(SmtpError);
    expect(err.message).toContain('535');
    expect(err.message).toContain('authentication failed');
    expect(err.message).not.toContain('s3cret!');
    expect(err.message).not.toContain(Buffer.from('s3cret!').toString('base64'));
    // The send stopped at AUTH — no envelope was attempted.
    expect(server.transcript.map((l) => l.split(' ')[0])).not.toContain('MAIL');
  });

  it('encodes a non-ASCII subject as an RFC 2047 encoded-word', async () => {
    const { server, port } = await mock();
    await sendMail(config({ port }), { ...mail, subject: 'Fleet Summary Report — 2026-08-02' }, { timeoutMs: 5000 });
    const block = server.dataBlocks[0]!;
    const encoded = `=?UTF-8?B?${Buffer.from('Fleet Summary Report — 2026-08-02', 'utf8').toString('base64')}?=`;
    expect(block).toContain(`Subject: ${encoded}`);
    expect(block).not.toContain('Subject: Fleet Summary Report —');
  });

  it('a refused MAIL FROM stops the send with the server’s own words', async () => {
    const { server, port } = await mock({ mailFrom: '550 5.7.1 sender rejected' });
    const err = await failSend(config({ port }), { timeoutMs: 5000 });
    expect(err).toBeInstanceOf(SmtpError);
    expect(err.message).toContain('MAIL FROM refused — 550 5.7.1 sender rejected');
    expect(server.dataBlocks).toHaveLength(0);
  });

  it('a refused recipient is named in the error', async () => {
    const { port } = await mock({ rcpt: '550 5.1.1 no such user' });
    const err = await failSend(config({ port }), { timeoutMs: 5000 });
    expect(err.message).toContain('RCPT TO <noc@example.com> refused — 550 5.1.1 no such user');
  });

  it('connection refused is an honest transport error', async () => {
    // Find a port nothing listens on: bind one, close it, use it.
    const probe = net.createServer();
    const port = await new Promise<number>((resolve) =>
      probe.listen(0, '127.0.0.1', () => resolve((probe.address() as AddressInfo).port)),
    );
    await new Promise<void>((resolve) => probe.close(() => resolve()));
    const err = await failSend(config({ port }), { timeoutMs: 2000 });
    expect(err).toBeInstanceOf(SmtpError);
    expect(err.message).toContain('ECONNREFUSED');
  });

  it('a silent server fails on the timeout, not on a hung process', async () => {
    const { port } = await mock({ greeting: null });
    const started = Date.now();
    const err = await failSend(config({ port }), { timeoutMs: 300 });
    expect(err).toBeInstanceOf(SmtpError);
    expect(err.message).toContain('timed out');
    expect(Date.now() - started).toBeLessThan(3000);
  });
});

describe('dotStuff', () => {
  it('doubles leading dots and normalizes every newline to CRLF', () => {
    expect(dotStuff('one\n.two\n..three\r\nfour\rfive')).toBe('one\r\n..two\r\n...three\r\nfour\r\nfive');
  });
});

describe('buildMessage', () => {
  it('produces both alternative parts and dot-stuffs the payload', () => {
    const msg = buildMessage({ from: 'reports@example.com' }, mail);
    expect(msg).toContain('Content-Type: text/plain; charset=utf-8');
    expect(msg).toContain('Content-Type: text/html; charset=utf-8');
    expect(msg).not.toContain('\n.');
    for (const line of msg.split('\r\n')) {
      expect(line.startsWith('.') ? line.startsWith('..') : true).toBe(true);
    }
  });
});
