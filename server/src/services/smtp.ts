/**
 * server/src/services/smtp.ts — a minimal SMTP client over node:net/node:tls.
 *
 * Node ships no SMTP client and the repo adds no runtime dependencies, so
 * the fleet report needed one. This is deliberately the smallest honest
 * implementation of the submission path (RFC 5321/3207/4954):
 *
 *   connect → 220 greeting → EHLO → [STARTTLS → TLS upgrade → EHLO again]
 *   → [AUTH LOGIN] → MAIL FROM → RCPT TO (per recipient) → DATA →
 *   dot-stuffed message → QUIT.
 *
 * The disciplines:
 *
 *   - HONEST ERRORS, NEVER THE PASSWORD. Every failure is an SmtpError whose
 *     message carries the phase, the server's reply code and its reply text —
 *     'AUTH LOGIN refused — 535 authentication failed' — and nothing the
 *     client sent. Credentials only ever travel base64'd on the wire; no log,
 *     error or audit line ever contains them.
 *   - MULTILINE REPLIES ARE REAL. '250-...' continuation lines are consumed
 *     until the matching '250 ' terminator; treating the first line as the
 *     whole reply desyncs every later command.
 *   - DOT-STUFFING. A body line that starts with '.' goes out as '..', and
 *     the message ends with a lone '.' — otherwise a report whose text part
 *     happens to start a line with a period truncates mid-message.
 *   - TIMEOUTS. Idle silence beyond timeoutMs (default 20s) at ANY stage —
 *     connect, greeting, mid-DATA — fails the send with a timeout error.
 *   - CORRECT ENVELOPE ENCODING. Text and HTML parts go base64 (UTF-8 safe,
 *     dot- and line-ending-proof), a non-ASCII subject gets RFC 2047
 *     encoded-word form ('Fleet Summary Report — …' carries an em dash).
 *
 * What is NOT here, deliberately: pipelining, SIZE/8BITMIME negotiation,
 * implicit TLS on port 465 (configure a STARTTLS-capable submission port
 * instead), and certificate verification overrides. STARTTLS verifies the
 * server certificate by default; a refusal is surfaced verbatim ('self-signed
 * certificate') so the operator sees WHY, not a retry that hides it.
 */

import * as net from 'node:net';
import * as tls from 'node:tls';
import * as os from 'node:os';
import { randomBytes } from 'node:crypto';
import type { SmtpConfig } from '@hpe/shared';

/** An SMTP failure with an honest, credential-free message. */
export class SmtpError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SmtpError';
  }
}

export interface SmtpMail {
  to: string[];
  subject: string;
  text: string;
  html: string;
}

export interface SmtpSendOptions {
  /** Idle-timeout per stage, connect through the final reply. Default 20s. */
  timeoutMs?: number;
  /**
   * Extra tls.connect options for the STARTTLS upgrade. Not configuration —
   * a test seam: the suite's mock server presents a self-signed test
   * certificate and passes it here as `ca`. Production sends never set it,
   * so verification stays on for them.
   */
  tlsOptions?: tls.ConnectionOptions;
}

export interface SmtpSendResult {
  ms: number;
  /** The server's reply code to the message body (250 when it queued). */
  code: number;
}

interface SmtpReply {
  code: number;
  text: string;
}

/** One physical connection's line reader + idle watchdog. Replaced wholesale
 *  on the STARTTLS upgrade. */
class Wire {
  private buffer = '';
  private queue: string[] = [];
  private waiters: { resolve: (line: string) => void; reject: (err: Error) => void }[] = [];
  private failed: Error | null = null;

