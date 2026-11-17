// rest.ts — the REST v3 surface (/api/v3). Handles repos, branches, commits, contents,
// issues, comments, labels, pulls, files and merges, with GitHub-shaped bodies and status
// codes, Link pagination and X-GitHub-Request-Id on every reply (the header is added by
// the http.ts helpers). The token is checked by app.ts before this module runs.

import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  VIEWER,
  ZERO_OID,
  blobAtPath,
  commitFile,
  deleteFile,
  diffTrees,
  dirEntriesAtPath,
  lineDiff,
  mergeConflict,
  mergeableState,
  parseCommit,
  squashMerge,
  type Issue,
  type PullRequest,
  type Repo,
  type Store,
} from './store.ts';
import { errorBody, JSON_TYPE, sendBytes, sendJson, sendStatus } from './http.ts';

export interface RestContext {
  /** The store this server owns. */
  store: Store;
  /** The HTTP method (GET/POST/PATCH/PUT/DELETE). */
  method: string;
  /** The path segments after /api/v3 (already URL-decoded). */
  segments: string[];
  /** The parsed query string. */
  query: URLSearchParams;
  /** The request Host header (for absolute Link URLs). */
  host: string;
  /** The parsed JSON body, or null when there is none / it is not JSON. */
  body: unknown;
  /** True when the body was present but was not valid JSON. */
  bodyInvalid: boolean;
  /** The raw request (for reading bodies the caller has not parsed). */
  req: IncomingMessage;
  /** The raw response. */
  res: ServerResponse;
}

function notFound(res: ServerResponse, message = 'Not Found'): void {
  sendJson(res, 404, errorBody(message));
}

function unprocessable(res: ServerResponse, message: string): void {
  sendJson(res, 422, errorBody(message));
}

function badRequest(res: ServerResponse, message = 'Bad Request'): void {
  sendJson(res, 400, errorBody(message));
}

function conflict(res: ServerResponse, message: string): void {
  sendJson(res, 409, errorBody(message));
}

function notAllowed(res: ServerResponse, message: string): void {
  sendJson(res, 405, errorBody(message));
}

function userJson(): { login: string; id: number; type: string } {
  return { login: VIEWER.login, id: VIEWER.id, type: VIEWER.type };
}

function repoJson(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    name: repo.name,
    full_name: `${VIEWER.login}/${repo.name}`,
    private: repo.private,
    owner: userJson(),
    description: repo.description,
    default_branch: repo.defaultBranch,
  };
}

/** The issue body GitHub returns, as a plain object (shared by the list path). */
function issueObject(repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => ({ name, color: repo.labels.get(name)?.color ?? 'ededed' })),
    user: userJson(),
  };
}

/**
 * The issue body serialised once per issue and cached as UTF-8 bytes (the read workload).
 * Sending the cached Buffer skips the per-request JSON.stringify, byteLength scan and
 * UTF-8 re-encode of the string form.
 */
function issueJsonBuffer(repo: Repo, issue: Issue): Buffer {
  if (issue.jsonCache !== null) return issue.jsonCache;
  const buffer = Buffer.from(`${JSON.stringify(issueObject(repo, issue))}\n`, 'utf8');
  issue.jsonCache = buffer;
  return buffer;
}

function pullJson(pull: PullRequest, repo: Repo, store: Store): Record<string, unknown> {
  const headTip = store.branchTip(repo, pull.headRef);
  const baseTip = store.branchTip(repo, pull.baseRef);
  return {
    id: pull.id,
    number: pull.number,
    state: pull.state,
    title: pull.title,
    body: pull.body,
    head: {
      ref: pull.headRef,
      sha: headTip ?? ZERO_OID,
      label: `${VIEWER.login}:${pull.headRef}`,
      user: userJson(),
    },
    base: {
      ref: pull.baseRef,
      sha: baseTip ?? ZERO_OID,
      label: `${VIEWER.login}:${pull.baseRef}`,
      user: userJson(),
    },
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeSha,
    mergeable: mergeableState(repo, pull) === 'MERGEABLE',
    user: userJson(),
  };
}

