[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/mihawnk-nft/github-core-clone-01/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/mihawnk-nft/github-core-clone-01/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

# github-core-clone-01 — a GitHub-compatible git forge

A standalone GitHub-compatible git forge in **one Node process, stdlib only** — no npm
dependencies, no git binary, no outside service, no proxy. It serves git smart HTTP
(upload-pack protocol v2, receive-pack v0), the REST v3 API, GraphQL v4 and MCP, all from
its own in-memory store.

## What it serves

- `GET /healthz` — `200 {"ok": true}`
- `/<owner>/<repo>.git/info/refs`, `git-upload-pack`, `git-receive-pack` — git smart HTTP
  (pkt-lines, packfiles, shallow fetch, fast-forward rules, sideband reports)
- `/api/v3/*` — REST v3: repos, branches, commits, contents, issues, comments, labels,
  pull requests, files and squash merges, with GitHub status codes, Link pagination and
  `X-GitHub-Request-Id` on every reply
- `POST /api/graphql` — GraphQL v4: `viewer`, `repository`, `node(id:)`, `__type`
  introspection, issue/pull-request connections with cursor pagination, and the five
  mutations (`createIssue`, `closeIssue`, `createPullRequest`, `mergePullRequest`,
  `addComment`), including operation batching
- `POST /mcp` — MCP over Streamable HTTP, modern `server/discover` era, with six tools
  (`create_repo`, `get_repo`, `create_issue`, `list_issues`, `create_pull_request`,
  `merge_pull_request`) whose effects show in the REST view

Every API call takes `Authorization: Bearer $MAKEFUN_SHOP_TOKEN`. The token's owner is
always `adaiversen` (the suite's fixed scenario viewer).

## How to run

```sh
# Node 22.18+ is required. No install step: stdlib only.
export MAKEFUN_SHOP_TOKEN=your-token
node --experimental-strip-types main.ts
```

`main.ts` is the entry <-> env lifecycle: it binds an ephemeral port, registers it with
`$MAKEFUN_ENV_URL`, polls `/done` and exits 0. For a local check, run the server on a
port yourself (or point the kit's runner at it):

```sh
node --experimental-strip-types sdk/run.ts --url http://127.0.0.1:PORT --token your-token --perf
```

## Layout

- `app.ts` — the server: routing, auth, body reading
- `store.ts` — the in-memory model, git object primitives, trees, merges, diffs
- `git.ts` — the pkt-line codec and the packfile reader/writer (plain objects, deltas resolved)
- `git-http.ts` — the git smart-HTTP handlers
- `rest.ts` — the REST v3 surface
- `graphql.ts` — the GraphQL v4 parser and executor
- `mcp.ts` — the MCP endpoint and its six tools
- `http.ts` — the response helpers every surface shares

## Bounty

Built for [make.fun · github-core-clone-01](https://make.fun/bounty/github-core-clone-01) —
"Build a GitHub-compatible git forge". MIT licensed.
