# Prompt for Me

[中文](README.zh.md)

Prompt for Me (中文名：Prompt 嘴替) suggests the next message you may want to send from the DeepSeek Harness composer. It learns from bounded conversation history and your local suggestion interactions, but it never submits on your behalf.

## What it does

- Adds one Sparkles button to the composer action row.
- Uses the same Trigger for the whole flow: click the button or press `Mod+Shift+Space`.
- Streams complete candidates progressively: the first validated suggestion enters the draft immediately while the other two continue generating in the background.
- Cycles through the ready suggestions one by one. If the next candidate is still arriving, the same Trigger waits for it without starting a duplicate request.
- Requests a fresh batch after the current batch is exhausted. The new request excludes only the batch you just saw, so the flow can continue indefinitely without an ever-growing prompt.
- Writes the selected suggestion into the draft. Press Enter to send, edit it first, delete it, or Trigger again for another suggestion.
- Never bypasses Harness approvals, never invokes tools, and never sends a message automatically.

## Install

The release tarball is the simplest option because it contains prebuilt Host and Client artifacts:

```sh
dsh plugin --profile web add https://github.com/ChuanTianML/prompt-for-me/releases/download/v0.2.0/dsh-prompt-for-me-0.2.0.tgz
```

Restart `dsh web` after installation.

You may also install a pinned Git tag:

```sh
dsh plugin --profile web add github:ChuanTianML/prompt-for-me#v0.2.0
```

pnpm 10 may ask you to allow the package's `prepare` script for a Git install. Add `dsh-prompt-for-me: true` under `allowBuilds` in the Web profile's `pnpm-workspace.yaml`, then run the command again. The script only copies the checked-out Host files and wraps the checked-out Client factory; it performs no downloads.

Update or remove it with:

```sh
dsh plugin --profile web update dsh-prompt-for-me
dsh plugin --profile web remove dsh-prompt-for-me
```

## Model and API key

The plugin calls `ctx.llm` on the Harness Host. By default it reuses the current session's provider and model, falling back to the Harness default selection. The provider therefore uses the API key already configured in DeepSeek Harness. The browser never receives or reads that key, and this plugin has no separate key.

To pin an auxiliary model, set both `provider` and `model` in `cordis.patch.yml` or an overriding profile patch:

```yaml
- id: prompt-for-me
  name: dsh-prompt-for-me
  config:
    provider: deepseek-official
    model: deepseek-chat
```

## Data and privacy

On each generation request, the Host may send these bounded text fields to the selected model provider:

- the current draft;
- recent user and assistant text from the current session;
- recent direct user prompts from up to 20 earlier sessions;
- up to 50 local suggestion outcomes, such as “cycled”, “edited”, or “submitted-exact”;
- the candidates from the immediately previous batch, so they are not repeated.

Common API-key, token, password, and Bearer-token patterns are replaced with `[REDACTED_SECRET]` before the model call. Attachments, tool arguments, files, credentials, and binary blocks are not collected. The plugin has no analytics endpoint and sends data only to the model route already selected in Harness.

Suggestion outcomes are stored only in this browser's `localStorage` under `dsh.prompt-for-me.outcomes.v1`. Clear them in the browser console with:

```js
localStorage.removeItem('dsh.prompt-for-me.outcomes.v1')
```

DeepSeek Harness `0.1.0-rc.6` does not expose downstream registration for custom durable session-event types. For that reason, the standalone plugin does not append its auxiliary model request or outcomes to the Harness session log; doing so would make persisted sessions unreadable to the stock runtime. This is the main difference from the experimental in-tree implementation and will be revisited when a public event-registration API exists.

The generation RPC uses NDJSON. Each complete candidate is validated before it reaches the draft; partial model tokens and incomplete JSON never enter the composer. Hovering the Sparkles button shows only the current action and shortcut, such as `Generate next message (⌘⇧Space)` or `Try another (⌘⇧Space)`.

## Configuration

All generation limits are configurable in `cordis.patch.yml`:

| Field | Default | Meaning |
| --- | ---: | --- |
| `candidateCount` | `3` | Suggestions required per batch. |
| `maxCandidateBytes` | `4096` | UTF-8 limit per suggestion. |
| `maxDraftBytes` | `32768` | UTF-8 limit for a draft or edited outcome. |
| `maxCurrentContextBytes` | `65536` | JSON budget for current-session text. |
| `maxHistorySessions` | `20` | Earlier sessions inspected. |
| `maxHistoryMessages` | `100` | Earlier direct user prompts retained. |
| `maxHistoryBytes` | `65536` | JSON budget for earlier prompts. |
| `maxLocalOutcomes` | `50` | Browser-local suggestion outcomes retained. |
| `maxOutputTokens` | `2048` | Auxiliary model output budget. |
| `timeoutMs` | `30000` | Auxiliary model-call timeout. |
| `shortcut` | `Mod+Shift+Space` | Portable Trigger, or `disabled`. |

## Development

Requires Node.js 22.19 or newer.

```sh
npm run check
```

The command rebuilds the static Host/Client artifacts, runs the Node test suite, and verifies the npm package contents.

## License

MIT
