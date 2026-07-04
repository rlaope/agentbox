import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { HarnessSpec, McpServerConfig, RetryPolicy, RunStatus, SandboxKind, ToolPolicy, WorkspaceSpec } from '../types.js';
import { parseSimpleYaml } from './yaml.js';

/**
 * Markdown is the authoring format for the common case; HarnessSpec is the IR.
 * A harness file is Claude Code skill-shaped: YAML frontmatter for the spec
 * fields, markdown body as the system prompt.
 *
 *   ---
 *   name: ppt-generate
 *   backend: claude
 *   tools: { allow: [Read, Write, "Bash(node:*)"] }
 *   artifacts: [out/**\/*.pptx]
 *   limits: { maxTurns: 30, timeoutMs: 480000 }
 *   ---
 *   You are a presentation-generation harness. ...
 */

export interface HarnessMarkdownOptions {
  /** Name used when frontmatter has no `name` (typically the file basename) */
  defaultName?: string;
  /** Label used in error messages (typically the file path) */
  source?: string;
}

export function harnessFromMarkdown(content: string, opts: HarnessMarkdownOptions = {}): HarnessSpec {
  const source = opts.source ?? '<markdown>';
  const { frontmatter, body } = splitFrontmatter(content, source);

  let data: Record<string, unknown>;
  try {
    data = parseSimpleYaml(frontmatter);
  } catch (err) {
    throw new Error(`${source}: ${err instanceof Error ? err.message : String(err)}`);
  }

  const name = optionalString(data.name, 'name', source) ?? opts.defaultName;
  if (!name) {
    throw new Error(`${source}: harness needs a "name" in frontmatter (or a file name to derive it from)`);
  }
  const backend = optionalString(data.backend, 'backend', source);
  if (!backend) {
    throw new Error(`${source}: harness "${name}" needs a "backend" (pi | codex | claude)`);
  }

  const spec: HarnessSpec = { name, backend: backend as HarnessSpec['backend'] };

  const description = optionalString(data.description, 'description', source);
  if (description) spec.description = description;
  const model = optionalString(data.model, 'model', source);
  if (model) spec.model = model;
  const sandbox = optionalString(data.sandbox, 'sandbox', source);
  if (sandbox) spec.sandbox = sandbox as SandboxKind;

  const tools = normalizeTools(data.tools, source);
  if (tools) spec.tools = tools;
  const artifacts = normalizeArtifacts(data.artifacts, source);
  if (artifacts) spec.artifacts = artifacts;
  const limits = normalizeLimits(data.limits, source);
  if (limits) spec.limits = limits;
  const workspace = normalizeWorkspace(data.workspace, source);
  if (workspace) spec.workspace = workspace;
  if (data.env !== undefined) spec.env = stringArray(data.env, 'env', source);
  const retry = normalizeRetry(data.retry, source);
  if (retry) spec.retry = retry;
  if (isRecord(data.driverOptions)) spec.driverOptions = data.driverOptions;

  const prompt = body.trim();
  if (prompt) spec.systemPrompt = prompt;

  return spec;
}

export async function loadHarnessFile(filePath: string): Promise<HarnessSpec> {
  const content = await fs.readFile(filePath, 'utf8');
  return harnessFromMarkdown(content, {
    defaultName: path.basename(filePath, '.md'),
    source: filePath,
  });
}

export async function listHarnessFiles(dir: string): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
    .map((entry) => path.join(dir, entry.name))
    .sort();
}

export async function loadHarnessDir(dir: string): Promise<HarnessSpec[]> {
  const specs: HarnessSpec[] = [];
  for (const file of await listHarnessFiles(dir)) {
    specs.push(await loadHarnessFile(file));
  }
  return specs;
}

function splitFrontmatter(content: string, source: string): { frontmatter: string; body: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(content);
  if (!match) {
    throw new Error(`${source}: missing frontmatter block (expected leading "---" ... "---")`);
  }
  return { frontmatter: match[1], body: content.slice(match[0].length) };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function optionalString(value: unknown, field: string, source: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw new Error(`${source}: "${field}" must be a string`);
  return value;
}

function stringArray(value: unknown, field: string, source: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new Error(`${source}: "${field}" must be an array of strings`);
  }
  return value as string[];
}

function optionalNumber(value: unknown, field: string, source: string): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'number') throw new Error(`${source}: "${field}" must be a number`);
  return value;
}

