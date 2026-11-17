// git-http.ts — git smart HTTP: info/refs advertisements, protocol v2 upload-pack
// (ls-refs + fetch) and v0 receive-pack. A real git client speaks to this.

import {
  collectReachable,
  isAncestor,
  parseCommit,
  parseTag,
  parseTree,
  peelToCommit,
  putObject,
  VIEWER,
  ZERO_OID,
  isObjectId,
  type GitObject,
  type Repo,
  type Store,
} from './store.ts';
import { decodePktLines, encodePktLines, pktLine, readPack, writePack, type Packet } from './git.ts';

const AGENT = 'forge/1.0.0';

/** The refs a client sees, in advertisement order: HEAD, heads, tags. */
export interface RefLine {
  oid: string;
  name: string;
  /** The commit an annotated tag peels to (when the tag object is a tag). */
  peeled?: string;
  /** HEAD's symref target (always the default branch). */
  symrefTarget?: string;
  unborn?: boolean;
}

function refLines(repo: Repo): RefLine[] {
  const lines: RefLine[] = [];
  const mainTip = repo.refs.get('refs/heads/main');
  lines.push({
    oid: mainTip ?? ZERO_OID,
    name: 'HEAD',
    symrefTarget: `refs/heads/${repo.defaultBranch}`,
    unborn: mainTip === undefined,
  });
  const heads = [...repo.refs.keys()].filter((name) => name.startsWith('refs/heads/')).sort();
  for (const name of heads) lines.push({ oid: repo.refs.get(name)!, name });
  const tags = [...repo.refs.keys()].filter((name) => name.startsWith('refs/tags/')).sort();
  for (const name of tags) {
    const oid = repo.refs.get(name)!;
    const object = repo.objects.get(oid);
    const line: RefLine = { oid, name };
    if (object && object.type === 'tag') {
      const peeled = peelToCommit(repo.objects, oid);
      if (peeled !== null) line.peeled = peeled;
    }
    lines.push(line);
  }
  return lines;
}

const UPLOAD_V2_CAPS = `agent=${AGENT} ls-refs=unborn fetch=shallow filter wait-for-done filter object-format=sha1`;
const UPLOAD_V0_CAPS = `symref=HEAD:refs/heads/main side-band-64k thin-pack ofs-delta shallow multi_ack agent=${AGENT}`;
const RECEIVE_V0_CAPS = `symref=HEAD:refs/heads/main report-status report-status-v2 side-band-64k delete-refs ofs-delta agent=${AGENT}`;

/** GET /{owner}/{repo}.git/info/refs?service=<service> */
export function handleInfoRefs(
  store: Store,
  owner: string,
  repoName: string,
  service: 'git-upload-pack' | 'git-receive-pack',
  query: URLSearchParams,
  headers: Record<string, string>,
): { status: number; contentType: string; body: Buffer } | { status: number; json: unknown } {
  const repo = store.getRepo(owner, repoName);
  if (!repo) return { status: 404, json: { message: 'Not Found' } };
  const requested = query.get('service');
  if (requested !== service) return { status: 400, json: { message: 'Not Found' } };

  const isV2 = service === 'git-upload-pack' && (headers['git-protocol'] ?? '').includes('version=2');
  const contentType = `application/x-${service}-advertisement`;

  if (service === 'git-receive-pack' || !isV2) {
    // v0 advertisement: service preamble, then ref lines (capabilities on the first).
    const caps = service === 'git-receive-pack' ? RECEIVE_V0_CAPS : UPLOAD_V0_CAPS;
    const parts: (string | Buffer | 'flush')[] = [`# service=${service}\n`, 'flush'];
    const refs = refLines(repo);
    const realRefs = refs.filter((ref) => ref.name !== 'HEAD' || !ref.unborn);
    if (realRefs.length === 0 && repo.refs.size === 0) {
      parts.push(`${ZERO_OID} capabilities^{}\u0000${caps}\n`);
    } else {
      const head = refs[0]!;
      parts.push(`${head.oid} HEAD\u0000${caps}\n`);
      for (const ref of refs.slice(1)) {
        parts.push(`${ref.oid} ${ref.name}\n`);
        if (ref.peeled !== undefined) parts.push(`${ref.peeled} ${ref.name}^{}\n`);
      }
    }
    parts.push('flush');
    return { status: 200, contentType, body: encodePktLines(parts) };
  }

  // v2 advertisement: service preamble, version 2, then one capability per line.
  const parts: (string | Buffer | 'flush')[] = [`# service=${service}\n`, 'flush', 'version 2\n'];
  for (const line of UPLOAD_V2_CAPS.split(' ')) parts.push(`${line}\n`);
  parts.push('flush');
  return { status: 200, contentType, body: encodePktLines(parts) };
}

