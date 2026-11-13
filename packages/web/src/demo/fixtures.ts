// Dữ liệu mẫu cho chế độ demo (?demo=1): đủ mọi trạng thái để review UI không cần backend.
import { formatWakeTurn } from "@claude-bridge/protocol";
import type {
  BusEvent,
  BusEventType,
  PermissionRequest,
  Session,
  SessionEventOrigin,
  SessionEventRecord,
  SystemStatus,
  Task,
  Ticket,
  Worker,
} from "@claude-bridge/protocol";
import { initialState, streamKeyForSession, streamKeyForTask } from "../state/reducer";
import type { AppState, StreamState } from "../state/types";

export const DEMO_IDS = {
  plannerSession: "p-1",
  oldPlannerSession: "p-0",
  orchestratorSession: "o-sh",
  permission: "perm-1",
} as const;

const MINUTE = 60_000;
const JIRA = "https://jira.example.com";
const GITLAB = "https://gitlab.example.com/game/sniper-hunting-client/-/merge_requests";

export function createDemoState(now: number = Date.now()): AppState {
  const at = (minutesAgo: number) => new Date(now - minutesAgo * MINUTE).toISOString();

  const workers: Worker[] = [
    worker("w-sh-01", "sniper-hunting-client", "wt-1", "busy", "t-88", at(0.2)),
    worker("w-sh-02", "sniper-hunting-client", "wt-2", "busy", "t-87", at(0.1)),
    worker("w-sh-03", "sniper-hunting-server", "wt-1", "idle", null, at(0.3)),
    worker("w-sh-04", "sniper-hunting-server", "wt-2", "offline", null, at(36)),
    worker("w-sh-05", "sniper-hunting-client", "wt-3", "busy", "t-89", at(0.2)),
  ];

  const tasks: Task[] = [
    task({
      task_id: "t-88",
      ticket_key: "SH-129",
      worker_id: "w-sh-01",
      state: "running",
      phase: "implementing",
      branch: "agent/SH-129",
      usage: { input_tokens: 31_200, output_tokens: 9_400, cache_read_input_tokens: 7_600 },
      assigned_at: at(12.2),
      started_at: at(12),
    }),
    task({
      task_id: "t-87",
      ticket_key: "SH-128",
      worker_id: "w-sh-02",
      state: "running",
      phase: "testing",
      branch: "agent/SH-128",
      usage: { input_tokens: 88_000, output_tokens: 21_000 },
      assigned_at: at(31.5),
      started_at: at(31),
    }),
    task({ task_id: "t-89", ticket_key: "SH-133", worker_id: "w-sh-05", state: "assigned", assigned_at: at(0.5) }),
    task({
      task_id: "t-84",
      ticket_key: "SH-124",
      worker_id: "w-sh-03",
      state: "completed",
      phase: "mr_created",
      branch: "agent/SH-124",
      mr_url: `${GITLAB}/412`,
      summary: "Thêm log cho luồng mua gem",
      usage: { input_tokens: 54_000, output_tokens: 12_500 },
      assigned_at: at(40),
      started_at: at(39.5),
      ended_at: at(5),
    }),
    task({
      task_id: "t-85",
      ticket_key: "SH-127",
      worker_id: "w-sh-04",
      state: "failed",
      phase: "testing",
      branch: "agent/SH-127",
      fail_category: "build_failed",
      fail_reason: "Unity batchmode build lỗi: CS0246 AdMediationConfig không tồn tại",
      usage: { input_tokens: 40_100, output_tokens: 8_700 },
      assigned_at: at(55),
      started_at: at(54.5),
      ended_at: at(44),
    }),
    task({
      task_id: "t-81",
      ticket_key: "SH-125",
      worker_id: "w-sh-03",
      state: "cancelled",
      fail_reason: "Người dùng yêu cầu dừng để làm lại yêu cầu",
      assigned_at: at(90),
      started_at: at(89),
      ended_at: at(80),
    }),
  ];

  const tickets: Ticket[] = [
    ticket("SH-130", "Crash khi mở shop lúc mất mạng", "Bug", ["agent", "ưu tiên"]),
    ticket("SH-131", "Reload bị bỏ qua sau khi đổi súng", "Bug", ["agent"], ["SH-128"]),
    ticket("SH-125", "Chỉnh lại độ nhạy ngắm khi zoom", "Task", ["agent"]),
    ticket("SH-128", "Tách cấu hình súng ra ScriptableObject", "Task", ["agent"], [], "indeterminate"),
    ticket("SH-129", "Sửa hiển thị số đạn dự trữ trên HUD", "Bug", ["agent"], [], "indeterminate"),
    ticket("SH-133", "Thêm âm thanh khi hết đạn", "Task", ["agent"], [], "indeterminate"),
    ticket("SH-124", "Thêm log cho luồng mua gem", "Task", ["agent"], [], "indeterminate"),
    ticket("SH-127", "Cập nhật SDK quảng cáo", "Task", ["agent"]),
  ];

  const sessions: Session[] = [
    session(DEMO_IDS.plannerSession, "planner", "sniper-hunting-client", "Đạn không nạp lại sau khi đổi súng", at(1), "active"),
    session(DEMO_IDS.oldPlannerSession, "planner", "sniper-hunting-server", "Crash shop khi mất mạng", at(180), "closed"),
    session(DEMO_IDS.orchestratorSession, "orchestrator", null, null, at(2), "active"),
  ];

  const permission: PermissionRequest = {
    request_id: DEMO_IDS.permission,
    session_id: DEMO_IDS.plannerSession,
    tool: "mcp__jira__jira_create_issue",
    input: {
      project_key: "SH",
      issue_type: "Bug",
      summary: "Reload bị bỏ qua sau khi đổi súng giữa lúc đang nạp đạn",
      description: [
        "Đặt lại cờ isReloading của súng cũ trong OnWeaponSwitched.",
        "",
        "## Tiêu chí nghiệm thu",
        "- Đổi súng giữa lúc reload rồi quay lại: reload hoạt động bình thường.",
        "- Không thay đổi thời gian reload của các súng khác.",
      ].join("\n"),
      additional_fields: JSON.stringify({ labels: ["agent"] }),
    },
    decision: null,
    updated_input: null,
    reason: null,
    created_at: at(0.8),
    decided_at: null,
  };

  const events = busEvents(at);

  const status: SystemStatus = {
    backend: "ok",
    project_key: "SH",
    orchestrator: "alive",
    dispatch_paused: false,
    running: 3,
    max_concurrency: 3,
    seat_usage: { status: "allowed", utilization: 0.62, resets_at: at(-140) },
    rate_limited_until: null,
    jira: "ok",
  };

  const streams: Record<string, StreamState> = {
    [streamKeyForSession(DEMO_IDS.plannerSession)]: stream(plannerRecords(at)),
    [streamKeyForSession(DEMO_IDS.oldPlannerSession)]: stream([
      rec(1, DEMO_IDS.oldPlannerSession, null, at(185), "user", { type: "user_text", text: "Shop crash khi mất mạng, kiểm tra giúp." }),
      rec(2, DEMO_IDS.oldPlannerSession, null, at(184), "agent", assistantText("Đã tạo SH-130 theo phương án đã chốt.")),
    ]),
    [streamKeyForSession(DEMO_IDS.orchestratorSession)]: stream(orchestratorRecords(at)),
    [streamKeyForTask("t-88")]: stream(taskRecords(at)),
    [streamKeyForTask("t-85")]: stream(failedTaskRecords(at)),
  };

  return {
    ...initialState,
    connection: { phase: "live", error: null, attempt: 0, retryAt: null },
    everLive: true,
    serverVersion: "demo",
    projects: ["SH", "MPS"],
    repos: [
      { name: "sniper-hunting-client", path: "D:/repos/sniper-hunting-client", project_key: "SH" },
      { name: "sniper-hunting-server", path: "D:/repos/sniper-hunting-server", project_key: "SH" },
    ],
    snapshotLoaded: true,
    snapshotSeq: 0,
    lastSeq: events.length,
    workers: Object.fromEntries(workers.map((w) => [w.worker_id, w])),
    tasks: Object.fromEntries(tasks.map((t) => [t.task_id, t])),
    tickets,
    sessions: Object.fromEntries(sessions.map((s) => [s.session_id, s])),
    permissions: { [permission.request_id]: permission },
    status,
    events,
    streams,
    plannerSessionId: DEMO_IDS.plannerSession,
  };
}

