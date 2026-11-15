// Bố cục văn phòng: dữ liệu tọa độ trong hệ ảnh nền 1448x1086. Đã chỉnh bằng ảnh chụp; muốn dời món nào chỉ sửa file này.
import type { AgentSpot, Facing, Point, ZoneId } from "./geometry";

/** Chỗ đứng của một robot. anchor là điểm chạm đất của robot. */
export interface Slot {
  id: string;
  zone: ZoneId;
  anchor: Point;
  /** Điểm trên lối đi mà robot phải qua khi vào / ra slot này. */
  gate: Point;
  facing: Facing;
  /** Vị trí thẻ tên so với anchor khi robot đứng yên ở slot (mặc định ngay dưới chân). */
  tag: Point;
}

export interface DeskSlot extends Slot {
  zone: "desk";
}

export interface RelaxSlot extends Slot {
  zone: "relax";
  /** rug: trên thảm đỏ; plaza: quanh quầy cà phê. Quyết định thứ tự lấp khi rate limit. */
  spot: "rug" | "plaza";
}

/** Chỗ đứng của agent: cùng dạng với Slot nhưng không thuộc khu nào của worker. */
export type AgentStand = Omit<Slot, "id" | "zone">;
/** Mỗi agent có góc đứng mặc định (home) và chỗ làm việc (work). */
export type AgentPlacement = Record<AgentSpot, AgentStand>;

export type WorkstationSprite = "workstation_basic" | "workstation_dual" | "workstation_analytics" | "workstation_manager";

export type FurnitureSprite =
  | WorkstationSprite
  | "sofa"
  | "vending_machine"
  | "water_dispenser"
  | "arcade_cabinet"
  | "coffee_station"
  | "bookshelf_lounge"
  | "floor_lamp"
  | "guitar"
  | "recharge_pod"
  | "server_rack"
  | "utility_shelf"
  | "kanban_board"
  | "flow_board"
  | "planning_table"
  | "hologram_table"
  | "dashboard_monitor"
  | "potted_palm"
  | "palm_planter"
  | "flower_box"
  | "small_planter"
  | "flower_planter"
  | "robot_vacuum";

/** anchor = giữa cạnh đáy của ảnh. Chiều sâu = anchor.y + depthBias. */
export interface FurnitureItem {
  id: string;
  sprite: FurnitureSprite;
  anchor: Point;
  flip?: boolean;
  depthBias?: number;
  /** Ảnh gốc bị cắt phẳng ở đáy (chân bàn họp, đế sofa): làm mờ dần mép dưới để không lộ đường cắt. */
  softBase?: boolean;
}

export interface DeskItem extends FurnitureItem {
  sprite: WorkstationSprite;
  slotId: string;
}

/** Vùng màn hình trên ảnh bàn (px tính từ góc trên-trái ảnh), để phủ nội dung theo phase. */
export interface ScreenRect {
  x: number;
  y: number;
  w: number;
  h: number;
  /** Độ nghiêng cạnh ngang của màn hình (độ, âm = dốc lên về bên phải). */
  skewDeg: number;
}

export interface FloorDecal {
  id: string;
  text: string;
  at: Point;
  /** right: chữ chạy theo trục xuống-phải; left: theo trục lên-phải. */
  axis: "right" | "left";
  tone: "relax" | "planning" | "work";
}

export interface OfficeLayout {
  /** Thứ tự mảng = thứ tự lấp bàn theo chỉ số worker. */
  desks: DeskSlot[];
  deskItems: DeskItem[];
  relax: RelaxSlot[];
  pods: Slot[];
  furniture: FurnitureItem[];
  planner: AgentPlacement;
  orchestrator: AgentPlacement;
  kanban: { item: FurnitureItem; plaque: Point; noteTarget: Point };
  serverRacks: FurnitureItem[];
  /** Điểm gắn cột đèn + thẻ chữ của đồng hồ tải, so với góc trên-trái ảnh tủ đầu tiên. */
  rackLabel: Point;
  signals: Point;
  overflowChips: Record<ZoneId, Point>;
  decals: FloorDecal[];
  /** Tuyến tuần tra của robot hút bụi (vòng kín). */
  vacuumPath: Point[];
}

