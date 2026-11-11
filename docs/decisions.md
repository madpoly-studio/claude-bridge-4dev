# Quyết định triển khai v1

Ghi lại các lựa chọn cho mục [ĐỀ XUẤT] / [MỞ] trong system design, và mọi chỗ lệch so với đề xuất.

## Đã chốt với chủ dự án (2026-11-11)

| # | Mục | Quyết định |
|---|---|---|
| I1 | Tech stack (mục 14) | Theo đề xuất: Node 22 + TypeScript, pnpm workspace, Fastify, `ws`, `better-sqlite3`, `@anthropic-ai/claude-agent-sdk`, MCP TypeScript SDK (streamable HTTP), React + Vite |
| I2 | Auth Gate (mục 5.1) | Pairing token sinh khi backend khởi động, in ra terminal. JWT SSO để sau, Auth Gate có interface `TokenVerifier` để thêm |
| I3 | Jira Reader (mục 5.4) | Jira Server self-host, REST API v2, header `Authorization: Bearer <PAT>`. Đọc cấu hình từ file `.env` có sẵn của team: `MPS_JIRA_URL`, `MPS_JIRA_PAT`, `MPS_JIRA_PROJECT_KEY`, `MPS_CA_BUNDLE` |
| I4 | Phạm vi | Phase 0–7. Phase 8 (end-to-end thật) cần Jira/GitLab thật, chạy tay theo README |

## Lựa chọn trong phạm vi [ĐỀ XUẤT]

| # | Mục | Lựa chọn | Ghi chú |
|---|---|---|---|
| P1 | `better-sqlite3` | Dùng bản 12.x | Bản 13.0.3 chưa có prebuild cho Windows + Node 22, phải build bằng node-gyp |
| P2 | Phiên bản đã đối chiếu | Agent SDK `0.3.322`, MCP SDK `1.32.2`, Claude Code CLI `2.1.322` | Option dùng: `query({prompt: AsyncIterable, options: {cwd, resume, canUseTool, mcpServers, allowedTools, disallowedTools, permissionMode, settingSources, systemPrompt}})`, `Query.interrupt()`. CLI worker: `claude -p --output-format stream-json --verbose --mcp-config <json> --strict-mcp-config --allowedTools ... --permission-mode dontAsk` |
| P3 | `session_id` | Bridge giữ ID nội bộ ổn định (`sessions.session_id`) và lưu riêng `claude_session_id` lấy từ event init | Session có ID trước khi Claude trả init; UI không phải đổi khóa |
| P4 | Bảng `tasks` | Thêm cột `phase`, `summary`, `usage` | Cần cho thanh 5 phase, card Chờ review, token trong Chi tiết task |
| P5 | Bảng `permission_requests` | Thêm `updated_input`, `reason`, `created_at` | Cần cho Sửa / Hủy và hiển thị |
| P6 | Fail category hệ thống | `runner_unresponsive`, `runner_lost`, `timeout`, `no_terminal_report` cùng cột `fail_category` với category của worker | Mục 7.8 |
| P7 | Worktree bẩn | Runner báo `exited{reason: "conflict"}` không spawn; bus ghi `failed(conflict)` | Mục 6 bước 3 |
| P8 | WS protocol | Bản nháp mục 9, thêm `project.select`, `session.close`, `tickets.refresh`, `auth.ok`, `replay.done`, `session.history`, `*.updated`, `permission.resolved` | Bổ sung, không đổi message có sẵn |
| P9 | Runner token | Runner gọi `/runners/register` bằng `RUNNER_BOOTSTRAP_TOKEN` (cấu hình chung backend + runner), nhận runner token riêng | Mục 7.6 |
| P10 | Orchestrator token | Backend tự sinh token role orchestrator khi khởi động, **một token cho mỗi project** (chỉ thao tác ticket `<PROJECT>-*`), và đưa vào cấu hình MCP của session orchestrator qua file tạm riêng (`--mcp-config <path>`), không qua argv | Mục 7.6, 12 |

## Vẫn [MỞ], dùng giá trị cấu hình được

| Mục | Cách xử lý ở v1 |
|---|---|
| `JIRA_CREATE_TOOL_PATTERN` | Regex cấu hình được. Mặc định khớp tên tool tạo issue phổ biến của các MCP server Jira (`create_issue`, `jira_create_issue`, `createJiraIssue`) |
| Allowlist tool của worker theo repo | Cấu hình theo từng slot trong file cấu hình runner (`allowed_tools`), có mặc định an toàn |
| Nguồn hạn mức seat | Ẩn chip; chỉ hiện khi SDK phát `rate_limit_event` |
| `MAX_CONCURRENCY`, `TASK_TIMEOUT`, `ORCH_TICK_MINUTES` | Giá trị đề xuất, override bằng biến môi trường |
