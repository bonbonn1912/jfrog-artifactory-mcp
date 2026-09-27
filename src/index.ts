import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolCallback } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { JFrogClient, encodePath, queryString, repoPath } from "./client.js";
import { loadConfig, type ServerConfig } from "./config.js";

function getConfig(): ServerConfig {
  try {
    return loadConfig();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`artifactory MCP configuration error: ${message}\n`);
    process.exit(1);
  }
}

const config = getConfig();
const artifactory = new JFrogClient(config.artifactoryBaseUrl, config.authorization, config.timeoutMs);
const xray = new JFrogClient(config.xrayBaseUrl, config.authorization, config.timeoutMs);

const server = new McpServer({ name: "artifactory", version: "0.1.0" });

type ToolHints = {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
};

function addTool<S extends z.ZodRawShape>(
  name: string,
  description: string,
  schema: z.ZodObject<S>,
  run: (args: z.infer<z.ZodObject<S>>) => Promise<unknown>,
  hints: ToolHints = { readOnlyHint: true, openWorldHint: true }
): void {
  const callback = async (rawArgs: unknown): Promise<CallToolResult> => {
    try {
      const output = await run(schema.parse(rawArgs));
      const text = typeof output === "string" ? output : JSON.stringify(output, null, 2) ?? "null";
      return { content: [{ type: "text", text }] };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { content: [{ type: "text", text: message }], isError: true };
    }
  };
  server.registerTool(
    name,
    { description, inputSchema: schema.shape, annotations: hints },
    // The callback validates unknown input with this exact schema before invoking the handler.
    callback as ToolCallback<S>
  );
}

const empty = z.object({});
const repoKeySchema = z.string().min(1)
  .refine((value) => !/[\\/]/.test(value) && value !== "." && value !== "..", "Repository keys must be a single path segment.")
  .describe("Artifactory repository key.");
const repoPathSchema = z.object({
  repoKey: repoKeySchema,
  path: z.string().default("").describe("Path within the repository; empty means the repository root.")
});
const pageSchema = {
  page: z.number().int().positive().optional().describe("1-based page number."),
  pageSize: z.number().int().min(1).max(500).optional().describe("Maximum items to return (up to 500).")
};
const queryObject = z.record(z.string(), z.unknown());

function pathOfRepoPath(args: { repoKey: string; path: string }): string {
  return `/api/storage/${repoPath(args.repoKey, args.path)}`;
}

function propertyString(properties: Record<string, string | string[]>): string {
  return Object.entries(properties)
    .map(([key, value]) => `${key}=${Array.isArray(value) ? value.join(",") : value}`)
    .join(";");
}

// System
addTool("ping", "Check that the Artifactory service is responding (SaaS or self-managed).", empty, async () =>
  artifactory.requestText("/api/system/ping"));
addTool("get_system_info", "Get Artifactory system information, including service and node details.", empty, async () =>
  artifactory.request("/api/system/info"));
addTool("get_version", "Get the Artifactory version and revision.", empty, async () =>
  artifactory.request("/api/system/version"));
addTool("get_health", "Check Artifactory service health. Uses the Artifactory ping API, which works with SaaS and self-managed installations.", empty, async () =>
  ({ healthy: (await artifactory.requestText("/api/system/ping")).trim() === "OK", check: "artifactory-api-ping" }));
addTool("list_nodes", "List nodes in a self-managed Artifactory cluster. This cluster-management endpoint may be unavailable on SaaS.", empty, async () =>
  artifactory.request("/api/system/nodes"));
addTool("get_node_status", "Find one node by ID or name in a self-managed Artifactory cluster. This endpoint may be unavailable on SaaS.", z.object({ nodeId: z.string().min(1) }), async ({ nodeId }) => {
  const result = await artifactory.request("/api/system/nodes");
  const nodes = Array.isArray(result)
    ? result
    : result && typeof result === "object" && Array.isArray((result as { nodes?: unknown[] }).nodes)
      ? (result as { nodes: unknown[] }).nodes
      : undefined;
  if (!nodes) return result;
  const node = nodes.find((candidate) => {
    if (!candidate || typeof candidate !== "object") return false;
    const details = candidate as Record<string, unknown>;
    return [details.nodeId, details.id, details.name, details.nodeName].some((value) => String(value ?? "") === nodeId);
  });
  if (!node) throw new Error(`Node '${nodeId}' was not present in the cluster node list.`);
  return node;
});

