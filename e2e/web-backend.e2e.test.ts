// Hợp đồng WS giữa frontend (LiveBridgeService + store của web) và backend thật (Claude giả).
// Bắt các lệch giao thức giữa hai gói vốn được phát triển song song.
import { createRequire } from "node:module";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { FakeTurn } from "../packages/backend/src/claude/fakeDriver.js";
import { type AgentHarness, startAgentHarness } from "../packages/backend/test/agentHarness.js";
import { ORIGIN, PAIRING_TOKEN } from "../packages/backend/test/helpers.js";
import { LiveBridgeService } from "../packages/web/src/services/live-bridge-service.js";
import { plannerSessions } from "../packages/web/src/state/selectors.js";
import { createStore, type Store } from "../packages/web/src/state/store.js";
import type { TransportFactory } from "../packages/web/src/ws/transport.js";

const requireFromBackend = createRequire(join(__dirname, "../packages/backend/package.json"));
const WS = requireFromBackend("ws") as typeof import("ws");

/** Transport Node: giống trình duyệt, gửi header Origin của frontend. */
const nodeTransport: TransportFactory = (url, handlers) => {
  const ws = new WS(url, { origin: ORIGIN });
  ws.on("open", () => handlers.onOpen());
  ws.on("message", (data) => handlers.onMessage(data.toString()));
  ws.on("close", (code, reason) => handlers.onClose(code, reason.toString()));
  ws.on("error", () => undefined);
  return { send: (d) => ws.send(d), close: (c, r) => ws.close(c, r) };
};

const CREATE_TOOL = "mcp__jira__jira_create_issue";

async function until<T>(what: string, fn: () => T | undefined | null | false, ms = 10_000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() - start > ms) throw new Error(`timeout: ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

let h: AgentHarness | null = null;
let service: LiveBridgeService | null = null;

afterEach(async () => {
  service?.disconnect();
  service = null;
  await h?.dispose();
  h = null;
});

async function connect(): Promise<Store> {
  const store = createStore();
  service = new LiveBridgeService(store, { transport: nodeTransport });
  service.connect(h!.bridge.baseUrl().replace("http", "ws") + "/ws", PAIRING_TOKEN);
  await until("live", () => store.getState().connection.phase === "live");
  return store;
}

describe("web ↔ backend", () => {
  it("auth, snapshot, tạo phiên planner, chat, gate duyệt ticket, dừng giao việc", async () => {
    h = await startAgentHarness({ withOrchestrator: true, config: { orchestrator_autostart: false } });
    h.driver.script = async (turn: FakeTurn) => {
      if (turn.text !== "tạo") return turn.say(`echo: ${turn.text}`);
      const out = await turn.useTool(CREATE_TOOL, {
        project_key: "SH",
        summary: "Sửa HUD",
        issue_type: "Bug",
        additional_fields: { labels: ["agent"] },
      }, () => ({ key: "SH-131" }));
      turn.say(out.allowed ? "Đã tạo ticket" : "Bị từ chối");
    };

    const store = await connect();
    const s0 = store.getState();
    expect(s0.repos.map((r) => r.name)).toContain("sh");
    expect(s0.status?.dispatch_paused).toBe(false);

    // Phiên mới → được chọn ngay (ack bọc {session}).
    expect(await service!.createPlannerSession("sh", "e2e")).toBe(true);
    const sid = await until("planner selected", () => store.getState().plannerSessionId);
    expect(plannerSessions(store.getState()).map((s) => s.session_id)).toContain(sid);

    // Chat nhiều turn: luồng session có câu trả lời của agent.
    await service!.sendMessage(sid, "xin chào");
    await until("echo", () =>
      store.getState().streams[`session:${sid}`]?.records.some((r) => JSON.stringify(r.event).includes("echo: xin chào")),
    );

    // Gate duyệt: request hiện ở store, duyệt → ticket.created SH-131 tới bus events của web.
    await service!.sendMessage(sid, "tạo");
    const req = await until("permission", () => Object.values(store.getState().permissions)[0]);
    expect(req.tool).toBe(CREATE_TOOL);
    expect(await service!.respondPermission({ request_id: req.request_id, decision: "allow" })).toBe(true);
    const ev = await until("ticket.created", () => store.getState().events.find((e) => e.type === "ticket.created"));
    expect(ev.ticket_key).toBe("SH-131");
    expect(Object.keys(store.getState().permissions)).toHaveLength(0);

    // Dừng giao việc phản ánh lên status.
    expect(await service!.setDispatchPaused(true)).toBe(true);
    await until("paused", () => store.getState().status?.dispatch_paused === true);

    // Reconnect: tải lại danh sách phiên, không trùng bus event.
    const before = store.getState().events.map((e) => e.seq);
    service!.disconnect();
    service!.connect(h.bridge.baseUrl().replace("http", "ws") + "/ws", PAIRING_TOKEN);
    await until("live again", () => store.getState().connection.phase === "live");
    const after = store.getState().events.map((e) => e.seq);
    expect(new Set(after).size).toBe(after.length);
    expect(after).toEqual(expect.arrayContaining(before));
    expect(store.getState().plannerSessionId).toBe(sid);
  });
});
