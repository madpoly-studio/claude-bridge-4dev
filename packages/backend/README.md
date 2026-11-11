# @claude-bridge/backend

Bridge backend: Task Bus (SQLite + MCP + runner HTTP API), Event Log, WebSocket hub with the Auth Gate,
Session Manager (planner / orchestrator over the Agent SDK), Permission Broker, Wake Dispatcher and Jira Reader.
It binds to `127.0.0.1` only.

## Run

```bash
pnpm --filter @claude-bridge/protocol build    # once, or after protocol changes
pnpm --filter @claude-bridge/backend dev       # tsx watch, cwd = packages/backend
pnpm --filter @claude-bridge/backend build && pnpm --filter @claude-bridge/backend start
pnpm --filter @claude-bridge/backend test
pnpm --filter @claude-bridge/backend typecheck # src + test
```

Configuration: `bridge.config.json` in the current directory, or the path in `BRIDGE_CONFIG`
(scripts run with cwd = `packages/backend`, so use for example `BRIDGE_CONFIG=../../bridge.config.json`).
See `bridge.config.example.json` at the repo root. Relative paths in the file resolve against the file's folder.
Env overrides: `BRIDGE_PORT`, `MAX_CONCURRENCY`, `TASK_TIMEOUT_MINUTES`, `ORCH_TICK_MINUTES`, `JIRA_POLL_SECONDS`,
`ALLOWED_ORIGINS` (comma list), `CLAUDE_AUTH_MODE`, `BRIDGE_PAIRING_TOKEN`, `RUNNER_BOOTSTRAP_TOKEN`, `LOG_LEVEL`.

At startup the backend prints the pairing token (paste it into the UI once). The runner bootstrap token comes from
config/env, or from `<data_dir>/runner-bootstrap.token` (generated on first start; runners on the same machine read it).

| Endpoint | Auth |
|---|---|
| `GET /health` | none |
| `POST /runners/register` | `Bearer <runner bootstrap token>` |
| `/runners/{id}/next`, `/runners/{id}/heartbeat`, `/tasks/{id}/{started,events,exited}` | `Bearer <runner token>` from register |
| `POST /mcp` (stateless streamable HTTP, JSON responses; `GET`/`DELETE` = 405) | `Bearer <orchestrator token>` or `Bearer <task token>` |
| `ws://127.0.0.1:<port>/ws` | `Origin` in `allowed_origins`, then first message `auth {token}` within 10 s |

Plain JSON-RPC to `/mcp` needs `Accept: application/json, text/event-stream`.

## Claude sessions (Phase 3-5)

### Configuration keys

| Key | Default | Meaning |
|---|---|---|
| `claude_auth_mode` | `subscription` | `subscription`: `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN` are removed from the Claude child env so the CLI login (seat) is used. `api_key`: `ANTHROPIC_API_KEY` is required; the backend refuses to start without it |
| `claude_executable` | `null` | Path of the `claude` binary; `null` uses the binary bundled with the Agent SDK |
| `planner.mcp_servers` | `{}` | MCP servers for planner sessions (Agent SDK `mcpServers` shape: stdio `{command,args,env}` or `{type:"http"/"sse",url,headers}`) |
| `planner.allowed_tools` | `[]` | Extra allowed tools on top of `Read`, `Grep`, `Glob`, `ToolSearch`. Exact names or a trailing `*` (`mcp__jira__jira_get_*`) |
| `planner.system_prompt_append` / `planner.model` | `null` | Appended to the built-in planner prompt / model override |
| `planner.setting_sources` | `[]` | Claude Code settings sources to load: only `user` is accepted. `project` / `local` are rejected because they come from the repo, which workers write (`.claude/settings.json` can set hooks, `env` such as `ANTHROPIC_BASE_URL`, `apiKeyHelper`). Put `CLAUDE.md` content into `planner.system_prompt_append` instead |
| `orchestrators.<KEY>` | none | One orchestrator per Jira project (`KEY` must be in `projects`): `cwd` (dedicated folder, must exist), `mcp_servers`, `allowed_tools`, `system_prompt_append`, `model`, `setting_sources` (`project` is allowed here: the cwd is a dedicated config folder) |
| `orchestrator_autostart` | `true` | Start every configured orchestrator when the backend listens; `false` = start on `project.select` or on the first message |
| `jira_create_tool_pattern` | create_issue names | Regex of the Jira create-issue tool that goes through the approval gate |
| `jira_env_file` | `null` | Team `.env` with `MPS_JIRA_URL`, `MPS_JIRA_PAT`, `MPS_JIRA_PROJECT_KEY`, `MPS_CA_BUNDLE` (CA path may be relative to the `.env` folder). Must be outside every `repos[].path` (planners can read repos); config parsing fails otherwise |

