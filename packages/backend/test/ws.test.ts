// WS hub: Auth Gate (Origin + token), subscribe/replay, push live, task.open, điểm mở rộng.
import { WS_CLOSE } from "@claude-bridge/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { z } from "zod";
import { WsError } from "../src/ws/hub.js";
import { type TestContext, ORIGIN, PAIRING_TOKEN, registerRunners, removeDir, startBridge } from "./helpers.js";

interface Msg {
  id: string;
  type: string;
  payload: any;
}

class TestWs {
  readonly messages: Msg[] = [];
  private waiters: { pred: (m: Msg) => boolean; resolve: (m: Msg) => void }[] = [];
  private n = 0;
  readonly closed: Promise<{ code: number; reason: string }>;

  constructor(readonly socket: WebSocket) {
    socket.on("message", (data) => {
      const msg = JSON.parse(data.toString()) as Msg;
      this.messages.push(msg);
      this.waiters = this.waiters.filter((w) => {
        if (!w.pred(msg)) return true;
        w.resolve(msg);
        return false;
      });
    });
    this.closed = new Promise((resolve) => socket.on("close", (code, reason) => resolve({ code, reason: reason.toString() })));
  }

  static open(url: string, origin: string | null = ORIGIN): Promise<TestWs> {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(url, origin ? { origin } : {});
      const client = new TestWs(socket);
      socket.once("open", () => resolve(client));
      socket.once("error", reject);
      socket.once("unexpected-response", (_req, res) => reject(new Error(`HTTP ${res.statusCode}`)));
    });
  }

  waitFor(pred: (m: Msg) => boolean, timeoutMs = 3000): Promise<Msg> {
    const found = this.messages.find(pred);
    if (found) return Promise.resolve(found);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("timed out waiting for message")), timeoutMs);
      this.waiters.push({
        pred,
        resolve: (m) => {
          clearTimeout(timer);
          resolve(m);
        },
      });
    });
  }

  send(type: string, payload: unknown = {}): string {
    const id = `c-${++this.n}`;
    this.socket.send(JSON.stringify({ id, type, payload }));
    return id;
  }

  /** Gửi request, chờ ack / error cùng id. */
  async request(type: string, payload: unknown = {}): Promise<Msg> {
    const id = this.send(type, payload);
    return this.waitFor((m) => m.id === id && (m.type === "ack" || m.type === "error"));
  }

  close(): void {
    this.socket.close();
  }
}

