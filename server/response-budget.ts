import type { Response } from 'express';
import { ApiError } from './security.js';
type Kind = 'view' | 'download' | 'export';
interface Waiting { principal: string; resolve: () => void; reject: (error: Error) => void; timer: NodeJS.Timeout; cancel: () => void; response: Response; }
/** Separate bounded lanes keep archive/slow-copy traffic from blocking document viewing. */
export function createResponseBudget(options: { waitMs?: number; idleMs?: number; queueLimit?: number } = {}) {
  const lanes = Object.fromEntries((['view', 'download', 'export'] as const).map(kind => [kind, { active: 0, limit: kind === 'view' ? 2 : 1, waiting: [] as Waiting[] }])) as Record<Kind, { active: number; limit: number; waiting: Waiting[] }>;
  const principals = new Set<string>();
  const busy = () => new ApiError(429, 'Flera filer hämtas just nu. Försök igen om en stund.');
  return async function withResponse<T>(response: Response, kind: Kind, principal: string, work: () => Promise<T>): Promise<T> {
    const lane = lanes[kind];
    const key = kind + ':' + principal;
    if (principals.has(key) || lane.waiting.length >= (options.queueLimit ?? 32)) throw busy();
    principals.add(key);
    let acquired = false, released = false;
    const release = () => {
      if (!acquired) return; acquired = false; released = true;
      principals.delete(key); response.off('finish', release); response.off('close', release);
      const next = lane.waiting.shift();
      if (next) { clearTimeout(next.timer); next.response.off('close', next.cancel); next.resolve(); }
      else lane.active--;
    };
    try {
      if (lane.active < lane.limit) lane.active++;
      else await new Promise<void>((resolve, reject) => {
        const cancel = () => { const index = lane.waiting.indexOf(waiting); if (index < 0) return; lane.waiting.splice(index, 1); clearTimeout(waiting.timer); response.off('close', cancel); reject(busy()); };
        const waiting: Waiting = { principal, resolve, reject, cancel, response, timer: setTimeout(cancel, options.waitMs ?? 5000).unref() };
        lane.waiting.push(waiting); response.once('close', cancel);
      });
      acquired = true;
      response.once('finish', release); response.once('close', release);
      // Idle timeout resets with socket progress; slow but progressing downloads remain valid.
      response.setTimeout(options.idleMs ?? 30000, () => response.destroy());
      if (response.destroyed) throw busy();
      return await work();
    } catch (error) { if (acquired) release(); else if (!released) principals.delete(key); throw error; }
  };
}
