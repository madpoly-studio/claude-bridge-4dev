import { describe, expect, it } from "vitest";
import { STATUS } from "../../../__tests__/helpers";
import { MIN_SEGMENT_MS, ROUTE_MIN_GAP_PX, WALK_SPEED_PX_S } from "../constants";
import { distance, SCENE_H, SCENE_W } from "./geometry";
import type { Point } from "./geometry";
import { ALL_SLOTS, DESK_SCREENS, OFFICE_LAYOUT } from "./layout";
import { facingOf, planRoute, segmentMs } from "./route";
import { ORCHESTRATOR_SHEET, spriteVars, WORKER_SHEET } from "./sprites";
import type { SheetSpec } from "./sprites";
import { deriveSignals, kanbanCounts, rackGauge } from "./system";

/** Kích thước ảnh (px), đo trên file .webp trong assets/furniture. */
const FURNITURE_SIZE = {
  utility_shelf: { w: 114, h: 139 },
  flower_planter: { w: 45, h: 68 },
  server_rack: { w: 88, h: 138 },
  workstation_manager: { w: 143, h: 129 },
} as const;
/** Khoảng hở ngang tối thiểu giữa orchestrator ở home và món đồ bên phải nó. */
const HOME_CLEARANCE_PX = 10;
/** Khe chỉ vừa thân robot: cho phép đầu tay robot lấn vào khung ảnh của bàn / tủ tối đa bấy nhiêu px (góc ảnh trong suốt). */
const AISLE_GRAZE_PX = 10;

