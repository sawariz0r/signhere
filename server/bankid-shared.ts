import { createHmac } from 'node:crypto';
import { canonical } from './db.js';
import type { SignatureContext } from './plugins.js';

// BankID pieces shared by every BankID signing method, whether it talks to the
// BankID RP API directly (bankid.ts) or through a broker (tic-bankid.ts).

export const BANKID_CONSENT = Object.freeze({
  version: 'signhere-consent-bankid-v1',
  text: 'Jag har läst hela dokumentet och samtycker till att signera det elektroniskt med BankID. Jag förstår att mitt namn, mitt personnummer, tidpunkten för signeringen, min IP-adress, webbläsarinformation och BankID:s signatursvar sparas som bevis.',
});

/** Animated BankID QR payload. The secret stays on the server; only this string reaches the browser. */
export function bankIdQrData(qrStartToken: string, qrStartSecret: string, elapsedSeconds: number) {
  const seconds = Math.max(0, Math.floor(elapsedSeconds));
  return 'bankid.' + qrStartToken + '.' + seconds + '.' + createHmac('sha256', qrStartSecret).update(String(seconds)).digest('hex');
}

const HINTS: Record<string, string> = {
  outstandingTransaction: 'Starta BankID-appen.',
  noClient: 'Starta BankID-appen.',
  started: 'Söker efter BankID, det kan ta en liten stund …',
  userMrtd: 'Följ instruktionerna i BankID-appen för att läsa av ditt pass eller id-kort.',
  userCallConfirm: 'Följ instruktionerna i BankID-appen.',
  userSign: 'Skriv in din säkerhetskod i BankID-appen och välj Skriv under.',
  userCancel: 'Åtgärden avbröts.',
  expiredTransaction: 'BankID-appen svarar inte. Kontrollera att den är startad och att du har internetanslutning. Försök sedan igen.',
  certificateErr: 'Det BankID du försöker använda är för gammalt eller spärrat. Använd ett annat BankID eller skaffa ett nytt hos din internetbank.',
  startFailed: 'Misslyckades att läsa av QR-koden. Starta BankID-appen och läs av QR-koden. Kontrollera att BankID-appen är uppdaterad.',
  cancelled: 'Åtgärden avbröts. Försök igen.',
  alreadyInProgress: 'En identifiering eller underskrift för det här personnumret är redan påbörjad. Försök igen.',
};
export const hintMessage = (hintCode: string | undefined, fallback = 'Okänt fel. Försök igen.') => (hintCode && Object.hasOwn(HINTS, hintCode) ? HINTS[hintCode] : fallback);

export function assertBankIdContext(context: SignatureContext) {
  if (context.consent.version !== BANKID_CONSENT.version || context.consent.text !== BANKID_CONSENT.text) throw new Error('BankID signing requires the BankID consent text.');
  if (!context.signingIntentHash) throw new Error('BankID signing requires a frozen signing intent.');
}
/** Exact `userNonVisibleData`: BankID signs it, so a completed order proves which frozen intent it approved. */
export function signedBinding(context: SignatureContext) {
  assertBankIdContext(context);
  return canonical({ schema: 'signhere-bankid-binding-v1', documentId: context.documentId, recipientId: context.recipientId, preparedHash: context.documentHash, signingIntentHash: context.signingIntentHash, consentVersion: context.consent.version });
}
/** Exact `userVisibleData` shown in the BankID app (simpleMarkdownV1). */
export function visibleText(context: SignatureContext) {
  const title = (context.documentTitle ?? '').replace(/[\s*]+/g, ' ').trim().slice(0, 200) || 'Namnlöst dokument';
  return ['# Signera dokument', 'Dokument: ' + title, 'Dokument-ID: ' + context.documentId, 'SHA-256: ' + context.documentHash, '---', context.consent.text].join('\n\n');
}

export const isBase64 = (value: string) => /^[A-Za-z0-9+/]+={0,2}$/.test(value);
/** The single base64 value of a BankID signed-data element, decoded. Returns undefined unless exactly one exists. */
function signedElement(xml: string, element: 'usrVisibleData' | 'usrNonVisibleData') {
  const matches = [...xml.matchAll(new RegExp('<(?:[\\w-]+:)?' + element + '\\b[^>]*>([^<]*)</(?:[\\w-]+:)?' + element + '>', 'g'))];
  const value = matches.length === 1 ? matches[0][1].replace(/\s+/g, '') : '';
  return isBase64(value) ? Buffer.from(value, 'base64').toString('utf8') : undefined;
}
/** Whether BankID's signature XML carries exactly this recipient's visible text and binding. Not an XML-DSig check. */
export function signatureCoversContext(xml: Buffer, context: SignatureContext) {
  const text = xml.toString('utf8');
  return signedElement(text, 'usrNonVisibleData') === signedBinding(context) && signedElement(text, 'usrVisibleData') === visibleText(context);
}
