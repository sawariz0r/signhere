# Connect your agent to Signhere

Signhere issues its own API keys. You do not need OAuth, an external identity provider, or an Anthropic/OpenAI API key. Your existing agent supplies the model; Signhere supplies document tools.

This release implements remote Streamable HTTP MCP at `/mcp`, the equivalent REST API at `/api/v1`, and a portable `signhere` skill. The examples below use `https://sign.example.com`; replace it with your installation's base URL. Host setup instructions were checked against official documentation on 2026-10-16. Transport tests are separate from account-level checks in Claude's or Codex's user interfaces; connector availability depends on your host and plan.

## Create a key

Open Signhere's settings and **Agenter** (`/settings/agents`), create a named key, select permissions and expiry, then copy it once. The full key is not displayed again. Use a separate key per agent/connection so you can revoke one without affecting the others. Keys act as their creating user in that user's team; they are not limited to a single document.

| Permission | Grants |
| --- | --- |
| `drafts:read` | List and read editor drafts |
| `drafts:write` | Create/update private drafts and save versions |
| `discussion:read` | Read draft review discussions |
| `discussion:write` | Add comments and replies |
| `reviews:share` | Allow an explicit version save to update existing active client links |

`reviews:share` does not create links, send emails or accept signatures. The server also requires `allowSharedUpdate: true` on a save that reaches active client links. A key without that scope can still edit the private working draft. Creating/revoking links and sending for signing remain in Signhere's interface.

## Claude chat, Desktop and Cowork

In Claude's **Customize → Connectors**, add a custom connector with the remote URL `https://sign.example.com/mcp`. Select **No sign in** for OAuth authentication, then add a request header named `Authorization` with value `Bearer YOUR_SIGNHERE_KEY`. This disables the OAuth login flow; the request header still authenticates every request to Signhere. Add and enable the connector for the conversation. Team/Enterprise owners configure organization connectors in their organization settings. In that case a fixed key is shared by everyone who can use the connector, giving them that key's access. Use the appropriate team and scopes. [Official Claude custom connector instructions](https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp).

Claude's hosted connector must be able to reach your Signhere HTTPS URL. An installation reachable only on your laptop or private LAN needs a network path supported by your agent host; a remote connector does not run from your computer. [Claude network requirements](https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp).

Download `https://sign.example.com/skills/signhere/signhere.zip` and add it using your host's skill upload feature where available. The ZIP has a single `signhere/` directory containing `SKILL.md` and its references. If the host cannot install skills, you can provide `SKILL.md` and its linked reference as instructions for that conversation. The MCP connection is configured independently; uploading a skill does not configure tools or store your key.

## Claude Code

Set `SIGNHERE_API_KEY` in the environment that launches Claude Code. In a project's `.mcp.json`, merge this entry into the existing `mcpServers` object:

```json
{
  "mcpServers": {
    "signhere": {
      "type": "http",
      "url": "https://sign.example.com/mcp",
      "headers": { "Authorization": "Bearer ${SIGNHERE_API_KEY}" }
    }
  }
}
```

