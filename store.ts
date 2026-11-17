// store.ts — the in-memory data model, git object primitives, and the shared domain
// logic (trees, merges, diffs) the REST, GraphQL and MCP surfaces all use.
//
// No I/O here, no process state: one Store holds every repository. The entry is a single
// process, so a Map is the store; nothing is ever written to disk.

import { createHash } from 'node:crypto';

export const ZERO_OID = '0000000000000000000000000000000000000000';

/** The token owner's identity. The suite's scenario seed is fixed (wire.ts), so the viewer
 *  is always adaiversen (id 1000); the token in MAKEFUN_SHOP_TOKEN names this login. */
export const VIEWER = Object.freeze({
  id: 1000,
  login: 'adaiversen',
  name: 'ada iversen',
  email: 'adaiversen@example.invalid',
});

export type GitObjectType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObject {
  readonly type: GitObjectType;
  readonly data: Buffer;
}

export interface TreeEntry {
  readonly mode: string;
  readonly name: string;
  readonly oid: string;
}

// --------------------------------------------------------------------------------------------
// git object primitives (the same bytes git itself produces)
// --------------------------------------------------------------------------------------------

const TYPE_CODE: Readonly<Record<GitObjectType, number>> = { commit: 1, tree: 2, blob: 3, tag: 4 };
export const CODE_TYPE: Readonly<Record<number, GitObjectType>> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

export function hashObject(type: GitObjectType, data: Uint8Array): string {
  const body = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const hash = createHash('sha1');
  hash.update(Buffer.from(`${type} ${body.length}\u0000`, 'utf8'));
  hash.update(body);
  return hash.digest('hex');
}

const HEX40 = /^[0-9a-f]{40}$/;
export function isObjectId(value: string): boolean {
  return HEX40.test(value);
}

/** Parse a tree object into its entries, in stored order. */
export function parseTree(data: Uint8Array): TreeEntry[] {
  const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < buffer.length) {
    const space = buffer.indexOf(0x20, offset);
    if (space < 0) throw new Error('tree entry has no mode separator');
    const nul = buffer.indexOf(0x00, space + 1);
    if (nul < 0) throw new Error('tree entry has no name terminator');
    if (nul + 21 > buffer.length) throw new Error('tree entry has a truncated object id');
    const mode = buffer.subarray(offset, space).toString('ascii');
    const name = buffer.subarray(space + 1, nul).toString('utf8');
    const oid = buffer.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    offset = nul + 21;
  }
  return entries;
}

/** git's tree-entry sort: byte order of the name, a directory compared as if it ended in '/'. */
function compareTreeNames(a: { name: string; mode: string }, b: { name: string; mode: string }): number {
  const left = Buffer.from(a.mode === '40000' ? `${a.name}/` : a.name, 'utf8');
  const right = Buffer.from(b.mode === '40000' ? `${b.name}/` : b.name, 'utf8');
  return Buffer.compare(left, right);
}