  constructor(
    private socket: net.Socket,
    private readonly target: string,
    private readonly timeoutMs: number,
  ) {
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => {
      this.buffer += chunk;
      let idx: number;
      while ((idx = this.buffer.indexOf('\r\n')) !== -1) {
        const line = this.buffer.slice(0, idx);
        this.buffer = this.buffer.slice(idx + 2);
        const w = this.waiters.shift();
        if (w) w.resolve(line);
        else this.queue.push(line);
      }
    });
    socket.on('error', (err) => this.fail(new SmtpError(`SMTP connection to ${this.target} failed — ${err.message}`)));
    socket.on('timeout', () => {
      this.fail(new SmtpError(`no response from ${this.target} for ${this.timeoutMs}ms — connection timed out`));
      socket.destroy();
    });
    socket.on('close', () => {
      if (!this.failed) this.fail(new SmtpError(`connection to ${this.target} closed by the server mid-exchange`));
    });
    socket.setTimeout(timeoutMs);
  }

  private fail(err: Error): void {
    if (this.failed) return;
    this.failed = err;
    for (const w of this.waiters.splice(0)) w.reject(err);
  }

  /** Resolves on connect; rejects with the wire's own honest error on
   *  refusal, or with a timeout when the connect itself stalls (the socket
   *  idle watchdog only starts once a connection exists). */
  connected(): Promise<void> {
    if (this.failed) return Promise.reject(this.failed);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.socket.destroy();
        reject(new SmtpError(`no connection to ${this.target} after ${this.timeoutMs}ms — connection timed out`));
      }, this.timeoutMs);
      this.socket.once('connect', () => {
        clearTimeout(timer);
        resolve();
      });
      this.socket.once('error', () => {
        clearTimeout(timer);
        reject(this.failed ?? new SmtpError(`SMTP connection to ${this.target} failed`));
      });
    });
  }

  /** Resolves on secureConnect after the STARTTLS upgrade; rejects on a TLS
   *  failure (certificate verification included — surfaced verbatim) or a
   *  close mid-handshake. */
  secured(): Promise<void> {
    if (this.failed) return Promise.reject(this.failed);
    return new Promise((resolve, reject) => {
      const onSecure = () => {
        cleanup();
        resolve();
      };
      const onErr = () => {
        cleanup();
        reject(this.failed ?? new SmtpError(`TLS handshake with ${this.target} failed`));
      };
      const onClose = () => {
        cleanup();
        reject(this.failed ?? new SmtpError(`connection to ${this.target} closed during the TLS handshake`));
      };
      const cleanup = () => {
        this.socket.off('secureConnect', onSecure);
        this.socket.off('error', onErr);
        this.socket.off('close', onClose);
      };
      this.socket.once('secureConnect', onSecure);
      this.socket.once('error', onErr);
      this.socket.once('close', onClose);
    });
  }

  line(): Promise<string> {
    if (this.queue.length > 0) return Promise.resolve(this.queue.shift()!);
    if (this.failed) return Promise.reject(this.failed);
    return new Promise((resolve, reject) => {
      this.waiters.push({ resolve, reject });
    });
  }

  write(text: string): void {
    if (this.failed) throw this.failed;
    this.socket.write(text);
  }

  /** Swap the raw socket for its TLS upgrade, keeping the watchdog. Any
   *  plaintext still queued is discarded — after '220 Ready' there must be
   *  none, and keeping it would leak pre-TLS bytes into the TLS stream. */
  upgrade(): net.Socket {
    this.socket.removeAllListeners();
    this.socket.setTimeout(0);
    return this.socket;
  }

  destroy(): void {
    this.socket.destroy();
  }
}

async function readReply(wire: Wire): Promise<SmtpReply> {
  const first = await wire.line();
  const m = /^(\d{3})([ -]?)(.*)$/.exec(first);
  if (!m || !m[1] || m[2] === undefined) {
    throw new SmtpError(`unexpected reply from the server: '${first.slice(0, 120)}'`);
  }
  const code = Number(m[1]);
  const lines = [m[3] ?? ''];
  if (m[2] === '-') {
    // Continuation lines until the same code with a space terminator.
    for (;;) {
      const l = await wire.line();
      const mm = /^(\d{3})([ -]?)(.*)$/.exec(l);
      if (mm && mm[1] === m[1] && mm[2] === ' ') {
        lines.push(mm[3] ?? '');
        break;
      }
      lines.push(mm ? (mm[3] ?? '') : l);
    }
  }
  return { code, text: lines.join(' ').trim() };
}

function refused(phase: string, reply: SmtpReply): SmtpError {
  return new SmtpError(`${phase} refused — ${reply.code}${reply.text ? ` ${reply.text}` : ''}`);
}

function expect(reply: SmtpReply, code: number, phase: string): SmtpReply {
  if (reply.code !== code) throw refused(phase, reply);
  return reply;
}

/**
 * Send one message. Throws SmtpError on any failure; resolves with the
 * timing and the server's accept code. Never logs — the caller (the report
 * scheduler) owns recording and auditing outcomes.
 */
