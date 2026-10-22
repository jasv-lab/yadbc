# yadbc

*Yet another database client.* A personal, fast, uncluttered PostgreSQL client:
a .NET 10 host (Kestrel on 127.0.0.1 + a Photino desktop window) with an Angular UI.

Windows for now: passwords live in Windows Credential Manager, and tunnels use Windows OpenSSH.

Design and decisions: [docs/design.md](docs/design.md) · UI debate verdict: [docs/ui-debate-verdict.md](docs/ui-debate-verdict.md)

## Layout

```
src/Yadbc.Host/   .NET host — modules by domain: Connections/, Query/, Hosting/
web/              Angular (zoneless) + CDK + Tailwind; builds into src/Yadbc.Host/wwwroot
src/Yadbc.Broker/ shared-connections broker (optional, k8s) — deploy/README.md
src/Yadbc.Contracts/ broker wire format, shared with the host
tests/            broker tests: dotnet test yadbc.slnx
deploy/           Helm chart and setup guide for the broker
dev/              throwaway Postgres for development (docker compose)
docs/             design docs
```

## Run it

```bash
docker compose -f dev/compose.yaml up -d --build   # test DB on 127.0.0.1:55433, user/password/db: yadbc (with HypoPG + pg_stat_statements)
npm --prefix web ci && npm --prefix web run build
dotnet run --project src/Yadbc.Host
```

## Develop

Live-reloading UI inside the desktop window:

```bash
npm --prefix web start                         # ng serve on :4200, proxies /api and /ws to :5179
YADBC_DEV_URL=http://localhost:4200 dotnet run --project src/Yadbc.Host
```

Without a window (debug in any browser): `YADBC_HEADLESS=1 dotnet run --project src/Yadbc.Host`
prints a `http://127.0.0.1:5179/#token=…` URL.

| Variable | Effect |
|---|---|
| `YADBC_HEADLESS=1` | No window; serve on a fixed port and print the URL |
| `YADBC_DEV_URL` | Window loads this URL (ng serve) instead of the built UI |
| `YADBC_PORT` | Fixed backend port (default: random, or 5179 in headless/dev mode) |
| `YADBC_DATA_DIR` | Where `connections.json` lives (default `%APPDATA%\yadbc`) |
| `YADBC_CREDENTIAL_PREFIX` | Credential Manager prefix instead of `yadbc` — give a test instance its own, so it never touches the real app's passwords and tokens |
| `YADBC_SSH` / `YADBC_KUBECTL` | Executables for tunnels (default: Windows OpenSSH, `kubectl` on PATH) |
| `YADBC_SSH_OPTIONS` | Extra options appended to every `ssh` tunnel command |

Passwords are stored in Windows Credential Manager under `yadbc:<connection id>`, never in files.

### Tunnels

**Edit connection → Connect** chooses Direct, **SSH tunnel** or **Kubernetes**. yadbc runs your own `ssh` or `kubectl`, so your SSH agent (Windows OpenSSH agent, 1Password…), `~/.ssh/config` aliases, kubeconfig and RBAC apply, and keeps the tunnel up while you use the connection.

- SSH: the host and port are the database *as the SSH server sees it* (`db.internal:5432`). The server's host key must already be trusted; connect once with `ssh <server>` in a terminal.
- Kubernetes: pick a kubeconfig, context and namespace (suggested from `~/.kube`), then a target such as `svc/postgres`, plus the port on that target.

Tests: `npm --prefix web test`

### Index advisor

Explain a query (Ctrl+E) and missing indexes show up next to the plan; the activity tab's **Index advisor** does the same for everything the database has been running. Two optional extensions on the server make it better:

- **pg_stat_statements** (workload view): `shared_preload_libraries = 'pg_stat_statements'`, restart, then `CREATE EXTENSION pg_stat_statements;` in the database.
- **HypoPG** (proof): install the `postgresql-<version>-hypopg` package, then `CREATE EXTENSION hypopg;`. yadbc then creates each suggested index *hypothetically* (nothing is built), re-plans, and shows the real cost difference. Without it the suggestions are heuristics, marked unverified.

### AI assistant

Ctrl+I opens it in the drawer. Point it at any OpenAI-compatible endpoint (OpenAI, a LiteLLM proxy, vLLM, Ollama…: an endpoint URL, a key if it needs one, a model). It sees the statement under your cursor, its error and plan, and the schema of the tables involved — never result rows. Suggested SQL is only ever inserted, never run.

## Use with Claude (MCP)

yadbc can expose your connections to Claude Code as an MCP server — read-only, and only while yadbc runs.

1. In yadbc: **Ctrl+K → "MCP server for Claude…"**, switch it on, copy the command.
2. Run it once in a terminal:

   ```bash
   claude mcp add --transport http yadbc http://127.0.0.1:47800/mcp --header "Authorization: Bearer <token from the dialog>"
   ```

3. Per connection, **Edit connection → Allow Claude (MCP)** decides access (on for local/dev by default, off for prod).

Tools: `list_connections`, `describe_schema`, `run_query`, `explain_query`, `suggest_indexes`, `get_activity`. Every query runs in a rolled-back read-only transaction and shows up in yadbc's History as "Claude".

## License

MIT — see [LICENSE](LICENSE).
