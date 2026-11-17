// graphql.ts — GraphQL v4 (/api/graphql) for the documents gh and github-mcp-server actually
// send. A small hand-written parser + executor for the known query/mutation shapes, with
// Relay global ids (opaque, stable base64), __type introspection, cursor pagination and
// operation batching. A GraphQL-level failure is an HTTP 200 carrying an `errors` array.

import {
  VIEWER,
  diffTrees,
  mergeableState,
  parseCommit,
  squashMerge,
  type Issue,
  type PullRequest,
  type Repo,
  type Store,
} from './store.ts';
import { sendJson } from './http.ts';
import type { ServerResponse } from 'node:http';

// --------------------------------------------------------------------------------------------
// global ids: opaque, stable, base64url of a typed key
// --------------------------------------------------------------------------------------------

function globalId(kind: string, ...parts: Array<string | number>): string {
  return Buffer.from([kind, ...parts.map(String)].join(':'), 'utf8').toString('base64url');
}

function decodeGlobalId(id: unknown): { kind: string; parts: string[] } | null {
  if (typeof id !== 'string' || id === '') return null;
  try {
    const text = Buffer.from(id, 'base64url').toString('utf8');
    const parts = text.split(':');
    const kind = parts[0];
    if (kind === undefined || parts.length < 2) return null;
    return { kind, parts: parts.slice(1) };
  } catch {
    return null;
  }
}

function repoGlobalId(repo: Repo): string {
  return globalId('Repository', repo.id);
}

function issueGlobalId(repo: Repo, issue: Issue): string {
  return globalId('Issue', repo.id, issue.number);
}

function pullGlobalId(repo: Repo, pull: PullRequest): string {
  return globalId('PullRequest', repo.id, pull.number);
}

function commentGlobalId(repo: Repo, issue: Issue, commentId: number): string {
  return globalId('IssueComment', repo.id, issue.number, commentId);
}

/** Find the object a global id names (Repository, Issue or PullRequest). */
function resolveGlobalId(store: Store, id: unknown): { type: string; repo: Repo; issue?: Issue; pull?: PullRequest } | null {
  const decoded = decodeGlobalId(id);
  if (decoded === null) return null;
  const repoId = Number(decoded.parts[0]);
  if (!Number.isInteger(repoId)) return null;
  const repo = [...store.repos.values()].find((r) => r.id === repoId);
  if (repo === undefined) return null;
  if (decoded.kind === 'Repository') return { type: 'Repository', repo };
  if (decoded.kind === 'Issue') {
    const issue = repo.issues.get(Number(decoded.parts[1]));
    return issue === undefined ? null : { type: 'Issue', repo, issue };
  }
  if (decoded.kind === 'PullRequest') {
    const pull = repo.pulls.get(Number(decoded.parts[1]));
    return pull === undefined ? null : { type: 'PullRequest', repo, pull };
  }
  return null;
}

// --------------------------------------------------------------------------------------------
// the schema surface gh feature-detects (the __type introspection answers)
// --------------------------------------------------------------------------------------------

