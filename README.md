# claude-bridge-4dev

Hệ thống web để **một người dùng điều khiển và quan sát các session Claude CLI** trong một luồng multi-agent gắn với
Jira (self-host) và GitLab (self-host).

```
Planner (chat, 1 phiên / 1 vấn đề) ──duyệt──► ticket Jira (label "agent")
                                                   │
Orchestrator (1 / Jira project) ◄── đánh thức ─────┘
        │ assign_task (MCP)
        ▼
Task Bus (SQLite) ◄── HTTP ──► Worker Runner ×M ──spawn──► claude -p trong worktree ──► GitLab MR
        │
        └── WebSocket ──► Web UI (Planner │ Orchestrator │ Log)
```

| Agent | Vai trò |
|---|---|
| **Planner** | Session hội thoại, đọc codebase, đề xuất giải pháp. Tool tạo issue Jira luôn phải qua **gate duyệt** trên UI (Duyệt / Sửa / Hủy) |
| **Orchestrator** | Session LLM dài hạn, mỗi Jira project một instance. Chỉ điều phối: quét Jira, giao việc cho worker rảnh qua tool `assign_task` |
| **Worker** | Slot gắn với một repo/worktree. Mỗi ticket chạy một `claude -p` mới, báo tiến độ qua `report_progress`, kết thúc bằng `complete_task` hoặc `fail_task` |

Nguyên tắc chính: Jira là nguồn sự thật về ticket. Mọi hành động điều phối là tool call có tham số, UI không bao giờ
parse câu chữ của LLM. State nằm ở SQLite, không nằm trong context của LLM. Mọi session đều resume được sau khi
backend restart.

## Cấu trúc repo

```
packages/protocol/   kiểu dữ liệu dùng chung: entity, bus event, MCP tool, API runner, WS message
packages/backend/    Auth Gate, Session Manager, Permission Broker, Wake Dispatcher, Jira Reader, Event Log, Task Bus
packages/runner/     Worker Runner: long-poll bus, spawn claude -p, chuyển tiếp stream, heartbeat
packages/web/        React + Vite SPA (tĩnh, đặt trên host có SSO)
e2e/                 test tích hợp: bus + runner + claude giả; web client + backend thật
docs/decisions.md    các lựa chọn cho mục ĐỀ XUẤT / MỞ của system design và chỗ lệch
```

Chi tiết từng gói: [backend](packages/backend/README.md) · [runner](packages/runner/README.md) · [web](packages/web/README.md).

## Yêu cầu

- Node.js ≥ 22, pnpm 9
- Claude Code CLI đã đăng nhập (`claude` trong PATH). Mặc định chạy dưới seat Team plan của bạn
  (`claude_auth_mode: "subscription"`); đổi sang `"api_key"` và đặt `ANTHROPIC_API_KEY` nếu cần
- Git (runner kiểm tra worktree sạch trước khi giao việc)
- Chrome (hoặc trình duyệt Chromium) trên **cùng máy** với backend

## Cài đặt

```bash
pnpm install
pnpm build          # protocol → backend, runner, web
```

## Cấu hình

### 1. Backend: `bridge.config.json` ở thư mục gốc repo

```bash
cp bridge.config.example.json bridge.config.json
```

| Khóa | Ý nghĩa |
|---|---|
| `allowed_origins` | **Bắt buộc.** Origin của frontend (host SSO, và `http://localhost:5173` khi dev) |
| `repos` | **Bắt buộc.** `REPO_WHITELIST`: các repo planner được mở (`name`, `path`, `project_key`). UI chỉ chọn trong danh sách này |
| `projects` | Các Jira project key |
| `jira_env_file` | Đường dẫn file `.env` của team (đọc `MPS_JIRA_URL`, `MPS_JIRA_PAT`, `MPS_CA_BUNDLE`) cho tab Tickets. Backend chỉ **đọc** Jira |
| `planner.mcp_servers`, `planner.allowed_tools` | MCP server Jira cho planner và các tool đọc được phép. Tool tạo issue khớp `jira_create_tool_pattern` luôn qua gate duyệt |
| `orchestrators.<KEY>` | `cwd` riêng cho orchestrator của project, MCP Jira (đọc), allowlist |
| `max_concurrency`, `task_timeout_minutes`, `orch_tick_minutes`, `jira_poll_seconds` | Giá trị mặc định theo system design mục 13 |

Biến môi trường ghi đè: `BRIDGE_PORT`, `MAX_CONCURRENCY`, `TASK_TIMEOUT_MINUTES`, `ORCH_TICK_MINUTES`,
`JIRA_POLL_SECONDS`, `ALLOWED_ORIGINS`, `CLAUDE_AUTH_MODE`, `BRIDGE_PAIRING_TOKEN`, `RUNNER_BOOTSTRAP_TOKEN`, `LOG_LEVEL`.
Đường dẫn khác cho file cấu hình: `BRIDGE_CONFIG=<path>`.

