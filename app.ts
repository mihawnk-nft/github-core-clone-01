// app.ts — the server: one node:http server, one in-memory store, four surfaces.
// Routing: /healthz (no auth), /api/v3/* (REST), /api/graphql (GraphQL v4), /mcp (MCP),
// /{owner}/{repo}.git/* (git smart HTTP). Everything else is a JSON 404.
//
// Auth: every surface except /healthz and the API root requires
// `Authorization: Bearer $MAKEFUN_SHOP_TOKEN` (the env's token). A missing or wrong token is
// a 401 {"message": "Bad credentials"}.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Store } from './store.ts';
import { handleRest, type RestContext } from './rest.ts';
import { handleGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import { handleInfoRefs, handleReceivePack, handleUploadPack } from './git-http.ts';
import { errorBody, sendBytes, sendJson } from './http.ts';

/** The largest request body accepted (a git pack can be many megabytes). */
const MAX_BODY_BYTES = 128 * 1024 * 1024;

/** The token the env hands this process; read once at module load (not per request). */
const EXPECTED_TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? '';

function bearerToken(req: IncomingMessage): string | null {
  const header = req.headers.authorization;
  if (typeof header !== 'string') return null;
  const trimmed = header.trim();
  if (!trimmed.startsWith('Bearer ')) return null;
  return trimmed.slice('Bearer '.length);
}

/** True when the request carries the env's token (any non-empty Bearer when unset). */
function authorized(req: IncomingMessage): boolean {
  const token = bearerToken(req);
  if (token === null || token === '') return false;
  if (EXPECTED_TOKEN === '') return true;
  return token === EXPECTED_TOKEN;
}

/** The request path and query, parsed from a single `new URL` per request. */
function parseUrl(req: IncomingMessage): { path: string; query: URLSearchParams } {
  try {
    const url = new URL(req.url ?? '/', 'http://entry');
    return { path: url.pathname, query: url.searchParams };
  } catch {
    return { path: '/', query: new URLSearchParams() };
  }
}

/** Read the whole request body (a Buffer), or null when it is too large. */
function readBody(req: IncomingMessage): Promise<Buffer | null> {
  // Fast path: a request with no Content-Length and no chunked encoding has no body.
  // Skip attaching stream listeners (the common case for GET/DELETE and empty POSTs).
  const contentLength = req.headers['content-length'];
  const transferEncoding = req.headers['transfer-encoding'];
  if (
    (contentLength === undefined || contentLength === '0') &&
    (transferEncoding === undefined || transferEncoding === '')
  ) {
    return Promise.resolve(Buffer.alloc(0));
  }
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let tooLarge = false;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        tooLarge = true;
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(tooLarge ? null : Buffer.concat(chunks)));
    req.on('error', () => resolve(null));
  });
}

/** Parse a JSON body: the value, or null with `invalid` set when it is not JSON. */
function parseJsonBody(body: Buffer): { value: unknown; invalid: boolean } {
  if (body.length === 0) return { value: null, invalid: false };
  try {
    return { value: JSON.parse(body.toString('utf8')) as unknown, invalid: false };
  } catch {
    return { value: null, invalid: true };
  }
}

function splitPath(path: string): string[] {
  return path.split('/').filter((segment) => segment !== '');
}

function decodeSegments(segments: readonly string[]): string[] {
  return segments.map((segment) => {
    // Fast path: no percent-escape means the segment is already decoded.
    if (!segment.includes('%')) return segment;
    try {
      return decodeURIComponent(segment);
    } catch {
      return segment;
    }
  });
}