// --------------------------------------------------------------------------------------------
// upload-pack (v2 ls-refs + fetch; a v0 fetch fallback)
// --------------------------------------------------------------------------------------------

interface FetchArgs {
  wants: string[];
  haves: string[];
  shallow: string[];
  depth: number | null;
  deepenSince: number | null;
  deepenNot: string[];
  done: boolean;
}

/** Parse a v2 request body into its command and arguments. */
function parseV2Request(body: Buffer): { command: string; args: string[] } {
  const packets = decodePktLines(body);
  const lines: string[] = [];
  for (const packet of packets) {
    if (packet.kind === 'data') lines.push(packet.payload.toString('utf8'));
    if (packet.kind === 'flush') break;
  }
  const first = lines[0] ?? '';
  const match = /^command=([a-z-]+)\n?$/.exec(first.trim());
  if (!match) throw new Error(`no command in the upload-pack request: ${JSON.stringify(first.slice(0, 60))}`);
  const args: string[] = [];
  for (const line of lines.slice(1)) {
    if (line === '') continue;
    if (line.startsWith('agent=') || line.startsWith('object-format=')) continue;
    args.push(line.replace(/\n$/, ''));
  }
  return { command: match[1]!, args };
}

/** Parse a v0 fetch body (two sections split by a flush: wants, then haves + done). */
function parseV0Fetch(body: Buffer): FetchArgs {
  const packets = decodePktLines(body);
  const args: FetchArgs = { wants: [], haves: [], shallow: [], depth: null, deepenSince: null, deepenNot: [], done: false };
  let section = 0;
  for (const packet of packets) {
    if (packet.kind === 'flush') {
      section += 1;
      continue;
    }
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    if (section === 0) {
      if (line.startsWith('want ')) {
        // The first want carries the requested features after the oid.
        args.wants.push(line.slice(5).split(' ')[0]!);
      } else if (line.startsWith('shallow ')) args.shallow.push(line.slice(8));
      else if (line.startsWith('deepen ')) {
        const n = Number(line.slice(7));
        if (Number.isFinite(n) && n > 0) args.depth = Math.trunc(n);
      } else if (line.startsWith('deepen-since ')) {
        const n = Number(line.slice(13));
        if (Number.isFinite(n)) args.deepenSince = Math.trunc(n);
      } else if (line.startsWith('deepen-not ')) args.deepenNot.push(line.slice(11));
    } else {
      if (line.startsWith('have ')) args.haves.push(line.slice(5));
      else if (line === 'done') args.done = true;
    }
  }
  return args;
}

/** The first data line of a request body (used to tell v2 from v0). */
function firstRequestLine(body: Buffer): string {
  const packets = decodePktLines(body);
  for (const packet of packets) {
    if (packet.kind === 'data') return packet.payload.toString('utf8');
    if (packet.kind === 'flush') break;
  }
  return '';
}

function parseFetchArgs(args: readonly string[]): FetchArgs {
  const out: FetchArgs = { wants: [], haves: [], shallow: [], depth: null, deepenSince: null, deepenNot: [], done: false };
  for (const arg of args) {
    if (arg.startsWith('want ')) out.wants.push(arg.slice(5).trim());
    else if (arg.startsWith('have ')) out.haves.push(arg.slice(5).trim());
    else if (arg.startsWith('shallow ')) out.shallow.push(arg.slice(8).trim());
    else if (arg.startsWith('deepen ')) {
      const n = Number(arg.slice(7).trim());
      if (Number.isFinite(n) && n > 0) out.depth = Math.trunc(n);
    } else if (arg.startsWith('deepen-since ')) {
      const n = Number(arg.slice(13).trim());
      if (Number.isFinite(n)) out.deepenSince = Math.trunc(n);
    } else if (arg.startsWith('deepen-not ')) out.deepenNot.push(arg.slice(11).trim());
    else if (arg === 'done') out.done = true;
  }
  return out;
}