// ------------------------------------------------------------------ builders

function worker(
  worker_id: string,
  repo: string,
  wt: string,
  state: Worker["state"],
  current_task_id: string | null,
  last_heartbeat: string,
): Worker {
  return { worker_id, repo, worktree_path: `D:/worktrees/${repo}/${wt}`, host: "dev-pc", state, current_task_id, last_heartbeat };
}

function task(p: Partial<Task> & Pick<Task, "task_id" | "ticket_key" | "worker_id" | "state" | "assigned_at">): Task {
  return {
    attempt: 1,
    session_id: null,
    phase: null,
    branch: null,
    mr_url: null,
    summary: null,
    fail_category: null,
    fail_reason: null,
    notes: null,
    usage: null,
    started_at: null,
    ended_at: null,
    ...p,
  };
}

function ticket(
  key: string,
  summary: string,
  issue_type: string,
  labels: string[],
  blocked_by: string[] = [],
  status_category = "new",
): Ticket {
  return {
    key,
    summary,
    issue_type,
    status: status_category === "new" ? "To Do" : "In Progress",
    status_category,
    labels,
    url: `${JIRA}/browse/${key}`,
    blocked_by,
    updated: null,
  };
}

function session(
  session_id: string,
  role: Session["role"],
  repo: string | null,
  title: string | null,
  last_active_at: string,
  state: Session["state"],
): Session {
  return {
    session_id,
    claude_session_id: `claude-${session_id}`,
    role,
    project_key: "SH",
    repo,
    title,
    state,
    busy: false,
    created_at: last_active_at,
    last_active_at,
  };
}

