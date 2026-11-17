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

/** The token the env hands this process; empty when it is not set (local testing). */
function expectedToken(): string {
  return process.env.MAKEFUN_SHOP_TOKEN ?? '';
}

function bearerToken(req: IncomingMessage): string | null {
  const header = req.headers.authorization;
  if (typeof header !== 'string') return null;
  const match = /^Bearer (.+)$/.exec(header.trim());
  return match === null ? null : match[1]!;
}

/** True when the request carries the env's token (any non-empty Bearer when unset). */
function authorized(req: IncomingMessage): boolean {
  const expected = expectedToken();
  const token = bearerToken(req);
  if (token === null || token === '') return false;
  if (expected === '') return true;
  return token === expected;
}

function pathOf(req: IncomingMessage): string {
  try {
    return new URL(req.url ?? '/', 'http://entry').pathname;
  } catch {
    return '/';
  }
}

function queryOf(req: IncomingMessage): URLSearchParams {
  try {
    return new URL(req.url ?? '/', 'http://entry').searchParams;
  } catch {
    return new URLSearchParams();
  }
}

/** Read the whole request body (a Buffer), or null when it is too large. */
function readBody(req: IncomingMessage): Promise<Buffer | null> {
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
  if (expectedToken() === '') {
    process.stderr.write('[entry] MAKEFUN_SHOP_TOKEN is not set: any non-empty Bearer token is accepted (local testing only)\n');
  }

  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      const method = req.method ?? 'GET';
      const path = pathOf(req);
      const query = queryOf(req);
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
        const headers: Record<string, string> = {};
        for (const [key, value] of Object.entries(req.headers)) {
          if (typeof value === 'string') headers[key.toLowerCase()] = value;
        }
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