/** The objects a fetch delivers: the included commits' trees and blobs, following parent
 * links only to commits that are themselves included — never beyond a shallow boundary.
 * (collectReachable would walk the whole history, which a depth-1 fetch must not send.) */
function collectShallow(repo: Repo, included: ReadonlyMap<string, number>): Set<string> {
  const seen = new Set<string>();
  const queue: string[] = [...included.keys()];
  while (queue.length > 0) {
    const oid = queue.pop()!;
    if (seen.has(oid)) continue;
    const object = repo.objects.get(oid);
    if (object === undefined) continue;
    seen.add(oid);
    if (object.type === 'commit') {
      const commit = parseCommit(object.data);
      queue.push(commit.tree);
      for (const parent of commit.parents) {
        if (included.has(parent)) queue.push(parent);
      }
    } else if (object.type === 'tag') {
      queue.push(parseTag(object.data).object);
    } else if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) {
        if (entry.mode !== '160000') queue.push(entry.oid);
      }
    }
  }
  return seen;
}

/**
 * The objects a fetch delivers, with the depth limit applied to the commit walk.
 * Returns the objects to send, the new shallow boundary, and the boundaries that are
 * no longer shallow.
 */
function selectFetch(
  repo: Repo,
  wants: readonly string[],
  haves: readonly string[],
  depth: number | null,
  clientShallow: readonly string[],
  deepenSince: number | null,
  deepenNot: readonly string[],
): { objects: Map<string, GitObject>; shallow: string[]; unshallow: string[] } {
  // The commits to include, by generation (0 = the wants).
  const included = new Map<string, number>();
  const queue: Array<{ oid: string; generation: number }> = [];
  for (const want of wants) {
    if (!isObjectId(want)) continue;
    const peeled = peelToCommit(repo.objects, want);
    if (peeled === null) continue;
    queue.push({ oid: peeled, generation: 0 });
  }
  const excluded = new Set<string>();
  for (const ref of deepenNot) {
    const tip = repo.refs.get(ref) ?? repo.refs.get(`refs/heads/${ref}`) ?? repo.refs.get(`refs/tags/${ref}`);
    if (tip) for (const oid of collectReachable([tip], (oid) => repo.objects.get(oid), { allowMissing: true })) excluded.add(oid);
  }
  let maxGeneration = 0;
  // When no depth/time limit is set, the walk stops at a commit the client already has:
  // the client holds that commit's history (or, for a shallow boundary, does not want its
  // ancestors). When a depth/time limit IS set, the limit controls the walk instead, so a
  // deepen past a shallow boundary still delivers the parent.
  const haveSet = new Set(haves);
  const limited = depth !== null || deepenSince !== null;
  while (queue.length) {
    const { oid, generation } = queue.pop()!;
    if (included.has(oid) || excluded.has(oid)) continue;
    const object = repo.objects.get(oid);
    if (!object || object.type !== 'commit') continue;
    included.set(oid, generation);
    if (generation > maxGeneration) maxGeneration = generation;
    const commit = parseCommit(object.data);
    const atLimit = depth !== null && generation >= depth - 1;
    const tooOld = deepenSince !== null && commitTimestamp(commit) < deepenSince;
    if (atLimit || tooOld) continue;
    if (!limited && haveSet.has(oid)) continue;
    for (const parent of commit.parents) queue.push({ oid: parent, generation: generation + 1 });
  }

  // The new shallow boundary: the included commits whose parents are not all included
  // (the frontier of the included set). For a depth-1 clone that is the tip; for a deepen
  // it is the deepest commit; for a new tip on a shallow clone it is the old boundary.
  const shallow: string[] = [];
  for (const oid of included.keys()) {
    const object = repo.objects.get(oid);
    if (!object || object.type !== 'commit') continue;
    const parents = parseCommit(object.data).parents;
    if (parents.length === 0) continue;
    if (parents.some((parent) => !included.has(parent))) shallow.push(oid);
  }
  // Boundaries the client held that are no longer shallow: included, with a parent included.
  const unshallow: string[] = [];
  for (const boundary of clientShallow) {
    if (!included.has(boundary)) continue;
    const object = repo.objects.get(boundary);
    if (!object || object.type !== 'commit') continue;
    if (parseCommit(object.data).parents.some((parent) => included.has(parent))) unshallow.push(boundary);
  }

  // The objects to send: the trees/blobs of the included commits (never the parents
  // beyond the shallow boundary), plus the wanted objects themselves — an annotated tag
  // is not reachable from the commit it points at — minus what the client holds. The
  // held set is shallow-aware: a shallow boundary's parents are NOT held by the client,
  // so a deepen past it must still deliver them.
  const wanted = collectShallow(repo, included);
  for (const want of wants) {
    if (repo.objects.has(want)) wanted.add(want);
  }
  const held = collectHeld(repo, haves, clientShallow);
  const objects = new Map<string, GitObject>();
  for (const oid of wanted) {
    if (held.has(oid)) continue;
    const object = repo.objects.get(oid);
    if (object) objects.set(oid, object);
  }
  return { objects, shallow, unshallow };
}