function parsePositiveInt(value: string | null, fallback: number): number {
  if (value === null) return fallback;
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** A Link header with a next page (absolute, same-origin). */
function paginationLink(host: string, path: string, query: URLSearchParams, page: number, perPage: number, hasNext: boolean): Record<string, string> {
  if (!hasNext) return {};
  const next = new URLSearchParams(query);
  next.set('page', String(page + 1));
  next.set('per_page', String(perPage));
  return { link: `<http://${host}${path}?${next.toString()}>; rel="next"` };
}

/** Paginate a list (sorted by the caller). Returns the page and the Link headers. */
function paginate<T>(items: readonly T[], ctx: RestContext, path: string): { page: T[]; headers: Record<string, string> } {
  const perPage = parsePositiveInt(ctx.query.get('per_page'), 30);
  const page = parsePositiveInt(ctx.query.get('page'), 1);
  const start = (page - 1) * perPage;
  const hasNext = start + perPage < items.length;
  return { page: items.slice(start, start + perPage), headers: paginationLink(ctx.host, path, ctx.query, page, perPage, hasNext) };
}

/** Parse a raw identity line ("Name <email> 1700000000 +0000") into its parts. */
function parseIdentity(line: string): { name: string; email: string; timestamp: number } {
  const match = /^(.*) <(.*)> (\d+) [+-]\d{4}$/.exec(line);
  if (match === null) return { name: line, email: '', timestamp: 0 };
  return { name: match[1]!, email: match[2]!, timestamp: Number.parseInt(match[3]!, 10) };
}

function commitJson(oid: string, repo: Repo): Record<string, unknown> | null {
  const object = repo.objects.get(oid);
  if (object === undefined || object.type !== 'commit') return null;
  const parsed = parseCommit(object.data);
  const author = parseIdentity(parsed.author);
  const committer = parseIdentity(parsed.committer);
  return {
    sha: oid,
    commit: {
      message: parsed.message,
      author: { name: author.name, email: author.email, date: new Date(author.timestamp * 1000).toISOString() },
      committer: { name: committer.name, email: committer.email, date: new Date(committer.timestamp * 1000).toISOString() },
    },
    author: userJson(),
    committer: userJson(),
  };
}

/** The newest-first ancestry of a commit (children before parents). */
function listCommits(repo: Repo, tip: string): Array<Record<string, unknown>> {
  const seen = new Set<string>();
  const queue: string[] = [tip];
  const out: Array<Record<string, unknown>> = [];
  while (queue.length > 0) {
    const oid = queue.shift()!;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const object = repo.objects.get(oid);
    if (object === undefined || object.type !== 'commit') continue;
    const json = commitJson(oid, repo);
    if (json !== null) out.push(json);
    queue.push(...parseCommit(object.data).parents);
  }
  return out;
}

/** Parse a ref name from a path (a branch name or a commit sha) into a commit oid. */
function resolveRef(repo: Repo, ref: string | null): string | null {
  if (ref === null) return repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? null;
  const asBranch = repo.refs.get(`refs/heads/${ref}`);
  if (asBranch !== undefined) return asBranch;
  if (/^[0-9a-f]{40}$/.test(ref)) {
    const object = repo.objects.get(ref);
    if (object !== undefined && object.type === 'commit') return ref;
  }
  return null;
}

/** The contents GET body for one blob, or the directory listing. */
function contentsGet(repo: Repo, tip: string, path: string): { status: number; body: unknown } {
  const treeOid = repo.objects.get(tip)?.type === 'commit' ? parseCommit(repo.objects.get(tip)!.data).tree : null;
  if (treeOid === null) return { status: 404, body: errorBody('Not Found') };
  const blob = blobAtPath(repo.objects, treeOid, path);
  if (blob !== null) {
    const data = repo.objects.get(blob)!.data;
    return {
      status: 200,
      body: {
        type: 'file',
        encoding: 'base64',
        size: data.length,
        name: path.split('/').pop() ?? path,
        path,
        content: data.toString('base64'),
        sha: blob,
      },
    };
  }
  const entries = dirEntriesAtPath(repo.objects, treeOid, path);
  if (entries === null) return { status: 404, body: errorBody('Not Found') };
  return {
    status: 200,
    body: entries.map((e) => {
      const object = repo.objects.get(e.oid);
      const type = e.mode === '40000' ? 'dir' : 'file';
      return {
        type,
        name: e.name,
        path: path === '' ? e.name : `${path}/${e.name}`,
        sha: e.oid,
        size: type === 'file' ? (object?.data.length ?? 0) : 0,
      };
    }),
  };
}

export function handleRest(ctx: RestContext): void {
  const { res, method, segments } = ctx;

  // The API root.
  if (segments.length === 0) {
    if (method !== 'GET') return notFound(res);
    sendJson(res, 200, { current_user_url: '/api/v3/user' }, { 'x-oauth-scopes': 'repo, read:org' });
    return;
  }

  // /meta — the installed version string.
  if (segments[0] === 'meta') {
    if (method !== 'GET') return notFound(res);
    sendJson(res, 200, { installed_version: '1.0.0' });
    return;
  }

  // /user — the token's owner, and the viewer's repos.
  if (segments[0] === 'user') {
    if (segments.length === 1) {
      if (method !== 'GET') return notFound(res);
      sendJson(res, 200, userJson());
      return;
    }
    if (segments[1] === 'repos') {
      if (method === 'GET') {
        const repos = ctx.store.listRepos(VIEWER.login);
        const { page, headers } = paginate(repos, ctx, '/api/v3/user/repos');
        sendJson(res, 200, page.map(repoJson), headers);
        return;
      }
      if (method === 'POST') {
        if (ctx.bodyInvalid) return badRequest(res);
        const body = (ctx.body ?? {}) as Record<string, unknown>;
        const name = typeof body.name === 'string' ? body.name.trim() : '';
        if (name === '') return unprocessable(res, 'Validation Failed: name is required');
        const repo = ctx.store.createRepo(name, body.private === true, typeof body.description === 'string' ? body.description : '');
        if (repo === null) return unprocessable(res, 'Repository already exists');
        sendJson(res, 201, repoJson(repo));
        return;
      }
      return notFound(res);
    }
    return notFound(res);
  }

  // /repos/:owner/:repo/...
  if (segments[0] === 'repos' && segments.length >= 3) {
    if (segments[1] !== VIEWER.login) return notFound(res);
    const repo = ctx.store.getRepo(VIEWER.login, segments[2] ?? '');
    if (repo === undefined) return notFound(res);

    const rest = segments.slice(3);

    // The repo itself.
    if (rest.length === 0) {
      if (method === 'GET') return sendJson(res, 200, repoJson(repo));
      if (method === 'PATCH') {
        if (ctx.bodyInvalid) return badRequest(res);
        const body = (ctx.body ?? {}) as Record<string, unknown>;
        if (typeof body.description === 'string') repo.description = body.description;
        if (typeof body.private === 'boolean') repo.private = body.private;
        return sendJson(res, 200, repoJson(repo));
      }
      if (method === 'DELETE') {
        ctx.store.deleteRepo(VIEWER.login, repo.name);
        return sendStatus(res, 204);
      }
      return notFound(res);
    }

    // branches
    if (rest[0] === 'branches') {
      const branches = [...repo.refs.keys()]
        .filter((r) => r.startsWith('refs/heads/'))
        .map((r) => r.slice('refs/heads/'.length))
        .sort();
      if (rest.length === 1) {
        if (method !== 'GET') return notFound(res);
        return sendJson(res, 200, branches.map((name) => ({ name, commit: { sha: repo.refs.get(`refs/heads/${name}`)! } })));
      }
      if (rest.length === 2) {
        if (method !== 'GET') return notFound(res);
        const tip = repo.refs.get(`refs/heads/${rest[1]}`);
        if (tip === undefined) return notFound(res);
        return sendJson(res, 200, { name: rest[1], commit: { sha: tip } });
      }
      return notFound(res);
    }

    // commits
    if (rest[0] === 'commits') {
      if (rest.length === 1) {
        if (method !== 'GET') return notFound(res);
        const tip = resolveRef(repo, ctx.query.get('sha'));
        if (tip === null) return notFound(res);
        return sendJson(res, 200, listCommits(repo, tip));
      }
      if (rest.length === 2 && method === 'GET') {
        const json = commitJson(rest[1]!, repo);
        if (json === null) return notFound(res);
        return sendJson(res, 200, json);
      }
      return notFound(res);
    }

    // git refs
    if (rest[0] === 'git' && rest[1] === 'refs') {
      if (rest.length === 2) {
        if (method === 'GET') {
          const refs = [...repo.refs.entries()].map(([name, oid]) => ({ ref: name, object: { sha: oid, type: name.startsWith('refs/tags/') ? 'tag' : 'commit' } }));
          return sendJson(res, 200, refs);
        }
        if (method === 'POST') {
          if (ctx.bodyInvalid) return badRequest(res);
          const body = (ctx.body ?? {}) as Record<string, unknown>;
          const ref = typeof body.ref === 'string' ? body.ref : '';
          const sha = typeof body.sha === 'string' ? body.sha : '';
          if (!ref.startsWith('refs/')) return unprocessable(res, 'Validation Failed: ref is required');
          if (repo.refs.has(ref)) return unprocessable(res, 'Reference already exists');
          const object = repo.objects.get(sha);
          if (object === undefined || object.type !== 'commit') return unprocessable(res, 'Validation Failed: sha does not exist');
          repo.refs.set(ref, sha);
          ctx.store.invalidateGit(repo);
          return sendJson(res, 201, { ref, object: { sha, type: 'commit' } });
        }
        return notFound(res);
      }
      // refs/heads/<branch> or refs/tags/<tag>
      if (rest.length === 4 && method === 'GET') {
        const full = `refs/${rest[2]}/${rest[3]}`;
        const oid = repo.refs.get(full);
        if (oid === undefined) return notFound(res);
        return sendJson(res, 200, { ref: full, object: { sha: oid, type: rest[2] === 'tags' ? 'tag' : 'commit' } });
      }
      return notFound(res);
    }

    // contents
    if (rest[0] === 'contents') {
      const path = rest.slice(1).join('/');
      if (method === 'GET') {
        const tip = resolveRef(repo, ctx.query.get('ref'));
        if (tip === null) return notFound(res);
        const result = contentsGet(repo, tip, path);
        return sendJson(res, result.status, result.body);
      }
      if (method === 'PUT') {
        if (ctx.bodyInvalid) return badRequest(res);
        const body = (ctx.body ?? {}) as Record<string, unknown>;
        if (typeof body.content !== 'string' || typeof body.message !== 'string') return unprocessable(res, 'Validation Failed: content and message are required');
        let data: Buffer;
        try {
          data = Buffer.from(body.content, 'base64');
        } catch {
          return badRequest(res);
        }
        const branch = typeof body.branch === 'string' ? body.branch : repo.defaultBranch;
        const currentTip = repo.refs.get(`refs/heads/${branch}`);
        const currentTree = currentTip !== undefined ? parseCommit(repo.objects.get(currentTip)!.data).tree : null;
        const existing = currentTree !== null ? blobAtPath(repo.objects, currentTree, path) : null;
        if (typeof body.sha === 'string' && body.sha !== existing) return conflict(res, 'sha does not match');
        const result = commitFile(ctx.store, repo, branch, path, data, body.message);
        const response = {
          content: {
            name: path.split('/').pop() ?? path,
            path,
            sha: result.blobSha,
            size: data.length,
            type: 'file',
            encoding: 'base64',
            content: data.toString('base64'),
          },
          commit: { sha: result.commitSha, message: body.message },
        };
        return sendJson(res, result.existed ? 200 : 201, response);
      }
      if (method === 'DELETE') {
        if (ctx.bodyInvalid) return badRequest(res);
        const body = (ctx.body ?? {}) as Record<string, unknown>;
        if (typeof body.message !== 'string') return unprocessable(res, 'Validation Failed: message is required');
        const branch = typeof body.branch === 'string' ? body.branch : repo.defaultBranch;
        const currentTip = repo.refs.get(`refs/heads/${branch}`);
        if (currentTip === undefined) return notFound(res);
        const currentTree = parseCommit(repo.objects.get(currentTip)!.data).tree;
        const existing = blobAtPath(repo.objects, currentTree, path);
        if (existing === null) return notFound(res);
        if (typeof body.sha === 'string' && body.sha !== existing) return conflict(res, 'sha does not match');
        const commitSha = deleteFile(ctx.store, repo, branch, path, body.message);
        if (commitSha === null) return notFound(res);
        return sendJson(res, 200, { commit: { sha: commitSha, message: body.message }, content: null });
      }
      return notFound(res);
    }

    // labels
    if (rest[0] === 'labels') {
      if (rest.length === 1) {
        if (method === 'GET') {
          return sendJson(res, 200, [...repo.labels.values()].map((l) => ({ name: l.name, color: l.color })));
        }
        if (method === 'POST') {
          if (ctx.bodyInvalid) return badRequest(res);
          const body = (ctx.body ?? {}) as Record<string, unknown>;
          const name = typeof body.name === 'string' ? body.name.trim() : '';
          if (name === '') return unprocessable(res, 'Validation Failed: name is required');
          const color = typeof body.color === 'string' ? body.color : 'ededed';
          repo.labels.set(name, { name, color });
          return sendJson(res, 201, { name, color });
        }
        return notFound(res);
      }
      return notFound(res);
    }

    // issues
    if (rest[0] === 'issues') {
      if (rest.length === 1) {
        if (method === 'GET') {
          const state = ctx.query.get('state') ?? 'open';
          const sort = ctx.query.get('sort') ?? 'created';
          const direction = ctx.query.get('direction') ?? 'desc';
          let issues = [...repo.issues.values()];
          if (state !== 'all') issues = issues.filter((i) => i.state === state);
          issues.sort((a, b) => {
            const byCreated = sort === 'created' ? a.createdSeq - b.createdSeq : a.updatedSeq - b.updatedSeq;
            return direction === 'asc' ? byCreated : -byCreated;
          });
          const { page, headers } = paginate(issues, ctx, `/api/v3/repos/${VIEWER.login}/${repo.name}/issues`);
          // Build the objects directly; the old stringify-then-parse round-trip is gone.
          return sendJson(res, 200, page.map((i) => issueObject(repo, i)), headers);
        }
        if (method === 'POST') {
          if (ctx.bodyInvalid) return badRequest(res);
          const body = (ctx.body ?? {}) as Record<string, unknown>;
          const title = typeof body.title === 'string' ? body.title : '';
          if (title === '') return unprocessable(res, 'Validation Failed: title is required');
          const labelNames = Array.isArray(body.labels)
            ? body.labels.filter((l): l is string => typeof l === 'string')
            : [];
          const unknown = labelNames.find((name) => !repo.labels.has(name));
          if (unknown !== undefined) return unprocessable(res, `Validation Failed: label ${unknown} does not exist`);
          const issue = ctx.store.createIssue(repo, title, typeof body.body === 'string' ? body.body : '', labelNames);
          return sendBytes(res, 201, issueJsonBuffer(repo, issue), JSON_TYPE);
        }
        return notFound(res);
      }
      const issueNumber = Number.parseInt(rest[1] ?? '', 10);
      if (!Number.isInteger(issueNumber)) return notFound(res);
      const issue = repo.issues.get(issueNumber);
      if (rest.length === 2) {
        if (issue === undefined) return notFound(res);
        if (method === 'GET') return sendBytes(res, 200, issueJsonBuffer(repo, issue), JSON_TYPE);
        if (method === 'PATCH') {
          if (ctx.bodyInvalid) return badRequest(res);
          const body = (ctx.body ?? {}) as Record<string, unknown>;
          if (typeof body.title === 'string') issue.title = body.title;
          if (typeof body.body === 'string') issue.body = body.body;
          if (body.state === 'open' || body.state === 'closed') issue.state = body.state;
          issue.updatedSeq = ++ctx.store.seq;
          issue.jsonCache = null;
          return sendBytes(res, 200, issueJsonBuffer(repo, issue), JSON_TYPE);
        }
        return notFound(res);
      }
      if (rest.length === 3 && rest[2] === 'comments') {
        if (issue === undefined) return notFound(res);
        if (method === 'GET') {
          return sendJson(res, 200, issue.comments.map((c) => ({ id: c.id, body: c.body, user: userJson() })));
        }
        if (method === 'POST') {
          if (ctx.bodyInvalid) return badRequest(res);
          const body = (ctx.body ?? {}) as Record<string, unknown>;
          const commentBody = typeof body.body === 'string' ? body.body : '';
          if (commentBody === '') return unprocessable(res, 'Validation Failed: body is required');
          const comment = { id: repo.nextCommentId++, body: commentBody, createdSeq: ++ctx.store.seq };
          issue.comments.push(comment);
          issue.updatedSeq = ++ctx.store.seq;
          return sendJson(res, 201, { id: comment.id, body: comment.body, user: userJson() });
        }
        return notFound(res);
      }
      return notFound(res);
    }

    // pulls
    if (rest[0] === 'pulls') {
      if (rest.length === 1) {
        if (method === 'GET') {
          const state = ctx.query.get('state') ?? 'open';
          let pulls = [...repo.pulls.values()];
          if (state !== 'all') pulls = pulls.filter((p) => p.state === state);
          pulls.sort((a, b) => b.number - a.number);
          const { page, headers } = paginate(pulls, ctx, `/api/v3/repos/${VIEWER.login}/${repo.name}/pulls`);
          return sendJson(res, 200, page.map((p) => pullJson(p, repo, ctx.store)), headers);
        }
        if (method === 'POST') {
          if (ctx.bodyInvalid) return badRequest(res);
          const body = (ctx.body ?? {}) as Record<string, unknown>;
          const title = typeof body.title === 'string' ? body.title : '';
          const headRef =
            typeof body.head === 'string'
              ? body.head
              : typeof (body.head as Record<string, unknown> | null)?.ref === 'string'
                ? ((body.head as Record<string, unknown>).ref as string)
                : '';
          const baseRef =
            typeof body.base === 'string'
              ? body.base
              : typeof (body.base as Record<string, unknown> | null)?.ref === 'string'
                ? ((body.base as Record<string, unknown>).ref as string)
                : '';
          if (title === '' || headRef === '' || baseRef === '') return unprocessable(res, 'Validation Failed: title, head and base are required');
          if (!repo.refs.has(`refs/heads/${headRef}`)) return unprocessable(res, `Validation Failed: head branch ${headRef} does not exist`);
          if (!repo.refs.has(`refs/heads/${baseRef}`)) return unprocessable(res, `Validation Failed: base branch ${baseRef} does not exist`);
          const duplicate = [...repo.pulls.values()].find((p) => p.state === 'open' && p.headRef === headRef && p.baseRef === baseRef);
          if (duplicate !== undefined) return unprocessable(res, 'Validation Failed: a pull request already exists for this head and base');
          const pull = ctx.store.createPull(repo, title, typeof body.body === 'string' ? body.body : '', headRef, baseRef);
          return sendJson(res, 201, pullJson(pull, repo, ctx.store));
        }
        return notFound(res);
      }
      const pullNumber = Number.parseInt(rest[1] ?? '', 10);
      if (!Number.isInteger(pullNumber)) return notFound(res);
      const pull = repo.pulls.get(pullNumber);
      if (rest.length === 2) {
        if (pull === undefined) return notFound(res);
        if (method !== 'GET') return notFound(res);
        return sendJson(res, 200, pullJson(pull, repo, ctx.store));
      }
      if (rest.length === 3 && rest[2] === 'files') {
        if (pull === undefined) return notFound(res);
        if (method !== 'GET') return notFound(res);
        const headTip = ctx.store.branchTip(repo, pull.headRef);
        const baseTip = ctx.store.branchTip(repo, pull.baseRef);
        if (headTip === null || baseTip === null) return sendJson(res, 200, []);
        const headTree = parseCommit(repo.objects.get(headTip)!.data).tree;
        const baseTree = parseCommit(repo.objects.get(baseTip)!.data).tree;
        const files = diffTrees(repo.objects, baseTree, headTree).map((change) => {
          const oldText = change.oldOid !== null ? (repo.objects.get(change.oldOid)?.data.toString('utf8') ?? '') : '';
          const newText = change.newOid !== null ? (repo.objects.get(change.newOid)?.data.toString('utf8') ?? '') : '';
          const diff = lineDiff(oldText, newText);
          return {
            filename: change.path,
            status: change.status,
            additions: diff.additions,
            deletions: diff.deletions,
            changes: diff.additions + diff.deletions,
          };
        });
        return sendJson(res, 200, files);
      }
      if (rest.length === 3 && rest[2] === 'merge') {
        if (pull === undefined) return notFound(res);
        if (method !== 'PUT') return notFound(res);
        if (pull.state !== 'open') return notAllowed(res, 'Pull request is not open');
        const headTip = ctx.store.branchTip(repo, pull.headRef);
        const baseTip = ctx.store.branchTip(repo, pull.baseRef);
        if (headTip === null || baseTip === null) return notAllowed(res, 'Merge conflict');
        const check = mergeConflict(repo, headTip, baseTip);
        if (check.conflict !== null) return notAllowed(res, 'Merge conflict');
        const result = squashMerge(ctx.store, repo, pull);
        if (!('sha' in result)) return notAllowed(res, 'Merge conflict');
        pull.jsonCache = null;
        return sendJson(res, 200, { merged: true, sha: result.sha, message: `Merge pull request #${pull.number} from ${pull.headRef}` });
      }
      return notFound(res);
    }

    return notFound(res);
  }

  return notFound(res);
}
