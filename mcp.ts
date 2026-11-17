// mcp.ts — the Model Context Protocol endpoint (POST /mcp, Streamable HTTP, plain JSON
// answers). The modern 2026-07-28 era: server/discover, no handshake, no session. The six
// tools are github-mcp-server's canonical names; their effects show in the REST view.
// A JSON-RPC error is an HTTP 200 carrying {error}; a body that is not JSON is an HTTP 400
// carrying JSON-RPC -32700. The token is checked by app.ts before this module runs.

import {
  VIEWER,
  mergeConflict,
  squashMerge,
  type Repo,
  type Store,
} from './store.ts';
import { sendJson, sendStatus } from './http.ts';
import type { ServerResponse } from 'node:http';

const SERVER_NAME = 'forge';
const SERVER_VERSION = '1.0.0';
const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

/** The six tools, a static constant so tools/list is byte-identical on every call. */
const TOOLS: ReadonlyArray<Record<string, unknown>> = Object.freeze([
  {
    name: 'create_repo',
    description: 'Create a repository owned by the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The repository name.' },
        description: { type: 'string', description: 'A short description of the repository.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      required: ['name'],
      additionalProperties: false,
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner.' },
        repo: { type: 'string', description: 'The repository name.' },
      },
      required: ['owner', 'repo'],
      additionalProperties: false,
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The issue title.' },
        body: { type: 'string', description: 'The issue body.' },
      },
      required: ['owner', 'repo', 'title'],
      additionalProperties: false,
    },
  },
  {
    name: 'list_issues',
    description: 'List the issues of a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner.' },
        repo: { type: 'string', description: 'The repository name.' },
        state: { type: 'string', description: 'The issue state filter: open, closed or all.', enum: ['open', 'closed', 'all'] },
      },
      required: ['owner', 'repo'],
      additionalProperties: false,
    },
  },
  {
    name: 'create_pull_request',
    description: 'Open a pull request from a head branch onto a base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The pull request title.' },
        body: { type: 'string', description: 'The pull request body.' },
        head: { type: 'string', description: 'The head branch name.' },
        base: { type: 'string', description: 'The base branch name.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
      additionalProperties: false,
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Squash-merge a pull request.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner.' },
        repo: { type: 'string', description: 'The repository name.' },
        pull_number: { type: 'integer', description: 'The pull request number.' },
      },
      required: ['owner', 'repo', 'pull_number'],
      additionalProperties: false,
    },
  },
]);

function repoJson(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    name: repo.name,
    full_name: `${VIEWER.login}/${repo.name}`,
    private: repo.private,
    description: repo.description,
    default_branch: repo.defaultBranch,
  };
}

function toolResult(result: unknown): Record<string, unknown> {
  const text = JSON.stringify(result);
  return { content: [{ type: 'text', text }], structuredContent: result };
}

function toolError(message: string): Record<string, unknown> {
  return { content: [{ type: 'text', text: message }], isError: true };
}

/** The required arguments a tools/call is missing, or an empty list. */
function missingArgs(args: Record<string, unknown>, required: readonly string[]): string[] {
  return required.filter((name) => args[name] === undefined || args[name] === null || args[name] === '');
}