/** What the client already holds: the closure of its haves, but never past a shallow
 * boundary — a shallow client holds the boundary commit and its tree, not its parents. */
function collectHeld(repo: Repo, haves: readonly string[], shallowBoundaries: readonly string[]): Set<string> {
  const boundary = new Set(shallowBoundaries);
  const seen = new Set<string>();
  const queue: string[] = [...haves];
  while (queue.length > 0) {
    const oid = queue.pop()!;
    if (seen.has(oid)) continue;
    const object = repo.objects.get(oid);
    if (object === undefined) continue;
    seen.add(oid);
    if (object.type === 'commit') {
      const commit = parseCommit(object.data);
      queue.push(commit.tree);
      if (!boundary.has(oid)) {
        for (const parent of commit.parents) queue.push(parent);
      }
    } else if (object.type === 'tag') {
      queue.push(parseTag(object.data).object);
    } else if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) {
        if (entry.mode !== '160000') queue.push(entry.oid);
      }
    }
  }
  return seen;
}

function commitTimestamp(commit: { author: string; committer: string }): number {
  const match = / (\d+) [+-]\d{4}$/.exec(commit.committer) ?? / (\d+) [+-]\d{4}$/.exec(commit.author);
  return match ? Number(match[1]) : 0;
}

/** Split pack bytes into sideband (band 1) pkt-lines, each under the pkt-line limit. */
function sidebandPack(pack: Buffer): Buffer[] {
  const chunks: Buffer[] = [];
  const CHUNK = 65500;
  for (let offset = 0; offset < pack.length; offset += CHUNK) {
    const piece = pack.subarray(offset, Math.min(pack.length, offset + CHUNK));
    const payload = Buffer.concat([Buffer.from([1]), piece]);
    chunks.push(pktLine(payload));
  }
  return chunks;
}

