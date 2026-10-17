import { request } from '../api';
import type { Draft } from './model';

/** Serialize autosave, explicit save and publish/send preparation through one revision cursor. */
export class DraftStorage {
  private queue: Promise<unknown> = Promise.resolve();
  saved: string;
  constructor(public revision: number, initial: Draft) { this.saved = revision ? JSON.stringify(initial) : ''; }
  save(draft: Draft): Promise<number> {
    const serialized = JSON.stringify(draft);
    const task = this.queue.catch(() => {}).then(async () => {
      if (this.saved === serialized) return this.revision;
      const result = await request<{ revision: number }>(`/api/drafts/${draft.id}`, { expectedRevision: this.revision, draft }, 'PUT');
      this.revision = result.revision;
      this.saved = serialized;
      return result.revision;
    });
    this.queue = task;
    return task;
  }
}
