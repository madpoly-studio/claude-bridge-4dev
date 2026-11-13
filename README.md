# claude-bridge-4dev

Hệ thống web để **một người dùng điều khiển và quan sát các session Claude CLI** trong một luồng multi-agent gắn với
Jira (self-host) và GitLab (self-host).

```
Planner (chat, 1 phiên / 1 vấn đề) ──duyệt──► ticket Jira (label "agent")
                                                   │
Orchestrator (1 / Jira project) ◄── bạn yêu cầu ───┘  (wake_mode "auto": tự đánh thức)
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

## Cài nhanh trên Windows

Cách dành cho người dùng: chỉ điền **một file** (`settings.json`), chạy `prepare.cmd` (tạo worktree) rồi `start.cmd`.
Mọi cấu hình của các gói (`bridge.config.json`, `runner.config.json`, file `.env` Jira, MCP của worker, flow của worker)
được sinh tự động.

Cần có sẵn: Node.js ≥ 22, Git for Windows, Claude Code (`claude` trong PATH, đã đăng nhập), uv (`winget install astral-sh.uv`).

```bat
git clone https://github.com/madpoly-studio/claude-bridge-4dev.git D:\claude-bridge
node D:\claude-bridge\scripts\mps-bridge\setup.mjs
```

Clone vào thư mục nào cũng được (`D:\claude-bridge` chỉ là ví dụ); bản clone đó chính là ứng dụng. `setup.mjs` tạo thư
mục làm việc `ws\` ngay trong bản clone (git bỏ qua nó), cài thư viện, build, rồi tạo `ws\settings.json` mẫu,
`ws\start.cmd`, `ws\prepare.cmd`, `ws\update.cmd` và `ws\HUONG-DAN.txt`. Setup không clone hay pull gì thêm.

| Việc | Cách làm |
|---|---|
| Điền cấu hình | Mở `ws\settings.json`, thay mọi giá trị `<VIET_HOA>` (Jira PAT, project key, repo). Khóa bắt đầu bằng `_` chỉ là hướng dẫn |
| Chuẩn bị worktree | `ws\prepare.cmd` (lần đầu): kiểm tra settings, `git fetch origin <base_branch>` rồi `git worktree add` cho từng worker, in ra bước đang làm. Chỉ cần git: không kiểm tra cổng, không build, không cần pairing token. Repo lớn (Unity) có thể mất nhiều phút. Worktree đã có thì bỏ qua |
| Chạy | `ws\start.cmd`: kiểm tra settings (liệt kê **mọi** lỗi một lần), kiểm tra cổng và công cụ, làm bước chuẩn bị worktree như `prepare.cmd` (bỏ qua worktree đã có), build nếu thiếu, sinh `ws\generated\`, rồi chạy backend + runner + web trong một cửa sổ |
| Mở giao diện | `http://127.0.0.1:4173` (mặc định), dán pairing token in trong khung "claude-bridge đang chạy" |
| Dừng | Ctrl+C trong cửa sổ đó. Hỏi `Terminate batch job (Y/N)?` thì gõ Y |
| Cập nhật | Dừng dịch vụ, rồi `ws\update.cmd`: `git pull --ff-only origin main` trong bản clone, cài thư viện, build, ghi lại các launcher (tạo `prepare.cmd` cho bản cài cũ). Từ chối nếu dịch vụ còn chạy, hoặc bản clone có thay đổi chưa commit, không ở nhánh `main`, hay không có remote `origin` |

Cổng: `ports.bridge` (mặc định 8787) và `ports.web` (mặc định 4173). Giao diện mặc định kết nối `ws://127.0.0.1:8787/ws`;
đổi `ports.bridge` thì lần đầu nhập WebSocket URL mà `start.cmd` in ra ở màn hình Kết nối.