/** Execute one tool. Returns a tool result (isError when the call cannot run). */
function callTool(store: Store, name: string, args: Record<string, unknown>): Record<string, unknown> {
  const tool = TOOLS.find((t) => t.name === name);
  if (tool === undefined) return toolError(`unknown tool ${name}`);
  const schema = tool.inputSchema as Record<string, unknown>;
  const required = (schema.required as readonly string[]) ?? [];
  const missing = missingArgs(args, required);
  if (missing.length > 0) return toolError(`missing required argument(s): ${missing.join(', ')}`);

  const owner = typeof args.owner === 'string' ? args.owner : VIEWER.login;
  const repoName = typeof args.repo === 'string' ? args.repo : '';

  if (name === 'create_repo') {
    const repoNameArg = typeof args.name === 'string' ? args.name.trim() : '';
    if (repoNameArg === '') return toolError('missing required argument: name');
    const repo = store.createRepo(repoNameArg, args.private === true, typeof args.description === 'string' ? args.description : '');
    if (repo === null) return toolError(`repository ${repoNameArg} already exists`);
    return toolResult(repoJson(repo));
  }

  if (owner !== VIEWER.login) return toolError(`repository ${owner}/${repoName} not found`);
  const repo = store.getRepo(VIEWER.login, repoName);
  if (repo === undefined) return toolError(`repository ${owner}/${repoName} not found`);

  if (name === 'get_repo') return toolResult(repoJson(repo));

  if (name === 'create_issue') {
    const title = typeof args.title === 'string' ? args.title : '';
    const body = typeof args.body === 'string' ? args.body : '';
    const issue = store.createIssue(repo, title, body, []);
    return toolResult({ id: issue.id, number: issue.number, title: issue.title, body: issue.body, state: 'open' });
  }

  if (name === 'list_issues') {
    const state = typeof args.state === 'string' ? args.state : 'open';
    let issues = [...repo.issues.values()];
    if (state !== 'all') issues = issues.filter((i) => i.state === state);
    issues.sort((a, b) => b.number - a.number);
    const list = issues.map((i) => ({ id: i.id, number: i.number, title: i.title, body: i.body, state: i.state }));
    return toolResult(list);
  }

  if (name === 'create_pull_request') {
    const title = typeof args.title === 'string' ? args.title : '';
    const body = typeof args.body === 'string' ? args.body : '';
    const head = typeof args.head === 'string' ? args.head : '';
    const base = typeof args.base === 'string' ? args.base : '';
    if (!repo.refs.has(`refs/heads/${head}`)) return toolError(`head branch ${head} does not exist`);
    if (!repo.refs.has(`refs/heads/${base}`)) return toolError(`base branch ${base} does not exist`);
    const duplicate = [...repo.pulls.values()].find((p) => p.state === 'open' && p.headRef === head && p.baseRef === base);
    if (duplicate !== undefined) return toolError('a pull request already exists for this head and base');
    const pull = store.createPull(repo, title, body, head, base);
    return toolResult({
      id: pull.id,
      number: pull.number,
      title: pull.title,
      body: pull.body,
      state: 'open',
      head: { ref: head },
      base: { ref: base },
      headRefName: head,
      baseRefName: base,
    });
  }

  if (name === 'merge_pull_request') {
    const number = typeof args.pull_number === 'number' ? args.pull_number : Number.parseInt(String(args.pull_number), 10);
    const pull = repo.pulls.get(number);
    if (pull === undefined) return toolError(`pull request #${number} not found`);
    if (pull.state !== 'open') return toolError(`pull request #${number} is not open`);
    const headTip = store.branchTip(repo, pull.headRef);
    const baseTip = store.branchTip(repo, pull.baseRef);
    if (headTip === null || baseTip === null) return toolError('the head or base branch is missing');
    if (mergeConflict(repo, headTip, baseTip).conflict !== null) return toolError('merge conflict');
    const result = squashMerge(store, repo, pull);
    if (!('sha' in result)) return toolError('merge conflict');
    return toolResult({ number: pull.number, merged: true, state: 'closed', merge_commit_sha: result.sha });
  }

  return toolError(`unknown tool ${name}`);
}

function jsonRpcResult(res: ServerResponse, id: unknown, result: unknown): void {
  sendJson(res, 200, { jsonrpc: '2.0', id, result });
}

function jsonRpcError(res: ServerResponse, id: unknown, code: number, message: string): void {
  sendJson(res, 200, { jsonrpc: '2.0', id, error: { code, message } });
}

/** Handle one POST /mcp body (already read as text; the token is checked by app.ts). */
export function handleMcp(store: Store, bodyText: string, res: ServerResponse): void {
  let body: unknown;
  try {
    body = JSON.parse(bodyText);
  } catch {
    // A body that is not JSON: HTTP 400 with JSON-RPC -32700.
    sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    return;
  }
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    return;
  }
  const request = body as Record<string, unknown>;
  const id = request.id ?? null;
  const method = typeof request.method === 'string' ? request.method : '';
  const params = (request.params ?? {}) as Record<string, unknown>;

  // A notification (no id) is acknowledged with no body.
  if (request.id === undefined) {
    sendStatus(res, 202);
    return;
  }

  if (method === 'server/discover') {
    const serverInfo = { name: SERVER_NAME, version: SERVER_VERSION };
    return jsonRpcResult(res, id, {
      supportedVersions: SUPPORTED_VERSIONS,
      capabilities: { tools: {} },
      serverInfo,
      _meta: { 'io.modelcontextprotocol/serverInfo': serverInfo },
    });
  }

  if (method === 'initialize') {
    const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
    const protocolVersion = SUPPORTED_VERSIONS.includes(requested) ? requested : '2025-11-25';
    return jsonRpcResult(res, id, {
      protocolVersion,
      capabilities: { tools: {} },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
    });
  }

  if (method === 'ping') {
    return jsonRpcResult(res, id, {});
  }

  if (method === 'tools/list') {
    return jsonRpcResult(res, id, { tools: TOOLS });
  }

  if (method === 'tools/call') {
    const name = typeof params.name === 'string' ? params.name : '';
    const args = (params.arguments ?? {}) as Record<string, unknown>;
    if (name === '' || !TOOLS.some((t) => t.name === name)) {
      return jsonRpcError(res, id, -32602, `unknown tool ${name}`);
    }
    const result = callTool(store, name, args);
    return jsonRpcResult(res, id, result);
  }

  if (method.startsWith('notifications/')) {
    return jsonRpcResult(res, id, {});
  }

  return jsonRpcError(res, id, -32601, `method not found: ${method}`);
}