// ------------------------------------------------------------------ bàn

/** Bước giữa hai bàn kề nhau trong một hàng (trục xuống-phải) và giữa hai hàng (trục xuống-trái). */
const DESK_STEP: Point = { x: 185, y: 62 };
const ROW_STEP: Point = { x: -90, y: 124 };
/** Bàn đầu của hàng giữa. */
const ROW_A_ORIGIN: Point = { x: 430, y: 584 };
/** Robot đứng sau cạnh lưng bàn (phía màn hình), nhìn qua màn hình về phía người xem. */
const STAND_OFFSET: Point = { x: -44, y: -62 };
/** Thẻ tên của robot ở bàn nằm ở gầm bàn phía trước, như biển tên của bàn. */
const DESK_TAG_FROM_DESK: Point = { x: -8, y: -4 };
/** Gate của hàng nằm trên lối đi sau lưng hàng bàn, trước bàn đầu hàng. */
const GATE_BACKOFF = 0.5;

const add = (a: Point, b: Point, k = 1): Point => ({ x: Math.round(a.x + b.x * k), y: Math.round(a.y + b.y * k) });

type RowId = "Z" | "A" | "B";

const ROW_START: Record<RowId, Point> = {
  Z: add(add(ROW_A_ORIGIN, DESK_STEP), ROW_STEP, -1),
  A: ROW_A_ORIGIN,
  B: add(ROW_A_ORIGIN, ROW_STEP),
};

const deskAnchor = (row: RowId, col: number): Point => add(ROW_START[row], DESK_STEP, col - 1);
const rowGate = (row: RowId): Point => add(add(ROW_START[row], STAND_OFFSET), DESK_STEP, -GATE_BACKOFF);

/** Thứ tự lấp bàn: cụm giữa trước, để vài worker đầu không dồn về một hàng. */
const DESK_ORDER: Array<[RowId, number]> = [
  ["A", 2],
  ["Z", 2],
  ["B", 2],
  ["A", 3],
  ["A", 1],
  ["Z", 1],
  ["B", 3],
  ["Z", 3],
  ["B", 1],
  ["A", 4],
];

const WORKSTATIONS: WorkstationSprite[] = ["workstation_basic", "workstation_dual", "workstation_analytics", "workstation_manager"];

const desks: DeskSlot[] = [];
const deskItems: DeskItem[] = [];
DESK_ORDER.forEach(([row, col], i) => {
  const desk = deskAnchor(row, col);
  const anchor = add(desk, STAND_OFFSET);
  const slotId = `desk-${row}${col}`;
  desks.push({
    id: slotId,
    zone: "desk",
    anchor,
    gate: rowGate(row),
    facing: 1,
    tag: { x: desk.x + DESK_TAG_FROM_DESK.x - anchor.x, y: desk.y + DESK_TAG_FROM_DESK.y - anchor.y },
  });
  deskItems.push({ id: `desk-item-${row}${col}`, sprite: WORKSTATIONS[i % WORKSTATIONS.length]!, anchor: desk, slotId });
});

/** Đo trên từng ảnh workstation_*.webp. */
export const DESK_SCREENS: Record<WorkstationSprite, ScreenRect> = {
  workstation_basic: { x: 48, y: 12.5, w: 38, h: 26, skewDeg: -21.5 },
  workstation_dual: { x: 54, y: 13, w: 52, h: 27, skewDeg: -21 },
  workstation_analytics: { x: 78, y: 10, w: 23, h: 23, skewDeg: -14.6 },
  workstation_manager: { x: 50, y: 18, w: 48, h: 28, skewDeg: -21.6 },
};

// ------------------------------------------------------------------ chỗ nghỉ, pod

const TAG_BELOW: Point = { x: 0, y: 5 };

const relaxSlot = (n: number, spot: RelaxSlot["spot"], anchor: Point, gate: Point, facing: Facing = 1): RelaxSlot => ({
  id: `relax-${n}`,
  zone: "relax",
  spot,
  anchor,
  gate,
  facing,
  tag: TAG_BELOW,
});