/** Build a tree object from entries; entries are sorted the way git sorts them. */
export function buildTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort(compareTreeNames);
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\u0000`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

export interface CommitView {
  readonly tree: string;
  readonly parents: string[];
  readonly author: string;
  readonly committer: string;
  readonly message: string;
}

/** Parse a commit object. */
export function parseCommit(data: Uint8Array): CommitView {
  const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const blank = buffer.indexOf('\n\n');
  const headerEnd = blank < 0 ? buffer.length : blank;
  const headerText = buffer.subarray(0, headerEnd).toString('utf8');
  const message = blank < 0 ? '' : buffer.subarray(blank + 2).toString('utf8');
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of headerText.split('\n')) {
    if (!line) continue;
    const space = line.indexOf(' ');
    const key = space < 0 ? line : line.slice(0, space);
    const value = space < 0 ? '' : line.slice(space + 1);
    if (key === 'tree') tree = value;
    else if (key === 'parent') parents.push(value);
    else if (key === 'author') author = value;
    else if (key === 'committer') committer = value;
  }
  return { tree, parents, author, committer, message };
}

/** Build a commit object's bytes. */
export function buildCommit(fields: {
  tree: string;
  parents?: readonly string[];
  message: string;
  author?: string;
  committer?: string;
  timestamp?: number;
  timezone?: string;
}): Buffer {
  const timestamp = fields.timestamp ?? Math.floor(Date.now() / 1000);
  const timezone = fields.timezone ?? '+0000';
  const who = `${fields.author ?? `${VIEWER.name} <${VIEWER.email}>`} ${timestamp} ${timezone}`;
  const committer = `${fields.committer ?? `${VIEWER.name} <${VIEWER.email}>`} ${timestamp} ${timezone}`;
  const lines = [`tree ${fields.tree}`];
  for (const parent of fields.parents ?? []) lines.push(`parent ${parent}`);
  lines.push(`author ${who}`, `committer ${committer}`, '');
  return Buffer.from(`${lines.join('\n')}\n${fields.message}`, 'utf8');
}

export interface TagView {
  readonly object: string;
  readonly type: GitObjectType;
  readonly tag: string;
  readonly tagger: string;
  readonly message: string;
}

/** Parse an annotated tag object. */
export function parseTag(data: Uint8Array): TagView {
  const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const blank = buffer.indexOf('\n\n');
  const headerEnd = blank < 0 ? buffer.length : blank;
  const headers = new Map<string, string>();
  for (const line of buffer.subarray(0, headerEnd).toString('utf8').split('\n')) {
    if (!line) continue;
    const space = line.indexOf(' ');
    if (space < 0) continue;
    headers.set(line.slice(0, space), line.slice(space + 1));
  }
  return {
    object: headers.get('object') ?? '',
    type: (headers.get('type') ?? 'commit') as GitObjectType,
    tag: headers.get('tag') ?? '',
    tagger: headers.get('tagger') ?? '',
    message: blank < 0 ? '' : buffer.subarray(blank + 2).toString('utf8'),
  };
}

/** Build an annotated tag object's bytes. */
export function buildTag(fields: {
  object: string;
  type: GitObjectType;
  tag: string;
  message: string;
  tagger?: string;
  timestamp?: number;
  timezone?: string;
}): Buffer {
  const timestamp = fields.timestamp ?? Math.floor(Date.now() / 1000);
  const timezone = fields.timezone ?? '+0000';
  const tagger = `${fields.tagger ?? `${VIEWER.name} <${VIEWER.email}>`} ${timestamp} ${timezone}`;
  return Buffer.from(
    `object ${fields.object}\ntype ${fields.type}\ntag ${fields.tag}\ntagger ${tagger}\n\n${fields.message}`,
    'utf8',
  );
}

/** Every object reachable from `roots` (commit -> tree + parents, tree -> entries, tag -> target). */
export function collectReachable(
  roots: Iterable<string>,
  lookup: (oid: string) => GitObject | undefined,
  options: { allowMissing?: boolean } = {},
): Set<string> {
  const seen = new Set<string>();
  const queue: string[] = [];
  for (const root of roots) if (isObjectId(root)) queue.push(root);
  while (queue.length) {
    const oid = queue.pop()!;
    if (seen.has(oid)) continue;
    const object = lookup(oid);
    if (!object) {
      if (options.allowMissing) continue;
      throw new Error(`object ${oid} is missing from the store`);
    }
    seen.add(oid);
    if (object.type === 'commit') {
      const commit = parseCommit(object.data);
      queue.push(commit.tree);
      for (const parent of commit.parents) queue.push(parent);
    } else if (object.type === 'tag') {
      queue.push(parseTag(object.data).object);
    } else if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) {
        if (entry.mode === '160000') continue;
        queue.push(entry.oid);
      }
    }
  }
  return seen;
}

/** Peel a tag (recursively) to the commit it points at; a commit returns itself. */
export function peelToCommit(objects: Map<string, GitObject>, oid: string): string | null {
  let current = oid;
  for (let depth = 0; depth < 10; depth += 1) {
    const object = objects.get(current);
    if (!object) return null;
    if (object.type === 'commit') return current;
    if (object.type === 'tag') {
      current = parseTag(object.data).object;
      continue;
    }
    return null;
  }
  return null;
}

/** True when `ancestor` is reachable from `descendant` through parent links (or equal). */
export function isAncestor(objects: Map<string, GitObject>, ancestor: string, descendant: string): boolean {
  if (ancestor === descendant) return true;
  const seen = new Set<string>();
  const queue = [descendant];
  while (queue.length) {
    const oid = queue.pop()!;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const object = objects.get(oid);
    if (!object || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) {
      if (parent === ancestor) return true;
      queue.push(parent);
    }
  }
  return false;
}

/** The merge base of two commits: the newest common ancestor (first found walking both sides). */
export function findMergeBase(objects: Map<string, GitObject>, a: string, b: string): string | null {
  if (a === b) return a;
  const ancestorsA = new Set<string>();
  const queueA = [a];
  while (queueA.length) {
    const oid = queueA.pop()!;
    if (ancestorsA.has(oid)) continue;
    ancestorsA.add(oid);
    const object = objects.get(oid);
    if (!object || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) queueA.push(parent);
  }
  const queueB = [b];
  const seenB = new Set<string>();
  while (queueB.length) {
    const oid = queueB.pop()!;
    if (seenB.has(oid)) continue;
    seenB.add(oid);
    if (ancestorsA.has(oid)) return oid;
    const object = objects.get(oid);
    if (!object || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) queueB.push(parent);
  }
  return null;
}

// --------------------------------------------------------------------------------------------
// tree navigation (paths are '/'-separated, no leading slash)
// --------------------------------------------------------------------------------------------

function splitPath(path: string): string[] {
  return path.split('/').filter((segment) => segment !== '' && segment !== '.' && segment !== '..');
}

/** The blob oid at `path` in the tree rooted at `rootTreeOid`, or null. */
export function blobAtPath(objects: Map<string, GitObject>, rootTreeOid: string, path: string): string | null {
  const segments = splitPath(path);
  let treeOid: string | null = rootTreeOid;
  for (let index = 0; index < segments.length; index += 1) {
    if (treeOid === null) return null;
    const tree = objects.get(treeOid);
    if (!tree || tree.type !== 'tree') return null;
    const entry = parseTree(tree.data).find((candidate) => candidate.name === segments[index]);
    if (!entry) return null;
    if (index === segments.length - 1) return entry.mode === '40000' ? null : entry.oid;
    if (entry.mode !== '40000') return null;
    treeOid = entry.oid;
  }
  return null;
}

/** The entries of the directory at `path` in the tree rooted at `rootTreeOid`, or null. */
export function dirEntriesAtPath(
  objects: Map<string, GitObject>,
  rootTreeOid: string,
  path: string,
): TreeEntry[] | null {
  const segments = splitPath(path);
  let treeOid: string | null = rootTreeOid;
  for (const segment of segments) {
    if (treeOid === null) return null;
    const tree = objects.get(treeOid);
    if (!tree || tree.type !== 'tree') return null;
    const entry = parseTree(tree.data).find((candidate) => candidate.name === segment);
    if (!entry || entry.mode !== '40000') return null;
    treeOid = entry.oid;
  }
  if (treeOid === null) return null;
  const tree = objects.get(treeOid);
  if (!tree || tree.type !== 'tree') return null;
  return parseTree(tree.data);
}

/** Flatten a tree into path -> {oid, mode} (files and dirs), recursively. */
export function flattenTree(
  objects: Map<string, GitObject>,
  rootTreeOid: string,
): Map<string, { oid: string; mode: string }> {
  const out = new Map<string, { oid: string; mode: string }>();
  const walk = (treeOid: string, prefix: string): void => {
    const tree = objects.get(treeOid);
    if (!tree || tree.type !== 'tree') return;
    for (const entry of parseTree(tree.data)) {
      const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      out.set(path, { oid: entry.oid, mode: entry.mode });
      if (entry.mode === '40000') walk(entry.oid, path);
    }
  };
  walk(rootTreeOid, '');
  return out;
}

/** Store an object, returning its id. */
export function putObject(objects: Map<string, GitObject>, type: GitObjectType, data: Buffer): string {
  const oid = hashObject(type, data);
  if (!objects.has(oid)) objects.set(oid, { type, data });
  return oid;
}

/**
 * A new root tree with `path` set to `blobOid` (creating intermediate dirs), storing every
 * new tree object. `rootTreeOid` may be null (an empty tree).
 */
export function setPathInTree(
  objects: Map<string, GitObject>,
  rootTreeOid: string | null,
  path: string,
  blobOid: string,
): string {
  const segments = splitPath(path);
  const build = (treeOid: string | null, index: number): string => {
    const entries: TreeEntry[] =
      treeOid === null ? [] : parseTree(objects.get(treeOid)?.data ?? Buffer.alloc(0));
    const kept = entries.filter((entry) => entry.name !== segments[index]);
    if (index === segments.length - 1) {
      kept.push({ mode: '100644', name: segments[index]!, oid: blobOid });
    } else {
      const existing = entries.find((entry) => entry.name === segments[index] && entry.mode === '40000');
      kept.push({
        mode: '40000',
        name: segments[index]!,
        oid: build(existing ? existing.oid : null, index + 1),
      });
    }
    return putObject(objects, 'tree', buildTree(kept));
  };
  return build(rootTreeOid, 0);
}

/** A new root tree with `path` removed (empty dirs pruned), or null when the tree is empty. */
export function removePathFromTree(
  objects: Map<string, GitObject>,
  rootTreeOid: string,
  path: string,
): string | null {
  const segments = splitPath(path);
  const build = (treeOid: string, index: number): string | null => {
    const entries = parseTree(objects.get(treeOid)?.data ?? Buffer.alloc(0));
    if (index === segments.length - 1) {
      const kept = entries.filter((entry) => entry.name !== segments[index]);
      return kept.length === 0 ? null : putObject(objects, 'tree', buildTree(kept));
    }
    const kept: TreeEntry[] = [];
    for (const entry of entries) {
      if (entry.name !== segments[index]) {
        kept.push(entry);
        continue;
      }
      if (entry.mode !== '40000') continue;
      const child = build(entry.oid, index + 1);
      if (child !== null) kept.push({ mode: '40000', name: entry.name, oid: child });
    }
    return kept.length === 0 ? null : putObject(objects, 'tree', buildTree(kept));
  };
  return build(rootTreeOid, 0);
}

/** The files that differ between two trees: added / removed / modified, with blob oids. */
export function diffTrees(
  objects: Map<string, GitObject>,
  baseTreeOid: string | null,
  headTreeOid: string | null,
): Array<{ path: string; status: 'added' | 'removed' | 'modified'; oldOid: string | null; newOid: string | null }> {
  const base = baseTreeOid === null ? new Map() : flattenTree(objects, baseTreeOid);
  const head = headTreeOid === null ? new Map() : flattenTree(objects, headTreeOid);
  const out: Array<{ path: string; status: 'added' | 'removed' | 'modified'; oldOid: string | null; newOid: string | null }> = [];
  const paths = new Set([...base.keys(), ...head.keys()]);
  for (const path of paths) {
    const b = base.get(path);
    const h = head.get(path);
    if (b && b.mode === '40000') continue;
    if (h && h.mode === '40000') continue;
    if (b && !h) out.push({ path, status: 'removed', oldOid: b.oid, newOid: null });
    else if (!b && h) out.push({ path, status: 'added', oldOid: null, newOid: h.oid });
    else if (b && h && b.oid !== h.oid) out.push({ path, status: 'modified', oldOid: b.oid, newOid: h.oid });
  }
  out.sort((x, y) => (x.path < y.path ? -1 : x.path > y.path ? 1 : 0));
  return out;
}

// --------------------------------------------------------------------------------------------
// the repository model
// --------------------------------------------------------------------------------------------

export interface IssueComment {
  readonly id: number;
  readonly body: string;
  readonly createdSeq: number;
}

export interface Issue {
  readonly id: number;
  readonly number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  readonly createdSeq: number;
  updatedSeq: number;
  comments: IssueComment[];
  /** Cached serialised REST body as UTF-8 bytes; cleared on any change. */
  jsonCache: Buffer | null;
}

export interface Label {
  readonly name: string;
  color: string;
}

export interface PullRequest {
  readonly id: number;
  readonly number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  readonly headRef: string;
  readonly baseRef: string;
  merged: boolean;
  mergedAt: string | null;
  mergeSha: string | null;
  readonly createdSeq: number;
  updatedSeq: number;
  jsonCache: string | null;
}

/** One cached fetch answer: the pack bytes (null when nothing is new) and the shallow lines. */
export interface FetchCacheEntry {
  readonly pack: Buffer | null;
  readonly shallow: string[];
  readonly unshallow: string[];
}

export interface Repo {
  readonly id: number;
  readonly owner: string;
  readonly name: string;
  description: string;
  private: boolean;
  readonly defaultBranch: string;
  readonly createdSeq: number;
  objects: Map<string, GitObject>;
  refs: Map<string, string>;
  issues: Map<number, Issue>;
  pulls: Map<number, PullRequest>;
  labels: Map<string, Label>;
  nextNumber: number;
  nextCommentId: number;
  /** Cached fetch answers per fetch key; cleared on any object/ref change. */
  packCache: Map<string, FetchCacheEntry>;
  /** Cached serialised REST repo body; cleared on any change. */
  jsonCache: string | null;
}

export class Store {
  repos = new Map<string, Repo>();
  nextRepoId = 1;
  nextIssueId = 1;
  nextPullId = 1;
  seq = 0;

  key(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(this.key(owner, name));
  }

  listRepos(owner: string): Repo[] {
    const out: Repo[] = [];
    for (const repo of this.repos.values()) if (repo.owner === owner) out.push(repo);
    out.sort((a, b) => a.createdSeq - b.createdSeq);
    return out;
  }

  createRepo(name: string, isPrivate: boolean, description: string): Repo | null {
    if (this.repos.has(this.key(VIEWER.login, name))) return null;
    const repo: Repo = {
      id: this.nextRepoId++,
      owner: VIEWER.login,
      name,
      description,
      private: isPrivate,
      defaultBranch: 'main',
      createdSeq: ++this.seq,
      objects: new Map(),
      refs: new Map(),
      issues: new Map(),
      pulls: new Map(),
      labels: new Map(),
      nextNumber: 1,
      nextCommentId: 1,
      packCache: new Map(),
      jsonCache: null,
    };
    this.repos.set(this.key(repo.owner, name), repo);
    return repo;
  }

  deleteRepo(owner: string, name: string): boolean {
    return this.repos.delete(this.key(owner, name));
  }

  /** The tip of a branch, or null when the branch does not exist. */
  branchTip(repo: Repo, branch: string): string | null {
    return repo.refs.get(`refs/heads/${branch}`) ?? null;
  }

  /** The tip commit's tree oid for a branch, or null when the branch has no commit. */
  branchTree(repo: Repo, branch: string): string | null {
    const tip = this.branchTip(repo, branch);
    if (tip === null) return null;
    const object = repo.objects.get(tip);
    if (!object || object.type !== 'commit') return null;
    return parseCommit(object.data).tree;
  }

  /** Invalidate every cache that depends on the repo's objects or refs. */
  invalidateGit(repo: Repo): void {
    repo.packCache.clear();
    repo.jsonCache = null;
  }

  createIssue(repo: Repo, title: string, body: string, labels: string[]): Issue {
    const issue: Issue = {
      id: this.nextIssueId++,
      number: repo.nextNumber++,
      title,
      body,
      state: 'open',
      labels: [...labels],
      createdSeq: ++this.seq,
      updatedSeq: this.seq,
      comments: [],
      jsonCache: null,
    };
    repo.issues.set(issue.number, issue);
    return issue;
  }

  createPull(repo: Repo, title: string, body: string, headRef: string, baseRef: string): PullRequest {
    const pull: PullRequest = {
      id: this.nextPullId++,
      number: repo.nextNumber++,
      title,
      body,
      state: 'open',
      headRef,
      baseRef,
      merged: false,
      mergedAt: null,
      mergeSha: null,
      createdSeq: ++this.seq,
      updatedSeq: this.seq,
      jsonCache: null,
    };
    repo.pulls.set(pull.number, pull);
    return pull;
  }
}

// --------------------------------------------------------------------------------------------
// contents: commit one file (create/update) or delete one file on a branch
// --------------------------------------------------------------------------------------------

/**
 * Commit `content` at `path` on `branch`. When the branch does not exist it is created from
 * the default branch tip (the contents API's branch-creation path). Returns the commit sha
 * and the blob sha, plus whether the file already existed on that branch.
 */
export function commitFile(
  store: Store,
  repo: Repo,
  branch: string,
  path: string,
  content: Buffer,
  message: string,
): { commitSha: string; blobSha: string; existed: boolean } {
  const tip = store.branchTip(repo, branch);
  const baseTree = tip === null ? store.branchTree(repo, repo.defaultBranch) : store.branchTree(repo, branch);
  const existed = baseTree !== null && blobAtPath(repo.objects, baseTree, path) !== null;
  const blobSha = putObject(repo.objects, 'blob', content);
  const tree = setPathInTree(repo.objects, baseTree, path, blobSha);
  const parents = tip === null ? (store.branchTip(repo, repo.defaultBranch) !== null && branch !== repo.defaultBranch ? [store.branchTip(repo, repo.defaultBranch)!] : []) : [tip];
  const commitSha = putObject(
    repo.objects,
    'commit',
    buildCommit({ tree, parents, message }),
  );
  repo.refs.set(`refs/heads/${branch}`, commitSha);
  store.invalidateGit(repo);
  return { commitSha, blobSha, existed };
}

/** Commit the deletion of `path` on `branch`. Returns the commit sha, or null when absent. */
export function deleteFile(
  store: Store,
  repo: Repo,
  branch: string,
  path: string,
  message: string,
): string | null {
  const tip = store.branchTip(repo, branch);
  if (tip === null) return null;
  const tree = store.branchTree(repo, branch);
  if (tree === null) return null;
  if (blobAtPath(repo.objects, tree, path) === null) return null;
  const newTree = removePathFromTree(repo.objects, tree, path);
  const emptyTree = putObject(repo.objects, 'tree', buildTree([]));
  const commitSha = putObject(
    repo.objects,
    'commit',
    buildCommit({ tree: newTree ?? emptyTree, parents: [tip], message }),
  );
  repo.refs.set(`refs/heads/${branch}`, commitSha);
  store.invalidateGit(repo);
  return commitSha;
}

// --------------------------------------------------------------------------------------------
// merges
// --------------------------------------------------------------------------------------------

export interface MergeCheck {
  /** null when the merge can proceed; a reason string when it cannot. */
  conflict: string | null;
  /** The merge base, when one exists. */
  base: string | null;
}

/** Would a squash merge of `headTip` into `baseTip` conflict? */
export function mergeConflict(
  repo: Repo,
  headTip: string,
  baseTip: string,
): MergeCheck {
  const base = findMergeBase(repo.objects, headTip, baseTip);
  if (base === null) return { conflict: 'no merge base', base: null };
  const baseTree = parseCommit(repo.objects.get(base)!.data).tree;
  const headTree = parseCommit(repo.objects.get(headTip)!.data).tree;
  const intoTree = parseCommit(repo.objects.get(baseTip)!.data).tree;
  const headChanges = diffTrees(repo.objects, baseTree, headTree);
  const intoChanges = new Map(diffTrees(repo.objects, baseTree, intoTree).map((change) => [change.path, change]));
  for (const change of headChanges) {
    const other = intoChanges.get(change.path);
    if (!other) continue;
    if (other.newOid !== change.newOid) return { conflict: `conflicting change to ${change.path}`, base };
  }
  return { conflict: null, base };
}

/**
 * Squash-merge a pull request: one commit on the base branch whose tree is the head tip's
 * tree, parented on the base tip. Returns the merge sha, or a conflict reason.
 */
export function squashMerge(
  store: Store,
  repo: Repo,
  pull: PullRequest,
): { sha: string } | { conflict: string } {
  const headTip = store.branchTip(repo, pull.headRef);
  const baseTip = store.branchTip(repo, pull.baseRef);
  if (headTip === null || baseTip === null) return { conflict: 'the head or base branch is missing' };
  const check = mergeConflict(repo, headTip, baseTip);
  if (check.conflict !== null) return { conflict: check.conflict };
  const headTree = parseCommit(repo.objects.get(headTip)!.data).tree;
  const message = `Merge pull request #${pull.number} from ${pull.headRef}\n\n${pull.title}\n`;
  const sha = putObject(
    repo.objects,
    'commit',
    buildCommit({ tree: headTree, parents: [baseTip], message }),
  );
  repo.refs.set(`refs/heads/${pull.baseRef}`, sha);
  pull.merged = true;
  pull.state = 'closed';
  pull.mergedAt = new Date().toISOString();
  pull.mergeSha = sha;
  pull.updatedSeq = ++store.seq;
  pull.jsonCache = null;
  store.invalidateGit(repo);
  return { sha };
}

