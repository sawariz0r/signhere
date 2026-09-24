import { readFileSync } from 'node:fs';
import nodemailer from 'nodemailer';

export interface MailAttachment { filename: string; content: Buffer; contentType: string }
export interface MailMessage {
  to: string; subject: string; text: string; html?: string; attachments?: MailAttachment[];
  /** Stable per logical delivery. Providers that support it use it to suppress duplicates. */
  idempotencyKey: string;
}
export interface Mailer { provider: 'smtp' | 'resend' | 'test'; send(message: MailMessage): Promise<{ messageId?: string }> }

/** A permanent failure is not retried; everything else is treated as transient. */
export class MailPermanentError extends Error {
  constructor(public readonly code: string) { super(code); this.name = 'MailPermanentError'; }
}
export class MailTransientError extends Error {
  constructor(public readonly code: string) { super(code); this.name = 'MailTransientError'; }
}

type Env = Record<string, string | undefined>;
function secret(env: Env, name: string) {
  const file = env[name + '_FILE'];
  if (file) {
    const value = readFileSync(file, 'utf8').trim();
    if (!value) throw new Error(name + '_FILE is empty.');
    return value;
  }
  return env[name] || undefined;
}
function sender(env: Env) {
  const from = (env.SIGNHERE_MAIL_FROM || env.SMTP_FROM)?.trim();
  if (!from) throw new Error('SIGNHERE_MAIL_FROM (or SMTP_FROM) is required when email delivery is configured.');
  if (/[\r\n]/.test(from)) throw new Error('SIGNHERE_MAIL_FROM must be a single line.');
  return from;
}

/**
 * Email delivery is optional. SMTP is the default provider and becomes active when
 * SMTP_HOST (or the SMTP_URL shorthand) is set; SIGNHERE_MAIL_PROVIDER=resend selects the Resend HTTP API instead.
 * Returns null when nothing is configured, so installations without mail keep working.
 */
export function mailerFromEnv(input: Env = process.env): Mailer | null {
  // Deployment tools often pass unset variables as empty strings; treat those as unset.
  const env: Env = Object.fromEntries(Object.entries(input).map(([key, value]) => [key, value?.trim() ? value : undefined]));
  const provider = (env.SIGNHERE_MAIL_PROVIDER?.trim() || 'smtp').toLowerCase();
  if (provider === 'smtp') {
    const url = env.SMTP_URL?.trim();
    if (url && !env.SMTP_HOST?.trim()) return smtpMailer({ ...smtpUrl(url), from: sender(env) });
    const host = env.SMTP_HOST?.trim();
    if (!host) return null;
    const port = Number(env.SMTP_PORT ?? 587);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('SMTP_PORT must be between 1 and 65535.');
    const secure = env.SMTP_SECURE ? env.SMTP_SECURE === 'true' : port === 465;
    const user = env.SMTP_USER?.trim();
    const pass = secret(env, 'SMTP_PASSWORD');
    return smtpMailer({ host, port, secure, user, pass, from: sender(env) });
  }
  if (provider === 'resend') {
    const apiKey = secret(env, 'RESEND_API_KEY');
    if (!apiKey) throw new Error('RESEND_API_KEY or RESEND_API_KEY_FILE is required when SIGNHERE_MAIL_PROVIDER=resend.');
    return resendMailer({ apiKey, from: sender(env) });
  }
  throw new Error('SIGNHERE_MAIL_PROVIDER must be smtp or resend.');
}

/**
 * Startup wrapper: e-mail is optional, so a missing or invalid mail setting disables e-mail
 * with a logged reason instead of stopping the application.
 */
export function loadMailer(env: Env = process.env, log: (message: string) => void = console.error): Mailer | null {
  try { return mailerFromEnv(env); }
  catch (error) {
    log('signhere: e-mail is disabled because its configuration is invalid: ' + (error instanceof Error ? error.message : 'unknown error') + ' Everything else keeps working; share links manually or fix the setting and restart.');
    return null;
  }
}

/** SMTP_URL (smtp:// or smtps://, credentials in the URL) is shorthand for the SMTP_* settings. */
function smtpUrl(value: string) {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error('SMTP_URL must be a valid smtp:// or smtps:// URL.'); }
  if (!['smtp:', 'smtps:'].includes(url.protocol) || !url.hostname) throw new Error('SMTP_URL must use smtp:// or smtps://.');
  const secure = url.protocol === 'smtps:';
  const port = url.port ? Number(url.port) : secure ? 465 : 587;
  return { host: url.hostname, port, secure, user: decodeURIComponent(url.username) || undefined, pass: decodeURIComponent(url.password) || undefined };
}

export function smtpMailer(options: { host: string; port: number; secure: boolean; user?: string; pass?: string; from: string }): Mailer {
  const transport = nodemailer.createTransport({
    host: options.host, port: options.port, secure: options.secure,
    // Plain SMTP on 587/25 must upgrade to TLS; never send documents in cleartext.
    requireTLS: !options.secure,
    ...(options.user ? { auth: { user: options.user, pass: options.pass ?? '' } } : {}),
    connectionTimeout: 15000, greetingTimeout: 15000, socketTimeout: 60000,
    disableFileAccess: true, disableUrlAccess: true,
  });
  return {
    provider: 'smtp',
    async send(message) {
      try {
        const info = await transport.sendMail({
          from: options.from, to: message.to, subject: message.subject, text: message.text, html: message.html,
          messageId: '<' + message.idempotencyKey + '@signhere>',
          attachments: message.attachments?.map(item => ({ filename: item.filename, content: item.content, contentType: item.contentType })),
        });
        return { messageId: info.messageId };
      } catch (error) {
        const { code, responseCode } = error as { code?: string; responseCode?: number };
        if (code === 'EAUTH') throw new MailPermanentError('smtp_unauthorized');
        // 5xx replies (bad recipient, rejected content) will not succeed on retry.
        if (typeof responseCode === 'number' && responseCode >= 500 && responseCode < 600) throw new MailPermanentError('smtp_rejected');
        throw new MailTransientError('smtp_unavailable');
      }
    },
  };
}

export function resendMailer(options: { apiKey: string; from: string; endpoint?: string; fetch?: typeof fetch }): Mailer {
  const send = options.fetch ?? fetch;
  return {
    provider: 'resend',
    async send(message) {
      let response: Response;
      try {
        response = await send(options.endpoint ?? 'https://api.resend.com/emails', {
          method: 'POST',
          headers: { Authorization: 'Bearer ' + options.apiKey, 'Content-Type': 'application/json', 'Idempotency-Key': message.idempotencyKey },
          body: JSON.stringify({
            from: options.from, to: [message.to], subject: message.subject, text: message.text, html: message.html,
            attachments: message.attachments?.map(item => ({ filename: item.filename, content: item.content.toString('base64'), content_type: item.contentType })),
          }),
          signal: AbortSignal.timeout(60000),
        });
      } catch { throw new MailTransientError('resend_unavailable'); }
      if (response.ok) {
        const body = await response.json().catch(() => ({})) as { id?: unknown };
        return { messageId: typeof body.id === 'string' ? body.id : undefined };
      }
      // 409 (concurrent idempotent request), 429 and 5xx are transient; other 4xx
      // (invalid address, unverified domain, bad key) will not succeed on retry.
      if ([409, 429].includes(response.status) || response.status >= 500) throw new MailTransientError('resend_unavailable');
      if (response.status === 401 || response.status === 403) throw new MailPermanentError('resend_unauthorized');
      throw new MailPermanentError('resend_rejected');
    },
  };
}
