export async function request<T>(path: string, body?: unknown, method?: string): Promise<T> {
  const response = await fetch(path, {
    method: method ?? (body === undefined ? 'GET' : 'POST'),
    credentials: 'same-origin',
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok) {
    const detail = await response.json().catch(() => ({}));
    throw new Error(detail.error || `Förfrågan misslyckades (${response.status}).`);
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

export async function fetchPdf(path: string, body?: unknown): Promise<Blob> {
  const response = await fetch(path, {
    method: body === undefined ? 'GET' : 'POST', credentials: 'same-origin',
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok) {
    const detail = await response.json().catch(() => ({}));
    throw new Error(detail.error || 'PDF-filen kunde inte hämtas.');
  }
  return response.blob();
}

export async function download(path: string, fileName: string, body?: unknown) {
  const blob = await fetchPdf(path, body);
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url; link.download = fileName;
  document.body.append(link); link.click(); link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

export const message = (error: unknown) => error instanceof Error ? error.message : 'Något gick fel. Försök igen.';
export const date = (value: string | null | undefined) => value ? new Date(value).toLocaleDateString('sv-SE', { day: 'numeric', month: 'short', year: 'numeric' }) : '—';
export const dateTime = (value: string | null | undefined) => value ? `${date(value)}, ${new Date(value).toLocaleTimeString('sv-SE')}` : '—';
export const initials = (name: string) => name.trim().split(/\s+/).slice(0, 2).map(n => n[0]?.toUpperCase()).join('');
export const size = (bytes: number) => bytes >= 1_000_000 ? `${(bytes / 1_000_000).toLocaleString('sv-SE', { maximumFractionDigits: 1 })} MB` : `${Math.max(1, Math.round(bytes / 1024))} kB`;
export const attachmentLabel = (attachment: { number: number }) => `Bilaga ${attachment.number}`;
export const pages = (n: number) => `${n} ${n === 1 ? 'sida' : 'sidor'} + signatursida`;

export function fileBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1]);
    reader.onerror = () => reject(new Error('Filen kunde inte läsas.'));
    reader.readAsDataURL(file);
  });
}
