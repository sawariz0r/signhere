export type User = { id: string; name: string; email: string; teamId: string; teamName: string; role?: string };
export type Strokes = number[][][];
export type Recipient = { id: string; name: string; email?: string; methodId: string; viewedAt: string | null; signedAt: string | null; signedName?: string; signature?: { strokes: Strokes }; ip?: string; userAgent?: string; parentRecipientId?: string; independentApproval?: { status: string; at?: string; receiptSha256?: string } };
export type AuditEvent = { sequence: number; type: string; at: string; data: Record<string, unknown>; hash: string; previousHash: string };
export type PdfPreparation = { kind: 'flatten'; engine: string; engineVersion: string; sourceHash: string; sourceSize: number; annotationCount: number; formFieldCount: number; noteCount: number };
export type PreparedPdf = { pdfBase64: string; hash: string; pages: number; size: number; preparation: PdfPreparation | null };
export type SigningDocument = { id: string; title: string; fileName: string; size: number; pages: number; status: 'pending' | 'finalizing' | 'completed' | 'cancelled'; originalHash: string; preparation?: PdfPreparation | null; completedHash: string | null; createdAt: string; completedAt: string | null; senderRecipientId: string | null; sender: { name: string; email: string; teamName: string }; recipients: Recipient[]; events: AuditEvent[]; evidenceVersion?: number; finalization?: { state: 'working' | 'action_required'; code?: string }; seal?: { profile: string; fingerprintSha256: string; cryptographicPdfSeal: boolean; trustedTimestamp: boolean; identityVerified: boolean }; attachmentOf?: AttachmentOf; attachments?: SigningDocument[]; attachmentCount?: number; openAttachmentCount?: number; deliveries?: Delivery[]; independentApproval?: { service: string; method: 'email' } };
export type Delivery = { id: string; recipientId: string | null; email: string; name: string; status: 'queued' | 'sending' | 'retry' | 'sent' | 'failed'; attempts: number; sentAt: string | null; error: string | null };
export type AttachmentOf = { documentId: string; title: string; completedHash: string; number: number };
/** A party's view of the main document and its bilagor. Events omit addresses, IPs and devices. */
export type PartyEvent = { documentId: string; sequence: number; type: string; at: string; hash: string; actor: string | null };
export type PartyDocument = Omit<SigningDocument, 'events'> & { partyRecipientId: string | null; events: PartyEvent[] };
export type Dossier = { documentId: string; documents: PartyDocument[] };
export type SignSession = { document: SigningDocument; recipientId: string; signingIntentHash?: string; consent: { version: string; text: string }; method: { id: string; label: string; version: string }; emailCopy?: boolean; independentApproval?: { required: true; service: string } };
export type CreatedDocument = { document: SigningDocument; links: ShareLink[]; senderRecipientId: string | null; notified?: boolean };
export type ShareLink = { recipientId: string; name: string; url: string };
export type Team = { name: string; members: { id: string; name: string; email: string; role: string }[]; invitations: { id: string; email: string; expiresAt: string }[] };
export type Bootstrap = { setupRequired: boolean; user: User | null; methods: { id: string; label: string; version: string }[]; delivery?: { email: boolean }; central?: Central };
/** Present only when the installation is connected to an (optional) central service. */
export type Central = { service: string; independentApproval: boolean };
export type IndependentApprovalState = { required: false } | { required: true; service: string; status: 'verified'; receiptSha256: string; approvedAt?: string } | { required: true; service: string; status: 'pending'; url: string } | { required: true; service: string; status: 'unavailable' | 'rejected' | 'expired' | 'cancelled'; reason: string };