/** Whether a pull request can merge cleanly right now (the GraphQL mergeable field). */
export function mergeableState(repo: Repo, pull: PullRequest): 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN' {
  if (pull.merged) return 'MERGEABLE';
  const headTip = repo.refs.get(`refs/heads/${pull.headRef}`);
  const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`);
  if (!headTip || !baseTip) return 'UNKNOWN';
  const head = repo.objects.get(headTip);
  const base = repo.objects.get(baseTip);
  if (!head || head.type !== 'commit' || !base || base.type !== 'commit') return 'UNKNOWN';
  if (isAncestor(repo.objects, baseTip, headTip)) return 'MERGEABLE';
  return mergeConflict(repo, headTip, baseTip).conflict === null ? 'MERGEABLE' : 'CONFLICTING';
}

/** A simple line diff (common prefix/suffix) for the pull files' change counts. */
export function lineDiff(oldText: string, newText: string): { additions: number; deletions: number } {
  const oldLines = oldText === '' ? [] : oldText.split('\n');
  const newLines = newText === '' ? [] : newText.split('\n');
  let prefix = 0;
  while (prefix < oldLines.length && prefix < newLines.length && oldLines[prefix] === newLines[prefix]) prefix += 1;
  let suffix = 0;
  while (
    suffix < oldLines.length - prefix &&
    suffix < newLines.length - prefix &&
    oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]
  ) {
    suffix += 1;
  }
  return {
    additions: newLines.length - prefix - suffix,
    deletions: oldLines.length - prefix - suffix,
  };
}
