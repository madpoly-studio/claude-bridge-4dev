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
scripts/mps-bridge/  cài đặt + khởi chạy trên Windows từ một file settings.json (setup.mjs, cli.mjs init|start|update)
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

## Cài nhanh trên Windows (D:\mps-claude-bridge)

Cách dành cho người dùng: chỉ điền **một file** (`settings.json`) rồi chạy `start.cmd`. Mọi cấu hình của các gói
(`bridge.config.json`, `runner.config.json`, file `.env` Jira, MCP của worker, flow của worker) được sinh tự động.

Cần có sẵn: Node.js ≥ 22, Git for Windows, Claude Code (`claude` trong PATH, đã đăng nhập), uv (`winget install astral-sh.uv`).

```bat
git clone https://github.com/madpoly-studio/claude-bridge-4dev.git D:\mps-claude-bridge\app
node D:\mps-claude-bridge\app\scripts\mps-bridge\setup.mjs
```

`setup.mjs` tạo `D:\mps-claude-bridge` (nếu chưa có), clone hoặc cập nhật `app\` (nhánh `main`), cài thư viện,
build, rồi tạo `settings.json` mẫu, `start.cmd`, `update.cmd` và `HUONG-DAN.txt`.

| Việc | Cách làm |
|---|---|
| Điền cấu hình | Mở `D:\mps-claude-bridge\settings.json`, thay mọi giá trị `<VIET_HOA>` (Jira PAT, project key, repo). Khóa bắt đầu bằng `_` chỉ là hướng dẫn |
| Chạy | `start.cmd`: kiểm tra settings (liệt kê **mọi** lỗi một lần), kiểm tra công cụ và cổng, sinh `generated\`, tạo worktree cho từng worker, rồi chạy backend + runner + web trong một cửa sổ |
| Mở giao diện | `http://127.0.0.1:4173` (mặc định), dán pairing token in trong khung "claude-bridge đang chạy" |
| Dừng | Ctrl+C trong cửa sổ đó. Hỏi `Terminate batch job (Y/N)?` thì gõ Y |
| Cập nhật | Dừng dịch vụ, rồi `update.cmd` (từ chối nếu dịch vụ còn chạy hoặc `app\` có thay đổi chưa commit) |

Cổng: `ports.bridge` (mặc định 8787) và `ports.web` (mặc định 4173). Giao diện mặc định kết nối `ws://127.0.0.1:8787/ws`;
đổi `ports.bridge` thì lần đầu nhập WebSocket URL mà `start.cmd` in ra ở màn hình Kết nối.

Mã thoát của `start.cmd` / `update.cmd` / `setup.mjs`: `0` dừng bình thường, `1` dịch vụ dừng bất ngờ hoặc không sẵn sàng
kịp (xem `logs\`), `2` `settings.json` thiếu hoặc sai, `3` môi trường (thiếu công cụ, cổng bị chiếm, lỗi git/build/worktree),
`130` Ctrl+C lần hai (dừng ngay).

`generated\` bị xóa và ghi lại ở mỗi lần start: không sửa tay. `settings.json` và `generated\` chứa Jira PAT, `logs\`
chứa pairing token. Worktree trong `worktrees\` không bao giờ bị script xóa hay reset: việc dở (sau Ctrl+C) được cất vào
`git stash` ở lần start sau. `repos[].path` nên là một bản clone riêng cho bridge, không phải clone đang code hằng ngày.
Mỗi lúc chỉ một `start.cmd` / `update.cmd` chạy trên một thư mục làm việc (`data\mps-bridge.lock`).

Danh sách lệnh cấm của worker (`git push --force`, xóa nhánh remote, …) chỉ là lớp bảo vệ phụ: rule của Claude so khớp
theo tiền tố nên không chặn được mọi biến thể. Trưởng nhóm cần bật **protected branch** trên GitLab cho `base_branch` của
mỗi repo.

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
| `jira_env_file` | Đường dẫn file `.env` của team (đọc `MPS_JIRA_URL`, `MPS_JIRA_PAT`, `MPS_CA_BUNDLE`) cho tab Tickets. Backend chỉ **đọc** Jira. Phải nằm **ngoài** mọi repo trong `repos` (planner đọc được repo), nếu không backend không khởi động |
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
pnpm test:e2e    # bus + runner thật + claude giả; web client + backend thật; config sinh bởi mps-bridge
pnpm test:scripts  # unit test của scripts/mps-bridge (node:test, không cần build)
```

Không test nào gọi Claude thật hay Jira thật: dùng driver Claude giả, `fake-claude.mjs` và server Jira giả.

## Bảo mật

Web UI này tương đương một remote shell trên máy chứa source code và token Jira/GitLab.

- Backend chỉ bind `127.0.0.1`. WebSocket kiểm tra `Origin` theo `allowed_origins` và yêu cầu pairing token ở message đầu tiên.
- Token riêng cho từng role: runner (bootstrap → runner token), orchestrator (một token / project, chỉ tool điều phối
  trên ticket `<PROJECT>-*`), worker (task token, chỉ tác động lên task của nó). Token lưu dạng hash, không ghi vào event log.
- Cấu hình MCP của session Claude (bearer token của bus, `env` như Jira PAT) được ghi vào file tạm riêng (mode 0600,
  thư mục tạm riêng) và truyền bằng `--mcp-config <đường dẫn>`, không bao giờ nằm trên command line của process.
- Planner chỉ có tool đọc, chặn ba lớp (`tools`, hook `PreToolUse`, `canUseTool`). Tool ghi duy nhất là tạo issue, luôn qua gate duyệt.
  Mọi đường dẫn planner đọc phải resolve (realpath) vào trong repo của session; file trông như secret (`.env*`, `*.pem`,
  `*.key`, `id_rsa*`, `.npmrc`, `.netrc`, `credentials*`) luôn bị từ chối.
- `cwd` của session chỉ lấy từ `repos`. Session không nạp settings của người dùng (`setting_sources: []` mặc định),
  để allow rule cá nhân không nới quyền planner. Planner không được nạp `project` / `local` (repo do worker ghi, settings
  của repo có thể cài hook / env); muốn đưa nội dung `CLAUDE.md` cho planner thì dùng `planner.system_prompt_append`.

## Trạng thái

Đã xong Phase 0–7 của lộ trình trong system design. **Phase 8** (chạy thật end-to-end: planner → Jira → orchestrator
→ worker → merge request) cần cấu hình Jira/GitLab MCP thật và chạy tay.

Các mục còn **[MỞ]** (đang để cấu hình được, xem [docs/decisions.md](docs/decisions.md)):

- MCP server Jira cụ thể mà team dùng, và tên tool tạo issue (`jira_create_tool_pattern`)
- Allowlist tool của worker cho từng repo
- Nguồn dữ liệu hạn mức seat (hiện chỉ hiện chip khi gặp rate limit)
- Xác thực bằng JWT của SSO (hiện dùng pairing token; Auth Gate có interface `TokenVerifier` để thêm sau)