Which Jira MCP server the team uses is still open (section 17.3). The example config uses
[`mcp-atlassian`](https://github.com/sooperset/mcp-atlassian) (`uvx mcp-atlassian`, Jira Server PAT in
`JIRA_PERSONAL_TOKEN`), whose tools become `mcp__jira__jira_search`, `mcp__jira__jira_get_issue`,
`mcp__jira__jira_create_issue`, ... The default `jira_create_tool_pattern` matches `mcp__jira__jira_create_issue`.
Check the tool names in the `init` event (`tools`) of a planner session and adjust `allowed_tools` / the pattern.

### Tool permissions

Every bridge session runs with `permissionMode: "default"`, `strictMcpConfig: true` and `settingSources` from config
(`[]` by default, so user-level allow rules cannot widen permissions). The allowlist is enforced three times:

1. `tools` lists only the allowed built-ins (planner: `Read`, `Grep`, `Glob`, `ToolSearch`; orchestrator: `ToolSearch`).
2. A `PreToolUse` hook (`onFailure: "block"`) denies every tool outside the allowlist. This also covers tools that an
   allow rule from a loaded settings source would pre-approve. For the create-issue tool it returns `ask`, so the call
   always reaches `canUseTool` (the approval gate) even when a rule allows it.
3. `canUseTool` denies anything outside the allowlist. For planner read tools it applies the same path guard as the
   hook (and checks `blockedPath` when the CLI sets one); CLI 2.1.322 also asks for some in-repo reads.

Planner path sandbox (`src/claude/repoPathGuard.ts`, run by the hook for every call): `file_path` / `path` /
`notebook_path` are resolved against the repo and through symlinks/junctions (`realpath`, nearest existing ancestor
for missing paths) and must stay inside the repo's realpath (case-insensitive on Windows; `D:/repo-evil` is not inside
`D:/repo`). `~`, `$VAR`, `%VAR%`, alternate data streams and Glob/Grep patterns that are absolute or contain `..`
are denied. Secret-looking files (`.env`, `.env.*`, `*.pem`, `*.key`, `id_rsa*` and other SSH keys, `.npmrc`,
`.netrc`, `.git-credentials`, `credentials*`) are denied by name, and the same patterns are passed as `Read(...)`
rules in `disallowedTools`.

Only exact MCP names from the allowlist are passed as `allowedTools`; wildcard entries go through `canUseTool`.
The orchestrator gets `bridge-bus` (`type: "http"`, `alwaysLoad: true`, bearer = that project's orchestrator token)
plus its configured servers; the create-issue tool is always denied for it.

MCP server configs hold secrets (bus token, `env` such as a Jira PAT). The Agent SDK would put `mcpServers` on the CLI
command line as `--mcp-config <json>`, readable by every local process, so `SdkClaudeDriver` writes them to
`<os tmp>/claude-bridge-mcp-<hash of data_dir>-XXXXXX/mcp-config.json` (mkdtemp, exclusive create, mode 0600) and passes
`extraArgs: { "mcp-config": <path> }` with `strictMcpConfig`. The file is deleted when the session's process ends;
files left by a killed backend are removed at the next start.

### Session lifecycle and resume

- `session.create {role:"planner", repo}`: `repo` is a name from `repos`; the cwd is that repo's path (never taken from
  the UI). The row is written at once (`state: starting`); the Claude process is spawned on the first `session.send`.
  The creating connection is subscribed to the session's events.
- Every SDK message is written to `session_events` (origin `agent`) before it is pushed as `session.event`. Typed text
  is stored as `{type:"user_text", text}` with origin `user`; wake turns use origin `system`; bridge notices (process
  died) are `{type:"bridge_notice", message}` with origin `system`.
