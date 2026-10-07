import { createHash } from "node:crypto";

// Credential discovery follows the pinned Pi SDK. This is not a model catalog:
// provider/model IDs and explicit models.json declarations remain caller-owned.
export const PI_CREDENTIAL_NAMES = Object.freeze([
  "OPENROUTER_API_KEY", "OPENAI_API_KEY", "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_OAUTH_TOKEN", "GEMINI_API_KEY", "GOOGLE_CLOUD_API_KEY", "XAI_API_KEY",
  "GROQ_API_KEY", "CEREBRAS_API_KEY", "MISTRAL_API_KEY", "DEEPSEEK_API_KEY",
  "NVIDIA_API_KEY", "AZURE_OPENAI_API_KEY", "AI_GATEWAY_API_KEY", "ZAI_API_KEY",
  "ZAI_CODING_CN_API_KEY", "MINIMAX_API_KEY", "MINIMAX_CN_API_KEY", "MOONSHOT_API_KEY",
  "HF_TOKEN", "FIREWORKS_API_KEY", "TOGETHER_API_KEY", "BASETEN_API_KEY", "OPENCODE_API_KEY",
  "KIMI_API_KEY", "META_API_KEY", "CLOUDFLARE_API_KEY", "XIAOMI_API_KEY",
  "XIAOMI_TOKEN_PLAN_CN_API_KEY", "XIAOMI_TOKEN_PLAN_AMS_API_KEY", "XIAOMI_TOKEN_PLAN_SGP_API_KEY",
  "ANT_LING_API_KEY", "QWEN_TOKEN_PLAN_API_KEY", "QWEN_TOKEN_PLAN_CN_API_KEY",
  "TYPESAFE_API_KEY", "RADIUS_API_KEY", "COPILOT_GITHUB_TOKEN", "AWS_BEARER_TOKEN_BEDROCK",
  "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN",
  "PAPERCLIP_PI_PROVIDERS",
]);

export function piProviderConfiguration(environment?: NodeJS.ProcessEnv): {
  json: string; digest: string; credentialNames: readonly string[];
} | undefined {
  const raw = environment?.PAPERCLIP_PI_PROVIDERS;
  if (raw === undefined) return undefined;
  const invalid = () => new Error("Pi custom providers require a bounded JSON object with explicit credentials; command-based credentials are unsupported");
  if (Buffer.byteLength(raw) > 64 * 1024) throw invalid();
  let providers: unknown;
  try { providers = JSON.parse(raw); } catch { throw invalid(); }
  if (!providers || typeof providers !== "object" || Array.isArray(providers)) throw invalid();
  const names = new Set<string>();
  const credential = (value: unknown) => {
    if (typeof value !== "string" || value.trimStart().startsWith("!")) throw invalid();
    if (/^[A-Z][A-Z0-9_]{0,127}$/.test(value)) {
      if (/^(?:PAPERCLIP_|NODE_|NPM_|npm_)/.test(value)
        || ["PATH", "HOME", "SHELL", "TMPDIR", "LD_PRELOAD", "DYLD_INSERT_LIBRARIES"].includes(value)) throw invalid();
      names.add(value);
    }
  };
  const inspect = (value: unknown, depth = 0): void => {
    if (depth > 16) throw invalid();
    if (!value || typeof value !== "object") return;
    for (const [key, child] of Object.entries(value)) {
      if (key === "apiKey") credential(child);
      else if (key === "headers") {
        if (!child || typeof child !== "object" || Array.isArray(child)) throw invalid();
        for (const header of Object.values(child)) credential(header);
      } else inspect(child, depth + 1);
    }
  };
  for (const provider of Object.values(providers)) {
    if (!provider || typeof provider !== "object" || Array.isArray(provider)) throw invalid();
    inspect(provider);
  }
  if (names.size > 64) throw invalid();
  const canonical = (value: unknown): string => value && typeof value === "object"
    ? Array.isArray(value) ? `[${value.map(canonical).join(",")}]`
      : `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(",")}}`
    : JSON.stringify(value);
  const json = `${canonical({ providers })}\n`;
  return { json, digest: `sha256:${createHash("sha256").update(json).digest("hex")}`, credentialNames: [...names] };
}

export function piCredentialNames(environment?: NodeJS.ProcessEnv): readonly string[] {
  return [...new Set([...PI_CREDENTIAL_NAMES, ...(piProviderConfiguration(environment)?.credentialNames ?? [])])];
}