/** POST /{owner}/{repo}.git/git-upload-pack */
export function handleUploadPack(
  store: Store,
  owner: string,
  repoName: string,
  body: Buffer,
  headers: Record<string, string>,
): { status: number; contentType: string; body: Buffer } | { status: number; json: unknown } {
  const repo = store.getRepo(owner, repoName);
  if (!repo) return { status: 404, json: { message: 'Not Found' } };
  const isV2 = (headers['git-protocol'] ?? '').includes('version=2');
  const contentType = 'application/x-git-upload-pack-result';

  // v2 (command=...) or v0 (want ...) — the body decides, not the header.
  let firstLine = '';
  try {
    firstLine = firstRequestLine(body);
  } catch (err) {
    return { status: 400, json: { message: `malformed upload-pack request: ${(err as Error).message}` } };
  }

  if (firstLine.startsWith('command=ls-refs')) {
    let parsed: { command: string; args: string[] };
    try {
      parsed = parseV2Request(body);
    } catch (err) {
      return { status: 400, json: { message: `malformed upload-pack request: ${(err as Error).message}` } };
    }
    const peel = parsed.args.includes('peel');
    const symrefs = parsed.args.includes('symrefs');
    const prefixes = parsed.args.filter((arg) => arg.startsWith('ref-prefix ')).map((arg) => arg.slice(11));
    const lines: (string | 'flush')[] = [];
    for (const ref of refLines(repo)) {
      if (prefixes.length > 0 && !prefixes.some((prefix) => ref.name.startsWith(prefix))) continue;
      if (ref.unborn) {
        lines.push(`unborn ${ref.name}${symrefs && ref.symrefTarget ? ` symref-target:${ref.symrefTarget}` : ''}\n`);
        continue;
      }
      let line = `${ref.oid} ${ref.name}`;
      if (symrefs && ref.symrefTarget) line += ` symref-target:${ref.symrefTarget}`;
      if (peel && ref.peeled !== undefined) line += ` peeled:${ref.peeled}`;
      lines.push(`${line}\n`);
    }
    lines.push('flush');
    return { status: 200, contentType, body: encodePktLines(lines) };
  }

  let fetchArgs: FetchArgs;
  let v2 = isV2;
  if (firstLine.startsWith('command=fetch')) {
    let parsed: { command: string; args: string[] };
    try {
      parsed = parseV2Request(body);
    } catch (err) {
      return { status: 400, json: { message: `malformed upload-pack request: ${(err as Error).message}` } };
    }
    fetchArgs = parseFetchArgs(parsed.args);
    v2 = true;
  } else if (firstLine.startsWith('want ')) {
    try {
      fetchArgs = parseV0Fetch(body);
    } catch (err) {
      return { status: 400, json: { message: `malformed upload-pack request: ${(err as Error).message}` } };
    }
    v2 = false;
  } else {
    return { status: 400, json: { message: `unknown upload-pack request: ${JSON.stringify(firstLine.slice(0, 60))}` } };
  }

  if (fetchArgs.wants.length === 0) {
    return { status: 200, contentType, body: encodePktLines(['flush']) };
  }

  // A cached pack when the fetch is identical to one already built for this repo.
  const cacheKey = `${fetchArgs.wants.join(',')}|${fetchArgs.haves.join(',')}|${fetchArgs.depth ?? ''}|${fetchArgs.shallow.join(',')}|${fetchArgs.deepenSince ?? ''}|${fetchArgs.deepenNot.join(',')}`;
  let cached = repo.packCache.get(cacheKey);
  if (cached === undefined) {
    const selected = selectFetch(repo, fetchArgs.wants, fetchArgs.haves, fetchArgs.depth, fetchArgs.shallow, fetchArgs.deepenSince, fetchArgs.deepenNot);
    cached = {
      pack: selected.objects.size > 0 ? writePack([...selected.objects.values()]) : null,
      shallow: selected.shallow,
      unshallow: selected.unshallow,
    };
    repo.packCache.set(cacheKey, cached);
  }
  const { pack, shallow, unshallow } = cached;

  const parts: Buffer[] = [];
  const push = (item: string | Buffer | 'flush' | 'delim'): void => {
    parts.push(item === 'flush' ? Buffer.from('0000', 'ascii') : item === 'delim' ? Buffer.from('0001', 'ascii') : pktLine(item));
  };

  if (v2) {
    if (fetchArgs.haves.length > 0) {
      push('acknowledgments\n');
      let acked = false;
      for (const have of fetchArgs.haves) {
        const haveCommit = peelToCommit(repo.objects, have);
        if (haveCommit === null) continue;
        const isCommon = fetchArgs.wants.some((want) => {
          const wantCommit = peelToCommit(repo.objects, want);
          return wantCommit !== null && isAncestor(repo.objects, haveCommit, wantCommit);
        });
        if (isCommon) {
          push(`ACK ${have}\n`);
          acked = true;
        }
      }
      if (!acked) push('NAK\n');
      else push('ready\n');
      push('delim');
    }
    if (shallow.length > 0 || unshallow.length > 0) {
      push('shallow-info\n');
      for (const oid of shallow) push(`shallow ${oid}\n`);
      for (const oid of unshallow) push(`unshallow ${oid}\n`);
      push('delim');
    }
    const wantedRefs: Array<{ oid: string; ref: string }> = [];
    for (const want of fetchArgs.wants) {
      for (const [name, oid] of repo.refs) if (oid === want) wantedRefs.push({ oid, ref: name });
    }
    if (wantedRefs.length > 0) {
      push('wanted-refs\n');
      for (const entry of wantedRefs) push(`${entry.oid} ${entry.ref}\n`);
      push('delim');
    }
    if (pack !== null) {
      push('packfile\n');
      for (const chunk of sidebandPack(pack)) parts.push(chunk);
    }
    push('flush');
    return { status: 200, contentType, body: Buffer.concat(parts) };
  }

  // v0 fetch: NAK/ACK + shallow lines, then the sideband pack.
  if (fetchArgs.haves.length > 0) {
    let acked = false;
    for (const have of fetchArgs.haves) {
      const haveCommit = peelToCommit(repo.objects, have);
      if (haveCommit === null) continue;
      const isCommon = fetchArgs.wants.some((want) => {
        const wantCommit = peelToCommit(repo.objects, want);
        return wantCommit !== null && isAncestor(repo.objects, haveCommit, wantCommit);
      });
      if (isCommon) {
        push(`ACK ${have}\n`);
        acked = true;
      }
    }
    if (!acked) push('NAK\n');
  }
  for (const oid of shallow) push(`shallow ${oid}\n`);
  for (const oid of unshallow) push(`unshallow ${oid}\n`);
  if (pack !== null) for (const chunk of sidebandPack(pack)) parts.push(chunk);
  push('flush');
  return { status: 200, contentType, body: Buffer.concat(parts) };
}