function stream(records: SessionEventRecord[]): StreamState {
  return { records, lastId: records[records.length - 1]?.id ?? 0, loaded: true };
}

function rec(
  id: number,
  session_id: string,
  task_id: string | null,
  ts: string,
  origin: SessionEventOrigin,
  event: unknown,
): SessionEventRecord {
  return { id, session_id, task_id, ts, origin, event };
}

export function assistantText(text: string): unknown {
  return { type: "assistant", message: { content: [{ type: "text", text }] } };
}

function toolUse(id: string, name: string, input: Record<string, unknown>): unknown {
  return { type: "tool_use", id, name, input };
}

function assistantTools(...blocks: unknown[]): unknown {
  return { type: "assistant", message: { content: blocks } };
}

function toolResults(...items: Array<[string, string, boolean?]>): unknown {
  return {
    type: "user",
    message: {
      content: items.map(([tool_use_id, content, is_error]) => ({ type: "tool_result", tool_use_id, content, is_error: !!is_error })),
    },
  };
}

type At = (minutesAgo: number) => string;

function plannerRecords(at: At): SessionEventRecord[] {
  const s = DEMO_IDS.plannerSession;
  const files = ["WeaponController.cs", "ReloadState.cs", "WeaponSwitcher.cs", "PlayerInventory.cs", "AmmoModel.cs", "WeaponBase.cs"];
  const reads = files.map((f, i) => toolUse(`r${i}`, "Read", { file_path: `Assets/Scripts/Weapons/${f}` }));
  return [
    rec(1, s, null, at(9), "agent", { type: "system", subtype: "init", model: "claude-opus" }),
    rec(2, s, null, at(9), "user", {
      type: "user_text",
      text: "Người chơi báo đạn không nạp lại sau khi đổi súng giữa lúc đang reload. Kiểm tra nguyên nhân và đề xuất cách sửa.",
    }),
    rec(3, s, null, at(8.5), "agent", assistantTools(...reads.slice(0, 2))),
    rec(4, s, null, at(8.4), "agent", toolResults(["r0", "…"], ["r1", "…"])),
    rec(5, s, null, at(8), "agent", assistantTools(...reads.slice(2))),
    rec(6, s, null, at(7.9), "agent", toolResults(["r2", "…"], ["r3", "…"], ["r4", "…"], ["r5", "…"])),
    rec(
      7,
      s,
      null,
      at(7),
      "agent",
      assistantText(
        [
          "Nguyên nhân: khi đổi súng, trạng thái reload bị hủy nhưng cờ `isReloading` của súng cũ không được đặt lại, nên lần reload sau bị bỏ qua.",
          "",
          "Phương án 1: đặt lại cờ trong `OnWeaponSwitched`. Thay đổi 1 file.",
          "",
          "Phương án 2: chuyển trạng thái reload vào state machine của từng súng. Đúng hơn về kiến trúc, thay đổi 4 file.",
        ].join("\n"),
      ),
    ),
    rec(8, s, null, at(2), "user", { type: "user_text", text: "Chốt phương án 1." }),
    rec(9, s, null, at(1), "agent", assistantText("Tôi sẽ tạo ticket với phương án 1. Bản nháp đang chờ bạn duyệt.")),
    rec(10, s, null, at(0.8), "agent", assistantTools(toolUse("c1", "mcp__jira__jira_create_issue", { project_key: "SH" }))),
  ];
}