Mã thoát của `start.cmd` / `prepare.cmd` / `update.cmd` / `setup.mjs`: `0` dừng bình thường (với `prepare.cmd`: worktree
đã sẵn sàng), `1` dịch vụ dừng bất ngờ hoặc không sẵn sàng kịp (xem `logs\`), `2` `settings.json` thiếu hoặc sai, `3` môi
trường (thiếu công cụ, cổng bị chiếm, lỗi git/build/worktree), `130` Ctrl+C lần hai (dừng ngay).

`generated\` bị xóa và ghi lại ở mỗi lần start: không sửa tay. `settings.json` và `generated\` chứa Jira PAT, `logs\`
chứa pairing token. Worktree đã tạo xong không bao giờ bị script xóa hay reset: việc dở (sau Ctrl+C) được cất vào
`git stash` ở lần start sau. `repos[].path` nên là một bản clone riêng cho bridge, không phải clone đang code hằng ngày,
và không được nằm trong bản clone bridge. Mỗi lúc chỉ một `start.cmd` / `prepare.cmd` / `update.cmd` chạy trên một thư
mục làm việc (`data\mps-bridge.lock`).

Thời gian chờ của bước worktree: `git fetch` và mỗi `git worktree add` tối đa **10 phút** (cả `worktree remove`,
`stash push`, `checkout` trong worktree); `git status` 2 phút; các lệnh chỉ đọc ref/object (`rev-parse`,
`worktree list`, `show`, `ls-tree`) 30 giây. Hết giờ thì cây tiến trình git bị dừng (`taskkill /T /F`), và script chỉ
dọn sau khi `taskkill` xong và mọi tiến trình con còn giữ output của git đã thoát. Worktree **tạo dở** được tự xóa,
không bao giờ bị stash:

- `git worktree add` lỗi hoặc quá giờ: xóa ngay đăng ký worktree đó (`git worktree remove --force --force`) và thư
  mục mà chính lần chạy này vừa tạo, rồi báo lỗi gốc.
- Lần chạy trước bị dừng giữa lúc tạo (Ctrl+C, đóng cửa sổ, quá giờ ở bản cũ): git để lại khóa `initializing`
  (`git worktree list --porcelain` hiện `locked initializing`). Slot nào còn khóa này mà HEAD chưa đổi kể từ lúc tạo
  (reflog của HEAD chỉ có đúng mục của `worktree add`) thì được xóa và tạo lại, kèm cảnh báo. Nếu đã có
  checkout/commit sau đó (bản cũ có thể đã giao worktree dở này cho worker) thì chỉ mở khóa, rồi xử lý như worktree
  bình thường (việc dở được stash, không xóa). Worktree khóa vì lý do khác, worktree không phải slot, và file có sẵn
  ở đường dẫn slot không bị đụng tới. Lệnh git của script chạy với `LC_ALL=C` để lý do khóa không bị dịch.

Lưu ý khi chạy từ bản clone:

- **Đừng chạy `git clean -fdx`** trong bản clone: lệnh đó xóa luôn `ws\` (settings, token, cơ sở dữ liệu, worktree).
- **Dùng một bản clone riêng để chạy bridge**, không code trên đó: `update.cmd` cần bản clone sạch trên `main` và build
  lại tại chỗ; `pnpm build` khi đang dev sẽ thay `dist\` dưới chân runner đang chạy. File cấu hình của chế độ dev
  (`bridge.config.json`, `runner.config.json`, `config\mcp\`, `data\`, `.env*`) trong bản clone bị cấm với worker và
  `start.cmd` cảnh báo nếu thấy chúng; file `jira_env_file` mà `bridge.config.json` ở gốc bản clone trỏ tới (đường
  dẫn tương đối tính từ gốc bản clone) cũng bị cấm và cảnh báo khi nằm trong bản clone. `--workspace` chỉ được trỏ vào
  trong bản clone khi nằm dưới `ws\`.
- **Đường dẫn dài** (repo Unity, bản clone nằm sâu): worktree mặc định ở `ws\worktrees\<repo>-01`, cộng thêm đường dẫn
  file dài nhất của repo có thể vượt 260 ký tự của Windows (`start.cmd` cảnh báo). Đặt `worktrees_dir` trong
  `settings.json` sang một thư mục ngắn (ví dụ `D:/wt`) và chạy `git config --global core.longpaths true`. Thư mục này
  phải nằm ngoài mọi repo và ngoài bản clone bridge (trừ trong `ws\`), mỗi bridge một thư mục riêng. Quyền truy cập
  (ACL) chỉ được khóa trên `ws\`, không khóa trên `worktrees_dir` riêng (không có bí mật nào ở đó). Đổi `worktrees_dir`
  thì `start.cmd` liệt kê worktree cũ kèm lệnh `git worktree remove` để bạn tự xóa.
- **Thư mục cha của worktree**: Claude Code nạp `CLAUDE.md` / `CLAUDE.local.md` / `.claude\CLAUDE.md` ở mọi thư mục
  cha của nơi worker và orchestrator chạy, và Node đọc `node_modules` / `package.json` ở thư mục cha. Với bố cục mặc
  định, các thư mục cha gồm cả bản clone bridge: đừng thêm `CLAUDE.md` vào gốc repo này. `start.cmd` cảnh báo nếu
  thấy file như vậy; nếu cần, đặt `worktrees_dir` ra chỗ khác.

### Chuyển từ bản cài cũ `D:\mps-claude-bridge`

Bản cài cũ để mã nguồn trong `D:\mps-claude-bridge\app\` và dữ liệu ngay trong `D:\mps-claude-bridge`. `update.cmd`
cũ vẫn chạy được (nó cập nhật `app\` rồi ghi lại launcher), nhưng để chuyển sang bố cục mới:

1. Dừng `start.cmd` cũ.
2. Clone bridge vào thư mục mới và chạy `setup.mjs` như trên. (`setup.mjs` nằm trong `app\` của bản cũ, chạy không có
   `--workspace`, sẽ từ chối để không tạo thư mục làm việc thứ hai cạnh bản đang chạy; `--ignore-old-install` bỏ qua.)
3. Chép `D:\mps-claude-bridge\settings.json` sang `ws\settings.json` của bản clone mới. Muốn giữ token đã ghi nhớ trên
   trình duyệt thì chép thêm `data\pairing-token.txt`; không chép cơ sở dữ liệu.
4. Việc dở đã được auto-stash nằm trong stash chung của từng repo (`git -C <repo> stash list`), không mất khi xóa worktree.
5. Xóa worktree cũ: `git -C <repo> worktree remove "D:\mps-claude-bridge\worktrees\<repo>-01"` (hoặc xóa thư mục rồi
   `git -C <repo> worktree prune`). `start.cmd` / `prepare.cmd` mới cũng liệt kê chúng.
6. Xóa thư mục `D:\mps-claude-bridge`.

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
| `wake_mode` | `"manual"` (mặc định): orchestrator chỉ làm khi bạn nhắn yêu cầu; bridge chỉ báo cho nó kết quả `task.completed` / `task.failed`. `"auto"`: tự đánh thức khi worker đăng ký, có ticket label `agent` mới và mỗi `orch_tick_minutes` (hành vi cũ) |

Biến môi trường ghi đè: `BRIDGE_PORT`, `MAX_CONCURRENCY`, `TASK_TIMEOUT_MINUTES`, `ORCH_TICK_MINUTES`,
`WAKE_MODE`, `JIRA_POLL_SECONDS`, `ALLOWED_ORIGINS`, `CLAUDE_AUTH_MODE`, `BRIDGE_PAIRING_TOKEN`, `RUNNER_BOOTSTRAP_TOKEN`, `LOG_LEVEL`.
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
2. Khi bridge khởi động, cột **Orchestrator** chỉ hiện thông tin bridge và lời chào (không tốn turn Claude); orchestrator
   **không tự lấy ticket**. Nhắn yêu cầu cho nó, ví dụ "Liệt kê các ticket label agent đang mở" hoặc "Giao SH-123 cho
   worker rảnh". Task xong/lỗi thì bridge báo cho orchestrator để nó báo lại bạn; nó chỉ giao tiếp khi đó là phần việc
   bạn đã yêu cầu và không tự retry task lỗi. (Với `wake_mode: "auto"`: `ticket.created` và tick mỗi
   `orch_tick_minutes` tự đánh thức orchestrator như trước.)
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
