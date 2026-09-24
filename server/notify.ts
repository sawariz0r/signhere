import { randomUUID } from 'node:crypto';
import type { Mailer } from './mail.js';

export interface Message { to: string; subject: string; text: string }
export interface Notifier { enabled: boolean; send(messages: Message[]): Promise<void> }

/** Test and alternative transports can supply their own delivery function. */
export type Deliver = (message: Message) => Promise<void>;

/**
 * E-mail is optional. Without a mailer the platform keeps working with manually shared links.
 * Delivery is best effort: a failed notification never rolls back signing state.
 */
export function createNotifier(options: { mailer?: Mailer | null; deliver?: Deliver } = {}): Notifier {
  const mailer = options.mailer;
  const deliver = options.deliver ?? (mailer ? async (message: Message) => { await mailer.send({ ...message, idempotencyKey: randomUUID() }); } : undefined);
  if (!deliver) return { enabled: false, async send() {} };
  return {
    enabled: true,
    async send(messages) {
      for (const message of messages) {
        // Deliberately omit recipient addresses and message content from logs.
        try { await deliver({ ...message, subject: oneLine(message.subject) }); }
        catch { console.error('signhere: notification delivery failed'); }
      }
    },
  };
}
const oneLine = (value: string) => value.replace(/[\r\n\t]+/g, ' ').slice(0, 200);
