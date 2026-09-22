const SECRET_KEY_PATTERN =
  /^(GITHUB_|GH_|MAOMAO_|UI_|WEBHOOK_|.*PRIVATE_KEY.*|.*_SECRET.*|.*_TOKEN$|INSTALLATION_)/i;

const PROVIDER_ALLOWLIST = [
  /^OPENAI_/i,
  /^ANTHROPIC_/i,
  /^OPENROUTER_/i,
  /^GOOGLE_/i,
  /^GEMINI_/i,
  /^XAI_/i,
  /^MISTRAL_/i,
  /^GROQ_/i,
  /^TOGETHER_/i,
  /^DEEPSEEK_/i,
  /^COHERE_/i,
  /^AZURE_/i,
  /^ZHIPU_/i,
  /^ZAI_/i,
  // Broad cloud prefixes so documented BYO providers keep working. Do not run
  // Maomao on a host whose process env holds unrelated AWS/GCP/Bedrock creds.
  /^AWS_/i,
  /^BEDROCK_/i,
  /^VERTEX_/i,
  /^OLLAMA_/i,
  /^OPENCODE_/i,
  /^HTTP_PROXY$/i,
  /^HTTPS_PROXY$/i,
  /^NO_PROXY$/i,
  /^PATH$/i,
  /^HOME$/i,
  /^USER$/i,
  /^LANG$/i,
  /^LC_/i,
  /^TERM$/i,
  /^TMPDIR$/i,
  /^XDG_/i,
  /^SSL_/i,
  /^NODE_/i,
];

export const GITHUB_SECRET_KEYS = [
  "GITHUB_APP_PRIVATE_KEY",
  "GITHUB_APP_PRIVATE_KEY_PATH",
  "GITHUB_WEBHOOK_SECRET",
  "GITHUB_TOKEN",
  "GH_TOKEN",
  "GITHUB_APP_ID",
];

export function sanitizeChildEnv(
  parent: NodeJS.ProcessEnv = process.env,
  extras: Record<string, string | undefined> = {},
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    PATH: parent.PATH,
    HOME: parent.HOME,
    USER: parent.USER,
    LANG: parent.LANG,
    TERM: "dumb",
    TMPDIR: parent.TMPDIR,
  };

  for (const [key, value] of Object.entries(parent)) {
    if (value == null) continue;
    if (SECRET_KEY_PATTERN.test(key) && !key.startsWith("OPENCODE_")) continue;
    if (GITHUB_SECRET_KEYS.includes(key)) continue;
    if (PROVIDER_ALLOWLIST.some((pattern) => pattern.test(key))) {
      env[key] = value;
    }
  }

  // Never let OpenCode inherit Maomao GitHub credentials, even if allowlisted by accident.
  for (const key of GITHUB_SECRET_KEYS) {
    delete env[key];
  }
  delete env.GITHUB_APP_PRIVATE_KEY;
  delete env.GITHUB_WEBHOOK_SECRET;
  delete env.GITHUB_TOKEN;
  delete env.GH_TOKEN;

  for (const [key, value] of Object.entries(extras)) {
    if (value != null) env[key] = value;
  }
  return env;
}

// These denies are honored only if the OpenCode binary respects
// OPENCODE_PERMISSION / OPENCODE_CONFIG_CONTENT. Operators must pin a known-good
// OpenCode build; a malicious PR must not regain shell via ignored permissions.
export function reviewerPermissionConfig(): Record<string, unknown> {
  return {
    $schema: "https://opencode.ai/config.json",
    permission: {
      "*": "deny",
      read: "allow",
      glob: "allow",
      grep: "allow",
      bash: "deny",
      edit: "deny",
      write: "deny",
      webfetch: "deny",
      websearch: "deny",
      task: "deny",
      skill: "deny",
      question: "deny",
    },
  };
}