// Repositories
addTool("list_repositories", "List repositories, optionally filtered by type, package type, or project.", z.object({
  type: z.enum(["local", "remote", "virtual", "federated", "distribution"]).optional(),
  packageType: z.string().optional(),
  project: z.string().optional()
}), async ({ type, packageType, project }) => artifactory.request("/api/repositories", {
  query: { type, packageType, project }
}));
addTool("get_repository", "Get the complete configuration for a repository key.", z.object({ repoKey: repoKeySchema }), async ({ repoKey }) =>
  artifactory.request(`/api/repositories/${encodeURIComponent(repoKey)}`));
addTool("create_repository", "Create a repository from an Artifactory repository configuration JSON object. Requires admin privileges.", z.object({
  repoKey: repoKeySchema,
  configuration: queryObject.describe("Repository configuration object accepted by the Artifactory REST API.")
}), async ({ repoKey, configuration }) => artifactory.request(`/api/repositories/${encodeURIComponent(repoKey)}`, {
  method: "PUT", body: configuration
}), { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true });
addTool("update_repository", "Update a repository configuration with the supplied Artifactory JSON fields. Requires admin privileges.", z.object({
  repoKey: repoKeySchema,
  configuration: queryObject
}), async ({ repoKey, configuration }) => artifactory.request(`/api/repositories/${encodeURIComponent(repoKey)}`, {
  method: "POST", body: configuration
}), { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true });
addTool("delete_repository", "Permanently delete a repository and its contents. Requires admin privileges.", z.object({ repoKey: repoKeySchema }), async ({ repoKey }) =>
  artifactory.request(`/api/repositories/${encodeURIComponent(repoKey)}`, { method: "DELETE" }),
{ readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true });

// Artifacts and storage
addTool("list_artifacts", "List files and folders below a repository path using Artifactory's storage listing API.", z.object({
  ...repoPathSchema.shape,
  deep: z.boolean().default(false),
  depth: z.number().int().min(1).max(10).optional(),
  listFolders: z.boolean().default(true)
}), async ({ repoKey, path, deep, depth, listFolders }) => artifactory.request(pathOfRepoPath({ repoKey, path }), {
  query: { list: "", deep: deep ? 1 : 0, depth, listFolders: listFolders ? 1 : 0 }
}));
addTool("get_artifact", "Get storage information for one artifact path, including checksums and download URI.", repoPathSchema, async ({ repoKey, path }) => {
  if (!path) throw new Error("path must identify an artifact within the repository.");
  return artifactory.request(pathOfRepoPath({ repoKey, path }));
});
addTool("get_artifact_metadata", "Get artifact metadata, properties, and download statistics for one path.", repoPathSchema, async ({ repoKey, path }) => {
  if (!path) throw new Error("path must identify an artifact within the repository.");
  return artifactory.request(pathOfRepoPath({ repoKey, path }), { query: { stats: "", properties: "" } });
});
addTool("download_artifact", "Download an artifact and return its base64 content. Limited to 2 MiB to keep MCP responses manageable.", repoPathSchema, async ({ repoKey, path }) => {
  if (!path) throw new Error("path must identify an artifact within the repository.");
  const bytes = await artifactory.requestBinary(`/${repoPath(repoKey, path)}`, 2 * 1024 * 1024, { accept: "application/octet-stream" });
  return { repoKey, path, sizeBytes: bytes.byteLength, encoding: "base64", content: bytes.toString("base64") };
});
addTool("upload_artifact", "Upload base64-encoded content to a repository path. Limited to 5 MiB.", z.object({
  repoKey: repoKeySchema,
  path: z.string().min(1),
  contentBase64: z.string().min(1),
  contentType: z.string().default("application/octet-stream")
}), async ({ repoKey, path, contentBase64, contentType }) => {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}(?:==)?|[A-Za-z0-9+/]{3}=?|[A-Za-z0-9+/]{4})?$/.test(contentBase64)) {
    throw new Error("contentBase64 is not valid base64 data.");
  }
  const bytes = Buffer.from(contentBase64, "base64");
  if (bytes.byteLength > 5 * 1024 * 1024) throw new Error("Upload exceeds the 5 MiB MCP limit.");
  if (bytes.byteLength === 0) throw new Error("contentBase64 must contain valid, non-empty base64 data.");
  return artifactory.request(`/${repoPath(repoKey, path)}`, { method: "PUT", body: bytes, contentType });
}, { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true });
addTool("copy_artifact", "Copy an artifact or folder to another repository path.", z.object({
  repoKey: repoKeySchema,
  path: z.string().min(1),
  targetRepoKey: repoKeySchema,
  targetPath: z.string().min(1)
}), async ({ repoKey, path, targetRepoKey, targetPath }) => artifactory.request(`/api/copy/${repoPath(repoKey, path)}`, {
  method: "POST", query: { to: `/${repoPath(targetRepoKey, targetPath)}` }
}), { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true });
addTool("move_artifact", "Move an artifact or folder to another repository path; the source path is removed.", z.object({
  repoKey: repoKeySchema,
  path: z.string().min(1),
  targetRepoKey: repoKeySchema,
  targetPath: z.string().min(1)
}), async ({ repoKey, path, targetRepoKey, targetPath }) => artifactory.request(`/api/move/${repoPath(repoKey, path)}`, {
  method: "POST", query: { to: `/${repoPath(targetRepoKey, targetPath)}` }
}), { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true });
addTool("delete_artifact", "Permanently delete an artifact or folder path from a repository.", z.object({ repoKey: repoKeySchema, path: z.string().min(1) }), async ({ repoKey, path }) =>
  artifactory.request(`/${repoPath(repoKey, path)}`, { method: "DELETE" }),
{ readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true });

