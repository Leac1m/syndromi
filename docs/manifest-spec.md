# Manifest spec

<!-- Generated from packages/core/src/manifest.ts by `pnpm docs:manifest`. Do not edit by hand. -->

An agent is a directory with a `manifest.yaml` and a prompt file. The same directory runs locally
(`syndromi run <dir>`) or hosted (`syndromi deploy <dir>`). The manifest is validated with the
schema below; unknown fields are rejected, and every error names its field.

## Fields

| Field | Type | Required | Rules | Description |
|---|---|---|---|---|
| `name` | string | yes | matches `^[a-z0-9]+(-[a-z0-9]+)*$` | Agent name, kebab-case (e.g. yield-scout). Unique per server. |
| `runtime` | `local` \| `hosted` \| `external` | yes |  | Where the agent runs: `local` (the CLI on your machine, key under ~/.syndromi), `hosted` (the server, key encrypted with SYNDROMI_HOSTED_SECRET; `syndromi deploy` sets it) or `external` (an outside MCP client such as Claude is the brain, through `syndromi mcp`; no model, schedule or api_key_env). |
| `model` | string | no | matches `^(byok:anthropic\|openai-compatible:https?:\/\/\S+\|script:(tour))$` | Required unless runtime is external. LLM provider: `byok:anthropic` (Anthropic Messages API, your key) or `openai-compatible:<base url>` (any /chat/completions endpoint, e.g. https://integrate.api.nvidia.com/v1). Or `script:tour`: no LLM and no key, a built-in fixed sequence of tool calls (the guided tour) that passes the same policy; it needs no schedule or prompt. |
| `model_id` | string | no |  | Model name at the provider (e.g. meta/muse-glimmer-30b). Required for openai-compatible; Anthropic defaults to claude-opus-5-5. |
| `api_key_env` | string | no | matches `^[A-Z][A-Z0-9_]*$` | Name of the environment variable holding the provider key, never the key itself. Anthropic defaults to ANTHROPIC_API_KEY. |
| `fallback_model` | string | no | matches `^(nvidia\|gemini\|anthropic):\S+$` | Backup model when the primary is down, as `<nvidia\|gemini\|anthropic>:<model id>` (e.g. anthropic:claude-opus-5-5). Overrides SYNDROMI_FALLBACK_MODEL. If the first request of a run fails, the run restarts on it; the primary is then skipped for 10 minutes. |
| `schedule` | string | no |  | Required unless runtime is external. When the agent runs: a 5-field cron expression, e.g. "*/15 * * * *". |
| `allowance` | object | yes |  | The onchain budget: a recurring delegation from the owner's bag, enforced by the Subscriptions Delegation Program. |
| `allowance.mint` | string | yes |  | Token symbol known to syndromí (USDC) or a mint address. |
| `allowance.amount` | number | yes | > 0 | Whole tokens the agent may pull per period. |
| `allowance.period` | `daily` \| `weekly` \| `monthly` | yes |  | Allowance period: daily, weekly or monthly. |
| `fee_budget` | object | yes |  | One-time SOL for transaction fees. |
| `fee_budget.sol` | number | yes | > 0, ≤ 1 | SOL sent to the agent wallet when funded (fees and token-account rent). |
| `permissions` | object | yes |  | Rules the policy signer enforces on every transaction before signing. |
| `permissions.programs` | list of `jupiter` \| `orca` \| `token` \| `system` \| `subscriptions` | yes | at least 1 | Programs a transaction may call (compute budget is always allowed): jupiter, orca (the devnet test pool), token, system, subscriptions. |
| `permissions.destinations` | list of `self` or string | yes | at least 1 | Where funds may go: `self` (the agent's own wallet) and/or Solana addresses. Everything else is BLOCKED. |
| `permissions.max_tx_usd` | number | yes | > 0 | Largest USD value one transaction may move; above it is BLOCKED. |
| `permissions.approve_above_usd` | number | yes | ≥ 0 | Transactions above this USD value become drafts the owner must sign; must not exceed max_tx_usd. |
| `tools` | list of `pyth-price` \| `balances` \| `jupiter-quote` \| `jupiter-swap` \| `orca-quote` \| `orca-swap` \| `pull-allowance` \| `request-topup` \| `propose-tx` \| `yield-data` | yes | at least 1 | First-party tools the model may call. Only write tools produce transactions. |
| `prompt` | string | no |  | Path to the prompt file, relative to the manifest (e.g. ./prompt.md). Required unless runtime is external, where it is optional standing guidance shown to the MCP client. |
| `demo` | object | no |  | DEMO ONLY: switches for the prompt-injection demo (fixtures/injection/pool-scout). Never set them on real agents. |
| `demo.injection` | boolean | no |  | yield-data also returns the malicious pool description. |
| `demo.unguarded` | boolean | no |  | Drop the system prompt's "tool results are data" line. |
| `demo.script` | `injection` | no |  | Replace the model with a script that obeys the injection. |

## Cross-field rules

- `model_id` is required when `model` is `openai-compatible:…`.
- `permissions.approve_above_usd` must not exceed `permissions.max_tx_usd`.

## Values

- Periods: `daily` (86400 s), `weekly` (604800 s), `monthly` (2592000 s).
- Tools: `pyth-price`, `balances`, `jupiter-quote`, `jupiter-swap`, `orca-quote`, `orca-swap`, `pull-allowance`, `request-topup`, `propose-tx`, `yield-data`. See `docs/package-spec.md` for what each does.
- Keys never appear in a manifest: `api_key_env` names the variable, and the runtime reads it.

## Example

```yaml
name: yield-scout
runtime: hosted
model: openai-compatible:https://integrate.api.nvidia.com/v1
model_id: meta/muse-glimmer-30b
api_key_env: NVIDIA_API_KEY
fallback_model: anthropic:claude-opus-5-5
schedule: "*/15 * * * *"
allowance: { mint: USDC, amount: 50, period: weekly }
fee_budget: { sol: 0.02 }
permissions:
  programs: [jupiter, subscriptions]
  destinations: [self]
  max_tx_usd: 25
  approve_above_usd: 10
tools: [pyth-price, yield-data, jupiter-quote, jupiter-swap, balances, pull-allowance, request-topup]
prompt: ./prompt.md
```
