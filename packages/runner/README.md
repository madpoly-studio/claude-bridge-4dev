# @claude-bridge/runner — Worker Runner

Process nhẹ (không phải LLM) nhận task từ Task Bus và chạy `claude -p` headless trong worktree của slot
(system design §6, §7.5, §7.8).

## Chạy

```bash
pnpm --filter @claude-bridge/protocol build      # một lần, nếu chưa có dist
pnpm --filter @claude-bridge/runner build
cp runner.config.example.json runner.config.json  # rồi sửa slot, worktree, allowlist

# dev (tsx)
pnpm --filter @claude-bridge/runner dev -- --config ../../runner.config.json
# build
node packages/runner/dist/index.js --config runner.config.json [--worker w-sh-01]
```

| Tham số / env | Ý nghĩa |
|---|---|
| `--config <path>` | File cấu hình. Mặc định: env `RUNNER_CONFIG`, nếu không có thì `./runner.config.json` |
| `--worker <id>` | Chỉ chạy slot này. Mặc định chạy mọi slot trong file |
| `RUNNER_BOOTSTRAP_TOKEN` | Token bootstrap để gọi `POST /runners/register` (P9). Nếu không đặt, đọc `bootstrap_token_file` |
| `RUNNER_LOG_LEVEL` | `debug` \| `info` (mặc định) \| `warn` \| `error` |

**Một process, nhiều slot.** Design §6 ghi "một instance cho mỗi slot". Runner chạy một vòng lặp độc lập cho mỗi
slot trong cùng process (register, long-poll, heartbeat, child process riêng), tương đương về hành vi. Muốn tách
process thì chạy nhiều lần với `--worker <id>`.

## Cấu hình (`runner.config.json`)

Validate bằng zod khi khởi động; sai cấu hình thì in lỗi và thoát với mã 2. Key lạ (vd. `_comment`) bị bỏ qua.
Đường dẫn tương đối (`worktree_path`, `bootstrap_token_file`, `mcp_config_files`) tính từ thư mục của file cấu hình.

| Khóa | Mặc định | Ghi chú |
|---|---|---|
| `bus_url` | `http://127.0.0.1:8787` | |
| `bootstrap_token_file` | `data/runner-bootstrap.token` | Đọc lại ở mỗi lần register, nên token backend sinh lại khi restart vẫn dùng được |
| `host` | `os.hostname()` | |
| `heartbeat_seconds` | `15` | Nếu bus trả `heartbeat_seconds` nhỏ hơn khi register thì dùng giá trị của bus |
| `claude_command` | `["claude"]` | Mảng argv. Child chạy với cwd = worktree, nên đường dẫn script phải tuyệt đối. Test dùng `[process.execPath, "<abs>/test/fixtures/fake-claude.mjs"]` |
| `slots[].worker_id` | bắt buộc | Duy nhất |
| `slots[].repo`, `slots[].worktree_path` | bắt buộc | |
| `slots[].allowed_tools` | bắt buộc | Allowlist theo repo (mục [MỞ], để cấu hình). Runner luôn thêm `mcp__bridge-bus__report_progress`, `complete_task`, `fail_task` |
| `slots[].disallowed_tools` | `[]` | |
| `slots[].mcp_config_files` | `[]` | File MCP config thêm cho repo (Jira, GitLab...). Cần vì worker chạy `--strict-mcp-config` |
| `slots[].permission_mode` | `dontAsk` | Một trong các choice của CLI: `acceptEdits`, `auto`, `bypassPermissions`, `manual`, `dontAsk`, `plan` |
| `slots[].extra_args` | `[]` | Thêm vào cuối argv. Phải bắt đầu bằng một `--flag`, nếu không sẽ bị `--allowedTools`/`--disallowedTools` (variadic) nuốt mất |
| `slots[].env` | `{}` | Env thêm cho child |

## Vòng lặp mỗi slot