The environment-variable reference keeps the secret out of the file. Claude Code supports HTTP authorization headers and variable expansion in `.mcp.json`. Use `/mcp` to inspect the connection. [Official Claude Code MCP documentation](https://code.claude.com/docs/en/mcp).

Extract the skill's `signhere/` folder into your chosen Claude Code skill directory, for example a project's `.claude/skills/`. [Claude Code skill locations](https://code.claude.com/docs/en/skills). Keep the key outside the skill. Ask: “Use the Signhere skill to create a proposal for this client. Keep it private and give me the editor link.”

## Codex

Set `SIGNHERE_API_KEY` in the environment that launches Codex. Merge the following into your Codex MCP configuration:

```toml
[mcp_servers.signhere]
url = "https://sign.example.com/mcp"
bearer_token_env_var = "SIGNHERE_API_KEY"
```

Codex sends the named environment variable as a bearer token. Confirm the variable is available to the actual Codex process, including when launched from an IDE or desktop app. [Official Codex MCP documentation](https://learn.chatgpt.com/docs/extend/mcp?surface=cli).

Extract the skill's `signhere/` folder into your chosen Codex skill directory (a project's `.agents/skills/` or `~/.agents/skills/` for your user). [Official Codex skill locations](https://learn.chatgpt.com/docs/build-skills). Load the `signhere` skill and request a document operation. Skill instructions cannot grant permissions missing from the key.

This release does not implement an OAuth connector for ChatGPT's chat interface. Do not substitute a Signhere key for an OAuth client ID/secret in a host that requires OAuth.

## First workflow

1. Ask the agent to identify the connected Signhere workspace. Check it is the intended team.
2. Ask it to create or revise a draft privately. Open the returned editor link in Signhere.
3. Ask it to save an immutable version. If a client already has a link, explicitly state whether that client's copy should be updated.
4. Create the client's review link in Signhere, selecting the saved client company and contact.
5. Ask the agent to read comments, revise the draft and, if desired, post a reply. New saves reach that client only with the sharing scope and explicit shared-save argument.

An agent write does not silently overwrite a newer editor revision. A conflict requires reading the latest source and reconciling the change. Exact retries reuse the same `requestId` and arguments, avoiding duplicate mutations.

## REST and MCP contract

Send `Authorization: Bearer YOUR_SIGNHERE_KEY` to `/api/v1` or `/mcp`. Browser cookies do not authenticate these routes. Never put keys in query strings. The workspace response contains `apiVersion`, `baseUrl`, `workspace`, `user` and `scopes`. Draft source uses schema version `2`, distinct from API `v1`, editable revision and saved version.

| MCP tool | REST operation | Inputs |
| --- | --- | --- |
| `signhere_workspace` | `GET /api/v1/workspace` | None |
| `signhere_list_drafts` | `GET /api/v1/drafts?limit=50` | Optional `limit` (1–100); newest first |
| `signhere_get_draft` | `GET /api/v1/drafts/:id` | `draftId` |
| `signhere_create_draft` | `POST /api/v1/drafts` | `draft`, UUID `requestId` |
| `signhere_update_draft` | `PUT /api/v1/drafts/:id` | `draftId`, complete `draft`, `expectedRevision`, UUID `requestId` |
| `signhere_save_draft` | `POST /api/v1/drafts/:id/save` | `draftId`, `expectedRevision`, UUID `requestId`, optional `allowSharedUpdate` (default false) |
| `signhere_get_discussion` | `GET /api/v1/drafts/:id/discussion` | `draftId` |
| `signhere_add_comment` | `POST /api/v1/drafts/:id/comments` | `draftId`, `version`, `body`, UUID `requestId`; optional `blockId`, reply `threadId`. Use `version: 0` only for an existing-thread reply, including signing-copy threads with no review version |

REST path IDs replace the MCP `draftId` argument. JSON request bodies are otherwise the same. The get-draft response includes the complete `draft`, `revision`, `savedVersion`, `hasActiveReviewLinks` and editor `url`. Create/update responses return the draft ID, new revision, editor URL and `saved: false`; saving is a separate operation. A save returns its immutable `version` and actual `visibility` (`private` or `shared`). A `revision_conflict` includes `currentRevision`; fetch the actual latest source before retrying. MCP operation errors have `isError: true` and structured error information. Read the connection's discovered schemas for exact current limits.

The minimal valid source and editing invariants are in the downloadable [draft-format reference](../server/assets/skills/signhere/references/draft-format.md). The list is bounded to the latest 100 drafts; this first contract does not provide search or pagination beyond that limit. Obtain another known draft by ID if needed. There are no MCP tools for key administration, sending or signing.

## Skill distribution and updates

Public files live on the same installation:

- `/skills/signhere/SKILL.md`
- `/skills/signhere/references/draft-format.md`
- `/skills/signhere/manifest.json`
- `/skills/signhere/CHANGELOG.md`
- `/skills/signhere/signhere.zip`

The manifest provides `version`, `compatibleApiVersions`, relative `skillUrl`, `packageUrl`, `changelogUrl`, `packageSha256`, and per-file `sha256`/`bytes`. Relative URLs resolve against the configured instance origin. The ZIP is deterministic, and digests describe the exact downloaded bytes; there is no hostname substitution. HTTPS and the configured instance establish the distribution trust boundary; the digest detects corruption or package/manifest mismatch, not compromise of that instance.

On active use, the skill asks an agent to check once per day if it can retain state, otherwise once per session. A bounded failed check does not block compatible work. A newer version prompts an update offer; it never installs automatically. After approval, the agent verifies the ZIP and per-file digests and replaces only the skill. Hosts that cannot fetch or write packages offer a manual download instead. Skill updates never change your key, connection or permissions.

For administrators: keep the existing configured public base URL accurate, terminate TLS normally, allow the MCP POST/GET transport through the reverse proxy, and do not rewrite bearer authorization headers. The existing cookie API's Origin checks stay in place. Revoke a compromised or unused key in Signhere; removing a connector from an agent host alone does not revoke the server-side credential.