export async function sendMail(config: SmtpConfig, mail: SmtpMail, opts: SmtpSendOptions = {}): Promise<SmtpSendResult> {
  const timeoutMs = opts.timeoutMs ?? 20_000;
  const started = Date.now();
  if (mail.to.length === 0) throw new SmtpError('no recipients — the message has nobody to go to');
  const target = `${config.host}:${config.port}`;

  let wire = new Wire(net.connect({ host: config.host, port: config.port }), target, timeoutMs);
  try {
    await wire.connected();
    expect(await readReply(wire), 220, 'greeting');
    const ehlo = os.hostname() || 'localhost';
    expect(await command(wire, `EHLO ${ehlo}`), 250, 'EHLO');

    if (config.tls) {
      expect(await command(wire, 'STARTTLS'), 220, 'STARTTLS');
      const raw = wire.upgrade();
      // SNI carries hostnames, never IP literals (tls.connect throws on one);
      // for a literal the chain is still verified, just without SNI.
      const tlsSocket = tls.connect({
        socket: raw,
        ...(net.isIP(config.host) === 0 ? { servername: config.host } : {}),
        ...opts.tlsOptions,
      });
      wire = new Wire(tlsSocket, target, timeoutMs);
      await wire.secured();
      // RFC 3207: the EHLO state does not survive the upgrade — say it again.
      expect(await command(wire, `EHLO ${ehlo}`), 250, 'EHLO after STARTTLS');
    }

    if (config.user) {
      expect(await command(wire, 'AUTH LOGIN'), 334, 'AUTH LOGIN');
      expect(await command(wire, Buffer.from(config.user, 'utf8').toString('base64')), 334, 'AUTH username');
      const auth = await command(wire, Buffer.from(config.password ?? '', 'utf8').toString('base64'));
      if (auth.code !== 235) {
        // The reply text is the server's own words; the password is never in it.
        throw new SmtpError(`SMTP authentication failed — ${auth.code}${auth.text ? ` ${auth.text}` : ''} (check the stored username and password)`);
      }
    }

    expect(await command(wire, `MAIL FROM:<${config.from}>`), 250, 'MAIL FROM');
    for (const to of mail.to) {
      const rcpt = await command(wire, `RCPT TO:<${to}>`);
      if (rcpt.code !== 250 && rcpt.code !== 251) throw refused(`RCPT TO <${to}>`, rcpt);
    }
    expect(await command(wire, 'DATA'), 354, 'DATA');
    wire.write(`${buildMessage(config, mail)}\r\n.\r\n`);
    const accepted = expect(await readReply(wire), 250, 'message body');
    // QUIT is politeness; the send already succeeded, so its reply is
    // best-effort — a server that hangs up now changes nothing.
    try {
      await command(wire, 'QUIT');
    } catch {
      /* closing anyway */
    }
    return { ms: Date.now() - started, code: accepted.code };
  } finally {
    wire.destroy();
  }
}

async function command(wire: Wire, text: string): Promise<SmtpReply> {
  wire.write(`${text}\r\n`);
  return readReply(wire);
}

/** Headers + MIME alternative parts, CRLF-normalized and dot-stuffed. */
export function buildMessage(config: Pick<SmtpConfig, 'from'>, mail: SmtpMail): string {
  const boundary = `----hpe-${randomBytes(8).toString('hex')}`;
  const fromDomain = config.from.split('@')[1] ?? 'localhost';
  const headers = [
    `From: ${config.from}`,
    `To: ${mail.to.join(', ')}`,
    `Subject: ${encodeHeader(mail.subject)}`,
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: <${Date.now().toString(36)}${randomBytes(6).toString('hex')}@${fromDomain}>`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
  ];
  const body = [
    `--${boundary}`,
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: base64',
    '',
    wrap76(Buffer.from(mail.text, 'utf8').toString('base64')),
    `--${boundary}`,
    'Content-Type: text/html; charset=utf-8',
    'Content-Transfer-Encoding: base64',
    '',
    wrap76(Buffer.from(mail.html, 'utf8').toString('base64')),
    `--${boundary}--`,
    '',
  ];
  return dotStuff([...headers, '', ...body].join('\r\n'));
}

/** RFC 2047: ASCII passes through; anything else goes encoded-word. */
function encodeHeader(value: string): string {
  if (/^[\x20-\x7e]*$/.test(value)) return value;
  return `=?UTF-8?B?${Buffer.from(value, 'utf8').toString('base64')}?=`;
}

function wrap76(b64: string): string {
  const lines: string[] = [];
  for (let i = 0; i < b64.length; i += 76) lines.push(b64.slice(i, i + 76));
  return lines.join('\r\n');
}

/** Normalize newlines to CRLF, then double every line-leading dot. */
export function dotStuff(text: string): string {
  return text
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .split('\n')
    .map((line) => (line.startsWith('.') ? `.${line}` : line))
    .join('\r\n');
}