// Search
addTool("search_artifacts", "Search artifact names through Artifactory's simple artifact search API.", z.object({
  name: z.string().min(1),
  repos: z.array(z.string()).optional()
}), async ({ name, repos }) => artifactory.request("/api/search/artifact", { query: { name, repos } }));
addTool("execute_aql", "Run a read-only Artifactory Query Language (AQL) query. The query is sent as text/plain.", z.object({
  query: z.string().min(1).max(6000).describe("AQL query, for example items.find({\"repo\":\"libs-release-local\"}).include(\"name\",\"path\")")
}), async ({ query }) => artifactory.request("/api/search/aql", { method: "POST", body: query, contentType: "text/plain" }));

// Properties
addTool("get_properties", "Get properties attached to an artifact or folder.", repoPathSchema, async ({ repoKey, path }) =>
  artifactory.request(pathOfRepoPath({ repoKey, path }), { query: { properties: "" } }));
addTool("set_properties", "Set or replace properties on an artifact or folder.", z.object({
  ...repoPathSchema.shape,
  properties: z.record(z.string(), z.union([z.string(), z.array(z.string())]))
}), async ({ repoKey, path, properties }) => artifactory.request(`/api/metadata/${repoPath(repoKey, path)}${queryString({ properties: propertyString(properties) })}`, {
  method: "PUT"
}), { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true });
addTool("delete_properties", "Delete selected properties from an artifact or folder.", z.object({
  ...repoPathSchema.shape,
  properties: z.array(z.string()).min(1)
}), async ({ repoKey, path, properties }) => artifactory.request(`/api/metadata/${repoPath(repoKey, path)}${queryString({ properties: properties.join(",") })}`, {
  method: "DELETE"
}), { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true });

// Packages
addTool("list_packages", "List packages of a package type, optionally filtered by name and paginated.", z.object({
  packageType: z.string().min(1),
  name: z.string().optional(),
  ...pageSchema
}), async ({ packageType, name, page, pageSize }) => artifactory.request(`/api/packages/${encodeURIComponent(packageType)}`, {
  query: { name, page, page_size: pageSize }
}));
addTool("get_package", "Get package details by package type and name.", z.object({ packageType: z.string().min(1), packageName: z.string().min(1) }), async ({ packageType, packageName }) =>
  artifactory.request(`/api/packages/${encodeURIComponent(packageType)}/${encodeURIComponent(packageName)}`));
addTool("list_package_versions", "List versions for a package, with optional pagination.", z.object({
  packageType: z.string().min(1), packageName: z.string().min(1), ...pageSchema
}), async ({ packageType, packageName, page, pageSize }) => artifactory.request(`/api/packages/${encodeURIComponent(packageType)}/${encodeURIComponent(packageName)}/versions`, {
  query: { page, page_size: pageSize }
}));
addTool("get_package_version", "Get metadata for one package version.", z.object({
  packageType: z.string().min(1), packageName: z.string().min(1), version: z.string().min(1)
}), async ({ packageType, packageName, version }) => artifactory.request(`/api/packages/${encodeURIComponent(packageType)}/${encodeURIComponent(packageName)}/versions/${encodeURIComponent(version)}`));

