# Create and sign a document

[Back to README](../README.md) · [Self-hosting](self-hosting.md)

Sign in to your installation. Recipients don't need an account to review or sign. The buttons below use their current Swedish labels.

## Create in the editor

1. On the document list, choose **Skapa i editorn**.
2. Add your text, parties, pricing, images and terms. Working edits are saved privately to the server; **Spara utkast** saves a version.
3. If you want feedback first, follow [private client review](#private-client-review) below.
4. Choose **Skicka**, check the signers and confirm the content to send. Signhere freezes that version as a PDF for signing and keeps your editable draft.
5. Share each person's signing link, or let configured email delivery send it.

The editor's signing deadline, reminder and decline settings are not applied yet.

## Upload a PDF

1. On the document list, choose **Nytt dokument** and select a PDF (up to 10 MB and 100 pages).
2. Give it a title. Use **Förhandsvisa PDF** to check the prepared signing copy, then choose **Nästa**.
3. Add the signers' names and email addresses. Select **Jag ska också signera** if you will sign too.
4. Choose **Skicka för signering**, or **Skapa och signera** if you're signing yourself.
5. Share each person's personal link. With [email configured](deployment.md#email-delivery), Signhere emails the invitations.

Each assignment needs a separate signature, even if you and another recipient use the same email address. The document completes once everyone has signed.

Signhere flattens supported forms and annotations into static content before signing; comments may appear on extra pages. It preserves the uploaded original when preparation changes it. Encrypted PDFs, active scripts, embedded files, existing digital signatures and unsupported structures are rejected. Everyone signs the same frozen PDF; later editor changes cannot alter it.

## What recipients do

Open the personal link, read the PDF, draw a signature and explicitly accept the consent text. A recipient can download the exact PDF they approved immediately, before the other parties finish.

Once everyone signs, Signhere seals the completed PDF. Recipients can return through their links to download it. If email is configured, every party and the sender also receive a completed-copy email; larger files are delivered through a link.

Treat personal links as credentials: anyone holding one has its access. Unsigned links expire after 7 days by default. Accepted links become read-only receipts, available while completion is pending and for at least 30 days after completion. Team members can rotate unsigned links or revoke a pending document from its page.

## Private client review

1. In the editor's **Granskning** panel, choose **Dela med klient…**.
2. Choose or add the client and contact, select a link lifetime, and copy the private link. The dialog saves a version if needed. Copy the link when shown; it cannot be retrieved later.
3. The client can comment on sections or the whole document without an account. Read and reply alongside the editor.
4. Revise privately, then choose **Spara utkast** when the changes are ready for existing client links. Earlier comments keep their original version and context.

Sending for signing makes review comments read-only through the review link. All assigned signers can see the earlier discussion in their signing workspace. The review link itself cannot sign, and discussion is separate from signing evidence. A signer can ask new questions about the signing copy until they sign.

## After signing

From the document page you can track progress, download the completed PDF or export the full verification bundle. The bundle includes private evidence such as IP addresses and device details; it is available to team members, while recipient links provide the PDF.

To add a **bilaga** (attachment), upload a PDF or create one in the editor from the completed document. Choose who signs it. Each attachment is a separate signing document linked to the signed main document, with its own signatures and seal. Recipients can return through their links to see the main document and their attachments.

To check a completed PDF, visit `/verify` on the installation that signed it. Your browser sends only the file's fingerprint. This checks that server's record; for independent cryptographic checks, follow the [offline verification guide](signing-security.md#6-verify-independently-of-the-running-platform).

## Settings and agents

Use the account menu's **Inställningar** to manage branding, team members, agents and the installation. To let your own agent help with drafts and review comments, start with the [agent connection guide](agent-connection.md).