// --------------------------------------------------------------------------------------------
// receive-pack (v0)
// --------------------------------------------------------------------------------------------

/** True when `newOid` is a fast-forward of `oldOid` (or the same object). */
function isFastForward(repo: Repo, oldOid: string, newOid: string): boolean {
  if (oldOid === newOid) return true;
  const newCommit = peelToCommit(repo.objects, newOid);
  if (newCommit === null) return true;
  const oldCommit = peelToCommit(repo.objects, oldOid);
  if (oldCommit === null) return true;
  return isAncestor(repo.objects, oldCommit, newCommit);
}

/** POST /{owner}/{repo}.git/git-receive-pack */
export function handleReceivePack(
  store: Store,
  owner: string,
  repoName: string,
  body: Buffer,
): { status: number; contentType: string; body: Buffer } | { status: number; json: unknown } {
  const repo = store.getRepo(owner, repoName);
  if (!repo) return { status: 404, json: { message: 'Not Found' } };
  const contentType = 'application/x-git-receive-pack-result';

  // The command list is pkt-lines up to the first flush; the rest is the pack.
  let flushIndex = -1;
  try {
    const packets = decodePktLines(body, { allowTrailing: true });
    let offset = 0;
    for (const packet of packets) {
      const rawLength = packet.kind === 'data' ? packet.payload.length + 4 : 4;
      if (packet.kind === 'flush') {
        flushIndex = offset + 4;
        break;
      }
      offset += rawLength;
    }
    if (flushIndex < 0) throw new Error('no flush packet after the command list');
  } catch (err) {
    return { status: 400, json: { message: `malformed receive-pack request: ${(err as Error).message}` } };
  }
  const commandBytes = body.subarray(0, flushIndex - 4);
  const packBytes = body.subarray(flushIndex);

  const commands: Array<{ oldOid: string; newOid: string; ref: string }> = [];
  let requestedSideband = false;
  try {
    const packets = decodePktLines(commandBytes);
    for (const packet of packets) {
      if (packet.kind !== 'data') continue;
      const text = packet.payload.toString('utf8');
      const nul = text.indexOf('\u0000');
      const line = nul >= 0 ? text.slice(0, nul) : text;
      if (nul >= 0) {
        const caps = text.slice(nul + 1);
        if (caps.includes('side-band-64k')) requestedSideband = true;
      }
      const match = /^([0-9a-f]{40}) ([0-9a-f]{40}) (\S+)\n?$/.exec(line.trim());
      if (!match) throw new Error(`bad command line ${JSON.stringify(line.slice(0, 80))}`);
      commands.push({ oldOid: match[1]!, newOid: match[2]!, ref: match[3]! });
    }
  } catch (err) {
    return { status: 400, json: { message: `malformed receive-pack command list: ${(err as Error).message}` } };
  }
  if (commands.length === 0) {
    return { status: 400, json: { message: 'no commands in the receive-pack request' } };
  }

  // Unpack the pack (a create/update always carries one, even an empty one).
  let unpackOk = true;
  let unpackDetail = 'ok';
  if (packBytes.length > 0) {
    try {
      const read = readPack(packBytes, { resolveBase: (oid) => repo.objects.get(oid) });
      if (!read.checksumOk) throw new Error('pack trailer does not match its bytes');
      for (const [oid, object] of read.objects) {
        if (!repo.objects.has(oid)) repo.objects.set(oid, object);
      }
    } catch (err) {
      unpackOk = false;
      unpackDetail = (err as Error).message.slice(0, 200);
    }
  }

  const report: Array<{ ref: string; ok: boolean; reason: string }> = [];
  if (unpackOk) {
    for (const command of commands) {
      const current = repo.refs.get(command.ref);
      if (command.newOid === ZERO_OID) {
        // Delete.
        if (current === undefined) report.push({ ref: command.ref, ok: false, reason: 'remote ref does not exist' });
        else if (command.oldOid !== ZERO_OID && command.oldOid !== current) report.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
        else {
          repo.refs.delete(command.ref);
          report.push({ ref: command.ref, ok: true, reason: '' });
        }
        continue;
      }
      if (command.oldOid === ZERO_OID) {
        // Create.
        if (current !== undefined) report.push({ ref: command.ref, ok: false, reason: 'already exists' });
        else if (!repo.objects.has(command.newOid)) report.push({ ref: command.ref, ok: false, reason: 'object not found' });
        else {
          repo.refs.set(command.ref, command.newOid);
          report.push({ ref: command.ref, ok: true, reason: '' });
        }
        continue;
      }
      // Update.
      if (current === undefined) report.push({ ref: command.ref, ok: false, reason: 'remote ref does not exist' });
      else if (command.oldOid !== current) report.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
      else if (!repo.objects.has(command.newOid)) report.push({ ref: command.ref, ok: false, reason: 'object not found' });
      else if (!isFastForward(repo, command.oldOid, command.newOid)) report.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
      else {
        repo.refs.set(command.ref, command.newOid);
        report.push({ ref: command.ref, ok: true, reason: '' });
      }
    }
    store.invalidateGit(repo);
  } else {
    for (const command of commands) report.push({ ref: command.ref, ok: false, reason: 'unpacker error' });
  }

  const inner: (string | 'flush')[] = [`unpack ${unpackDetail}\n`];
  for (const entry of report) {
    inner.push(entry.ok ? `ok ${entry.ref}\n` : `ng ${entry.ref} ${entry.reason}\n`);
  }
  inner.push('flush');
  const innerReport = encodePktLines(inner);

  if (requestedSideband) {
    const parts: Buffer[] = [];
    const CHUNK = 65500;
    for (let offset = 0; offset < innerReport.length; offset += CHUNK) {
      const piece = innerReport.subarray(offset, Math.min(innerReport.length, offset + CHUNK));
      parts.push(pktLine(Buffer.concat([Buffer.from([1]), piece])));
    }
    parts.push(Buffer.from('0000', 'ascii'));
    return { status: 200, contentType, body: Buffer.concat(parts) };
  }
  return { status: 200, contentType, body: innerReport };
}

/** The viewer identity the git commits carry (used by the contents API's author lines). */
export function viewerIdentity(): string {
  return `${VIEWER.name} <${VIEWER.email}>`;
}

export type { Packet };