// Docker / OCI
addTool("list_docker_images", "List Docker/OCI image manifests in a repository using AQL.", z.object({
  repoKey: repoKeySchema,
  namePattern: z.string().default("manifest.json")
}), async ({ repoKey, namePattern }) => {
  const query = `items.find({"$and":[{"repo":${JSON.stringify(repoKey)}},{"name":{"$match":${JSON.stringify(namePattern)}}}]}).include("repo","path","name","created","size","sha256").sort({"$desc":["created"]}).limit(500)`;
  return artifactory.request("/api/search/aql", { method: "POST", body: query, contentType: "text/plain" });
});
addTool("list_docker_tags", "List tags for a Docker/OCI image in an Artifactory repository.", z.object({
  repoKey: repoKeySchema,
  image: z.string().min(1)
}), async ({ repoKey, image }) => artifactory.request(`/api/docker/${encodeURIComponent(repoKey)}/v2/${encodePath(image)}/tags/list`));
addTool("get_docker_manifest", "Get the Docker/OCI manifest for an image tag.", z.object({
  repoKey: repoKeySchema,
  image: z.string().min(1),
  tag: z.string().min(1)
}), async ({ repoKey, image, tag }) => artifactory.request(`/api/docker/${encodeURIComponent(repoKey)}/v2/${encodePath(image)}/manifests/${encodeURIComponent(tag)}`, {
  accept: "application/vnd.docker.distribution.manifest.v2+json, application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.list.v2+json"
}));

// Builds
addTool("list_builds", "List build names in Artifactory, optionally scoped to a project.", z.object({ project: z.string().optional() }), async ({ project }) =>
  artifactory.request("/api/build", { query: { project } }));
addTool("get_build", "List available numbers and timestamps for one build name.", z.object({ buildName: z.string().min(1), project: z.string().optional() }), async ({ buildName, project }) =>
  artifactory.request(`/api/build/${encodeURIComponent(buildName)}`, { query: { project } }));
addTool("get_build_info", "Get full build-info JSON for a build name and number.", z.object({
  buildName: z.string().min(1), buildNumber: z.string().min(1), project: z.string().optional()
}), async ({ buildName, buildNumber, project }) => artifactory.request(`/api/build/${encodeURIComponent(buildName)}/${encodeURIComponent(buildNumber)}`, { query: { project } }));
addTool("get_build_artifacts", "Get the artifact modules from build-info for a build name and number.", z.object({
  buildName: z.string().min(1), buildNumber: z.string().min(1), project: z.string().optional()
}), async ({ buildName, buildNumber, project }) => {
  const build = await artifactory.request(`/api/build/${encodeURIComponent(buildName)}/${encodeURIComponent(buildNumber)}`, { query: { project } });
  if (!build || typeof build !== "object") return build;
  return (build as { buildInfo?: { modules?: unknown[] } }).buildInfo?.modules?.map((module) => {
    if (!module || typeof module !== "object") return module;
    const typed = module as Record<string, unknown>;
    return { id: typed.id, artifacts: typed.artifacts };
  }) ?? [];
});
addTool("get_build_dependencies", "Get dependency modules from build-info for a build name and number.", z.object({
  buildName: z.string().min(1), buildNumber: z.string().min(1), project: z.string().optional()
}), async ({ buildName, buildNumber, project }) => {
  const build = await artifactory.request(`/api/build/${encodeURIComponent(buildName)}/${encodeURIComponent(buildNumber)}`, { query: { project } });
  if (!build || typeof build !== "object") return build;
  return (build as { buildInfo?: { modules?: unknown[] } }).buildInfo?.modules?.map((module) => {
    if (!module || typeof module !== "object") return module;
    const typed = module as Record<string, unknown>;
    return { id: typed.id, dependencies: typed.dependencies };
  }) ?? [];
});
addTool("publish_build_info", "Publish or replace build-info JSON in Artifactory.", z.object({
  buildInfo: queryObject,
  project: z.string().optional()
}), async ({ buildInfo, project }) => artifactory.request("/api/build", {
  method: "PUT", query: { project }, body: buildInfo
}), { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true });
addTool("promote_build", "Promote a published build to another repository or status. Review options carefully; promotion may copy or move artifacts.", z.object({
  buildName: z.string().min(1), buildNumber: z.string().min(1),
  targetRepo: z.string().min(1), status: z.string().optional(), comment: z.string().optional(),
  copy: z.boolean().default(true), failFast: z.boolean().default(true), project: z.string().optional()
}), async ({ buildName, buildNumber, targetRepo, status, comment, copy, failFast, project }) => artifactory.request(
  `/api/build/promote/${encodeURIComponent(buildName)}/${encodeURIComponent(buildNumber)}`,
  { method: "POST", query: { project }, body: { targetRepo, status, comment, copy, failFast } }
), { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true });