1. `POST /runners/register` bằng token bootstrap (kèm `current_task_id` nếu process đang chạy task). Nhận `runner_token`.
   Lỗi thì thử lại với backoff (tối đa 10s).
2. Heartbeat mỗi `heartbeat_seconds`, cả khi rảnh. `{cancel: true}` (khớp task đang chạy) → kill tree, `exited{reason: "cancelled"}`.
3. Long-poll `GET /runners/{id}/next?wait=30`. `204` → poll lại ngay.
4. Có task:
   - `git -C <worktree> status --porcelain` khác rỗng → `exited{exit_code: null, usage: null, reason: "conflict"}`, không spawn (P7).
     git lỗi (không phải repo, không có git) → `reason: "spawn_error"`.
   - Ghi MCP config chứa task token ra file tạm, spawn claude, ghi prompt vào stdin rồi đóng stdin.
   - Dòng `{"type":"system","subtype":"init"}` → `POST started {session_id, pid}`. Sau 10s chưa có init → `started{session_id: null}`.
   - Mọi dòng stdout được chuyển tới `POST /tasks/{id}/events` theo lô (500ms hoặc 50 event), đúng thứ tự, gửi sau `started`.
     Dòng không phải JSON gửi dạng `{type: "raw", text}`.
   - Vượt `timeout_seconds` → kill tree, `reason: "timeout"`.
   - Process thoát → kill các process con/cháu còn sót (xem "Dọn process còn sót") → flush event → `POST exited {exit_code, usage, reason, message}`.
     `usage` = `usage` + `total_cost_usd` của dòng `result` cuối.
     Thoát mã khác 0 mà runner không kill → `reason: null`, `message` chứa ~1000 ký tự cuối của stderr (bus ghi `failed(no_terminal_report)` nếu chưa có báo cáo kết thúc).
   - `reason: "timeout"`/`"cancelled"` chỉ khi yêu cầu kill đến **trước** khi process thoát. Cancel (heartbeat, reconcile, bus từ chối
     `started`), timeout hay shutdown đến sau khi process đã tự thoát (lúc runner còn đang drain stdio, flush event) bị bỏ qua: run đó
     được báo như thoát bình thường.
   - **Kill không có tác dụng:** sau khi kill, chờ process thoát tối đa 30s. Quá hạn → `POST exited {exit_code: null, reason: <lý do kill>,
     message: "process did not terminate after kill"}` (shutdown: `reason: null`), ngừng chuyển event của process đó, và slot vào trạng thái
     **cách ly**: không long-poll nhận task mới, vẫn heartbeat với `current_task_id: null` (bus không coi worker là mất), log `ERROR` và thử
     kill lại mỗi 5s cho tới khi process thật sự thoát, rồi mới nhận task tiếp.
5. Quay lại bước 3.

**Lỗi mạng:** mọi call tới bus thử lại với exponential backoff (500ms → tối đa 10s, có jitter). 5xx/429 cũng thử lại;
4xx khác là lỗi vĩnh viễn, được log. `401` (hoặc `404 WORKER_NOT_FOUND`) → register lại một lần rồi gửi lại.
Register trả `reconcile: "abort"` khi đang chạy task → kill task, `reason: "cancelled"`.
Bus từ chối `started` bằng 4xx (task không còn active) → runner dừng process, `reason: "cancelled"`.

**Event:** buffer tối đa 10 000 event chờ gửi. Bus không tới được lâu hơn thế thì bỏ event cũ nhất, log warning, và chèn
`{type: "runner_notice", subtype: "events_dropped", count}` vào đúng chỗ bị hụt.

