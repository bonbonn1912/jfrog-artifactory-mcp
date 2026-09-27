# Artifactory MCP for Gemini CLI

A local Model Context Protocol server that exposes the tools listed in [`tools.md`](./tools.md) to Gemini CLI. It supports JFrog Artifactory SaaS and self-managed installations, including Data Center/HA. Xray tools use the same JPD's `/xray` service by default and can be pointed at another Xray URL with `XRAY_URL`.

The server uses MCP `stdio`, so Gemini CLI starts it as a child process. API traffic goes directly from this process to your Artifactory installation.

## Requirements

- Node.js 20.11 or later
- An Artifactory URL, such as `https://acme.jfrog.io/artifactory` (SaaS) or `https://artifactory.example.internal/artifactory` (self-managed)
- A JFrog access token, or a username and password with the permissions required by the tools you use

## Build

```sh
npm install
npm run build
```

## Configure Gemini CLI

Set `ARTIFACTORY_URL` and credentials in the environment available to Gemini CLI. For a token:

```sh
export ARTIFACTORY_URL="https://acme.jfrog.io/artifactory"
export ARTIFACTORY_ACCESS_TOKEN="<access-token>"
```

Copy [`gemini-cli-settings.example.json`](./gemini-cli-settings.example.json) into your Gemini CLI settings (usually `~/.gemini/settings.json`), replace the example absolute path with this checkout's `dist/index.js` path, and keep `trust` set to `false` so Gemini asks before invoking tools. The example uses Gemini CLI environment-variable expansion for the token.

Alternatively configure Basic authentication with `ARTIFACTORY_USERNAME` and `ARTIFACTORY_PASSWORD`. Do not commit tokens or passwords to settings files.

Optional environment variables:

| Variable | Default | Description |
| --- | --- | --- |
| `XRAY_URL` | `<platform-base>/xray` | Xray service base URL |
| `ARTIFACTORY_TIMEOUT_MS` | `30000` | Request timeout, from 1,000 to 300,000 ms |

`ARTIFACTORY_URL` can be the Artifactory context URL or the JFrog Platform origin; `/artifactory` is appended when it is not present. Credentials are sent only to the configured services. HTTP redirects are not followed.

## Tool behavior and limits

- Tool names match `tools.md`.
- Repository, artifact, build, and Xray tools call the corresponding Artifactory/Xray REST APIs. Permissions are enforced by Artifactory and Xray.
- `download_artifact` returns base64 data up to 2 MiB. `upload_artifact` accepts base64 data up to 5 MiB.
- `find_cleanup_candidates` only returns AQL matches; it does not delete artifacts.
- Mutating and destructive tools are annotated for MCP clients. Repository deletion, artifact deletion, movement, and property deletion are destructive.
- `get_artifact_scan` and `get_build_scan` read the Xray v2 summary APIs. `get_vulnerabilities` and `get_policy_violations` use Xray's violations search API and accept its filters/pagination objects.

## SaaS and self-managed compatibility

The server accepts both SaaS URLs (for example, `https://acme.jfrog.io`) and self-managed URLs. The `get_health` tool uses Artifactory's `/api/system/ping`, which supports both deployment types. Cluster/node details and the system configuration descriptor are self-managed administration APIs and may be unavailable on SaaS. Other capabilities depend on the Artifactory/Xray version, license, configuration, and the credentials' permissions; the tool returns the service's HTTP error when an API is unavailable.