const PLAZA_GATE: Point = { x: 566, y: 372 };

const relax: RelaxSlot[] = [
  relaxSlot(1, "rug", { x: 330, y: 398 }, { x: 356, y: 432 }),
  relaxSlot(2, "rug", { x: 200, y: 436 }, { x: 250, y: 462 }),
  relaxSlot(3, "rug", { x: 432, y: 366 }, { x: 456, y: 398 }, -1),
  relaxSlot(4, "rug", { x: 128, y: 452 }, { x: 196, y: 482 }),
  relaxSlot(5, "rug", { x: 268, y: 418 }, { x: 300, y: 448 }, -1),
  relaxSlot(6, "rug", { x: 506, y: 344 }, { x: 524, y: 378 }),
  relaxSlot(7, "plaza", { x: 640, y: 300 }, PLAZA_GATE),
  relaxSlot(8, "plaza", { x: 728, y: 340 }, PLAZA_GATE, -1),
  relaxSlot(9, "plaza", { x: 548, y: 342 }, PLAZA_GATE),
  relaxSlot(10, "plaza", { x: 604, y: 386 }, PLAZA_GATE),
];

const POD_GATE: Point = { x: 196, y: 566 };
const POD_STAND: Point = { x: 62, y: 16 };

const podItems: FurnitureItem[] = [
  { id: "pod-1", sprite: "recharge_pod", anchor: { x: 106, y: 574 } },
  { id: "pod-2", sprite: "recharge_pod", anchor: { x: 120, y: 664 } },
  { id: "pod-3", sprite: "recharge_pod", anchor: { x: 176, y: 738 } },
  { id: "pod-4", sprite: "recharge_pod", anchor: { x: 258, y: 796 } },
];

const pods: Slot[] = podItems.map((item) => ({
  id: item.id,
  zone: "pod",
  anchor: add(item.anchor, POD_STAND),
  gate: POD_GATE,
  facing: 1,
  tag: TAG_BELOW,
}));

// ------------------------------------------------------------------ nội thất

const furniture: FurnitureItem[] = [
  // Relax: dọc tường kính bên trái.
  { id: "bookshelf", sprite: "bookshelf_lounge", anchor: { x: 118, y: 404 } },
  { id: "sofa", sprite: "sofa", anchor: { x: 226, y: 396 }, softBase: true },
  { id: "lamp", sprite: "floor_lamp", anchor: { x: 322, y: 340 } },
  { id: "vending", sprite: "vending_machine", anchor: { x: 384, y: 330 } },
  { id: "water", sprite: "water_dispenser", anchor: { x: 446, y: 304 } },
  { id: "arcade", sprite: "arcade_cabinet", anchor: { x: 506, y: 292 } },
  { id: "guitar", sprite: "guitar", anchor: { x: 62, y: 430 } },
  { id: "coffee", sprite: "coffee_station", anchor: { x: 664, y: 252 } },
  { id: "palm-corner", sprite: "potted_palm", anchor: { x: 728, y: 236 } },
  // Planning: dọc tường kính bên phải.
  { id: "flow", sprite: "flow_board", anchor: { x: 1042, y: 330 } },
  { id: "table", sprite: "planning_table", anchor: { x: 1106, y: 438 }, softBase: true },
  { id: "hologram", sprite: "hologram_table", anchor: { x: 1312, y: 446 } },
  { id: "palm-planning", sprite: "potted_palm", anchor: { x: 1160, y: 346 } },
  { id: "dashboard", sprite: "dashboard_monitor", anchor: { x: 1262, y: 392 } },
  // Work area: cây ở đầu hàng bàn và dọc lan can trước.
  { id: "plant-a", sprite: "small_planter", anchor: { x: 312, y: 574 } },
  // Chậu hoa đứng trước kệ, bên phải tầm tay của orchestrator ở home (không đè lên robot).
  { id: "plant-b", sprite: "flower_planter", anchor: { x: 1288, y: 728 } },
  { id: "box-1", sprite: "flower_box", anchor: { x: 470, y: 886 } },
  { id: "box-2", sprite: "flower_box", anchor: { x: 800, y: 896 } },
  { id: "palm-front", sprite: "palm_planter", anchor: { x: 1040, y: 866 } },
  // Kệ dạt sát cột góc phải để chừa góc dưới-phải của sàn cho hai agent đứng (mép trái kệ cách tay orchestrator một khoảng).
  { id: "shelf", sprite: "utility_shelf", anchor: { x: 1320, y: 726 } },
  ...podItems,
];