function orchestratorRecords(at: At): SessionEventRecord[] {
  const s = DEMO_IDS.orchestratorSession;
  const sys = (id: number, minutesAgo: number, events: Parameters<typeof formatWakeTurn>[0]) =>
    rec(id, s, null, at(minutesAgo), "system", { type: "user_text", text: formatWakeTurn(events) });
  // wake_mode manual (mặc định): lời chào lúc backend khởi động, orchestrator chỉ làm khi người dùng yêu cầu.
  return [
    rec(1, s, null, at(15), "system", { type: "bridge_welcome", text: demoWelcomeText(at(15)) }),
    rec(2, s, null, at(13), "user", { type: "user_text", text: "Giao các ticket label agent đang sẵn sàng cho worker rảnh." }),
    sys(3, 12.8, [{ type: "task.completed", task_id: "t-84", ticket_key: "SH-124" }]),
    rec(
      4,
      s,
      null,
      at(12.3),
      "agent",
      assistantTools(
        { type: "text", text: "SH-131 phụ thuộc SH-128 đang chạy trên w-sh-02, giữ lại trong hàng đợi. SH-129 độc lập, giao cho w-sh-01." },
        toolUse("a1", "mcp__bridge-bus__assign_task", { worker_id: "w-sh-01", ticket_key: "SH-129" }),
      ),
    ),
    rec(5, s, null, at(12.2), "agent", toolResults(["a1", '{"task_id":"t-88"}'])),
    rec(6, s, null, at(6), "user", { type: "user_text", text: "Ưu tiên SH-130 trước các ticket còn lại." }),
    rec(7, s, null, at(5.9), "agent", assistantText("Đã ghi nhận. SH-130 sẽ được giao ngay khi có worker idle trên repo client.")),
    sys(8, 3, [{ type: "task.failed", task_id: "t-85", ticket_key: "SH-127", category: "build_failed" }]),
    rec(9, s, null, at(2.8), "agent", assistantText("SH-127 lỗi build ở lần thử 1 (build_failed). Bạn có muốn giao lại không?")),
  ];
}

/** Cùng bố cục với `formatWelcome` của backend. */
function demoWelcomeText(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  const time = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return [
    `Bridge đã khởi động lúc ${time} · project \`SH\`.`,
    "Chế độ thủ công: orchestrator chỉ làm khi bạn yêu cầu, không tự nhận ticket. Bridge chỉ báo lại khi task bạn giao xong hoặc lỗi.",
    [
      "Repo của project:",
      "- `sniper-hunting-client` · D:/repos/sniper-hunting-client",
      "- `sniper-hunting-server` · D:/repos/sniper-hunting-server",
      "Worker sẽ hiện ở tab Workers khi runner đăng ký.",
    ].join("\n"),
    ["Ví dụ yêu cầu:", "- Liệt kê các ticket label agent đang mở", "- Giao SH-123 cho worker rảnh", "- Tình hình các worker?"].join("\n"),
  ].join("\n\n");
}

function taskRecords(at: At): SessionEventRecord[] {
  const s = "w-sess-88";
  const t = "t-88";
  return [
    rec(1, s, t, at(11.9), "agent", { type: "system", subtype: "init", model: "claude-sonnet" }),
    rec(2, s, t, at(11.8), "agent", assistantTools(toolUse("j1", "mcp__jira__jira_get_issue", { issue_key: "SH-129" }))),
    rec(3, s, t, at(11.5), "agent", assistantTools(toolUse("b1", "mcp__bridge-bus__report_progress", { phase: "understanding", message: "Đọc ticket" }))),
    rec(4, s, t, at(11.1), "agent", assistantTools(toolUse("g1", "Grep", { pattern: "reserveAmmo", path: "Assets/Scripts/UI" }))),
    rec(5, s, t, at(10.8), "agent", assistantTools(toolUse("r1", "Read", { file_path: "Assets/Scripts/UI/HudAmmoView.cs" }))),
    rec(6, s, t, at(10), "agent", assistantText("HUD đọc reserveAmmo từ model cũ; cần đổi sang WeaponAmmoModel.Reserve.")),
    rec(7, s, t, at(9.6), "agent", assistantTools(toolUse("b2", "mcp__bridge-bus__report_progress", { phase: "implementing", message: "Sửa HUD" }))),
    rec(8, s, t, at(7.1), "agent", assistantTools(toolUse("e1", "Edit", { file_path: "Assets/Scripts/UI/HudAmmoView.cs" }))),
    rec(9, s, t, at(2), "agent", assistantTools(toolUse("e2", "Edit", { file_path: "Assets/Scripts/Weapons/WeaponAmmoModel.cs" }))),
  ];
}

