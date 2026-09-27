export interface ServerConfig {
  artifactoryBaseUrl: string;
  platformBaseUrl: string;
  xrayBaseUrl: string;
  authorization: string;
  timeoutMs: number;
}

function normalizeUrl(value: string, name: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${name} must be a valid absolute URL, for example https://acme.jfrog.io/artifactory or https://artifactory.example.internal/artifactory`);
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`${name} must use http or https`);
  }
  if (parsed.username || parsed.password) {
    throw new Error(`${name} must not contain credentials; configure authentication through environment variables`);
  }
  if (parsed.search || parsed.hash) {
    throw new Error(`${name} must not contain a query string or fragment`);
  }

  return parsed.toString().replace(/\/$/, "");
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const rawUrl = env.ARTIFACTORY_URL?.trim();
  if (!rawUrl) {
    throw new Error("Set ARTIFACTORY_URL to your Artifactory SaaS or self-managed base URL, for example https://acme.jfrog.io/artifactory.");
  }

  const suppliedBase = normalizeUrl(rawUrl, "ARTIFACTORY_URL");
  const artifactoryBaseUrl = suppliedBase.endsWith("/artifactory")
    ? suppliedBase
    : `${suppliedBase}/artifactory`;
  const platformBaseUrl = artifactoryBaseUrl.slice(0, -"/artifactory".length);
  const xrayBaseUrl = normalizeUrl(env.XRAY_URL?.trim() || `${platformBaseUrl}/xray`, "XRAY_URL");

  const token = env.ARTIFACTORY_ACCESS_TOKEN?.trim();
  const username = env.ARTIFACTORY_USERNAME;
  const password = env.ARTIFACTORY_PASSWORD;
  if (token) {
    return {
      artifactoryBaseUrl,
      platformBaseUrl,
      xrayBaseUrl,
      authorization: `Bearer ${token}`,
      timeoutMs: parseTimeout(env.ARTIFACTORY_TIMEOUT_MS)
    };
  }
  if (username && password) {
    const encodedCredentials = Buffer.from(`${username}:${password}`).toString("base64");
    return {
      artifactoryBaseUrl,
      platformBaseUrl,
      xrayBaseUrl,
      authorization: `Basic ${encodedCredentials}`,
      timeoutMs: parseTimeout(env.ARTIFACTORY_TIMEOUT_MS)
    };
  }

  throw new Error("Set ARTIFACTORY_ACCESS_TOKEN or both ARTIFACTORY_USERNAME and ARTIFACTORY_PASSWORD.");
}

function parseTimeout(raw: string | undefined): number {
  if (!raw) return 30_000;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1_000 || value > 300_000) {
    throw new Error("ARTIFACTORY_TIMEOUT_MS must be an integer between 1000 and 300000.");
  }
  return value;
}