**Tắt (SIGINT/SIGTERM):** dừng long-poll, kill task đang chạy, flush event, `POST exited {reason: null, message: "runner shutdown"}`
(bus ghi `failed(no_terminal_report)`, đúng tiêu chí Phase 2 "kill giữa chừng"), rồi thoát. Phần báo cáo cuối được thử lại tối đa 15s.
Tín hiệu thứ hai → kill đồng bộ mọi cây process claude đang chạy (POSIX: `SIGKILL` vào process group; Windows: `taskkill /PID <pid> /T /F`),
xóa mọi thư mục tạm chứa MCP config (có task token), rồi thoát ngay (không báo `exited`). Sự kiện `exit` của process cũng chạy cùng bước dọn
đồng bộ này, để runner thoát theo đường nào (crash, shutdown khi có process kẹt) cũng không để lại claude hay file token.

**Dọn process còn sót.** Claude có thể để lại process chạy tiếp sau khi nó thoát (dev server, watcher chạy từ tool Bash). Chúng giữ file
trong worktree (Windows khóa file), làm task sau bị `conflict`. Sau mỗi lần claude thoát (kể cả thoát bình thường), trước khi drain stdio:

- POSIX: claude là trưởng process group (spawn `detached`), runner gửi `SIGKILL` vào cả group (bỏ qua `ESRCH`). Process tự `setsid` thì thoát được.
- Windows: không có process group và orphan không được gán lại cha, `taskkill /T` không tìm thấy chúng khi claude đã thoát. Trong lúc claude
  chạy, runner chụp bảng process mỗi 2s (`powershell.exe -NoProfile` + `Get-CimInstance Win32_Process`: `ProcessId`, `ParentProcessId`,
  `CreationDate`; khoảng 0.5s mỗi lần, không chạy chồng nhau, timeout 10s) và ghi lại các process hậu duệ. Sau khi claude thoát, chụp thêm một
  lần, giữ những hậu duệ còn sống mà `CreationDate` vẫn khớp (tránh kill nhầm process khác dùng lại PID), rồi `taskkill /F /T /PID ...`.
  Hậu duệ vừa sinh vừa chết giữa hai lần chụp mà con của nó vẫn sống thì có thể lọt. Lỗi chụp/kill chỉ log warning.

## Lệnh claude và các flag đã đối chiếu

Đã kiểm tra với `claude --help` và một lần chạy thật trên **Claude Code CLI 2.1.322** (Windows 11, `claude.exe` bản native):

```
<claude_command...> -p --output-format stream-json --verbose
  --mcp-config <file tạm> [mcp_config_files...] --strict-mcp-config
  --permission-mode <mode>
  --allowedTools <tool> <tool> ... mcp__bridge-bus__report_progress mcp__bridge-bus__complete_task mcp__bridge-bus__fail_task
  [--disallowedTools <tool> ...] [extra_args...]
  (prompt qua stdin)
```

| Flag | Kết quả kiểm tra |
|---|---|
| `-p` / `--print` | Không có prompt positional thì đọc prompt từ stdin (đã chạy thật) |
| `--output-format stream-json` + `--verbose` | Đúng như P2. Thứ tự thực tế: các dòng `system/hook_started`, `system/hook_response` (SessionStart hook của máy) **trước** `system/init`; cuối cùng `result` có `usage`, `total_cost_usd` |
| `--mcp-config <configs...>` | Nhận file hoặc chuỗi JSON, variadic. Nhiều file trong một flag đều được nạp (đã kiểm tra: init liệt kê cả hai server) |
| `--strict-mcp-config` | Chỉ dùng server từ `--mcp-config` |
| `--allowedTools`/`--disallowedTools <tools...>` | Variadic, "comma or space-separated". Runner truyền mỗi tool một argv riêng, kể cả dạng `Bash(git:*)` |
| `--permission-mode` | Choices: `acceptEdits`, `auto`, `bypassPermissions`, `manual`, `dontAsk`, `plan`. Init báo `permissionMode: "dontAsk"` |

Không có khác biệt so với P2 trong `docs/decisions.md`. Các quan sát thêm:

- Init có thể đến muộn vài giây vì SessionStart hook của người dùng (đo được ~8s trên máy dev, sát ngưỡng 10s). Khi quá 10s, runner gửi
  `started{session_id: null}`; session_id thật vẫn nằm trong event `system/init` đã chuyển tới bus.
- Init có `mcp_servers[{name: "bridge-bus", status}]`. Status khác `connected` → runner log warning, vì worker sẽ không báo kết quả được.
- Khi kết nối MCP, claude gọi `server/discover` và `GET /mcp` (SSE) trước `initialize`. Bus stateless nên trả 405 cho GET.

## Ghi chú Windows

- **Tìm `claude`:** tên trần (không đuôi, không đường dẫn) được tìm bằng `where.exe`. Ưu tiên `.exe`/`.com` (spawn trực tiếp, không shell).
  Nếu chỉ có shim `.cmd`/`.bat` (cài qua npm), runner chạy `cmd.exe /d /s /c` với từng argument được escape cho cmd.exe
  (quote kiểu MSVCRT + caret-escape metachar, hai lần cho shim), không bao giờ ghép chuỗi không tin cậy vào dòng lệnh shell.
  Prompt đi qua stdin, token đi qua file, nên không có dữ liệu từ bus trên dòng lệnh.
- **MCP config:** ghi vào thư mục mới `%TEMP%\claude-bridge-task-XXXX\mcp-config.json` (`mkdtemp`, mode 0600 trên POSIX; trên Windows
  `%TEMP%` nằm trong profile người dùng, ACL chỉ user đó đọc được). File chứa task token: không bao giờ được log, xóa sau khi process thoát.
- **Kill tree:** `taskkill /pid <pid> /T /F` (mã thoát của claude khi đó thường là 1). POSIX: spawn `detached`, SIGTERM vào process group,
  SIGKILL sau 5s nếu chưa thoát. Process còn sót sau khi claude thoát: xem "Dọn process còn sót".
- Child không nhận `RUNNER_BOOTSTRAP_TOKEN` (bị loại khỏi env) để worker không tự register runner được.

## Bảo mật & log

Log một dòng, dạng `ISO-time LEVEL [worker_id][task_id] message key=value`. Không log token (bootstrap, runner, task) hay nội dung MCP config.
Event chuyển tới bus là stdout thô của claude; runner không đưa token vào đó.

## Test

```bash
pnpm --filter @claude-bridge/runner test        # vitest
pnpm --filter @claude-bridge/runner typecheck   # src + test
```

- `test/helpers/fakeBus.ts`: bus giả (node:http) cài 6 endpoint runner + endpoint MCP tối thiểu, ghi lại mọi call.
- `test/fixtures/fake-claude.mjs`: claude giả, không phụ thuộc gì. Đọc prompt từ stdin, in stream-json (hook, init, assistant, dòng
  không phải JSON, result kèm usage), và ở mode `complete` gọi tool `complete_task` của bus qua JSON-RPC HTTP thô, lấy URL + header
  từ file `--mcp-config` (gọi `initialize` trước, đọc được cả JSON lẫn SSE). Dùng lại được cho test end-to-end với bus thật.
  Điều khiển bằng env: `FAKE_CLAUDE_MODE=complete|hang|crash`, `FAKE_CLAUDE_TOOL=complete_task|fail_task|none`, `FAKE_CLAUDE_TOOL_ARGS`,
  `FAKE_CLAUDE_EXTRA_LINES`, `FAKE_CLAUDE_NO_INIT`, `FAKE_CLAUDE_DELAY_MS`, `FAKE_CLAUDE_GRANDCHILD` (process cháu giữ stdout và sống lâu hơn
  claude; trên Windows spawn `detached` vì Node tự kill con không detached khi nó thoát), `FAKE_CLAUDE_RECORD_FILE`,
  `FAKE_CLAUDE_EXIT_CODE` (xem đầu file).
- Các test vòng lặp cần `git` (tạo repo tạm); không có git thì bị skip.