const TYPE_FIELDS: Readonly<Record<string, readonly string[]>> = {
  Query: ['viewer', 'repository', 'node', '__type'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'],
  User: ['id', 'login', 'name', 'email'],
  Repository: [
    'id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission',
    'hasIssuesEnabled', 'description', 'private', 'issue', 'issues', 'pullRequests', 'pullRequest',
    'url', 'createdAt', 'updatedAt',
  ],
  Issue: ['id', 'number', 'title', 'state', 'body', 'author', 'createdAt', 'updatedAt', 'comments', 'labels', 'repository', 'url'],
  PullRequest: [
    'id', 'number', 'title', 'body', 'state', 'merged', 'mergedAt', 'headRefName', 'baseRefName',
    'headRefOid', 'baseRefOid', 'mergeable', 'files', 'author', 'createdAt', 'updatedAt',
  ],
  IssueConnection: ['nodes', 'pageInfo', 'totalCount'],
  PullRequestConnection: ['nodes', 'pageInfo', 'totalCount'],
  PullRequestChangedFileConnection: ['nodes', 'pageInfo', 'totalCount'],
  PullRequestChangedFile: ['path', 'additions', 'deletions', 'changeType'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'],
  Ref: ['name', 'target'],
  IssueComment: ['id', 'body', 'author', 'createdAt'],
  IssueCommentEdge: ['node', 'cursor'],
  IssueCommentConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
};

const TYPE_ENUM_VALUES: Readonly<Record<string, readonly string[]>> = {
  SearchType: ['ISSUE', 'PULL_REQUEST', 'REPOSITORY', 'USER', 'DISCUSSION', 'COMMIT', 'CODE', 'TOPIC', 'MARKETPLACE_LISTING'],
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
  OrderDirection: ['ASC', 'DESC'],
  PullRequestMergeMethod: ['MERGE', 'SQUASH', 'REBASE'],
};

// --------------------------------------------------------------------------------------------
// a tiny GraphQL parser (documents only — no schema validation beyond the field lookups)
// --------------------------------------------------------------------------------------------

type ValueNode =
  | { kind: 'variable'; name: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; values: ValueNode[] }
  | { kind: 'object'; fields: Array<{ name: string; value: ValueNode }> };

interface FieldNode {
  readonly kind: 'field';
  readonly alias: string | null;
  readonly name: string;
  readonly args: Array<{ name: string; value: ValueNode }>;
  readonly selectionSet: SelectionNode[] | null;
}

interface FragmentNode {
  readonly kind: 'fragment';
  readonly typeCondition: string | null;
  readonly selectionSet: SelectionNode[];
}

type SelectionNode = FieldNode | FragmentNode;

interface OperationNode {
  readonly type: 'query' | 'mutation';
  readonly name: string | null;
  readonly variables: Array<{ name: string; type: string; defaultValue: ValueNode | null }>;
  readonly selectionSet: SelectionNode[];
}

interface Token {
  readonly kind: 'name' | 'string' | 'number' | 'punct' | 'spread';
  readonly value: string;
}

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < source.length) {
    const ch = source[i]!;
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',') {
      i += 1;
      continue;
    }
    if (ch === '#') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '.' && source.slice(i, i + 3) === '...') {
      tokens.push({ kind: 'spread', value: '...' });
      i += 3;
      continue;
    }
    if ('{}()[]:!=$'.includes(ch)) {
      tokens.push({ kind: 'punct', value: ch });
      i += 1;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      let out = '';
      while (j < source.length && source[j] !== '"') {
        if (source[j] === '\\' && j + 1 < source.length) {
          const escaped = source[j + 1]!;
          out += escaped === 'n' ? '\n' : escaped === 't' ? '\t' : escaped === 'r' ? '\r' : escaped;
          j += 2;
        } else {
          out += source[j];
          j += 1;
        }
      }
      tokens.push({ kind: 'string', value: out });
      i = j + 1;
      continue;
    }
    if (/[0-9-]/.test(ch)) {
      let j = i;
      while (j < source.length && /[0-9.eE+-]/.test(source[j]!)) j += 1;
      tokens.push({ kind: 'number', value: source.slice(i, j) });
      i = j;
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      let j = i;
      while (j < source.length && /[A-Za-z0-9_]/.test(source[j]!)) j += 1;
      tokens.push({ kind: 'name', value: source.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(ch)} in the GraphQL document`);
  }
  return tokens;
}

class Parser {
  private pos = 0;
  private readonly tokens: Token[];

  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token | undefined {
    return this.tokens[this.pos];
  }

  private next(): Token {
    const token = this.tokens[this.pos];
    if (token === undefined) throw new Error('unexpected end of the GraphQL document');
    this.pos += 1;
    return token;
  }

  private expectPunct(value: string): void {
    const token = this.next();
    if (token.kind !== 'punct' || token.value !== value) throw new Error(`expected ${value} in the GraphQL document, got ${token.value}`);
  }

  private expectName(): string {
    const token = this.next();
    if (token.kind !== 'name') throw new Error(`expected a name in the GraphQL document, got ${token.value}`);
    return token.value;
  }

  parseDocument(): OperationNode {
    const first = this.peek();
    if (first === undefined) throw new Error('empty GraphQL document');
    let type: 'query' | 'mutation' = 'query';
    let name: string | null = null;
    if (first.kind === 'name' && (first.value === 'query' || first.value === 'mutation')) {
      type = this.next().value as 'query' | 'mutation';
      const next = this.peek();
      if (next !== undefined && next.kind === 'name') name = this.next().value;
    }
    const variables: OperationNode['variables'] = [];
    if (this.peek()?.value === '(') {
      this.next();
      while (this.peek() !== undefined && this.peek()!.value !== ')') {
        this.expectPunct('$');
        const varName = this.expectName();
        this.expectPunct(':');
        // The variable type: a name, possibly wrapped in [ ] and !.
        let varType = '';
        while (this.peek() !== undefined && this.peek()!.value !== ')' && this.peek()!.value !== '=' && this.peek()!.value !== '$') {
          varType += this.next().value;
        }
        let defaultValue: ValueNode | null = null;
        if (this.peek()?.value === '=') {
          this.next();
          defaultValue = this.parseValue();
        }
        variables.push({ name: varName, type: varType, defaultValue });
      }
      this.expectPunct(')');
    }
    const selectionSet = this.parseSelectionSet();
    return { type, name, variables, selectionSet };
  }

  private parseSelectionSet(): SelectionNode[] {
    this.expectPunct('{');
    const selections: SelectionNode[] = [];
    while (this.peek() !== undefined && this.peek()!.value !== '}') {
      selections.push(this.parseSelection());
    }
    this.expectPunct('}');
    return selections;
  }

  private parseSelection(): SelectionNode {
    if (this.peek()?.kind === 'spread') {
      this.next();
      let typeCondition: string | null = null;
      if (this.peek()?.kind === 'name' && this.peek()!.value === 'on') {
        this.next();
        typeCondition = this.expectName();
      }
      return { kind: 'fragment', typeCondition, selectionSet: this.parseSelectionSet() };
    }
    const first = this.expectName();
    let alias: string | null = null;
    let name = first;
    if (this.peek()?.value === ':') {
      this.next();
      alias = first;
      name = this.expectName();
    }
    const args: FieldNode['args'] = [];
    if (this.peek()?.value === '(') {
      this.next();
      while (this.peek() !== undefined && this.peek()!.value !== ')') {
        const argName = this.expectName();
        this.expectPunct(':');
        args.push({ name: argName, value: this.parseValue() });
      }
      this.expectPunct(')');
    }
    const selectionSet = this.peek()?.value === '{' ? this.parseSelectionSet() : null;
    return { kind: 'field', alias, name, args, selectionSet };
  }

  private parseValue(): ValueNode {
    const token = this.next();
    if (token.kind === 'punct' && token.value === '$') return { kind: 'variable', name: this.expectName() };
    if (token.kind === 'string') return { kind: 'string', value: token.value };
    if (token.kind === 'number') {
      const value = Number(token.value);
      return token.value.includes('.') || token.value.includes('e') || token.value.includes('E')
        ? { kind: 'float', value }
        : { kind: 'int', value };
    }
    if (token.kind === 'punct' && token.value === '[') {
      const values: ValueNode[] = [];
      while (this.peek() !== undefined && this.peek()!.value !== ']') values.push(this.parseValue());
      this.expectPunct(']');
      return { kind: 'list', values };
    }
    if (token.kind === 'punct' && token.value === '{') {
      const fields: Array<{ name: string; value: ValueNode }> = [];
      while (this.peek() !== undefined && this.peek()!.value !== '}') {
        const name = this.expectName();
        this.expectPunct(':');
        fields.push({ name, value: this.parseValue() });
      }
      this.expectPunct('}');
      return { kind: 'object', fields };
    }
    if (token.kind === 'name') {
      if (token.value === 'true') return { kind: 'boolean', value: true };
      if (token.value === 'false') return { kind: 'boolean', value: false };
      if (token.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: token.value };
    }
    throw new Error(`unexpected token ${token.value} in a GraphQL value`);
  }
}

/** Resolve a value node against the operation's variables. */
function valueOf(node: ValueNode, variables: Readonly<Record<string, unknown>>): unknown {
  switch (node.kind) {
    case 'variable':
      return variables[node.name] ?? null;
    case 'string':
    case 'int':
    case 'float':
    case 'boolean':
      return node.value;
    case 'null':
      return null;
    case 'enum':
      return node.value;
    case 'list':
      return node.values.map((v) => valueOf(v, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const field of node.fields) out[field.name] = valueOf(field.value, variables);
      return out;
    }
  }
}

function argValue(field: FieldNode, name: string, variables: Readonly<Record<string, unknown>>): unknown {
  const arg = field.args.find((a) => a.name === name);
  return arg === undefined ? undefined : valueOf(arg.value, variables);
}

// --------------------------------------------------------------------------------------------
// the executor
// --------------------------------------------------------------------------------------------

interface ExecContext {
  store: Store;
  variables: Readonly<Record<string, unknown>>;
  errors: Array<{ message: string; path?: Array<string | number> }>;
}

/** A resolved object: its GraphQL type and the source record the fields read from. */
interface TypedValue {
  readonly __typename: string;
  readonly source: unknown;
}

function issueState(issue: Issue): 'OPEN' | 'CLOSED' {
  return issue.state === 'open' ? 'OPEN' : 'CLOSED';
}

function pullState(pull: PullRequest): 'OPEN' | 'CLOSED' | 'MERGED' {
  if (pull.merged) return 'MERGED';
  return pull.state === 'open' ? 'OPEN' : 'CLOSED';
}

function cursorForIssue(issue: Issue): string {
  return Buffer.from(`issue:${issue.number}`, 'utf8').toString('base64url');
}

function issueAfterCursor(cursor: unknown): number | null {
  if (typeof cursor !== 'string' || cursor === '') return null;
  try {
    const text = Buffer.from(cursor, 'base64url').toString('utf8');
    const match = /^issue:(\d+)$/.exec(text);
    return match === null ? null : Number.parseInt(match[1]!, 10);
  } catch {
    return null;
  }
}

/** Execute a selection set against a typed value, building the response object. */
function executeSelectionSet(ctx: ExecContext, typeName: string, source: unknown, selections: SelectionNode[], path: Array<string | number>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const selection of selections) {
    if (selection.kind === 'fragment') {
      if (selection.typeCondition !== null && selection.typeCondition !== typeName) continue;
      Object.assign(out, executeSelectionSet(ctx, typeName, source, selection.selectionSet, path));
      continue;
    }
    const key = selection.alias ?? selection.name;
    const value = resolveField(ctx, typeName, source, selection, [...path, key]);
    if (value === undefined) {
      // An unknown field: the error is recorded, the key reads null.
      ctx.errors.push({ message: `Cannot query field "${selection.name}" on type "${typeName}".`, path: [...path, key] });
      out[key] = null;
      continue;
    }
    if (selection.selectionSet === null) {
      out[key] = value;
      continue;
    }
    if (value === null) {
      out[key] = null;
      continue;
    }
    if (Array.isArray(value)) {
      out[key] = value.map((entry, index) =>
        entry !== null && typeof entry === 'object' && '__typename' in (entry as Record<string, unknown>)
          ? executeSelectionSet(ctx, (entry as TypedValue).__typename, (entry as TypedValue).source, selection.selectionSet!, [...path, key, index])
          : entry,
      );
      continue;
    }
    if (typeof value === 'object' && '__typename' in (value as Record<string, unknown>)) {
      out[key] = executeSelectionSet(ctx, (value as TypedValue).__typename, (value as TypedValue).source, selection.selectionSet, [...path, key]);
      continue;
    }
    out[key] = value;
  }
  return out;
}

function typed(typeName: string, source: unknown): TypedValue {
  return { __typename: typeName, source };
}

/** The field resolvers, by type. Returns undefined for a field the type does not hold. */
function resolveField(
  ctx: ExecContext,
  typeName: string,
  source: unknown,
  field: FieldNode,
  path: Array<string | number>,
): unknown {
  const { store, variables } = ctx;
  const arg = (name: string): unknown => argValue(field, name, variables);

  if (typeName === 'Query') {
    if (field.name === 'viewer') return typed('User', VIEWER);
    if (field.name === 'repository') {
      const owner = arg('owner');
      const name = arg('name');
      if (owner !== VIEWER.login || typeof name !== 'string') return null;
      const repo = store.getRepo(VIEWER.login, name);
      return repo === undefined ? null : typed('Repository', repo);
    }
    if (field.name === 'node') {
      const resolved = resolveGlobalId(store, arg('id'));
      if (resolved === null) return null;
      if (resolved.type === 'Repository') return typed('Repository', resolved.repo);
      if (resolved.type === 'Issue') return typed('Issue', { repo: resolved.repo, issue: resolved.issue! });
      if (resolved.type === 'PullRequest') return typed('PullRequest', { repo: resolved.repo, pull: resolved.pull! });
      return null;
    }
    if (field.name === '__type') {
      const name = arg('name');
      if (typeof name !== 'string') return null;
      return typed('__Type', { name });
    }
    return undefined;
  }

  if (typeName === 'Mutation') {
    const input = (arg('input') ?? {}) as Record<string, unknown>;
    if (field.name === 'createIssue') {
      const resolved = resolveGlobalId(store, input.repositoryId);
      if (resolved === null || resolved.type !== 'Repository') return null;
      const title = typeof input.title === 'string' ? input.title : '';
      const body = typeof input.body === 'string' ? input.body : '';
      const issue = store.createIssue(resolved.repo, title, body, []);
      return typed('CreateIssuePayload', { issue, repo: resolved.repo });
    }
    if (field.name === 'closeIssue') {
      const resolved = resolveGlobalId(store, input.issueId);
      if (resolved === null || resolved.type !== 'Issue') return null;
      const issue = resolved.issue!;
      issue.state = 'closed';
      issue.updatedSeq = ++store.seq;
      issue.jsonCache = null;
      return typed('CloseIssuePayload', { issue, repo: resolved.repo });
    }
    if (field.name === 'createPullRequest') {
      const resolved = resolveGlobalId(store, input.repositoryId);
      if (resolved === null || resolved.type !== 'Repository') return null;
      const repo = resolved.repo;
      const headRef = typeof input.headRefName === 'string' ? input.headRefName : '';
      const baseRef = typeof input.baseRefName === 'string' ? input.baseRefName : '';
      const title = typeof input.title === 'string' ? input.title : '';
      const body = typeof input.body === 'string' ? input.body : '';
      if (!repo.refs.has(`refs/heads/${headRef}`) || !repo.refs.has(`refs/heads/${baseRef}`)) return null;
      const pull = store.createPull(repo, title, body, headRef, baseRef);
      return typed('CreatePullRequestPayload', { pull, repo });
    }
    if (field.name === 'mergePullRequest') {
      const resolved = resolveGlobalId(store, input.pullRequestId);
      if (resolved === null || resolved.type !== 'PullRequest') return null;
      const pull = resolved.pull!;
      if (pull.state !== 'open') return typed('MergePullRequestPayload', { pull, repo: resolved.repo });
      const result = squashMerge(store, resolved.repo, pull);
      if (!('sha' in result)) return typed('MergePullRequestPayload', { pull, repo: resolved.repo });
      return typed('MergePullRequestPayload', { pull, repo: resolved.repo });
    }
    if (field.name === 'addComment') {
      const resolved = resolveGlobalId(store, input.subjectId);
      if (resolved === null || resolved.type !== 'Issue') return null;
      const issue = resolved.issue!;
      const repo = resolved.repo;
      const body = typeof input.body === 'string' ? input.body : '';
      const comment = { id: repo.nextCommentId++, body, createdSeq: ++store.seq };
      issue.comments.push(comment);
      issue.updatedSeq = ++store.seq;
      return typed('AddCommentPayload', { comment, issue, repo });
    }
    return undefined;
  }

  if (typeName === 'User') {
    const user = source as typeof VIEWER;
    if (field.name === 'login') return user.login;
    if (field.name === 'id') return globalId('User', user.id);
    if (field.name === 'name') return user.name;
    if (field.name === 'email') return user.email;
    return undefined;
  }

  if (typeName === 'Repository') {
    const repo = source as Repo;
    if (field.name === 'id') return repoGlobalId(repo);
    if (field.name === 'databaseId') return repo.id;
    if (field.name === 'name') return repo.name;
    if (field.name === 'nameWithOwner') return `${VIEWER.login}/${repo.name}`;
    if (field.name === 'owner') return typed('User', VIEWER);
    if (field.name === 'defaultBranchRef') {
      const tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
      return tip === undefined ? null : typed('Ref', { name: repo.defaultBranch, oid: tip });
    }
    if (field.name === 'viewerPermission') return 'ADMIN';
    if (field.name === 'hasIssuesEnabled') return true;
    if (field.name === 'description') return repo.description;
    if (field.name === 'private') return repo.private;
    if (field.name === 'url') return `https://example.invalid/${VIEWER.login}/${repo.name}`;
    if (field.name === 'issue') {
      const number = arg('number');
      if (typeof number !== 'number') return null;
      const issue = repo.issues.get(number);
      return issue === undefined ? null : typed('Issue', { repo, issue });
    }
    if (field.name === 'issues') {
      const first = typeof arg('first') === 'number' ? (arg('first') as number) : 30;
      const states = arg('states');
      const orderBy = (arg('orderBy') ?? {}) as Record<string, unknown>;
      const after = arg('after');
      let issues = [...repo.issues.values()];
      if (Array.isArray(states) && states.length > 0) {
        const wanted = new Set(states.map((s) => String(s).toLowerCase()));
        issues = issues.filter((i) => wanted.has(i.state));
      }
      const direction = orderBy.direction === 'ASC' ? 1 : -1;
      const orderField = orderBy.field === 'UPDATED_AT' ? 'updated' : orderBy.field === 'COMMENTS' ? 'comments' : 'created';
      issues.sort((a, b) => {
        const left = orderField === 'updated' ? a.updatedSeq : orderField === 'comments' ? a.comments.length : a.createdSeq;
        const right = orderField === 'updated' ? b.updatedSeq : orderField === 'comments' ? b.comments.length : b.createdSeq;
        return (left - right) * direction;
      });
      const afterNumber = issueAfterCursor(after);
      if (afterNumber !== null) {
        const index = issues.findIndex((i) => i.number === afterNumber);
        if (index >= 0) issues = issues.slice(index + 1);
      }
      const page = issues.slice(0, first);
      const hasNextPage = issues.length > first;
      const endCursor = page.length > 0 ? cursorForIssue(page[page.length - 1]!) : null;
      return typed('IssueConnection', { nodes: page.map((issue) => typed('Issue', { repo, issue })), pageInfo: { hasNextPage, endCursor } });
    }
    if (field.name === 'pullRequests') {
      const first = typeof arg('first') === 'number' ? (arg('first') as number) : 30;
      const pulls = [...repo.pulls.values()].sort((a, b) => b.number - a.number).slice(0, first);
      return typed('PullRequestConnection', { nodes: pulls.map((pull) => typed('PullRequest', { repo, pull })) });
    }
    if (field.name === 'pullRequest') {
      const number = arg('number');
      if (typeof number !== 'number') return null;
      const pull = repo.pulls.get(number);
      return pull === undefined ? null : typed('PullRequest', { repo, pull });
    }
    return undefined;
  }

  if (typeName === 'Issue') {
    const { repo, issue } = source as { repo: Repo; issue: Issue };
    if (field.name === 'id') return issueGlobalId(repo, issue);
    if (field.name === 'number') return issue.number;
    if (field.name === 'title') return issue.title;
    if (field.name === 'state') return issueState(issue);
    if (field.name === 'body') return issue.body;
    if (field.name === 'author') return typed('User', VIEWER);
    if (field.name === 'labels') return typed('LabelConnection', { nodes: issue.labels.map((name) => typed('Label', { name })) });
    if (field.name === 'repository') return typed('Repository', repo);
    return undefined;
  }

  if (typeName === 'PullRequest') {
    const { repo, pull } = source as { repo: Repo; pull: PullRequest };
    if (field.name === 'id') return pullGlobalId(repo, pull);
    if (field.name === 'number') return pull.number;
    if (field.name === 'title') return pull.title;
    if (field.name === 'body') return pull.body;
    if (field.name === 'state') return pullState(pull);
    if (field.name === 'merged') return pull.merged;
    if (field.name === 'mergedAt') return pull.mergedAt;
    if (field.name === 'headRefName') return pull.headRef;
    if (field.name === 'baseRefName') return pull.baseRef;
    if (field.name === 'headRefOid') return store.branchTip(repo, pull.headRef);
    if (field.name === 'baseRefOid') return store.branchTip(repo, pull.baseRef);
    if (field.name === 'mergeable') return mergeableState(repo, pull);
    if (field.name === 'author') return typed('User', VIEWER);
    if (field.name === 'files') {
      const first = typeof arg('first') === 'number' ? (arg('first') as number) : 10;
      const headTip = store.branchTip(repo, pull.headRef);
      const baseTip = store.branchTip(repo, pull.baseRef);
      if (headTip === null || baseTip === null) return typed('PullRequestChangedFileConnection', { nodes: [] });
      const headTree = parseCommit(repo.objects.get(headTip)!.data).tree;
      const baseTree = parseCommit(repo.objects.get(baseTip)!.data).tree;
      const nodes = diffTrees(repo.objects, baseTree, headTree)
        .slice(0, first)
        .map((change) => typed('PullRequestChangedFile', { path: change.path }));
      return typed('PullRequestChangedFileConnection', { nodes });
    }
    return undefined;
  }

  if (typeName === 'IssueConnection' || typeName === 'PullRequestConnection' || typeName === 'PullRequestChangedFileConnection' || typeName === 'LabelConnection' || typeName === 'IssueCommentConnection') {
    const conn = source as { nodes: unknown[]; pageInfo?: { hasNextPage: boolean; endCursor: string | null } };
    if (field.name === 'nodes') return conn.nodes;
    if (field.name === 'edges') return conn.nodes.map((node) => typed('IssueCommentEdge', { node }));
    if (field.name === 'totalCount') return conn.nodes.length;
    if (field.name === 'pageInfo') {
      const pageInfo = conn.pageInfo ?? { hasNextPage: false, endCursor: null };
      return typed('PageInfo', pageInfo);
    }
    return undefined;
  }

  if (typeName === 'PageInfo') {
    const pageInfo = source as { hasNextPage: boolean; endCursor: string | null };
    if (field.name === 'hasNextPage') return pageInfo.hasNextPage;
    if (field.name === 'hasPreviousPage') return false;
    if (field.name === 'startCursor') return null;
    if (field.name === 'endCursor') return pageInfo.endCursor;
    return undefined;
  }

  if (typeName === 'PullRequestChangedFile') {
    const file = source as { path: string };
    if (field.name === 'path') return file.path;
    if (field.name === 'additions') return 1;
    if (field.name === 'deletions') return 0;
    if (field.name === 'changeType') return 'MODIFIED';
    return undefined;
  }

  if (typeName === 'Ref') {
    const ref = source as { name: string; oid: string };
    if (field.name === 'name') return ref.name;
    if (field.name === 'target') return typed('Commit', { oid: ref.oid });
    return undefined;
  }

  if (typeName === 'Label') {
    const label = source as { name: string };
    if (field.name === 'name') return label.name;
    return undefined;
  }

  if (typeName === 'IssueComment') {
    const comment = source as { id: number; body: string; globalId?: string };
    if (field.name === 'id') return comment.globalId ?? globalId('IssueComment', comment.id);
    if (field.name === 'body') return comment.body;
    if (field.name === 'author') return typed('User', VIEWER);
    return undefined;
  }

  if (typeName === 'IssueCommentEdge') {
    const edge = source as { node: unknown };
    if (field.name === 'node') return edge.node;
    if (field.name === 'cursor') return null;
    return undefined;
  }

  if (typeName === '__Type') {
    const type = source as { name: string };
    if (field.name === 'name') return type.name;
    if (field.name === 'kind') return TYPE_ENUM_VALUES[type.name] !== undefined ? 'ENUM' : 'OBJECT';
    if (field.name === 'fields') {
      const names = TYPE_FIELDS[type.name] ?? [];
      return names.map((name) => typed('__Field', { name }));
    }
    if (field.name === 'enumValues') {
      const values = TYPE_ENUM_VALUES[type.name] ?? [];
      return values.map((name) => typed('__EnumValue', { name }));
    }
    return undefined;
  }

  if (typeName === '__Field') {
    const f = source as { name: string };
    if (field.name === 'name') return f.name;
    if (field.name === 'description') return null;
    return undefined;
  }

  if (typeName === '__EnumValue') {
    const v = source as { name: string };
    if (field.name === 'name') return v.name;
    if (field.name === 'description') return null;
    return undefined;
  }

  if (typeName === 'CreateIssuePayload') {
    const payload = source as { issue: Issue; repo: Repo };
    if (field.name === 'issue') return typed('Issue', { repo: payload.repo, issue: payload.issue });
    return undefined;
  }

  if (typeName === 'CloseIssuePayload') {
    const payload = source as { issue: Issue; repo: Repo };
    if (field.name === 'issue') return typed('Issue', { repo: payload.repo, issue: payload.issue });
    return undefined;
  }

  if (typeName === 'CreatePullRequestPayload') {
    const payload = source as { pull: PullRequest; repo: Repo };
    if (field.name === 'pullRequest') return typed('PullRequest', { repo: payload.repo, pull: payload.pull });
    return undefined;
  }

  if (typeName === 'MergePullRequestPayload') {
    const payload = source as { pull: PullRequest; repo: Repo };
    if (field.name === 'pullRequest') return typed('PullRequest', { repo: payload.repo, pull: payload.pull });
    return undefined;
  }

  if (typeName === 'AddCommentPayload') {
    const payload = source as { comment: { id: number; body: string }; issue: Issue; repo: Repo };
    if (field.name === 'commentEdge') {
      return typed('IssueCommentEdge', {
        node: typed('IssueComment', {
          id: payload.comment.id,
          body: payload.comment.body,
          globalId: commentGlobalId(payload.repo, payload.issue, payload.comment.id),
        }),
      });
    }
    return undefined;
  }

  return undefined;
}

