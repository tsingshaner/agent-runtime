# Project MCP

`Mcp.open(dataDir)` opens a configuration store without spawning processes.
`create(config)`, `get(id)`, `list()`, `update(id, config)` (full replacement), and
`delete(id)` manage servers. `bind(projectId, id, enabled)` / `unbind` persist
explicit project selections; `enabled(projectId)` returns only enabled configs.

A stdio config contains `name`, `transport: 'stdio'`, `command`, optional `args`,
`cwd`, `timeoutMs` (default 10000), and `env`. Each env entry maps the child variable
name to the **parent environment variable name**, never a literal credential.
Child stderr is not inherited. Public errors contain stable safe codes, and known
resolved credentials are redacted from discovery and call results.

`connect(projectId)` freezes that selection and returns `tools`, `callTool(name,
args)`, and idempotent `close()`. No config mutation changes existing connections.
`probe(id)` discovers and immediately releases one server. `dispose()` rejects
new connections and releases owned ones, including concurrent preparation.

Discovery follows pagination (maximum 1000 tools per server) and rejects duplicate
tool names. Timeouts are MCP_TIMEOUT; transport calls fail MCP_CALL_FAILED;
ordinary server tool results retain `isError`. Failed preparation closes every
connection it opened. Configuration updates use atomic writes under a disk lock;
competing writers fail RESOURCE_BUSY, and stale locks require inspection after a
crash. No user-global MCP configuration is read or modified.

Streamable HTTP uses `transport: 'http'`, `url`, and optional `headers`, whose
values are environment variable names (e.g. Authorization -> MCP_AUTH_HEADER).
URLs reject embedded credentials, query strings, and fragments. HTTP redirects
are refused to avoid forwarding credentials. No OAuth flow is started. Fetches
and RPCs are bounded, and automatic stream retries are disabled. Closing sends
session DELETE when supported and always aborts local transport resources;
remote termination failures are reported as MCP_CLOSE_FAILED.
