import type { Draft } from '../editor/model';
import type { Brand } from '../types';

export type SharedVersion = { version: number; sourceRevision: number; publishedAt: string };
export type ReviewComment = { id: string; authorName: string; body: string; createdAt: string };
export type ReviewThread = { id: string; version: number | null; signingDocumentId?: string | null; blockId: string | null; resolved: boolean; comments: ReviewComment[] };
export type CommentInput = { version?: number; blockId?: string | null; threadId?: string; body: string; requestId: string };
export type ReviewLink = { id: string; name: string; expiresAt: number; revokedAt: string | null };
export type ReviewData = { draft: Draft; version: number; versions: SharedVersion[]; threads: ReviewThread[]; reviewerName: string; brand: Brand; signing: { state: string; sentAt: string } | null };
export type DraftDetail = { draft: Draft; revision: number; versions: SharedVersion[]; threads: ReviewThread[]; links: ReviewLink[]; signings: { revision: number; documentId: string }[] };
export type SigningDiscussion = { draftId: string; revision: number; source: Draft; sections: { id: string; label: string }[]; changedSections: { id: string; label: string }[]; versions: SharedVersion[]; threads: ReviewThread[] };
