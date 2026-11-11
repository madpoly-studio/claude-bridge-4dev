import { describe, expect, it } from "vitest";
import { initialState } from "../state/reducer";
import {
  filterEvents,
  groupTickets,
  jiraBaseUrl,
  latestTaskByTicket,
  orchestratorSession,
  pickDefaultPlannerSession,
  ticketUrl,
  totalTokens,
} from "../state/selectors";
import { describeBusEvent } from "../state/event-format";
import type { Session } from "@claude-bridge/protocol";
import { busEvent, makeTask, makeTicket, STATUS } from "./helpers";

const byId = <T extends { task_id: string }>(list: T[]) => Object.fromEntries(list.map((t) => [t.task_id, t]));

describe("groupTickets", () => {
  const tickets = [
    makeTicket({ key: "SH-1" }),
    makeTicket({ key: "SH-2", blocked_by: ["SH-3"] }),
    makeTicket({ key: "SH-3" }),
    makeTicket({ key: "SH-4" }),
    makeTicket({ key: "SH-5" }),
    makeTicket({ key: "SH-6", status_category: "done" }),
    makeTicket({ key: "SH-7" }),
  ];
  const tasks = byId([
    makeTask({ task_id: "t-3", ticket_key: "SH-3", state: "running", worker_id: "w-2" }),
    makeTask({ task_id: "t-4", ticket_key: "SH-4", state: "completed", mr_url: "https://g/merge_requests/9" }),
    makeTask({ task_id: "t-5a", ticket_key: "SH-5", state: "failed", attempt: 1, fail_category: "build_failed" }),
    makeTask({ task_id: "t-5b", ticket_key: "SH-5", state: "failed", attempt: 2, fail_category: "timeout" }),
    makeTask({ task_id: "t-7a", ticket_key: "SH-7", state: "failed", attempt: 1 }),
    makeTask({ task_id: "t-7b", ticket_key: "SH-7", state: "assigned", attempt: 2 }),
    makeTask({ task_id: "t-8", ticket_key: "SH-8", state: "running" }),
  ]);
  const g = groupTickets(tickets, tasks);
  const keys = (rows: { key: string }[]) => rows.map((r) => r.key);

  it("nhóm theo task mới nhất của ticket", () => {
    expect(keys(g.waiting)).toEqual(["SH-1", "SH-2"]);
    expect(keys(g.inProgress)).toEqual(["SH-3", "SH-7", "SH-8"]);
    expect(keys(g.review)).toEqual(["SH-4"]);
    expect(keys(g.failed)).toEqual(["SH-5"]);
  });

  it("giữ blocked_by, MR và số lần thử", () => {
    expect(g.waiting.find((r) => r.key === "SH-2")?.blockedBy).toEqual(["SH-3"]);
    expect(g.review[0]?.task?.mr_url).toContain("merge_requests/9");
    expect(g.failed[0]?.task?.attempt).toBe(2);
    expect(g.failed[0]?.task?.fail_category).toBe("timeout");
  });

  it("bỏ ticket done; task đang chạy chưa có trong Jira vẫn hiện", () => {
    expect([...keys(g.waiting), ...keys(g.inProgress), ...keys(g.review), ...keys(g.failed)]).not.toContain("SH-6");
    expect(g.inProgress.find((r) => r.key === "SH-8")?.url).toBeNull();
  });

  it("latestTaskByTicket chọn attempt lớn nhất", () => {
    expect(latestTaskByTicket(tasks).get("SH-5")?.task_id).toBe("t-5b");
  });
});

describe("filterEvents", () => {
  const events = [
    busEvent(1, "worker.registered", { worker_id: "w-1" }),
    busEvent(2, "task.assigned", { worker_id: "w-1", task_id: "t-1", ticket_key: "SH-1" }),
    busEvent(3, "task.failed", { task_id: "t-1", ticket_key: "SH-1" }),
    busEvent(4, "ticket.created", { ticket_key: "SH-2" }),
    busEvent(5, "worker.offline", { worker_id: "w-2" }),
  ];
  const seqs = (list: { seq: number }[]) => list.map((e) => e.seq);

  it("mới nhất trước", () => expect(seqs(filterEvents(events, { category: "all", query: "" }))).toEqual([5, 4, 3, 2, 1]));
  it("theo nhóm", () => {
    expect(seqs(filterEvents(events, { category: "task", query: "" }))).toEqual([3, 2]);
    expect(seqs(filterEvents(events, { category: "worker", query: "" }))).toEqual([5, 1]);
    expect(seqs(filterEvents(events, { category: "ticket", query: "" }))).toEqual([4]);
    expect(seqs(filterEvents(events, { category: "errors", query: "" }))).toEqual([5, 3]);
  });
  it("theo ID", () => expect(seqs(filterEvents(events, { category: "all", query: "sh-1" }))).toEqual([3, 2]));
});

describe("misc selectors", () => {
  it("jiraBaseUrl / ticketUrl suy ra link từ ticket có sẵn", () => {
    const tickets = [makeTicket({ key: "SH-1", url: "https://jira.x/browse/SH-1" })];
    expect(jiraBaseUrl(tickets)).toBe("https://jira.x");
    expect(ticketUrl("SH-9", tickets)).toBe("https://jira.x/browse/SH-9");
    expect(ticketUrl("SH-9", [])).toBeNull();
  });

  it("totalTokens cộng các loại token", () => {
    expect(totalTokens({ input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 1 })).toBe(16);
    expect(totalTokens(null)).toBeNull();
  });

  it("orchestratorSession chọn session theo project hiện tại", () => {
    const mk = (id: string, project: string, at: string): Session => ({
      session_id: id,
      claude_session_id: null,
      role: "orchestrator",
      project_key: project,
      repo: null,
      title: null,
      state: "active",
      busy: false,
      created_at: at,
      last_active_at: at,
    });
    const state = {
      ...initialState,
      status: { ...STATUS, project_key: "MPS" },
      sessions: { a: mk("a", "SH", "2026-11-11T10:00:00Z"), b: mk("b", "MPS", "2026-11-11T09:00:00Z") },
    };
    expect(orchestratorSession(state)?.session_id).toBe("b");
  });

  it("pickDefaultPlannerSession ưu tiên phiên đã nhớ, rồi phiên chưa đóng gần nhất", () => {
    const mk = (id: string, at: string, state: Session["state"]): Session => ({
      session_id: id,
      claude_session_id: null,
      role: "planner",
      project_key: null,
      repo: "r",
      title: null,
      state,
      busy: false,
      created_at: at,
      last_active_at: at,
    });
    const list = [mk("old", "2026-11-11T08:00:00Z", "active"), mk("new", "2026-11-11T11:00:00Z", "closed"), mk("mid", "2026-11-11T09:00:00Z", "active")];
    expect(pickDefaultPlannerSession(list, "old")).toBe("old");
    expect(pickDefaultPlannerSession(list, "gone")).toBe("mid");
    expect(pickDefaultPlannerSession([], null)).toBeNull();
  });

  it("describeBusEvent theo mockup", () => {
    expect(describeBusEvent(busEvent(1, "task.assigned", { ticket_key: "SH-129", worker_id: "w-sh-01" }))).toBe("SH-129 → w-sh-01");
    expect(describeBusEvent(busEvent(1, "task.completed", { ticket_key: "SH-124", payload: { mr_url: "https://g/-/merge_requests/412" } }))).toBe(
      "SH-124 · MR !412",
    );
    expect(describeBusEvent(busEvent(1, "worker.offline", { worker_id: "w-sh-04" }))).toBe("w-sh-04 · mất heartbeat");
  });
});