// Security
addTool("list_users", "List Artifactory users. The authenticated user must have permission to view users.", empty, async () =>
  artifactory.request("/api/security/users"));
addTool("list_groups", "List Artifactory groups.", empty, async () =>
  artifactory.request("/api/security/groups"));
addTool("get_permissions", "List Artifactory permission targets.", empty, async () =>
  artifactory.request("/api/security/permissions"));
addTool("get_permission_target", "Get one Artifactory permission target by name.", z.object({ name: z.string().min(1) }), async ({ name }) =>
  artifactory.request(`/api/security/permissions/${encodeURIComponent(name)}`));

// Xray on the same self-managed JPD (can be overridden with XRAY_URL)
addTool("get_artifact_scan", "Get Xray security, license, and operational-risk summary for an artifact path or checksum.", z.object({
  paths: z.array(z.string()).optional().describe("Artifactory paths prefixed with the Xray Artifactory ID, for example default/artifactory/repo/path/file.jar."),
  checksums: z.array(z.string()).optional().describe("Artifact SHA-256 or SHA-1 checksums.")
}), async ({ paths, checksums }) => {
  if (!paths?.length && !checksums?.length) throw new Error("Provide at least one artifact path or checksum.");
  return xray.request("/api/v2/summary/artifact", { method: "POST", body: { paths, checksums } });
});
addTool("get_build_scan", "Get Xray security summary for an Artifactory build.", z.object({
  buildName: z.string().min(1), buildNumber: z.string().min(1), buildRepo: z.string().optional(), projectKey: z.string().optional()
}), async ({ buildName, buildNumber, buildRepo, projectKey }) => xray.request("/api/v2/summary/build", {
  query: { build_name: buildName, build_number: buildNumber, build_repo: buildRepo, project_key: projectKey }
}));
addTool("get_vulnerabilities", "Search Xray violations, including vulnerability findings, with Xray filters and pagination.", z.object({
  filters: queryObject.default({}),
  pagination: queryObject.default({}),
  projectKey: z.string().optional()
}), async ({ filters, pagination, projectKey }) => xray.request("/api/v1/violations", {
  method: "POST", query: { projectKey }, body: { filters, pagination }
}));
addTool("get_policy_violations", "Search Xray policy violations. Supply filters such as watch_name, violation_type, or CVE criteria.", z.object({
  filters: queryObject.default({}),
  pagination: queryObject.default({}),
  projectKey: z.string().optional()
}), async ({ filters, pagination, projectKey }) => xray.request("/api/v1/violations", {
  method: "POST", query: { projectKey }, body: { filters, pagination }
}));

// Administration
addTool("get_storage_info", "Get Artifactory storage summary information for binaries, filestore, and repositories.", empty, async () =>
  artifactory.request("/api/storageinfo"));
addTool("get_cluster_status", "Get cluster status and node information on self-managed Artifactory. This endpoint may be unavailable on SaaS.", empty, async () =>
  artifactory.request("/api/system/cluster"));
addTool("get_configuration", "Get the Artifactory configuration descriptor on self-managed installations. This endpoint is not available on SaaS.", empty, async () =>
  artifactory.request("/api/system/configuration"));

// Operations
addTool("find_cleanup_candidates", "Find old artifacts with no recorded downloads. Results are suggestions only; this tool never deletes data.", z.object({
  repoKey: repoKeySchema.optional(),
  olderThanDays: z.number().int().min(30).max(3650).default(180),
  limit: z.number().int().min(1).max(500).default(100)
}), async ({ repoKey, olderThanDays, limit }) => {
  const cutoff = new Date(Date.now() - olderThanDays * 86_400_000).toISOString();
  const criteria: Record<string, unknown>[] = [
    { created: { $lt: cutoff } },
    { "stat.downloads": { $eq: 0 } }
  ];
  if (repoKey) criteria.push({ repo: repoKey });
  const query = `items.find({"$and":${JSON.stringify(criteria)}}).include("repo","path","name","created","size","stat.downloads","stat.downloaded").sort({"$asc":["created"]}).limit(${limit})`;
  return artifactory.request("/api/search/aql", { method: "POST", body: query, contentType: "text/plain" });
});
addTool("get_replication_status", "Get replication configuration and scheduled status for one repository.", z.object({ repoKey: repoKeySchema }), async ({ repoKey }) =>
  artifactory.request(`/api/replications/${encodeURIComponent(repoKey)}/status`));

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`artifactory MCP startup failed: ${message}\n`);
  process.exitCode = 1;
});
