export type QueryValue = string | number | boolean | undefined | string[];

export interface RequestOptions {
  method?: string;
  query?: Record<string, QueryValue>;
  body?: unknown;
  contentType?: string;
  accept?: string;
}

export class JFrogClient {
  constructor(
    private readonly baseUrl: string,
    private readonly authorization: string,
    private readonly timeoutMs: number
  ) {}

  async request(path: string, options: RequestOptions = {}): Promise<unknown> {
    const response = await this.fetch(path, options);
    const text = await response.text();
    if (!text) return { status: response.status };
    try {
      return JSON.parse(text) as unknown;
    } catch {
      return text;
    }
  }

  async requestText(path: string, options: RequestOptions = {}): Promise<string> {
    const response = await this.fetch(path, options);
    return response.text();
  }

  async requestBinary(path: string, maxBytes: number, options: RequestOptions = {}): Promise<Buffer> {
    const response = await this.fetch(path, options);
    const declaredSize = Number(response.headers.get("content-length") ?? "0");
    if (declaredSize > maxBytes) {
      throw new Error(`The response is ${declaredSize} bytes; the MCP download limit is ${maxBytes} bytes.`);
    }
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.byteLength > maxBytes) {
      throw new Error(`The response is ${bytes.byteLength} bytes; the MCP download limit is ${maxBytes} bytes.`);
    }
    return bytes;
  }

  private async fetch(path: string, options: RequestOptions): Promise<Response> {
    const url = new URL(path.replace(/^\//, ""), `${this.baseUrl}/`);
    for (const [key, value] of Object.entries(options.query ?? {})) {
      if (value === undefined) continue;
      if (Array.isArray(value)) {
        for (const item of value) url.searchParams.append(key, item);
      } else {
        url.searchParams.set(key, String(value));
      }
    }

    const headers = new Headers({
      Authorization: this.authorization,
      Accept: options.accept ?? "application/json"
    });
    if (options.contentType) headers.set("Content-Type", options.contentType);
    else if (options.body !== undefined) headers.set("Content-Type", "application/json");

    let body: BodyInit | undefined;
    if (options.body !== undefined) {
      if (typeof options.body === "string" || options.body instanceof Blob || options.body instanceof ArrayBuffer) {
        body = options.body;
      } else if (ArrayBuffer.isView(options.body)) {
        body = options.body as BodyInit;
      } else {
        body = JSON.stringify(options.body);
      }
    }

    let response: Response;
    try {
      const requestInit: RequestInit = {
        method: options.method ?? "GET",
        headers,
        signal: AbortSignal.timeout(this.timeoutMs),
        redirect: "manual"
      };
      if (body !== undefined) requestInit.body = body;
      response = await fetch(url, requestInit);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`Request to ${url.pathname} failed: ${detail}`);
    }

    if (!response.ok) {
      const detail = (await response.text()).slice(0, 1_200);
      const suffix = detail ? `: ${detail}` : "";
      throw new Error(`JFrog returned HTTP ${response.status} for ${options.method ?? "GET"} ${url.pathname}${suffix}`);
    }
    return response;
  }
}

export function repoPath(repoKey: string, path = ""): string {
  if (!repoKey || repoKey.includes("/") || repoKey === "." || repoKey === "..") {
    throw new Error("repoKey must be a single repository key without slashes.");
  }
  const segments = path.replace(/^\/+|\/+$/g, "").split("/").filter(Boolean);
  if (segments.some((segment) => segment === "." || segment === ".." || segment.includes("\\"))) {
    throw new Error("Artifact paths must not contain traversal segments or backslashes.");
  }
  return [repoKey, ...segments].map(encodeURIComponent).join("/");
}

export function queryString(values: Record<string, QueryValue>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (const item of value) params.append(key, item);
    } else {
      params.set(key, String(value));
    }
  }
  const text = params.toString();
  return text ? `?${text}` : "";
}

export function encodePath(value: string): string {
  return value.split("/").map(encodeURIComponent).join("/");
}
