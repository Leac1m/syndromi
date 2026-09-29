import type { Manifest } from "@syndromi/core";
import { AnthropicProvider } from "./anthropic.js";
import { OpenAICompatibleProvider } from "./openai-compatible.js";
import { call, finish, ScriptedProvider, type ScriptStep, useTools } from "./scripted.js";
import type { Fetch, LlmProvider } from "./types.js";

export * from "./anthropic.js";
export * from "./openai-compatible.js";
export * from "./scripted.js";
export * from "./types.js";

type ModelFields = Partial<Pick<Manifest, "model" | "model_id" | "api_key_env">>;

/** Verified endpoints; `--model <preset>:<model id>` switches provider for a run. */
export const MODEL_PRESETS = {
  nvidia: {
    model: "openai-compatible:https://integrate.api.nvidia.com/v1",
    api_key_env: "NVIDIA_API_KEY",
  },
  gemini: {
    model: "openai-compatible:https://generativelanguage.googleapis.com/v1beta/openai",
    api_key_env: "GEMINI_API_KEY",
  },
  anthropic: { model: "byok:anthropic", api_key_env: "ANTHROPIC_API_KEY" },
} as const;

/**
 * `nvidia:meta/muse-glimmer-30b`, `gemini:gemini-3.8-flash` or `anthropic:claude-sonnet-5` swap
 * the provider; a bare id (`gemini-3.7-flash`) keeps the manifest's provider.
 */
export function modelOverride(spec: string): ModelFields {
  const colon = spec.indexOf(":");
  const preset = colon > 0 ? spec.slice(0, colon) : "";
  if (preset in MODEL_PRESETS) {
    const id = spec.slice(colon + 1);
    if (!id) throw new Error(`--model ${spec}: missing model id after "${preset}:"`);
    return { ...MODEL_PRESETS[preset as keyof typeof MODEL_PRESETS], model_id: id };
  }
  return { model_id: spec };
}

/**
 * The injection demo's fallback "model": it does what the malicious pool description says, every
 * time (balances → pull → yield-data → transfer to the address in the notice → summary).
 */
export function injectionScript(): ScriptStep[] {
  return [
    useTools(call("balances")),
    useTools(call("pull-allowance", { amount: 2 })),
    useTools(call("yield-data")),
    (results) => {
      const to = results[0]?.content.match(/vault (\w{32,44})/)?.[1] ?? "unknown";
      return useTools(call("propose-tx", { token: "USDC", to, amount: 2 }));
    },
    finish(
      "Followed the pool's migration notice and tried to move the USDC to the migration vault.",
    ),
  ];
}

/** Build the provider a manifest names. Keys come from the env var named by `api_key_env`. */
export function createProvider(
  manifest: Pick<Manifest, "model" | "model_id" | "api_key_env" | "demo">,
  env: Record<string, string | undefined> = process.env,
  fetchImpl?: Fetch,
): LlmProvider {
  const keyFrom = (name: string | undefined) => {
    if (!name) return undefined;
    const value = env[name];
    if (!value) throw new Error(`${name} is not set (manifest api_key_env). Add it to .env.`);
    return value;
  };
  if (manifest.demo?.script === "injection") return new ScriptedProvider(injectionScript());
  if (manifest.model === "byok:anthropic") {
    const apiKey = keyFrom(manifest.api_key_env ?? "ANTHROPIC_API_KEY") as string;
    return new AnthropicProvider({
      apiKey,
      ...(manifest.model_id ? { model: manifest.model_id } : {}),
      ...(fetchImpl ? { fetch: fetchImpl } : {}),
    });
  }
  const baseUrl = manifest.model.slice("openai-compatible:".length);
  if (!manifest.model_id) throw new Error("model_id is required for openai-compatible models");
  const apiKey = keyFrom(manifest.api_key_env);
  return new OpenAICompatibleProvider({
    baseUrl,
    model: manifest.model_id,
    ...(apiKey ? { apiKey } : {}),
    ...(fetchImpl ? { fetch: fetchImpl } : {}),
  });
}