// --------------------------------------------------------------------------------------------
// one operation, then the HTTP handler (single or batched)
// --------------------------------------------------------------------------------------------

function executeOperation(store: Store, query: unknown, variables: unknown): { data: Record<string, unknown> | null; errors: Array<{ message: string; path?: Array<string | number> }> } {
  if (typeof query !== 'string' || query.trim() === '') {
    return { data: null, errors: [{ message: 'A GraphQL query string is required.' }] };
  }
  let operation: OperationNode;
  try {
    operation = new Parser(tokenize(query)).parseDocument();
  } catch (err) {
    return { data: null, errors: [{ message: `GraphQL syntax error: ${(err as Error).message}` }] };
  }
  const vars = (variables ?? {}) as Record<string, unknown>;
  const ctx: ExecContext = { store, variables: vars, errors: [] };
  const rootType = operation.type === 'mutation' ? 'Mutation' : 'Query';
  const data = executeSelectionSet(ctx, rootType, null, operation.selectionSet, []);
  return { data, errors: ctx.errors };
}

export function handleGraphQL(store: Store, body: unknown, res: ServerResponse): void {
  if (Array.isArray(body)) {
    // Operation batching: one result per operation, in order.
    const results = body.map((entry) => {
      const op = (entry ?? {}) as Record<string, unknown>;
      return executeOperation(store, op.query, op.variables);
    });
    sendJson(res, 200, results);
    return;
  }
  if (body === null || typeof body !== 'object') {
    sendJson(res, 400, { errors: [{ message: 'A GraphQL operation body is required.' }] });
    return;
  }
  const op = body as Record<string, unknown>;
  const result = executeOperation(store, op.query, op.variables);
  sendJson(res, 200, result);
}