function failedTaskRecords(at: At): SessionEventRecord[] {
  const s = "w-sess-85";
  const t = "t-85";
  return [
    rec(1, s, t, at(54), "agent", assistantTools(toolUse("b1", "mcp__bridge-bus__report_progress", { phase: "implementing", message: "Cập nhật SDK" }))),
    rec(2, s, t, at(47), "agent", assistantTools(toolUse("x1", "Bash", { command: "unity -batchmode -buildTarget Android" }))),
    rec(3, s, t, at(46), "agent", toolResults(["x1", "error CS0246: AdMediationConfig không tồn tại", true])),
    rec(4, s, t, at(45), "agent", assistantTools(toolUse("f1", "mcp__bridge-bus__fail_task", { category: "build_failed", reason: "CS0246" }))),
    rec(5, s, t, at(44), "agent", { type: "result", subtype: "success", is_error: false, num_turns: 18, total_cost_usd: 0.41 }),
  ];
}

function busEvents(at: At): BusEvent[] {
  const list: Array<[number, BusEventType, string | null, string | null, string | null, Record<string, unknown>]> = [
    [120, "worker.registered", "w-sh-01", null, null, {}],
    [120, "worker.registered", "w-sh-02", null, null, {}],
    [120, "worker.registered", "w-sh-03", null, null, {}],
    [120, "worker.registered", "w-sh-04", null, null, {}],
    [90, "task.assigned", "w-sh-03", "t-81", "SH-125", {}],
    [80, "task.cancelled", "w-sh-03", "t-81", "SH-125", { reason: "Người dùng yêu cầu dừng" }],
    [55, "task.assigned", "w-sh-04", "t-85", "SH-127", {}],
    [54.5, "task.started", "w-sh-04", "t-85", "SH-127", {}],
    [44, "task.failed", "w-sh-04", "t-85", "SH-127", { category: "build_failed", reason: "CS0246", attempt: 1 }],
    [40, "task.assigned", "w-sh-03", "t-84", "SH-124", {}],
    [39.5, "task.started", "w-sh-03", "t-84", "SH-124", {}],
    [36, "worker.offline", "w-sh-04", null, null, {}],
    [31.5, "task.assigned", "w-sh-02", "t-87", "SH-128", {}],
    [31, "task.started", "w-sh-02", "t-87", "SH-128", {}],
    [20, "task.progress", "w-sh-02", "t-87", "SH-128", { phase: "testing", message: "Chạy test" }],
    [13, "ticket.created", null, null, "SH-131", { session_id: "p-0", labels: ["agent"], has_agent_label: true }],
    [12.2, "task.assigned", "w-sh-01", "t-88", "SH-129", {}],
    [12, "task.started", "w-sh-01", "t-88", "SH-129", {}],
    [11.5, "task.progress", "w-sh-01", "t-88", "SH-129", { phase: "understanding", message: "Đọc ticket" }],
    [9.6, "task.progress", "w-sh-01", "t-88", "SH-129", { phase: "implementing", message: "Sửa HUD" }],
    [5, "task.completed", "w-sh-03", "t-84", "SH-124", { mr_url: `${GITLAB}/412`, branch: "agent/SH-124", summary: "" }],
    [4, "dispatch.paused", null, null, null, {}],
    [3.5, "dispatch.resumed", null, null, null, {}],
    [0.5, "task.assigned", "w-sh-05", "t-89", "SH-133", {}],
  ];
  return list.map(([minutesAgo, type, worker_id, task_id, ticket_key, payload], i) => ({
    seq: i + 1,
    ts: at(minutesAgo),
    type,
    worker_id,
    task_id,
    ticket_key,
    payload,
  }));
}
