import { z } from 'zod';

export const CONSENT = Object.freeze({
  version: 'signhere-consent-v1',
  text: 'Jag har läst hela dokumentet och samtycker till att signera det elektroniskt. Jag avser att min ritade underskrift uttrycker mitt godkännande. Jag förstår att mitt namn, min underskrift, tidpunkten för signeringen, min IP-adress och webbläsarinformation sparas som bevis.',
});
export type Strokes = number[][][];
export interface SignatureContext {
  documentId: string; documentHash: string; recipientId: string; name: string; consent: typeof CONSENT;
}
export type SignatureResult =
  | { status: 'completed'; visualSignature?: { strokes: Strokes }; providerEvidence: Record<string, unknown> }
  | { status: 'pending'; attemptId: string; providerEvidence: Record<string, unknown> }
  | { status: 'failed' | 'cancelled'; reason: string };
export interface SigningMethod {
  id: string; label: string; version: string;
  capabilities: { visualSignature: boolean; verifiesIdentity: boolean; asynchronous: boolean };
  /** Providers must bind verified results to the immutable document hash and
   * recipient. An asynchronous method needs a persisted attempt state machine
   * and authenticated callbacks before being enabled in the application. */
  begin(context: SignatureContext): Promise<Record<string, unknown>>;
  complete(context: SignatureContext, payload: unknown): Promise<SignatureResult>;
}
const strokesSchema = z.object({
  strokes: z.array(z.array(z.tuple([z.number().finite().min(0).max(1), z.number().finite().min(0).max(1)])).min(2).max(2000)).min(1).max(100),
}).strict().superRefine(({ strokes }, ctx) => {
  const points = strokes.flat();
  let length = 0;
  for (const stroke of strokes) for (let i = 1; i < stroke.length; i++) length += Math.hypot(stroke[i][0] - stroke[i - 1][0], stroke[i][1] - stroke[i - 1][1]);
  if (points.length > 12000 || length < 0.15) ctx.addIssue({ code: 'custom', message: 'Rita en tydlig underskrift med högst 12 000 punkter.' });
});
const draw: SigningMethod = Object.freeze({
  id: 'draw', label: 'Rita din signatur', version: '1.0.0',
  capabilities: Object.freeze({ visualSignature: true, verifiesIdentity: false, asynchronous: false }),
  async begin() { return {}; },
  async complete(_context: SignatureContext, payload: unknown): Promise<SignatureResult> {
    const { strokes } = strokesSchema.parse(payload);
    return { status: 'completed', visualSignature: { strokes }, providerEvidence: { assurance: 'self-asserted', identityVerified: false } };
  },
});
const signingMethods = new Map<string, SigningMethod>([[draw.id, draw]]);
export const getSigningMethod = (id: string): Readonly<SigningMethod> | undefined => signingMethods.get(id);
export const listMethods = () => [...signingMethods.values()].map(({ id, label, version, capabilities }) => ({ id, label, version, capabilities }));