describe("WebSocket hub", () => {
  let ctx: TestContext;
  let url: string;
  const sockets: TestWs[] = [];

  const openAuthed = async (): Promise<TestWs> => {
    const ws = await TestWs.open(url);
    sockets.push(ws);
    const ack = await ws.request("auth", { token: PAIRING_TOKEN });
    expect(ack.type).toBe("ack");
    return ws;
  };

  beforeEach(async () => {
    ctx = await startBridge({ listen: true, app: { wsAuthTimeoutMs: 200 } });
    url = `${ctx.bridge.baseUrl().replace("http", "ws")}/ws`;
  });
  afterEach(async () => {
    for (const s of sockets.splice(0)) s.close();
    await ctx.bridge.close();
    removeDir(ctx.dir);
  });

  it("rejects upgrades from origins not in allowed_origins, and without Origin", async () => {
    await expect(TestWs.open(url, "https://evil.example")).rejects.toThrow("HTTP 403");
    await expect(TestWs.open(url, null)).rejects.toThrow("HTTP 403");
    await expect(TestWs.open(url.replace("/ws", "/other"))).rejects.toThrow("HTTP 404");
  });

  it("closes on a bad token, a non-auth first message, or no auth in time", async () => {
    const bad = await TestWs.open(url);
    bad.send("auth", { token: "wrong" });
    expect((await bad.waitFor((m) => m.type === "error")).payload.code).toBe("UNAUTHENTICATED");
    expect((await bad.closed).code).toBe(WS_CLOSE.AUTH_FAILED);

    const early = await TestWs.open(url);
    early.send("subscribe", {});
    expect((await early.closed).code).toBe(WS_CLOSE.AUTH_FAILED);

    const silent = await TestWs.open(url);
    expect((await silent.closed).code).toBe(WS_CLOSE.AUTH_TIMEOUT);
  });

  it("auth.ok carries server info", async () => {
    const ws = await openAuthed();
    const ok = await ws.waitFor((m) => m.type === "auth.ok");
    expect(ok.payload).toMatchObject({
      server_version: expect.any(String),
      projects: ["SH"],
      repos: [{ name: "sh", path: "D:/repos/sh", project_key: "SH" }],
    });
  });

  it("subscribe sends snapshot, replays events after since_seq, then pushes live updates", async () => {
    const { bus, eventLog } = ctx.bridge;
    await registerRunners(ctx.bridge, "w-1", "w-2");
    bus.assignTask({ worker_id: "w-1", ticket_key: "SH-1" });
    const since = eventLog.lastSeq();
    bus.setDispatchPaused(true);
    bus.setDispatchPaused(false);
    const last = eventLog.lastSeq();

    const ws = await openAuthed();
    const ack = await ws.request("subscribe", { since_seq: since });
    expect(ack.payload).toEqual({ result: { last_seq: last } });
    const types = ws.messages.map((m) => m.type);
    expect(types.slice(types.indexOf("state.snapshot"))).toEqual(["state.snapshot", "bus.event", "bus.event", "replay.done", "ack"]);
    const snapshot = ws.messages.find((m) => m.type === "state.snapshot")!.payload;
    expect(snapshot).toMatchObject({
      last_seq: last,
      tickets: [],
      sessions: [],
      pending_permissions: [],
      status: { backend: "ok", dispatch_paused: false, running: 1, max_concurrency: 2, orchestrator: "stopped" },
    });
    expect(snapshot.workers).toHaveLength(2);
    expect(snapshot.tasks).toHaveLength(1);
    const replayed = ws.messages.filter((m) => m.type === "bus.event").map((m) => m.payload);
    expect(replayed.map((e) => e.type)).toEqual(["dispatch.paused", "dispatch.resumed"]);
    expect(replayed[0].seq).toBe(since + 1);

    // Live.
    const { task_id } = bus.assignTask({ worker_id: "w-2", ticket_key: "SH-2" });
    const live = await ws.waitFor((m) => m.type === "bus.event" && m.payload.type === "task.assigned" && m.payload.task_id === task_id);
    expect(live.payload.seq).toBe(last + 1);
    await ws.waitFor((m) => m.type === "task.updated" && m.payload.task_id === task_id);
    await ws.waitFor((m) => m.type === "worker.updated" && m.payload.worker_id === "w-2" && m.payload.state === "busy");
    await ws.waitFor((m) => m.type === "system.status" && m.payload.running === 2);
  });

  it("dispatch.pause / dispatch.resume via WS", async () => {
    const ws = await openAuthed();
    await ws.request("subscribe", {});
    expect((await ws.request("dispatch.pause")).payload).toEqual({ result: { changed: true } });
    expect(ctx.bridge.bus.isDispatchPaused()).toBe(true);
    await ws.waitFor((m) => m.type === "bus.event" && m.payload.type === "dispatch.paused");
    await ws.waitFor((m) => m.type === "system.status" && m.payload.dispatch_paused === true);
    await ws.request("dispatch.resume");
    expect(ctx.bridge.bus.isDispatchPaused()).toBe(false);
  });

  it("task.open sends session.history then live session.event for that task only", async () => {
    const { bus } = ctx.bridge;
    const [r1] = await registerRunners(ctx.bridge, "w-1");
    const { task_id } = bus.assignTask({ worker_id: "w-1", ticket_key: "SH-1" });
    await r1!.pickUp();
    await r1!.started(task_id, "claude-xyz");
    await r1!.events(task_id, [{ type: "assistant", n: 1 }, { type: "assistant", n: 2 }]);

    const ws = await openAuthed();
    const first = ctx.bridge.eventLog.readSessionEvents({ task_id })[0]!.id;
    const ack = await ws.request("task.open", { task_id, since: first });
    expect(ack.payload.result.task.task_id).toBe(task_id);
    const history = ws.messages.find((m) => m.type === "session.history")!.payload;
    expect(history).toMatchObject({ session_id: "claude-xyz", task_id });
    expect(history.events.map((e: { event: { n: number } }) => e.event.n)).toEqual([2]);

    ctx.bridge.eventLog.appendSessionEvent({ session_id: "other", origin: "agent", event: { n: 99 } });
    await r1!.events(task_id, [{ type: "result", n: 3 }]);
    const live = await ws.waitFor((m) => m.type === "session.event");
    expect(live.payload).toMatchObject({ task_id, event: { n: 3 } });
    expect(ws.messages.filter((m) => m.type === "session.event")).toHaveLength(1);

    expect((await ws.request("task.open", { task_id: "t-missing" })).payload.code).toBe("NOT_FOUND");
  });

  it("unknown types and bad payloads → BAD_REQUEST; tickets.refresh acks", async () => {
    const ws = await openAuthed();
    expect((await ws.request("nope.what")).payload.code).toBe("BAD_REQUEST");
    expect((await ws.request("task.open", { task_id: 5 })).payload.code).toBe("BAD_REQUEST");
    expect((await ws.request("tickets.refresh")).type).toBe("ack");
  });

  it("extension points: registerHandler, snapshot contributor, status contributor, session routing", async () => {
    const { hub, status } = ctx.bridge;
    hub.registerHandler("session.open", z.object({ session_id: z.string() }), ({ client }, payload) => {
      if (payload.session_id === "bad") throw new WsError("NOT_FOUND", "no such session");
      client.openSession(payload.session_id);
      return { opened: payload.session_id };
    });
    const now = new Date().toISOString();
    hub.registerSnapshotContributor(() => ({
      sessions: [
        {
          session_id: "s-1",
          claude_session_id: null,
          role: "planner",
          project_key: "SH",
          repo: "sh",
          title: null,
          state: "active",
          busy: false,
          created_at: now,
          last_active_at: now,
        },
      ],
    }));
    status.registerContributor(() => ({ orchestrator: "alive", project_key: "SH", jira: "ok" }));

    const ws = await openAuthed();
    await ws.request("subscribe", {});
    const snapshot = ws.messages.find((m) => m.type === "state.snapshot")!.payload;
    expect(snapshot.sessions.map((s: { session_id: string }) => s.session_id)).toEqual(["s-1"]);
    expect(snapshot.status).toMatchObject({ orchestrator: "alive", project_key: "SH", jira: "ok" });

    expect((await ws.request("session.open", { session_id: "s-1" })).payload).toEqual({ result: { opened: "s-1" } });
    expect((await ws.request("session.open", { session_id: "bad" })).payload.code).toBe("NOT_FOUND");
    ctx.bridge.eventLog.appendSessionEvent({ session_id: "s-1", origin: "user", event: { type: "user_text", text: "hi" } });
    const ev = await ws.waitFor((m) => m.type === "session.event");
    expect(ev.payload).toMatchObject({ session_id: "s-1", origin: "user" });

    status.notifyChanged();
    await ws.waitFor((m) => m.type === "system.status" && m.payload.orchestrator === "alive");
  });
});