function normalizeTools(value: unknown, source: string): ToolPolicy | undefined {
  if (value === undefined || value === null) return undefined;
  if (!isRecord(value)) throw new Error(`${source}: "tools" must be a mapping with allow/deny/mcpServers`);
  const tools: ToolPolicy = {};
  if (value.allow !== undefined) tools.allow = stringArray(value.allow, 'tools.allow', source);
  if (value.deny !== undefined) tools.deny = stringArray(value.deny, 'tools.deny', source);
  if (value.mcpServers !== undefined) {
    if (!isRecord(value.mcpServers)) throw new Error(`${source}: "tools.mcpServers" must be a mapping`);
    const servers: Record<string, McpServerConfig> = {};
    for (const [name, config] of Object.entries(value.mcpServers)) {
      if (!isRecord(config) || typeof config.command !== 'string') {
        throw new Error(`${source}: "tools.mcpServers.${name}" needs a "command"`);
      }
      const server: McpServerConfig = { command: config.command };
      if (config.args !== undefined) server.args = stringArray(config.args, `tools.mcpServers.${name}.args`, source);
      if (config.env !== undefined) {
        if (!isRecord(config.env) || Object.values(config.env).some((v) => typeof v !== 'string')) {
          throw new Error(`${source}: "tools.mcpServers.${name}.env" must map names to strings`);
        }
        server.env = config.env as Record<string, string>;
      }
      servers[name] = server;
    }
    tools.mcpServers = servers;
  }
  return tools;
}

function normalizeRetry(value: unknown, source: string): RetryPolicy | undefined {
  if (value === undefined || value === null) return undefined;
  if (!isRecord(value) || typeof value.maxAttempts !== 'number') {
    throw new Error(`${source}: "retry" must be a mapping with a numeric maxAttempts`);
  }
  const retry: RetryPolicy = { maxAttempts: value.maxAttempts };
  if (value.on !== undefined) retry.on = stringArray(value.on, 'retry.on', source) as RunStatus[];
  return retry;
}

function normalizeArtifacts(value: unknown, source: string): { globs: string[] } | undefined {
  if (value === undefined || value === null) return undefined;
  if (Array.isArray(value)) return { globs: stringArray(value, 'artifacts', source) };
  if (isRecord(value) && value.globs !== undefined) {
    return { globs: stringArray(value.globs, 'artifacts.globs', source) };
  }
  throw new Error(`${source}: "artifacts" must be a glob array or { globs: [...] }`);
}

function normalizeLimits(value: unknown, source: string): HarnessSpec['limits'] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!isRecord(value)) throw new Error(`${source}: "limits" must be a mapping`);
  const limits: NonNullable<HarnessSpec['limits']> = {};
  const maxTurns = optionalNumber(value.maxTurns, 'limits.maxTurns', source);
  if (maxTurns !== undefined) limits.maxTurns = maxTurns;
  const timeoutMs = optionalNumber(value.timeoutMs, 'limits.timeoutMs', source);
  if (timeoutMs !== undefined) limits.timeoutMs = timeoutMs;
  const maxWorkspaceBytes = optionalNumber(value.maxWorkspaceBytes, 'limits.maxWorkspaceBytes', source);
  if (maxWorkspaceBytes !== undefined) limits.maxWorkspaceBytes = maxWorkspaceBytes;
  return limits;
}

function normalizeWorkspace(value: unknown, source: string): WorkspaceSpec | undefined {
  if (value === undefined || value === null) return undefined;
  if (!isRecord(value)) throw new Error(`${source}: "workspace" must be a mapping`);
  const workspace: WorkspaceSpec = {};
  const snapshot = optionalString(value.snapshot, 'workspace.snapshot', source);
  if (snapshot) workspace.snapshot = snapshot;
  const templateDir = optionalString(value.templateDir, 'workspace.templateDir', source);
  if (templateDir) workspace.templateDir = templateDir;
  if (value.seedFiles !== undefined) {
    if (!isRecord(value.seedFiles)) throw new Error(`${source}: "workspace.seedFiles" must be a mapping`);
    const seedFiles: Record<string, string> = {};
    for (const [rel, content] of Object.entries(value.seedFiles)) {
      if (typeof content !== 'string') {
        throw new Error(`${source}: "workspace.seedFiles.${rel}" must be a string`);
      }
      seedFiles[rel] = content;
    }
    workspace.seedFiles = seedFiles;
  }
  return workspace;
}
