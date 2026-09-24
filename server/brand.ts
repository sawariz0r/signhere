import { z } from 'zod';

/**
 * A team's whitelabel settings: a name, an optional logo and one colour from a fixed palette.
 * The key is stored, not the colour, so the palette can be tuned later. Every colour passes
 * 4.5:1 against white text. The web app renders the same keys from web/brand.ts (oklch);
 * these are the sRGB equivalents for the PDF signature page.
 */
export const ACCENTS = { ink: '#0e1116', blue: '#1b589e', green: '#00694a', red: '#ac312a', violet: '#614092', amber: '#905211' } as const;
export type Accent = keyof typeof ACCENTS;
export const accentSchema = z.enum(Object.keys(ACCENTS) as [Accent, ...Accent[]]);
export const accentOf = (value: unknown): Accent => accentSchema.safeParse(value).success ? value as Accent : 'ink';
export const MAX_LOGO_BYTES = 500 * 1024;
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * Checks the PNG header without decoding the image. Browsers decode it for display and the
 * sandboxed PDF worker decodes it for the signature page; the dimension cap bounds both.
 */
export function checkLogoPng(bytes: Buffer) {
  if (bytes.length > MAX_LOGO_BYTES) throw new Error('Filen är större än 500 kB.');
  if (bytes.length < 33 || !bytes.subarray(0, 8).equals(PNG) || bytes.readUInt32BE(8) !== 13 || bytes.toString('latin1', 12, 16) !== 'IHDR') throw new Error('Logotypen måste vara en PNG-fil.');
  const width = bytes.readUInt32BE(16), height = bytes.readUInt32BE(20);
  if (!width || !height || width > 2048 || height > 2048) throw new Error('Logotypen får vara högst 2048 × 2048 pixlar.');
}

/** showName is the stored setting; the name is always shown when there is no logo. */
export interface Brand { name: string; logoUrl: string | null; showName: boolean; accent: Accent }
/** Expects a teams row, or a joined row with team_name, logo_hash, logo_show_name and accent. */
export const brandOf = (row: { name?: string; team_name?: string; logo_hash?: string | null; logo_show_name?: boolean; accent?: string }): Brand => ({
  name: row.team_name ?? row.name ?? '', logoUrl: row.logo_hash ? '/api/logos/' + row.logo_hash : null,
  showName: row.logo_show_name !== false, accent: accentOf(row.accent),
});
