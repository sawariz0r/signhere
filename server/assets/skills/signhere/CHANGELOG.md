# Signhere skill changes

## 1.0.4

Documents native blocks, party data, reusable fields and supported Tiptap formatting. Adds a synthetic service agreement fixture, pricing guidance for unknown rates, and signing-flow guidance. Documents current signing-PDF fidelity limits and distinguishes stored editor preferences from signing behavior. JSON examples are validated against the draft schema; the agreement fixture is exercised through MCP and the editor, including reusable-value updates. Authentication, revision, retry and sharing safeguards remain in place.

## 1.0.3

Adds optional ChatGPT host OAuth alongside the existing user-supplied API token mode. The human signs in and approves scopes in their own browser; the agent never handles passwords, sessions, recovery or authorization codes. OAuth access has a fixed lifetime without refresh; expiry requires a human reconnection. Both modes use the same document tools and keep credential changes outside skill updates.

## 1.0.2

Replaces browser sign-in guidance with the user-supplied, short-lived bearer-token workflow. Agents never use passwords, browser sessions, account recovery or credential creation. Missing or expired tokens require a user-supplied replacement. Workspace identity includes token expiry; new tokens default to one hour with a 15-minute to 24-hour range. Public skill update downloads omit authentication tokens.

## 1.0.1

Superseded by 1.0.2: this release included application browser-login guidance outside the agent's intended workflow. Use the token-only instructions in the current skill.

## 1.0.0

Initial API-key connection: create and revise editor drafts, save immutable versions, and read or reply to review discussions. Includes revision conflict handling and optional, approval-based skill updates. Sending, signing acceptance and creating review links remain in Signhere's interface.