### 2. Runner: `runner.config.json` ở thư mục gốc repo

```bash
cp runner.config.example.json runner.config.json
```

Mỗi phần tử `slots` là một worker: `worker_id`, `repo`, `worktree_path` (git worktree riêng, phải sạch),
`allowed_tools` (allowlist tool chạy headless của repo đó), `mcp_config_files` (MCP Jira / GitLab cho worker).
Ba tool bus của worker (`report_progress`, `complete_task`, `fail_task`) luôn được thêm tự động.

`bridge.config.json`, `runner.config.json` và `config/mcp/` đã nằm trong `.gitignore` vì có thể chứa token.

## Chạy

```bash
# Terminal 1: backend + Task Bus (bind 127.0.0.1:8787)
pnpm start:backend          # hoặc pnpm dev:backend khi phát triển
#   → in ra PAIRING TOKEN, dán vào UI một lần
#   → tạo data/runner-bootstrap.token cho runner

# Terminal 2: worker runner (mọi slot trong runner.config.json, hoặc --worker <id>)
pnpm start:runner --config runner.config.json

# Terminal 3: frontend khi dev (production: deploy packages/web/dist lên host SSO)
pnpm dev:web                # http://localhost:5173
```

Trên UI: bấm **Kết nối**, nhập pairing token. Lần đầu Chrome hỏi quyền **Local Network Access** cho origin của
frontend; cần cho phép để trang kết nối được `ws://127.0.0.1`.

Muốn xem giao diện mà không cần backend: mở `http://localhost:5173/?demo=1`.

### Luồng sử dụng

1. **Planner** → *Phiên mới* → chọn repo → mô tả vấn đề. Khi planner muốn tạo ticket, card bản nháp hiện ra:
   **Duyệt và tạo ticket**, **Sửa** (chỉnh tiêu đề, mô tả, label rồi tạo) hoặc **Hủy** (kèm lý do, planner tiếp tục
   hội thoại).
2. Ticket có label `agent` được tạo thì backend phát `ticket.created` và **đánh thức orchestrator** (gộp theo cửa sổ
   10 giây). Orchestrator cũng được đánh thức định kỳ mỗi `orch_tick_minutes` để bắt ticket tạo tay trên Jira.
3. **Orchestrator** đọc Jira và trạng thái worker, giao task qua `assign_task`.
4. **Runner** nhận task, chạy `claude -p` trong worktree. Tab **Log → Workers** hiện thanh 5 phase; bấm vào worker để
   xem **Chi tiết task** (chỉ xem).
5. Nút **Dừng giao việc** trên top bar chặn mọi `assign_task` mới ngay lập tức. Task đang chạy không bị ảnh hưởng.

## Kiểm thử

```bash
pnpm typecheck
pnpm test        # unit test: backend 80, runner 20, web 65
pnpm test:e2e    # bus + runner thật + claude giả; web client + backend thật
```

Không test nào gọi Claude thật hay Jira thật: dùng driver Claude giả, `fake-claude.mjs` và server Jira giả.

## Bảo mật

Web UI này tương đương một remote shell trên máy chứa source code và token Jira/GitLab.

- Backend chỉ bind `127.0.0.1`. WebSocket kiểm tra `Origin` theo `allowed_origins` và yêu cầu pairing token ở message đầu tiên.
- Token riêng cho từng role: runner (bootstrap → runner token), orchestrator (chỉ tool điều phối), worker (task token,
  chỉ tác động lên task của nó). Token lưu dạng hash, không ghi vào event log.
- Planner chỉ có tool đọc, chặn ba lớp (`tools`, hook `PreToolUse`, `canUseTool`). Tool ghi duy nhất là tạo issue, luôn qua gate duyệt.
- `cwd` của session chỉ lấy từ `repos`. Session không nạp settings của người dùng (`setting_sources: []` mặc định),
  để allow rule cá nhân không nới quyền planner.

## Trạng thái

Đã xong Phase 0–7 của lộ trình trong system design. **Phase 8** (chạy thật end-to-end: planner → Jira → orchestrator
→ worker → merge request) cần cấu hình Jira/GitLab MCP thật và chạy tay.

Các mục còn **[MỞ]** (đang để cấu hình được, xem [docs/decisions.md](docs/decisions.md)):

- MCP server Jira cụ thể mà team dùng, và tên tool tạo issue (`jira_create_tool_pattern`)
- Allowlist tool của worker cho từng repo
- Nguồn dữ liệu hạn mức seat (hiện chỉ hiện chip khi gặp rate limit)
- Xác thực bằng JWT của SSO (hiện dùng pairing token; Auth Gate có interface `TokenVerifier` để thêm sau)