- The `init` message stores `claude_session_id` and moves the session to `active`.
- `busy` is true from a send until the turn's `result`; every change is pushed as `session.updated` (broadcast).
- Backend start: sessions in `starting` / `active` become `detached` (graceful shutdown does the same). The next
  `session.send` spawns the process with `resume: claude_session_id`; `session.open {session_id, since}` replays the
  stored events (`session.history`: the latest 5000 events with `id > since`, ascending, with `truncated: true` and
  `first_id` when older ones were left out) and subscribes to live ones in the same tick. `task.open` works the same.
  A process that dies on its own makes the session `detached` (resumable) or `error` (no init was received). A
  resumed process that fails before `init` (e.g. "No conversation found" after transcripts were cleaned up) clears
  `claude_session_id` and records a `bridge_notice`, so the next start begins a new conversation instead of failing forever.
- `session.send` to a session that is closing, or whose process has already exited, fails with `CONFLICT` (the
  message is not stored and not silently dropped).
- `session.interrupt` calls `Query.interrupt()`; `session.close` closes the query and sets `state: closed` (not allowed
  for the orchestrator, which the backend manages).
- `project.select` sets the connection's project and `status.project_key` (single user: the last selection wins) and
  returns `{project_key, orchestrator_session}`. The snapshot carries open planner sessions + that project's orchestrator.

### Orchestrator supervision

The orchestrator session for a project is reused across restarts (resume by `claude_session_id`). If its process dies,
the backend respawns it with resume after 1 s, 2 s, 4 s ... (max 60 s); `status.orchestrator` goes `restarting` then
`alive`, or `dead` after 5 consecutive failures (a run of 5 min or a completed turn resets the count; a user message to a
dead orchestrator restarts it). After a respawn a `tick` wake is queued so it rebuilds the picture. No turn is sent at
startup; the first trigger (worker registration, tick) wakes it.

### Permission Broker