/** Build the server. It binds nothing until the caller listens; the entry listens on an ephemeral port. */
export function createApp(): Server {
  const store = new Store();
  if (EXPECTED_TOKEN === '') {
    process.stderr.write('[entry] MAKEFUN_SHOP_TOKEN is not set: any non-empty Bearer token is accepted (local testing only)\n');
  }

  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      const method = req.method ?? 'GET';
      const { path, query } = parseUrl(req);
      const host = req.headers.host ?? 'entry';

      // The env's boot check calls this twice: 200 {"ok":true}, no auth.
      if (method === 'GET' && path === '/healthz') {
        sendJson(res, 200, { ok: true });
        return;
      }

      // The git smart-HTTP surface: /{owner}/{repo}.git/{info/refs,git-upload-pack,git-receive-pack}
      const gitMatch = /^\/([^/]+)\/([^/]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/.exec(path);
      if (gitMatch !== null) {
        if (!authorized(req)) {
          sendJson(res, 401, errorBody('Bad credentials'));
          return;
        }
        const owner = decodeURIComponent(gitMatch[1]!);
        const repoName = decodeURIComponent(gitMatch[2]!);
        const service = gitMatch[3]!;
        // Node already lowercases incoming header names, so req.headers is usable as-is;
        // the git handlers only read 'git-protocol'.
        const headers = req.headers as Record<string, string>;
        if (service === 'info/refs') {
          if (method !== 'GET') {
            sendJson(res, 404, errorBody('Not Found'));
            return;
          }
          const requested = query.get('service');
          const serviceName = requested === 'git-receive-pack' ? 'git-receive-pack' : 'git-upload-pack';
          const result = handleInfoRefs(store, owner, repoName, serviceName, query, headers);
          if ('json' in result) {
            sendJson(res, result.status, result.json);
          } else {
            sendBytes(res, result.status, result.body, result.contentType);
          }
          return;
        }
        const body = await readBody(req);
        if (body === null) {
          sendJson(res, 413, errorBody('Request Entity Too Large'));
          return;
        }
        if (service === 'git-upload-pack') {
          if (method !== 'POST') {
            sendJson(res, 404, errorBody('Not Found'));
            return;
          }
          const result = handleUploadPack(store, owner, repoName, body, headers);
          if ('json' in result) sendJson(res, result.status, result.json);
          else sendBytes(res, result.status, result.body, result.contentType);
          return;
        }
        // git-receive-pack
        if (method !== 'POST') {
          sendJson(res, 404, errorBody('Not Found'));
          return;
        }
        const result = handleReceivePack(store, owner, repoName, body);
        if ('json' in result) sendJson(res, result.status, result.json);
        else sendBytes(res, result.status, result.body, result.contentType);
        return;
      }

      // GraphQL v4.
      if (path === '/api/graphql') {
        if (method !== 'POST') {
          sendJson(res, 404, errorBody('Not Found'));
          return;
        }
        if (!authorized(req)) {
          sendJson(res, 401, errorBody('Bad credentials'));
          return;
        }
        const body = await readBody(req);
        if (body === null) {
          sendJson(res, 413, errorBody('Request Entity Too Large'));
          return;
        }
        const parsed = parseJsonBody(body);
        if (parsed.invalid) {
          sendJson(res, 400, { errors: [{ message: 'A GraphQL operation body is required.' }] });
          return;
        }
        handleGraphQL(store, parsed.value, res);
        return;
      }

      // MCP over Streamable HTTP.
      if (path === '/mcp') {
        if (method !== 'POST' && method !== 'DELETE') {
          sendJson(res, 404, errorBody('Not Found'));
          return;
        }
        if (!authorized(req)) {
          sendJson(res, 401, errorBody('Bad credentials'));
          return;
        }
        if (method === 'DELETE') {
          res.writeHead(202);
          res.end();
          return;
        }
        const body = await readBody(req);
        if (body === null) {
          sendJson(res, 413, errorBody('Request Entity Too Large'));
          return;
        }
        handleMcp(store, body.toString('utf8'), res);
        return;
      }

      // REST v3.
      if (path === '/api/v3' || path === '/api/v3/' || path.startsWith('/api/v3/')) {
        const segments = decodeSegments(splitPath(path).slice(2));
        if (segments.length > 0 && !authorized(req)) {
          sendJson(res, 401, errorBody('Bad credentials'));
          return;
        }
        const body = await readBody(req);
        if (body === null) {
          sendJson(res, 413, errorBody('Request Entity Too Large'));
          return;
        }
        const parsed = parseJsonBody(body);
        const ctx: RestContext = {
          store,
          method,
          segments,
          query,
          host,
          body: parsed.value,
          bodyInvalid: parsed.invalid,
          req,
          res,
        };
        handleRest(ctx);
        return;
      }

      // Everything else, every method: GitHub's 404 body.
      sendJson(res, 404, errorBody('Not Found'));
    })().catch((err: unknown) => {
      // A request handler must never hang the connection: answer 500 and log.
      try {
        process.stderr.write(`[entry] request ${method} ${path} failed: ${err instanceof Error ? err.message : String(err)}\n`);
        if (!res.headersSent) sendJson(res, 500, errorBody('Internal Server Error'));
        else res.end();
      } catch {
        // The connection is already gone.
      }
    });
  });
}
