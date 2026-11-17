// http.ts — the small response helpers every surface shares. Every JSON reply carries a
// non-empty X-GitHub-Request-Id and an application/json content type.

import type { ServerResponse } from 'node:http';

const JSON_TYPE = 'application/json; charset=utf-8';

let requestCounter = 0;

/** A unique request id (the protocol group requires it on every REST reply). */
export function requestId(): string {
  requestCounter = (requestCounter + 1) % 0x7fffffff;
  return `req-${Date.now().toString(36)}-${requestCounter.toString(16)}`;
}

/** Send a JSON body (serialised here). */
export function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  headers: Readonly<Record<string, string>> = {},
): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': Buffer.byteLength(text),
    'x-github-request-id': requestId(),
    ...headers,
  });
  res.end(text);
}

/** Send a pre-serialised JSON body (the hot read path's cache). */
export function sendJsonText(
  res: ServerResponse,
  status: number,
  text: string,
  headers: Readonly<Record<string, string>> = {},
): void {
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': Buffer.byteLength(text),
    'x-github-request-id': requestId(),
    ...headers,
  });
  res.end(text);
}

/** Send raw bytes with a content type (the git surfaces). */
export function sendBytes(
  res: ServerResponse,
  status: number,
  body: Buffer,
  contentType: string,
  headers: Readonly<Record<string, string>> = {},
): void {
  res.writeHead(status, {
    'content-type': contentType,
    'content-length': body.length,
    'x-github-request-id': requestId(),
    ...headers,
  });
  res.end(body);
}

/** Send a status with no body (204). */
export function sendStatus(res: ServerResponse, status: number, headers: Readonly<Record<string, string>> = {}): void {
  res.writeHead(status, { 'x-github-request-id': requestId(), ...headers });
  res.end();
}

/** The error body every surface uses: a JSON object with a string message. */
export function errorBody(message: string): { message: string } {
  return { message };
}