The planner's create-issue tool (`jira_create_tool_pattern`) is held in `canUseTool`: a `permission_requests` row is
written and `permission.request` is broadcast. `permission.respond`:
`allow` runs the tool with its input; `allow` + `updated_input` runs it with the edited input; `deny` gives the planner
`reason` (or a default Vietnamese message) and the conversation continues. Every decision is stored and broadcast as
`permission.resolved`. A pending request is denied with reason `expired` when its turn is interrupted, its session dies
or closes, or the backend restarts. When the approved call's `tool_result` comes back without `is_error`, the ticket key
is taken from the result (`key` / `issueKey` fields first, then a Jira key regex preferring the input's project) and the
labels from the effective input (`labels`, `fields.labels`, `additional_fields.labels`), then `bus.emitTicketCreated`
publishes `ticket.created`. A denied request never produces `ticket.created`.

### Wake Dispatcher

Triggers: `ticket.created` with `has_agent_label`, `task.completed`, `task.failed` (routed by the ticket key's project),
`worker.registered` (all orchestrators), and a `tick` every `orch_tick_minutes`. Triggers within
`wake_debounce_seconds` of the first one are merged into one `[bridge-event]` turn (`formatWakeTurn`, identifiers only,
duplicates removed). If the orchestrator is mid-turn the events wait and are sent as one turn when its `result`
arrives. Events for an orchestrator that is stopped or dead are dropped (it rebuilds its picture when it starts).
User messages to the orchestrator are plain `session.send` turns, never debounced.

### Jira Reader

Reads the team `.env` (`jira_env_file`) once at startup. For each project in `projects` (or `MPS_JIRA_PROJECT_KEY`):
`GET /rest/api/2/search` with
`project = "<KEY>" AND labels = "<agent_label>" AND statusCategory != Done ORDER BY updated DESC`,
`Authorization: Bearer <PAT>`, paginated. `blocked_by` = inward links of type `Blocks` / "is blocked by" whose issue is
not done. Polls every `jira_poll_seconds` and at once on `ticket.created`, `task.completed`, `task.failed` and
`tickets.refresh` (overlapping requests collapse into one more read). Pushes `tickets.updated` when the list changes;
`status.jira` is `ok`, `error` (last read failed) or `unconfigured`. `MPS_CA_BUNDLE` is added to Node's root CAs for that
agent only. The PAT is never logged. Read only.

### Seat usage

`status.seat_usage` / `status.rate_limited_until` come only from the SDK's `rate_limit_event` (and assistant messages
with `error: "rate_limit"`), as decided for section 10.4.

## Behaviour notes

- `max_concurrency` is checked against `assigned + running` at assign time, and `SystemStatus.running` reports the same
  number, so "Đang chạy x/y" matches the error the orchestrator gets.
- Task tokens and runner tokens are stored as SHA-256 hashes and survive a restart. A task token's plain text is kept in
  memory until the task ends. If the bus restarts before the runner picks the task up, `next` issues a new token.
  Orchestrator tokens (one per project) are generated on every start (P10). An orchestrator token only acts on tickets
  `<PROJECT>-*`: `assign_task` / `cancel_task` on another project's ticket fail with `FORBIDDEN`, `list_tasks` returns
  only its project's tasks; `list_workers` is shared.
- `complete_task.mr_url` must be an `http` / `https` URL (`javascript:` and others fail with `INVALID_INPUT`).
- After a restart, the sweeper measures the heartbeat and start timeouts from the restart time at the earliest, so
  runners get one full period to re-register.
- A worker tool call (`report_progress` / `complete_task` / `fail_task`) on an `assigned` task first moves it to
  `running` (event `task.started` with `implied: true`), so the state machine stays `assigned → running → end`.
- The heartbeat returns `cancel: true` when the runner's current task is `cancelled`, was failed by the bus
  (system category), is unknown, or belongs to another worker. Tasks that the worker failed itself are not killed.
- A runner that polls `next` or sends a heartbeat while marked `offline` goes back to `idle` and emits `worker.registered`.
- Runner error contract: an unknown worker gets `404 WORKER_NOT_FOUND` and a bad runner token gets `401`. The runner
  re-registers in both cases. `started` on a task that is no longer active gets `409 TASK_NOT_ACTIVE`, and the runner
  then kills the process. A task owned by another worker gets `403`. `exited` is idempotent and returns `200` on terminal
  tasks, where it only records `usage`. `events` is accepted on terminal tasks so the trailing `result` line is kept.
  These paths never return 5xx.
- `data_dir` defaults to `./data` next to the config file. With the config at the repo root, the bootstrap token file is
  `<repo>/data/runner-bootstrap.token`, which is where the runner looks by default.
- Terminal tasks are immutable at two levels: conditional `UPDATE … WHERE state IN ('assigned','running')` and an SQLite
  trigger. Only `usage` and `session_id` can be filled in later.

## Extension points

Everything is created in `createApp(config, opts)` (`src/app.ts`), which returns a `BridgeApp`:
`{ config, app, db, eventLog, bus, core, runners, sweeper, tokens, status, hub, agents, jira, pairingToken,
runnerBootstrapToken, baseUrl(), mcpUrl(), listen(), close() }`. `opts.claudeDriver` replaces the Agent SDK driver
(tests use `FakeClaudeDriver` from `src/claude/fakeDriver.ts`); `opts.timers` replaces the timers used for debounce,
tick, Jira poll and restart backoff. Orchestrators, the wake tick and the Jira poll start in `listen()`.

### Claude driver - `src/claude/driver.ts`

```ts
interface ClaudeDriver { start(options: ClaudeSessionOptions): ClaudeSessionHandle }
interface ClaudeSessionHandle { messages: AsyncIterable<SDKMessage>; send(text): void; interrupt(): Promise<void>; close(): void }
```

`SdkClaudeDriver` runs `query({ prompt: AsyncIterable<SDKUserMessage>, options })`; `ClaudeSessionOptions` is a `Pick`
of the SDK `Options` plus a required `cwd`.

### Sessions - `bridge.agents`

```ts
agents.sessions: SessionManager        // createPlanner, get, list, history, ensureLive, sendText(id, text, "user" | "system"),
                                       // interrupt, close; onUpdated / onMessage / onTurnEnded / onLive / onEnded
agents.orchestrators: OrchestratorManager  // start(project), health(project), sessionFor(project), isReady(project)
agents.broker: PermissionBroker        // listPending(), respond(...), onRequest / onResolved
agents.wake: WakeDispatcher            // enqueue(project, WakeEvent), pendingEvents(project)
bridge.jira.reader: JiraReader         // tickets(), status(), refresh()
```

### Task Bus — `bridge.bus: TaskBus`

```ts
emitTicketCreated(input: { ticket_key: string; session_id: string; labels: string[] }): BusEvent<TicketCreatedPayload>
setDispatchPaused(paused: boolean): boolean          // true if it changed
isDispatchPaused(): boolean
listWorkers(filter?: ListWorkersInput): Worker[]
listTasks(filter?: ListTasksInput): Task[]
listRecentTasks(limit?: number): Task[]              // all active + recent terminal tasks
getTask(taskId: string): Task | null
status(): BusStatus                                   // worker/task counts, active, max_concurrency, dispatch_paused
onTaskAssigned(cb: (task: Task) => void): Unsubscribe
```

`bridge.tokens.getOrchestratorToken(project: string): string` is the bearer token for that project's orchestrator bus MCP config
(`mcpServers: { "bridge-bus": { type: "http", url: bridge.mcpUrl(), headers: { Authorization: "Bearer …" } } }`).

Change listeners on `bridge.core: BusCore`. All of them fire after the SQLite transaction commits:

```ts
onWorkerUpdated(cb: (w: Worker) => void): Unsubscribe
onTaskUpdated(cb: (t: Task) => void): Unsubscribe
onStatusChanged(cb: () => void): Unsubscribe
```

### Event Log — `bridge.eventLog: EventLog`

```ts
onBusEvent(cb: (e: BusEvent) => void): Unsubscribe           // Wake Dispatcher subscribes here (task.completed, ...)
onSessionEvent(cb: (r: SessionEventRecord) => void): Unsubscribe
appendBusEvent(input: BusEventInput): BusEvent               // outside a bus transaction only
readBusEventsSince(sinceSeq: number, limit?: number): BusEvent[]
lastSeq(): number
appendSessionEvent(input: { session_id; task_id?; origin; event }): SessionEventRecord   // write before pushing to WS
appendSessionEvents(inputs): SessionEventRecord[]
readSessionEvents(q: { session_id?; task_id?; since?; limit? }): SessionEventRecord[]
```

Session events are routed to WS clients automatically: to clients that opened the `session_id`
(`client.openSession`) or the `task_id` (`task.open`). Never put tokens or secrets in any payload (§12).

### WebSocket hub — `bridge.hub: WsHub`

```ts
registerHandler<K extends ClientMessageType>(type: K, schema: z.ZodType, handler: (ctx: { client: WsClient; requestId: string }, payload: ClientPayloads[K]) => unknown): void
registerSnapshotContributor(fn: () => { sessions?: Session[]; tickets?: Ticket[]; pending_permissions?: PermissionRequest[] }): () => void
broadcast<K extends ServerMessageType>(type: K, payload: ServerPayloads[K]): void      // all subscribed clients
sendToSubscribersOfSession<K>(sessionId: string, type: K, payload: ServerPayloads[K]): void
routeSessionEvent(record: SessionEventRecord): void
```

- The handler's return value is sent as `ack {result}`. Throw `WsError(code, message)` or `BusError` to send `error`.
  Payload validation failures and unknown types return `BAD_REQUEST`.
- Registering a type again replaces the handler. This is intended for `tickets.refresh`, whose Phase 1 handler only acks.
- Snapshot contributors must be synchronous (read from DB or memory). `subscribe` builds the snapshot and replays events
  in one tick, so no event is lost or duplicated between them.
- `WsClient`: `send(type, payload, id?)`, `openSession(id)`, `closeSession(id)`, `openTask(id)`, `subscribed`, `principal`.
- Auth: `TokenVerifier { verify(token): Promise<AuthPrincipal | null> }` (`src/ws/auth.ts`). Pass another implementation
  as `createApp(config, { tokenVerifier })` to add JWT / SSO.
- Built in: `auth` (replies `auth.ok` and then `ack` with the same id), `subscribe`, `dispatch.pause`, `dispatch.resume`,
  `task.open`, `tickets.refresh` (replaced by the Jira Reader: `{refreshed, jira, count?}`), `project.select`,
  `session.create` / `list` / `open` / `send` / `interrupt` / `close`, `permission.respond`. Acks: `session.create` and
  `session.send` / `session.open` / `session.close` return `{session}`, `session.list` returns `{sessions}`,
  `session.interrupt` returns `{interrupted}`, `permission.respond` returns `{request}`.

### System status — `bridge.status: StatusService`

```ts
registerContributor(fn: () => Partial<Pick<SystemStatus, "project_key" | "orchestrator" | "jira" | "seat_usage" | "rate_limited_until">>): Unsubscribe
notifyChanged(): void      // call when your fields change; the hub pushes system.status
get(): SystemStatus
```

The bus owns `dispatch_paused`, `running` and `max_concurrency`. The defaults are `orchestrator: "stopped"`,
`jira: "unconfigured"` and `project_key: null`.

### Database

`src/db/database.ts` holds versioned migrations (`PRAGMA user_version`). To add tables or columns, append a new entry to
`MIGRATIONS`. Never edit an existing entry. The `sessions` and `permission_requests` tables already exist
(`sessions.busy` is runtime-only and not stored).
