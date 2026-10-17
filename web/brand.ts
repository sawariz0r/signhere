import type { CSSProperties } from 'react';
import type { AccentKey, Brand } from './types';

/** The fixed palette. Every colour passes 4.5:1 against white text; server/brand.ts has the sRGB values for the PDF. */
export const ACCENTS: [AccentKey, string, string][] = [
  ['ink', 'Svart', '#0e1116'], ['blue', 'Blå', 'oklch(0.46 0.13 255)'], ['green', 'Grön', 'oklch(0.46 0.1 165)'],
  ['red', 'Röd', 'oklch(0.5 0.16 28)'], ['violet', 'Lila', 'oklch(0.45 0.13 300)'], ['amber', 'Brun', 'oklch(0.5 0.11 60)'],
];
export const accentColor = (key: AccentKey) => (ACCENTS.find(([value]) => value === key) ?? ACCENTS[0])[2];
export const accentStyle = (brand?: Brand | null) => ({ '--accent': accentColor(brand?.accent ?? 'ink') }) as CSSProperties;
export const brandName = (brand: Brand, fallback = 'Ditt företag') => brand.name.trim() || fallback;
export const monogram = (name: string) => name.match(/[\p{L}\p{N}]/u)?.[0]?.toUpperCase() ?? 'S';

const LOGO_TYPES = ['image/png', 'image/svg+xml', 'image/jpeg', 'image/webp'];
const MAX_WIDTH = 640, MAX_HEIGHT = 192;

/**
 * Rasterises an uploaded logo to a PNG (base64) in the browser. An SVG loaded as an image
 * runs no scripts and fetches nothing external, so the server only ever stores PNGs.
 */
export async function logoPng(file: File): Promise<string> {
  if (!LOGO_TYPES.includes(file.type)) throw new Error('Välj en PNG-, SVG- eller JPG-fil.');
  if (file.size > 500 * 1024) throw new Error('Filen är större än 500 kB.');
  const url = URL.createObjectURL(file);
  try {
    const image = new Image();
    image.decoding = 'async'; image.src = url;
    await image.decode().catch(() => { throw new Error('Logotypen kunde inte läsas. Prova en annan fil.'); });
    let width = image.naturalWidth, height = image.naturalHeight;
    if (file.type === 'image/svg+xml') {
      // Vector logos render at the largest size that fits; one without width/height uses its viewBox.
      const box = (await file.text()).match(/viewBox\s*=\s*["']\s*[-\d.]+[\s,]+[-\d.]+[\s,]+([\d.]+)[\s,]+([\d.]+)/i);
      if (box) { width = Number(box[1]); height = Number(box[2]); }
      if (!width || !height) { width = 300; height = 150; }
      const scale = Math.min(MAX_WIDTH / width, MAX_HEIGHT / height);
      width *= scale; height *= scale;
    } else {
      const scale = Math.min(1, MAX_WIDTH / width, MAX_HEIGHT / height);
      width *= scale; height *= scale;
    }
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(width)); canvas.height = Math.max(1, Math.round(height));
    const context = canvas.getContext('2d')!;
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    let data: string;
    try {
      // Trim transparent margins so the logo sits flush against the company name.
      const { data: pixels } = context.getImageData(0, 0, canvas.width, canvas.height);
      let left = canvas.width, top = canvas.height, right = -1, bottom = -1;
      for (let y = 0; y < canvas.height; y++) for (let x = 0; x < canvas.width; x++) if (pixels[(y * canvas.width + x) * 4 + 3] > 8) { left = Math.min(left, x); right = Math.max(right, x); top = Math.min(top, y); bottom = Math.max(bottom, y); }
      if (right < 0) throw new Error('Logotypen är helt genomskinlig.');
      const trimmed = document.createElement('canvas');
      trimmed.width = right - left + 1; trimmed.height = bottom - top + 1;
      trimmed.getContext('2d')!.drawImage(canvas, left, top, trimmed.width, trimmed.height, 0, 0, trimmed.width, trimmed.height);
      data = trimmed.toDataURL('image/png');
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('Logotypen')) throw error;
      // An SVG with foreignObject taints the canvas in some browsers.
      throw new Error('Logotypen kunde inte läsas. Prova en PNG-fil.');
    }
    return data.slice(data.indexOf(',') + 1);
  } finally { URL.revokeObjectURL(url); }
}
