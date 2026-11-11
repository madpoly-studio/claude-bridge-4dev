# @claude-bridge/backend

Bridge backend: Task Bus (SQLite + MCP + runner HTTP API), Event Log, WebSocket hub with the Auth Gate.
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

## Behaviour notes

- `max_concurrency` is checked against `assigned + running` at assign time, and `SystemStatus.running` reports the same
  number, so "Đang chạy x/y" matches the error the orchestrator gets.
- Task tokens and runner tokens are stored as SHA-256 hashes and survive a restart. A task token's plain text is kept in
  memory until the task ends. If the bus restarts before the runner picks the task up, `next` issues a new token.
  The orchestrator token is generated on every start (P10).
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
`{ config, app, db, eventLog, bus, core, runners, sweeper, tokens, status, hub, pairingToken, runnerBootstrapToken,
baseUrl(), mcpUrl(), listen(), close() }`. New modules (sessions, permission, wake, jira) should be wired in `createApp`.

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

`bridge.tokens.getOrchestratorToken(): string` is the bearer token for the orchestrator session's bus MCP config
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
  `task.open`, `tickets.refresh`.

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