interface Box {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

/** Khung ảnh nội thất: neo ở giữa cạnh đáy. */
const itemBox = (anchor: Point, size: { w: number; h: number }): Box => ({
  left: anchor.x - size.w / 2,
  right: anchor.x + size.w / 2,
  top: anchor.y - size.h,
  bottom: anchor.y,
});

/** Khung ảnh robot agent quanh điểm chạm đất. */
const spriteBox = (ground: Point, sheet: SheetSpec<"idle">): Box => ({
  left: ground.x - sheet.anchor.x,
  right: ground.x - sheet.anchor.x + sheet.display.w,
  top: ground.y - sheet.anchor.y,
  bottom: ground.y - sheet.anchor.y + sheet.display.h,
});

describe("OFFICE_LAYOUT", () => {
  const { desks, deskItems, relax, pods, furniture, serverRacks, kanban } = OFFICE_LAYOUT;
  const slots = [...desks, ...relax, ...pods];
  const agentStands = [OFFICE_LAYOUT.planner.home, OFFICE_LAYOUT.planner.work, OFFICE_LAYOUT.orchestrator.home, OFFICE_LAYOUT.orchestrator.work];

  it("đủ chỗ: 10 bàn, ít nhất 6 chỗ nghỉ, ít nhất 3 pod", () => {
    expect(desks).toHaveLength(10);
    expect(deskItems).toHaveLength(10);
    expect(relax.length).toBeGreaterThanOrEqual(6);
    expect(pods.length).toBeGreaterThanOrEqual(3);
    expect(relax.some((s) => s.spot === "plaza")).toBe(true);
  });

  it("id không trùng; mỗi bàn có đúng một slot", () => {
    expect(new Set(slots.map((s) => s.id)).size).toBe(slots.length);
    expect(ALL_SLOTS.size).toBe(slots.length);
    const items = [...furniture, ...deskItems, ...serverRacks, kanban.item];
    expect(new Set(items.map((i) => i.id)).size).toBe(items.length);
    expect(new Set(deskItems.map((d) => d.slotId))).toEqual(new Set(desks.map((d) => d.id)));
    for (const d of deskItems) expect(DESK_SCREENS[d.sprite]).toBeDefined();
  });

  it("mọi điểm neo và gate nằm trong ảnh nền", () => {
    const points = [
      ...slots.flatMap((s) => [s.anchor, s.gate]),
      ...furniture.map((f) => f.anchor),
      ...deskItems.map((f) => f.anchor),
      ...serverRacks.map((f) => f.anchor),
      kanban.item.anchor,
      kanban.plaque,
      kanban.noteTarget,
      ...agentStands.flatMap((s) => [s.anchor, s.gate]),
      OFFICE_LAYOUT.signals,
      ...Object.values(OFFICE_LAYOUT.overflowChips),
    ];
    for (const p of points) {
      expect(p.x).toBeGreaterThanOrEqual(0);
      expect(p.x).toBeLessThanOrEqual(SCENE_W);
      expect(p.y).toBeGreaterThanOrEqual(0);
      expect(p.y).toBeLessThanOrEqual(SCENE_H);
    }
  });

  it("không hai chỗ đứng nào trùng nhau", () => {
    for (let i = 0; i < slots.length; i++) {
      for (let j = i + 1; j < slots.length; j++) expect(distance(slots[i]!.anchor, slots[j]!.anchor)).toBeGreaterThan(40);
    }
  });

  it("agent: hai góc home cạnh nhau ở góc dưới-phải của sàn, tách khỏi chỗ làm việc và khỏi mọi chỗ đứng của worker", () => {
    const { planner, orchestrator } = OFFICE_LAYOUT;
    for (const home of [planner.home, orchestrator.home]) {
      expect(home.anchor.x).toBeGreaterThan(SCENE_W * 0.7);
      expect(home.anchor.y).toBeGreaterThan(SCENE_H * 0.6);
      for (const s of slots) expect(distance(home.anchor, s.anchor)).toBeGreaterThan(80);
    }
    // Cạnh nhau: đủ xa để hai robot (rộng khoảng 100 px) không chồng lên nhau, đủ gần để vẫn là một cụm.
    const gap = distance(planner.home.anchor, orchestrator.home.anchor);
    expect(gap).toBeGreaterThan(90);
    expect(gap).toBeLessThan(160);
    // Planner đứng bên trái, cùng thứ tự với hai avatar ở dock chat.
    expect(planner.home.anchor.x).toBeLessThan(orchestrator.home.anchor.x);
    // Chỗ làm việc giữ nguyên ở khu Planning phía trên.
    for (const agent of [planner, orchestrator]) {
      expect(agent.work.anchor.y).toBeLessThan(agent.home.anchor.y - 200);
      expect(distance(agent.work.anchor, agent.home.anchor)).toBeGreaterThan(300);
    }
  });

  it("agent: tuyến home ↔ work đi qua gate của cả hai đầu, chiều về là chiều đi đảo ngược", () => {
    for (const agent of [OFFICE_LAYOUT.planner, OFFICE_LAYOUT.orchestrator]) {
      const up = planRoute(agent.home, agent.work);
      expect(up).toEqual([agent.home.gate, agent.work.gate, agent.work.anchor]);
      const down = planRoute(agent.work, agent.home);
      expect(down).toEqual([agent.work.gate, agent.home.gate, agent.home.anchor]);
    }
  });

  it("góc home: kệ và chậu hoa không chạm orchestrator, chậu hoa không vẽ đè lên robot", () => {
    const home = OFFICE_LAYOUT.orchestrator.home.anchor;
    const robot = spriteBox(home, ORCHESTRATOR_SHEET);
    for (const id of ["shelf", "plant-b"] as const) {
      const item = furniture.find((f) => f.id === id)!;
      const box = itemBox(item.anchor, FURNITURE_SIZE[item.sprite as keyof typeof FURNITURE_SIZE]);
      // Cách nhau theo chiều ngang, không chỉ khác chiều sâu.
      expect(box.left - robot.right).toBeGreaterThanOrEqual(HOME_CLEARANCE_PX);
    }
  });

  it("orchestrator đi thẳng đứng trong khe giữa bàn Z3 và tủ server: thân robot không lấn vào tủ hay bàn", () => {
    const { home, work } = OFFICE_LAYOUT.orchestrator;
    expect(home.gate.x).toBe(work.gate.x);
    const robot = spriteBox(home.gate, ORCHESTRATOR_SHEET);
    const rack = itemBox(serverRacks[0]!.anchor, FURNITURE_SIZE.server_rack);
    const deskZ3 = deskItems.find((d) => d.id === "desk-item-Z3")!;
    const desk = itemBox(deskZ3.anchor, FURNITURE_SIZE[deskZ3.sprite as keyof typeof FURNITURE_SIZE]);
    expect(robot.right - rack.left).toBeLessThanOrEqual(AISLE_GRAZE_PX);
    expect(desk.right - robot.left).toBeLessThanOrEqual(AISLE_GRAZE_PX);
    // Hai tủ vẫn là hai tủ: tủ 1 không che hết tủ 2.
    expect(serverRacks[1]!.anchor.x - serverRacks[0]!.anchor.x).toBeGreaterThan(FURNITURE_SIZE.server_rack.w / 2);
  });

  it("robot đứng sau bàn của nó (vẽ trước bàn theo chiều sâu)", () => {
    for (const item of deskItems) {
      const slot = desks.find((d) => d.id === item.slotId)!;
      expect(slot.anchor.y).toBeLessThan(item.anchor.y);
    }
  });
});

describe("route", () => {
  const relax = { anchor: { x: 100, y: 100 }, gate: { x: 130, y: 150 } };
  const desk = { anchor: { x: 600, y: 500 }, gate: { x: 300, y: 400 } };

  it("đi qua gate của chỗ đi, gate của đích, rồi tới đích", () => {
    expect(planRoute(relax, desk)).toEqual([relax.gate, desk.gate, desk.anchor]);
    expect(planRoute(desk, relax)).toEqual([desk.gate, relax.gate, relax.anchor]);
  });

  it("bỏ waypoint quá gần điểm trước; luôn kết thúc ở đích", () => {
    const near = { anchor: { x: 100, y: 100 }, gate: { x: 100, y: 100 + ROUTE_MIN_GAP_PX - 1 } };
    expect(planRoute(near, desk)).toEqual([desk.gate, desk.anchor]);
    const sameGate = { anchor: { x: 320, y: 420 }, gate: desk.gate };
    expect(planRoute(desk, sameGate)).toEqual([desk.gate, sameGate.anchor]);
    const gateAtAnchor = { anchor: { x: 700, y: 700 }, gate: { x: 705, y: 705 } };
    expect(planRoute(desk, gateAtAnchor)).toEqual([desk.gate, gateAtAnchor.anchor]);
    expect(planRoute(desk, desk)).toEqual([desk.gate, desk.anchor]);
  });

  it("đang ở trên lối đi (gate = chỗ đứng): không quay lại", () => {
    const onAisle = { anchor: { x: 200, y: 300 }, gate: { x: 200, y: 300 } };
    expect(planRoute(onAisle, desk)).toEqual([desk.gate, desk.anchor]);
  });

  it("thời lượng đoạn theo tốc độ đi, có sàn tối thiểu", () => {
    expect(segmentMs({ x: 0, y: 0 }, { x: WALK_SPEED_PX_S * 2, y: 0 })).toBe(2000);
    expect(segmentMs({ x: 0, y: 0 }, { x: 1, y: 0 })).toBe(MIN_SEGMENT_MS);
  });

  it("hướng mặt theo chiều ngang, gần thẳng đứng thì giữ hướng cũ", () => {
    expect(facingOf({ x: 0, y: 0 }, { x: 50, y: 10 }, -1)).toBe(1);
    expect(facingOf({ x: 0, y: 0 }, { x: -50, y: 10 }, 1)).toBe(-1);
    expect(facingOf({ x: 0, y: 0 }, { x: 2, y: 90 }, -1)).toBe(-1);
  });
});

describe("spriteVars", () => {
  it("tính sẵn phần trăm cho steps(): work là hàng 1, 6 frame, 8 fps", () => {
    expect(spriteVars(WORKER_SHEET, "work")).toEqual({
      "--cols": 6,
      "--rows": 6,
      "--row-pos": "20%",
      "--end-x": "100%",
      "--frames": 6,
      "--dur": "750ms",
      "--iter": "infinite",
    });
  });

  it("move có 4 frame: dừng ở frame thứ 4 (60%), không trượt sang ô trống", () => {
    expect(spriteVars(WORKER_SHEET, "move")).toMatchObject({ "--row-pos": "40%", "--end-x": "60%", "--frames": 4, "--dur": "500ms" });
  });

  it("happy không lặp: mặc định 1 lượt, truyền số lượt thì dùng số đó", () => {
    expect(spriteVars(WORKER_SHEET, "happy")["--iter"]).toBe("1");
    expect(spriteVars(WORKER_SHEET, "happy", 3)).toMatchObject({ "--iter": "3", "--dur": "600ms", "--row-pos": "100%" });
  });

  it("điểm neo của worker theo tỉ lệ [128, 234] / 256 của ô", () => {
    const { display, anchor } = WORKER_SHEET;
    expect(anchor.x / display.w).toBeCloseTo(128 / 256, 2);
    expect(anchor.y / display.h).toBeCloseTo(234 / 256, 2);
  });
});

describe("system", () => {
  it("deriveSignals", () => {
    expect(deriveSignals(null, "live", false)).toEqual({ paused: false, rateLimitedUntil: null, disconnected: false });
    const until = "2026-11-11T11:00:00Z";
    const status = { ...STATUS, dispatch_paused: true, rate_limited_until: until };
    expect(deriveSignals(status, "reconnecting", true)).toEqual({ paused: true, rateLimitedUntil: until, disconnected: true });
    // Hết hạn rồi (rateLimited = false) thì không còn biển dù status vẫn mang mốc cũ.
    expect(deriveSignals(status, "live", false).rateLimitedUntil).toBeNull();
  });

  it("kanbanCounts trừ số note đang bay khỏi cột review, không âm", () => {
    const row = { key: "SH-1", summary: "", url: null, labels: [], blockedBy: [], task: null };
    const groups = { waiting: [row, row], inProgress: [row], review: [row, row], failed: [] };
    expect(kanbanCounts(groups, 0)).toEqual({ waiting: 2, inProgress: 1, review: 2, failed: 0 });
    expect(kanbanCounts(groups, 1).review).toBe(1);
    expect(kanbanCounts(groups, 5).review).toBe(0);
  });

  it("rackGauge: số đèn = max_concurrency (tối đa 8), đèn sáng = running", () => {
    expect(rackGauge(null)).toMatchObject({ lit: 0, total: 0 });
    expect(rackGauge({ ...STATUS, running: 1, max_concurrency: 3 })).toEqual({ lit: 1, total: 3, label: "Đang chạy 1 / 3" });
    expect(rackGauge({ ...STATUS, running: 12, max_concurrency: 20 })).toMatchObject({ lit: 8, total: 8, label: "Đang chạy 12 / 20" });
  });
});
