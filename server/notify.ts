import { createTransport } from 'nodemailer';

export interface Message { to: string; subject: string; text: string }
export interface Notifier { enabled: boolean; send(messages: Message[]): Promise<void> }

/** Test and alternative transports can supply their own delivery function. */
export type Deliver = (message: Message) => Promise<void>;

/**
 * E-mail is optional. Without SMTP_URL the platform keeps working with manually shared links.
 * Delivery is best effort: a failed notification never rolls back signing state.
 */
export function createNotifier(options: { smtpUrl?: string; from?: string; deliver?: Deliver } = {}): Notifier {
  let deliver = options.deliver;
  if (!deliver && options.smtpUrl) {
    const url = new URL(options.smtpUrl);
    if (!['smtp:', 'smtps:'].includes(url.protocol)) throw new Error('SMTP_URL must use smtp:// or smtps://.');
    if (!options.from) throw new Error('SMTP_FROM is required when SMTP_URL is set.');
    const transport = createTransport(options.smtpUrl);
    deliver = async message => { await transport.sendMail({ from: options.from, ...message }); };
  }
  if (!deliver) return { enabled: false, async send() {} };
  const send = deliver;
  return {
    enabled: true,
    async send(messages) {
      for (const message of messages) {
        // Deliberately omit recipient addresses and message content from logs.
        try { await send({ ...message, subject: oneLine(message.subject) }); }
        catch { console.error('signhere: notification delivery failed'); }
      }
    },
  };
}
const oneLine = (value: string) => value.replace(/[\r\n\t]+/g, ' ').slice(0, 200);