const serverRacks: FurnitureItem[] = [
  // Tủ 1 đứng sát tủ 2 để khe giữa bàn Z3 và tủ đủ rộng cho một robot agent đi qua.
  { id: "rack-1", sprite: "server_rack", anchor: { x: 1278, y: 582 } },
  { id: "rack-2", sprite: "server_rack", anchor: { x: 1332, y: 566 } },
];

// ------------------------------------------------------------------ agent

const AGENT_TAG: Point = { x: 0, y: 6 };
const agentStand = (anchor: Point, gate: Point, tag: Point = AGENT_TAG): AgentStand => ({ anchor, gate, facing: 1, tag });

/** Lối duy nhất từ góc home lên khu Planning: khe giữa đầu phải bàn Z3 và tủ server 1, rộng xấp xỉ thân một robot agent. */
const HOME_AISLE_X = 1190;

/**
 * home: hai chỗ cạnh nhau ở góc dưới-phải của sàn, trước lan can. Gate của home nằm ở miệng khe giữa bàn Z3 và tủ server;
 * gate của work nằm trên lối đi dưới thảm tím. Orchestrator đi thẳng đứng giữa khe; planner từ miệng khe chéo lên lối đi,
 * vòng sau góc bàn Z3. Khe chỉ vừa thân robot: tay robot đi sát mép bàn và mép tủ, nhưng điểm chạm đất không cắt qua món nào.
 * Thẻ tên của planner ở home lệch sang trái để không đè thẻ của orchestrator khi nhãn phóng to ở cửa sổ nhỏ.
 */
const plannerPlacement: AgentPlacement = {
  home: agentStand({ x: 1110, y: 782 }, { x: 1182, y: 626 }, { x: -18, y: 6 }),
  work: agentStand({ x: 834, y: 362 }, { x: 1060, y: 470 }),
};

const orchestratorPlacement: AgentPlacement = {
  home: agentStand({ x: 1202, y: 738 }, { x: HOME_AISLE_X, y: 646 }),
  work: agentStand({ x: 1236, y: 416 }, { x: HOME_AISLE_X, y: 524 }),
};

const kanbanItem: FurnitureItem = { id: "kanban", sprite: "kanban_board", anchor: { x: 912, y: 292 } };

export const OFFICE_LAYOUT: OfficeLayout = {
  desks,
  deskItems,
  relax,
  pods,
  furniture,
  planner: plannerPlacement,
  orchestrator: orchestratorPlacement,
  kanban: { item: kanbanItem, plaque: { x: 912, y: 172 }, noteTarget: { x: 912, y: 228 } },
  serverRacks,
  rackLabel: { x: 1322, y: 566 },
  signals: { x: 724, y: 30 },
  overflowChips: { desk: { x: 630, y: 884 }, relax: { x: 250, y: 300 }, pod: { x: 70, y: 780 } },
  decals: [
    { id: "decal-relax", text: "RELAX", at: { x: 262, y: 480 }, axis: "left", tone: "relax" },
    { id: "decal-planning", text: "PLANNING", at: { x: 954, y: 398 }, axis: "right", tone: "planning" },
    { id: "decal-work", text: "WORK AREA", at: { x: 940, y: 842 }, axis: "left", tone: "work" },
  ],
  vacuumPath: [
    { x: 540, y: 866 },
    { x: 730, y: 866 },
    { x: 1010, y: 791 },
    { x: 730, y: 866 },
  ],
};

export const ALL_SLOTS: ReadonlyMap<string, Slot> = new Map<string, Slot>(
  [...OFFICE_LAYOUT.desks, ...OFFICE_LAYOUT.relax, ...OFFICE_LAYOUT.pods].map((s) => [s.id, s]),
);
