# Kiến trúc: chế độ xem "Virtual Office" cho `packages/web`

Tài liệu của system-architect, đọc cùng `OFFICE_BRIEF.md` và `OFFICE_PLAN.md`. Chỉ có thiết kế, không có code tính năng.
Mọi tọa độ ở mục 7 là **ước lượng từ việc nhìn ảnh nền**, chưa chạy thử; implementer tinh chỉnh bằng ảnh chụp.

## A. Tổng quan

Office là một cây component thứ hai đặt cạnh `Dashboard`, nạp lười, đọc cùng `Store` qua `BridgeContext` đã export sẵn.
Cảnh là hàm thuần của `AppState` cộng một state cục bộ nhỏ cho hiệu ứng tạm; không thêm gì vào `AppState`, reducer, protocol.
Kiểu kiến trúc: **mô hình thuần (model) → component trình bày**, một chiều, giống cách repo đang tách `state/selectors.ts` khỏi component.

```
AppShell ──(viewMode)──┬── Dashboard (nguyên trạng)
                       └── lazy OfficeView
                              ├── TopBar + StatusBanners            (dùng lại)
                              ├── SceneViewport ── OfficeScene (memo)
                              │      ├── DepthLayer : Furniture, Desk, KanbanBoard, ServerRackGauge,
                              │      │                WorkerRobot ×N, AgentRobot ×2      (z = y)
                              │      ├── TintOverlay (pause / mất kết nối)
                              │      ├── LabelLayer : thẻ tên, bong bóng, biển số kanban, chip "+N"
                              │      └── FxLayer    : FlyingNote, SceneSignals
                              ├── FloatingChat ── PlannerColumn / OrchestratorColumn (nguyên trạng)
                              ├── TaskDetailPanel | ListDrawer | WorkerInfoDialog     (Modal có sẵn)
                              └── useDemoDirector (chỉ khi demo)

Store ─ useBridgeSelector(slice) ─► model/* (thuần) ─► SceneWorker[] / SceneAgent ─► component memo
Store ─ subscribe ─► useOfficeFx (reducer cục bộ: bong bóng, happy, error, note) ─┘
```

## B. Trả lời 11 câu hỏi của plan (mục 5)

| # | Quyết định | Lý do |
|---|---|---|
| 1 | Điểm chuyển view ở **`AppShell`**. `AppShell` giữ `viewMode` qua `useViewMode()` (file trong `office/`). `?view=office\|dashboard` thắng storage cho lần tải đó và **không ghi** storage. Bấm nút thì ghi storage và xóa tham số `view` khỏi URL bằng `history.replaceState`. Mặc định `dashboard`. | `Dashboard` không đổi hành vi; ảnh chụp headless và link chia sẻ không làm đổi lựa chọn đã nhớ; không xóa `view` thì refresh sẽ đè lại lựa chọn vừa bấm. |
| 2 | Asset đặt ở **`components/office/assets/*.webp`, import từ TS** (`assets/index.ts`). Không dùng `public/office`. | Có hash (khỏi `?v=`), đúng với `base: "./"`, chỉ chunk lười tham chiếu nên dashboard không tải, xóa một thư mục là sạch. Đây là chỗ lệch có chủ đích so với brief; mục tiêu của brief (nạp lười, dưới 3 MB) vẫn giữ. |
| 3 | Hướng **(a)**: bọc nguyên `PlannerColumn` / `OrchestratorColumn`, ghi đè bằng CSS của office, **không thêm prop nào** vào hai file cũ. Mount cả hai tab, tab ẩn dùng `visibility: hidden`; thu gọn vẫn giữ mount. | Không sửa file cũ; nháp trong `ChatInput` không mất; giữ layout nên `useAutoScroll` vẫn bám đáy (với `display: none` thì không). |
| 4 | Một hook `useOfficeFx()` ở `OfficeView` + reducer thuần `model/effects.ts`. Thời lượng: bong bóng progress **6 s**, happy **1,8 s** (3 lượt của 0,6 s), error **4 s** kèm bong bóng `fail_category` 4 s, bong bóng "đã hủy" **3 s**, note bay **1,2 s**. | Một lượt happy 0,6 s quá ngắn để nhận ra; đây là chỗ lệch nhỏ so với "một lượt" của brief. |
| 5 | Bàn theo **chỉ số trong `sortedWorkers`** (mọi worker đã biết, không chỉ worker bận), ánh xạ qua thứ tự lấp bàn `layout.desks`. Không dùng localStorage. | Giống nhau trên mọi máy, test được, không có state ẩn. Chỉ dịch chỗ khi thêm worker có id nhỏ hơn, hiếm. Worker thứ 11 trở đi không có bàn (chip "+N"). |
| 6 | `assigned`: đi tới bàn rồi đứng `idle`, nhãn "CHỜ RUNNER"; `move` chỉ phát khi đang thật sự trượt. `cancelled`: không `error`, bong bóng trung tính "đã hủy" 3 s rồi về Relax. | Robot không "đi" vô hạn; hủy không phải lỗi. |
| 7 | Tuyến **qua điểm trung gian**: `chỗ đi → gate của nó → gate của đích → đích`, mỗi đoạn một CSS transition tuyến tính. `z-index = round(y)` và **transition cả `z-index`** cùng thời lượng với `transform`. | Robot đứng sau bàn, tức đứng trong lối đi giữa hai hàng; đi dọc lối đi thì sắp theo y luôn đúng. `z-index` là thuộc tính animate được (nội suy số nguyên), không cần rAF. |
| 8 | Robot planner: bận theo **phiên đang chọn**; alert khi có permission ở **bất kỳ** phiên không phải orchestrator. Bấm robot đang alert: mở chat tab Planner, nếu phiên đang chọn không có permission thì tự `selectPlannerSession` sang phiên có permission cũ nhất. | Người bấm dấu "!" là muốn xử lý nó; cùng logic với nút "Mở phiên đó" đã có. |
| 9 | Bộ đạo diễn nằm trong `office/demo/`, lấy `store` bằng `useContext(BridgeContext)` (context đã export). Không thêm hook vào `bridge-context.ts`, không sửa `App.tsx`, `fixtures.ts`, `demo-bridge-service.ts`. | Test cũ không bao giờ mount `OfficeView` nên không thể bị ảnh hưởng. |
| 10 | **Vẫn hỗ trợ**, không chặn. Sân khấu có bề rộng tối thiểu 760 px (scale sàn ≈ 0,52), hẹp hơn thì cuộn ngang. Viewport < 720 px: khung chat thành bottom sheet rộng 100%, cao 70dvh. | Một media query, không nhánh layout riêng. |
| 11 | **Một** `@keyframes` dùng biến CSS; phần trăm tính sẵn trong TS (`spriteVars`). Animation không lặp phát lại bằng **đổi `key`** của phần tử sprite; thời điểm kết thúc do timer của `useOfficeFx` quyết định, không nghe `animationend`. | Một cơ chế cho cả worker và agent; hết hiệu ứng là dữ kiện của model, không phải của DOM. |

## C. Module và ranh giới

Quy tắc phụ thuộc: `model/` không import React, DOM, CSS, asset. `hooks/` và `scene/` import `model/`. Không file nào ngoài
`AppShell.tsx` import từ `office/`. `ViewSwitchButton.tsx` và `view-mode.ts` là hai file duy nhất được import tĩnh; chúng
không được import gì khác trong `office/` ngoài `constants.ts`.

```
components/office/
  OfficeView.tsx            default export cho React.lazy. Ghép TopBar, banner, cảnh, chat, panel; giữ state UI cục bộ
                            (chat dock, list đang mở, worker đang xem). Không tính toán cảnh.
  ViewSwitchButton.tsx      Nút trên TopBar. Chỉ dùng class của common/ui.module.css.
  view-mode.ts              resolveViewMode (thuần) + useViewMode.
  constants.ts              Khóa storage, tên tham số URL, thời lượng, tốc độ đi.
  office.module.css         Khung trang của Office (không phải cảnh).
  assets/                   *.webp do script sinh + index.ts (map id → URL đã import).
  model/                                                      ── THUẦN, có test cạnh file ──
    geometry.ts             Point, SCENE_W/H, distance.
    layout.ts               OFFICE_LAYOUT: dữ liệu tọa độ. Không logic.
    sprites.ts              SheetSpec của worker và agent, spriteVars().
    skin.ts                 fnv1a32, skinOf.
    assign.ts               deskIndexOf, assignSlots.
    scene-state.ts          resolveTask, deriveWorkerScene, buildWorkersScene, derivePlannerScene,
                            deriveOrchestratorScene, sceneWorkerEqual.
    system.ts               deriveSignals, kanbanCounts, rackGauge.
    effects.ts              Reducer hiệu ứng tạm, detectTransitions, collectProgress.
    route.ts                planRoute, segmentMs, facingOf.
  hooks/
    useBridgeSelector.ts    useSyncExternalStore trên một lát của AppState; useBridgeStore.
    useSceneScale.ts        ResizeObserver → biến CSS --scene-scale, --label-scale (ghi thẳng vào DOM, không setState).
    useOfficeFx.ts          Nối store với reducer hiệu ứng; một setTimeout tới hạn gần nhất.
    useRouteWalker.ts       Đi lần lượt các waypoint của planRoute; transitionend + timeout dự phòng.
    useRateLimited.ts       boolean; một timeout tới rate_limited_until.
    usePrefersReducedMotion.ts
    useChatDock.ts          { open, tab } nhớ qua lib/storage.
  scene/
    OfficeScene.tsx         memo. Dựng 4 lớp, gọi model, phát danh sách robot.
    Sprite.tsx              Phần tử sprite tổng quát (sheet + anim → biến CSS).
    Furniture.tsx           Ảnh tĩnh theo FurnitureItem.
    Desk.tsx                memo. Ảnh bàn + màn hình theo phase.
    WorkerRobot.tsx         memo(sceneWorkerEqual). button + Sprite; portal thẻ tên sang LabelLayer.
    RobotTag.tsx            Tên, nhãn trạng thái, 5 chấm phase.
    SpeechBubble.tsx
    AgentRobot.tsx          memo. Planner / orchestrator.
    KanbanBoard.tsx         button mở danh sách ticket + biển 4 số.
    ServerRackGauge.tsx     Đèn LED theo running / max_concurrency.
    SceneSignals.tsx        Biển pause / rate limit / mất kết nối (tự chạy useNow 1 s khi cần).
    FlyingNote.tsx
    OverflowChip.tsx        "+N", mở ListDrawer workers.
    DebugGrid.tsx           ?debug=grid: vẽ anchor, gate, id slot.
    scene.module.css        Lớp, sprite keyframes, transition, reduced motion.
  chat/
    FloatingChat.tsx, floating-chat.module.css
  panels/
    ListDrawer.tsx          Modal drawer chứa TicketsTab hoặc WorkersTab.
    WorkerInfoDialog.tsx    Modal dialog chứa WorkerCard (task = null).
  demo/
    scenarios.ts            scenarioActions (thuần).
    director.ts             directorStep (thuần).
    useDemoDirector.ts
  __tests__/OfficeView.test.tsx   Test khói.
```

Không thuộc office: quyền gửi lệnh (`BridgeActions`), dữ liệu entity, nhãn trạng thái (`state/event-format.ts`), `Modal`.
Gỡ tính năng = xóa `components/office/` + hoàn tác 3 file ở mục J.

## D. Interface (TypeScript, chỉ chữ ký)

### D1. Hình học và layout (`model/geometry.ts`, `model/layout.ts`)

```ts
export const SCENE_W = 1448;
export const SCENE_H = 1086;

/** Tọa độ trong hệ ảnh nền 1448x1086, gốc trên-trái, y hướng xuống. */
export interface Point { x: number; y: number }

export type ZoneId = "desk" | "relax" | "pod";
/** 1: sprite nguyên bản (mặt hơi lệch phải); -1: lật ngang. */
export type Facing = 1 | -1;

/** Chỗ đứng của một robot. anchor là điểm chạm đất của robot. */
export interface Slot {
  id: string;            // "desk-5", "relax-2", "pod-1"
  zone: ZoneId;
  anchor: Point;
  /** Điểm trên lối đi mà robot phải qua khi vào / ra slot này. */
  gate: Point;
  facing: Facing;
}

export interface DeskSlot extends Slot {
  zone: "desk";
  /** Tâm màn hình trên bàn, để đặt lớp phủ phase. */
  screen: Point;
}

export interface RelaxSlot extends Slot {
  zone: "relax";
  /** rug: trên thảm đỏ; plaza: quanh quầy cà phê. Quyết định thứ tự lấp khi rate limit. */
  spot: "rug" | "plaza";
}

export type FurnitureSprite =
  | "workstation_basic" | "workstation_dual" | "workstation_analytics" | "workstation_manager"
  | "sofa" | "vending_machine" | "water_dispenser" | "arcade_cabinet" | "coffee_station"
  | "bookshelf_lounge" | "floor_lamp" | "recharge_pod" | "server_rack"
  | "kanban_board" | "flow_board" | "planning_table" | "hologram_table"
  | "potted_palm" | "palm_planter" | "flower_box";

/** anchor = giữa cạnh đáy của ảnh. Chiều sâu = anchor.y + depthBias. */
export interface FurnitureItem {
  id: string;
  sprite: FurnitureSprite;
  anchor: Point;
  flip?: boolean;
  depthBias?: number;
}

export interface DeskItem extends FurnitureItem { slotId: string }

export interface OfficeLayout {
  /** Thứ tự mảng = thứ tự lấp bàn theo chỉ số worker. */
  desks: DeskSlot[];
  deskItems: DeskItem[];
  relax: RelaxSlot[];
  pods: Slot[];
  furniture: FurnitureItem[];
  planner: { anchor: Point; facing: Facing };
  orchestrator: { anchor: Point; facing: Facing };
  kanban: { item: FurnitureItem; plaque: Point; noteTarget: Point };
  serverRacks: FurnitureItem[];
  signals: Point;
  overflowChips: Record<ZoneId, Point>;
}

export const OFFICE_LAYOUT: OfficeLayout;
export function distance(a: Point, b: Point): number;
```

### D2. Sprite (`model/sprites.ts`)

```ts
export type WorkerAnim = "idle" | "work" | "move" | "error" | "sleep" | "happy";
export type AgentAnim = "idle" | "processing" | "alert" | "off";

export interface AnimSpec { row: number; frames: number; fps: number; loop: boolean }

export interface SheetSpec<A extends string> {
  cols: number;
  rows: number;
  /** Kích thước hiển thị của một ô trong hệ cảnh (không phải kích thước file). */
  display: { w: number; h: number };
  /** Điểm chạm đất trong ô hiển thị. */
  anchor: Point;
  anims: Record<A, AnimSpec>;
}

/** 6x6; display 160x160; anchor [80,146] (quy đổi từ [128,234] của ô 256). */
export const WORKER_SHEET: SheetSpec<WorkerAnim>;
/** Sheet do script đóng gói lại: 1 hàng, 3 frame idle; display 192x174. */
export const AGENT_SHEET: SheetSpec<"idle">;

/** Biến CSS đã tính sẵn cho một animation. Mọi phần trăm được chia ở đây, CSS không chia cho (cols - 1). */
export interface SpriteVars {
  "--cols": number; "--rows": number;
  "--row-pos": string;   // "40%"
  "--end-x": string;     // "120%"
  "--frames": number;
  "--dur": string;       // "750ms"
  "--iter": string;      // "infinite" | "3"
}
export function spriteVars<A extends string>(sheet: SheetSpec<A>, anim: A, iterations?: number): SpriteVars;
```

### D3. Skin và gán chỗ (`model/skin.ts`, `model/assign.ts`)

```ts
export const SKIN_COUNT = 5;
export type SkinIndex = 0 | 1 | 2 | 3 | 4;

/** FNV-1a 32 bit trên các code unit UTF-16 của chuỗi. */
export function fnv1a32(text: string): number;
export function skinOf(workerId: string): SkinIndex;

/** Chỉ số ổn định của worker = vị trí trong sortedWorkers. */
export function deskIndexOf(sortedWorkerIds: readonly string[]): Map<string, number>;

export type AssignMode = "stable" | "compact";

export interface SlotAssignment {
  /** worker_id → slot id. */
  placed: Map<string, string>;
  /** Không còn chỗ, theo thứ tự đầu vào. */
  overflow: string[];
}

/**
 * stable: worker có chỉ số i ưu tiên pool[i % pool.length], bị chiếm thì lấy slot trống kế tiếp theo vòng.
 * compact: lấp pool từ đầu theo thứ tự đầu vào (dùng cho giờ cà phê).
 * candidates đã sắp theo chỉ số ổn định; chỉ số nhỏ hơn được chọn trước.
 */
export function assignSlots(
  candidates: ReadonlyArray<{ workerId: string; index: number }>,
  pool: readonly string[],
  mode: AssignMode,
): SlotAssignment;
```

### D4. Mô hình cảnh (`model/scene-state.ts`, `model/system.ts`)

```ts
export type BubbleTone = "progress" | "fail" | "info";
export type DeskScreen = TaskPhase | "waiting" | "off";

/** Phẳng, toàn giá trị nguyên thủy, để memo so sánh nông. */
export interface SceneWorker {
  id: string;
  skin: SkinIndex;
  zone: ZoneId;
  slotId: string;
  x: number; y: number;
  gateX: number; gateY: number;
  facing: Facing;
  /** Animation khi đứng yên; `move` do component tự bật trong lúc trượt. */
  anim: WorkerAnim;
  /** Đổi giá trị thì sprite phát lại từ frame 0 (id của hiệu ứng, 0 nếu không có). */
  animKey: number;
  /** "BUSY" | "IDLE" | "OFFLINE" | "CHỜ RUNNER" | "XONG" | "LỖI". */
  stateLabel: string;
  /** Dòng phụ: ticket key, fail_category, "nghỉ cà phê"; null nếu không có. */
  detail: string | null;
  /** -1: có task nhưng chưa báo phase; 0..4; null: không có task. */
  phaseIndex: number | null;
  taskId: string | null;
  bubbleId: number;
  bubbleText: string | null;
  bubbleTone: BubbleTone;
  ariaLabel: string;
}

export interface WorkersScene {
  actors: SceneWorker[];
  /** deskSlotId → nội dung màn hình. */
  screens: Record<string, DeskScreen>;
  overflow: Record<ZoneId, string[]>;
}

export interface WorkerIntent {
  zone: ZoneId;
  anim: WorkerAnim;
  animKey: number;
  stateLabel: string;
  detail: string | null;
  phaseIndex: number | null;
  taskId: string | null;
  screen: DeskScreen;
}

/** Task đang sống của worker: current_task_id nếu chưa terminal, không thì task chưa terminal mới nhất theo worker_id. */
export function resolveTask(worker: Worker, tasks: Record<string, Task>): Task | null;

/** Một worker → ý định cảnh, chưa có vị trí. Bảng quyết định ở mục E2. */
export function deriveWorkerScene(
  worker: Worker,
  task: Task | null,
  fx: WorkerFx | undefined,
  ctx: { rateLimited: boolean },
): WorkerIntent;

/** Gộp: sortedWorkers → intent → gán slot → SceneWorker. */
export function buildWorkersScene(
  input: { workers: Record<string, Worker>; tasks: Record<string, Task>; fx: SceneFxState; rateLimited: boolean },
  layout: OfficeLayout,
): WorkersScene;

export function sceneWorkerEqual(a: SceneWorker, b: SceneWorker): boolean;

export interface SceneAgent {
  role: "planner" | "orchestrator";
  anim: AgentAnim;
  /** "rảnh" | "đang trả lời" | "chờ duyệt (2)" | nhãn ORCHESTRATOR_LABEL... */
  statusLabel: string;
  pendingCount: number;
  /** Planner: phiên cần chuyển tới khi bấm lúc đang alert; null nếu không cần. */
  jumpSessionId: string | null;
  ariaLabel: string;
}

export function derivePlannerScene(
  sessions: Record<string, Session>,
  plannerSessionId: string | null,
  permissions: Record<string, PermissionRequest>,
): SceneAgent;

export function deriveOrchestratorScene(session: Session | null, health: OrchestratorHealth | null): SceneAgent;

// model/system.ts
export interface SceneSignals { paused: boolean; rateLimitedUntil: string | null; disconnected: boolean }
export function deriveSignals(status: SystemStatus | null, phase: ConnectionPhase, rateLimited: boolean): SceneSignals;

export interface KanbanCounts { waiting: number; inProgress: number; review: number; failed: number }
/** review hiển thị = review thật trừ số note còn đang bay (không âm). */
export function kanbanCounts(groups: TicketGroups, notesInFlight: number): KanbanCounts;

export function rackGauge(status: SystemStatus | null): { lit: number; total: number; label: string };
```

### D5. Hiệu ứng tạm (`model/effects.ts`)

```ts
export interface PoseFx { id: number; kind: "happy" | "error"; detail: string | null; until: number }
export interface BubbleFx { id: number; text: string; tone: BubbleTone; until: number }
export interface WorkerFx { pose: PoseFx | null; bubble: BubbleFx | null }
export interface NoteFx { id: number; fromSlotId: string; until: number }

export interface SceneFxState {
  byWorker: Record<string, WorkerFx>;
  notes: NoteFx[];
  nextId: number;
}
export const INITIAL_FX: SceneFxState;

export interface TaskTransition {
  workerId: string;
  taskId: string;
  to: "completed" | "failed" | "cancelled";
  failCategory: FailCategory | null;
}

/** Chỉ tính task CÓ trong prev, chưa terminal ở prev và terminal ở next. Task mới xuất hiện đã terminal thì bỏ. */
export function detectTransitions(prev: Record<string, Task>, next: Record<string, Task>): TaskTransition[];

/** Các task.progress có seq > cursor và payload.message là chuỗi khác rỗng; mỗi worker lấy cái mới nhất. */
export function collectProgress(
  events: readonly BusEvent[],
  cursorSeq: number,
): { items: Array<{ workerId: string; text: string }>; cursorSeq: number };

export type FxAction =
  | { type: "transitions"; items: TaskTransition[]; deskOf: Record<string, string>; now: number }
  | { type: "progress"; items: Array<{ workerId: string; text: string }>; now: number }
  | { type: "expire"; now: number }
  | { type: "reset" };

export function fxReducer(state: SceneFxState, action: FxAction): SceneFxState;
/** Hạn gần nhất trong state, null nếu không còn hiệu ứng. */
export function nextExpiry(state: SceneFxState): number | null;
```

Quy tắc reducer:
- `completed` → `pose happy` (1,8 s) + một `NoteFx` (1,2 s) nếu worker có bàn. `failed` → `pose error` (4 s) + bong bóng tone `fail` ghi `fail_category`. `cancelled` → chỉ bong bóng `info` "đã hủy".
- Bong bóng mới thay bong bóng cũ của cùng worker. `expire` gỡ mọi mục có `until <= now`; không còn gì thì trả đúng tham chiếu cũ.
- `now` luôn được truyền vào; reducer không gọi `Date.now()`.

### D6. Tuyến đi (`model/route.ts`)

```ts
export interface Placement { anchor: Point; gate: Point }

/** [from.gate?, to.gate?, to.anchor], bỏ điểm cách điểm trước dưới 24 px. from là waypoint robot đang hướng tới. */
export function planRoute(from: Placement, to: Placement): Point[];
/** distance / WALK_SPEED_PX_S, tối thiểu 250 ms. */
export function segmentMs(from: Point, to: Point): number;
/** Đi sang trái thì -1, sang phải 1, gần như thẳng đứng thì giữ fallback. */
export function facingOf(from: Point, to: Point, fallback: Facing): Facing;
```

### D7. Hook và component chính

```ts
// hooks/useBridgeSelector.ts — select phải trả về tham chiếu lấy thẳng từ state, không tạo object mới.
export function useBridgeStore(): Store;
export function useBridgeSelector<T>(select: (state: AppState) => T): T;

// hooks
export function useSceneScale(viewport: RefObject<HTMLElement>, stage: RefObject<HTMLElement>): void;
export function useOfficeFx(): SceneFxState;
export function useRateLimited(status: SystemStatus | null): boolean;
export function usePrefersReducedMotion(): boolean;
export interface WalkState { x: number; y: number; moving: boolean; facing: Facing; segmentMs: number; ready: boolean }
export function useRouteWalker(target: Placement, restFacing: Facing, reducedMotion: boolean): WalkState;
export type ChatTab = "planner" | "orchestrator";
export function useChatDock(): { open: boolean; tab: ChatTab; show(tab: ChatTab, opener?: HTMLElement | null): void; collapse(): void };

// view-mode.ts
export type ViewMode = "dashboard" | "office";
export function resolveViewMode(search: string, stored: string | null): ViewMode;
export function useViewMode(): [ViewMode, (mode: ViewMode) => void];

// component
interface OfficeViewProps { onOpenConnection: () => void; viewSwitch: ReactNode }
interface OfficeSceneProps {
  workers: Record<string, Worker>; tasks: Record<string, Task>; tickets: Ticket[];
  sessions: Record<string, Session>; permissions: Record<string, PermissionRequest>;
  plannerSessionId: string | null; status: SystemStatus | null; connectionPhase: ConnectionPhase;
  fx: SceneFxState;
  onOpenTask(taskId: string): void; onWorkerInfo(workerId: string): void;
  onOpenChat(tab: ChatTab, jumpSessionId: string | null): void; onOpenList(kind: "tickets" | "workers"): void;
}
interface WorkerRobotProps { actor: SceneWorker; labelLayer: HTMLElement | null; reducedMotion: boolean; onActivate(actor: SceneWorker): void }
interface SpriteProps<A extends string> { sheet: SheetSpec<A>; url: string; anim: A; replayKey?: number; iterations?: number; flip?: boolean }
interface FloatingChatProps { dock: ReturnType<typeof useChatDock>; planner: SceneAgent; orchestrator: SceneAgent }
```

## E. Luồng dữ liệu và memo

### E1. Từ store tới pixel

1. `OfficeView` **không gọi `useBridgeState()`**. Nó gọi `useBridgeSelector` cho từng lát: `workers`, `tasks`, `tickets`, `sessions`, `permissions`, `plannerSessionId`, `status`, `connection.phase`, `openTaskId`. `useSyncExternalStore` bỏ qua render khi lát đó giữ nguyên tham chiếu, và reducer hiện tại giữ nguyên tham chiếu các nhánh không đổi. Khi chat stream chỉ có `streams` đổi, nên `OfficeView` và `OfficeScene` không render.
2. `OfficeScene` (memo) tính bằng `useMemo`:
   - `buildWorkersScene` theo `[workers, tasks, fx, rateLimited]`;
   - `derivePlannerScene` theo `[sessions, plannerSessionId, permissions]`; `deriveOrchestratorScene` theo `[sessions, status]`;
   - `groupTickets` + `kanbanCounts` theo `[tickets, tasks, fx.notes.length]`.
3. `WorkerRobot` nhận một prop `actor` phẳng, memo bằng `sceneWorkerEqual`. Model dựng lại mọi `SceneWorker` mỗi khi `workers` / `tasks` đổi, nhưng chỉ robot có trường thật sự đổi mới render. Render lại không làm animation CSS chạy lại (chỉ đổi `key` mới chạy lại).
4. Vị trí đang trượt là state cục bộ của `WorkerRobot` (`useRouteWalker`), không nằm trong model.
5. `TopBar`, `StatusBanners`, hai cột chat, `TaskDetailPanel` tự đăng ký store như hiện nay; chi phí khi chat stream bằng đúng dashboard hiện tại.

Nguồn sự thật: entity ở `Store`; hiệu ứng tạm ở `useOfficeFx`; vị trí đang đi ở từng `WorkerRobot`; chat mở / tab ở `useChatDock`; list và thẻ worker đang mở ở `OfficeView`; `openTaskId` vẫn ở `AppState`.

### E2. Bảng quyết định của `deriveWorkerScene` (dòng trên thắng dòng dưới)

| Điều kiện | zone | anim | stateLabel / detail | màn hình |
|---|---|---|---|---|
| `fx.pose.kind = happy` | desk | happy | XONG / ticket key | `mr_created` |
| `fx.pose.kind = error` | desk | error | LỖI / `fail_category` | off |
| `worker.state = offline` | pod | sleep | OFFLINE | off |
| task `running` | desk | work | BUSY / ticket key | `task.phase`, null thì `waiting` |
| task `assigned` | desk | idle | CHỜ RUNNER / ticket key | `waiting` |
| `worker.state = busy`, không tìm ra task | desk | work | BUSY / null, `phaseIndex = null` | `waiting` |
| còn lại (idle) | relax | idle | IDLE / "nghỉ cà phê" khi rate limit | off |

Task lấy từ `resolveTask`, nên worker `idle` mà task chưa terminal vẫn ở bàn (xử lý lệch pha `worker.updated` / `task.updated`).
Worker không có bàn (chỉ số ≥ 10) mà zone là desk thì vào `overflow.desk`.

Gán slot trong `buildWorkersScene`: desk theo `layout.desks[index]`; pod `stable`; relax `stable` trên pool `[rug..., plaza...]`, khi `rateLimited` thì `compact` trên pool `[plaza..., rug...]`.

### E3. `useOfficeFx`

- Đăng ký thẳng `store.subscribe` trong effect. Mỗi lần store báo: so tham chiếu `tasks` và `events` với lần trước; chỉ khi khác mới chạy `detectTransitions` / `collectProgress` và dispatch vào `useReducer` cục bộ. Chat stream chỉ tốn hai phép so tham chiếu.
- Lúc mount: `prevTasks = tasks hiện tại`, `cursorSeq = state.lastSeq`. Vì vậy không ăn mừng và không có bong bóng cho chuyện đã xảy ra trước khi vào view; sau refresh cũng vậy. Đây là hành vi chấp nhận.
- **Tái lập mốc, không sinh hiệu ứng** khi `snapshotSeq` đổi hoặc `connection.phase !== "live"`: snapshot và replay sau reconnect chỉ cập nhật `prevTasks` và `cursorSeq`. Không so `ts` với đồng hồ máy.
- Một `setTimeout` tới `nextExpiry(state)`, đặt lại mỗi khi state đổi, dọn khi unmount.
- `deskOf` trong action `transitions` lấy từ `deskIndexOf` để biết note bay từ bàn nào.

## F. Kỹ thuật sprite, chiều sâu, z-index

### F1. Sprite bằng CSS

- Phần tử sprite có kích thước `sheet.display`, `background-image` đặt inline từ URL đã import, `background-size: calc(var(--cols) * 100%) calc(var(--rows) * 100%)`, `background-position: 0 var(--row-pos)`. Vì dùng phần trăm, kích thước file độc lập với kích thước hiển thị: script xuất ô **192 px** (sheet 1152x1152 WebP), hiển thị 160 px.
- Một keyframes duy nhất: `to { background-position-x: var(--end-x) }`, chạy với `animation: <name> var(--dur) steps(var(--frames)) var(--iter)`.
- `spriteVars` tính: `--row-pos = row / (rows - 1) * 100%` (0% nếu `rows = 1`), `--end-x = frames / (cols - 1) * 100%`, `--dur = frames / fps`. Ví dụ worker `work`: hàng 1, 6 frame, 8 fps → `20%`, `120%`, `750ms`. `move`: 4 frame → `--end-x: 80%`, `500ms`.
- Animation không lặp (`happy`): `--iter: 3`, `animation-fill-mode: forwards`, phần tử sprite có `key = anim + ":" + animKey` để React mount lại và phát từ frame 0.
- Lật ngang: `scaleX(-1)` đặt trên **phần tử sprite bên trong**, không đặt trên wrapper (wrapper mang `translate`, thẻ tên không được lật).
- `image-rendering: auto` (ảnh là tranh độ phân giải cao bị thu nhỏ, không phải pixel art thật).
- Agent: script cắt 3 frame `idle` sạch của mỗi atlas thành sheet 1 hàng. `processing` = idle + vòng xoay CSS quanh chân + nhún nhanh; `alert` = idle + rung nhẹ + huy hiệu "!" là phần tử DOM có chữ "chờ duyệt"; `off` = idle đứng yên, giảm opacity. Không dùng các frame `processing` / `alert` của atlas (bị cắt mép, dính dấu "!").

### F2. Di chuyển

- Wrapper robot: `position: absolute; left: 0; top: 0; transform: translate(x, y)` với `x = anchor.x - sheet.anchor.x`, tương tự cho y; `z-index: round(anchor.y)`.
- `transition: transform var(--seg-ms) linear, z-index var(--seg-ms) linear`. Hai thuộc tính cùng thời lượng, cùng hàm thời gian nên thứ tự sâu luôn khớp vị trí. Việc cần kiểm ở vòng chụp ảnh đầu tiên của Task 11: nếu trình duyệt không nội suy `z-index`, giữ nguyên thiết kế tuyến và đặt `z-index` của đích ở đầu mỗi đoạn (đoạn nào cũng ngắn theo y vì bám lối đi).
- `useRouteWalker`: khi `target` đổi, lập `planRoute(waypoint đang hướng tới, target)`, đặt waypoint đầu; `transitionend` có `propertyName === "transform"` thì sang waypoint kế; timeout dự phòng `segmentMs + 200`. Đổi đích giữa đường không cần đọc vị trí DOM, CSS tự nối từ vị trí hiện tại.
- Trong lúc `moving`: anim hiển thị là `move`, hướng theo `facingOf`. Tới nơi: dùng `actor.anim`, `actor.facing`.
- Lần mount đầu: `ready = false`, không transition; bật sau frame đầu.
- Thẻ tên và bong bóng nằm ở `LabelLayer` qua `createPortal`, dùng cùng `translate` và cùng transition nên đi theo robot.

### F3. Thang chiều sâu

Trong sân khấu (sân khấu có `isolation: isolate`, mọi z-index dưới đây không lọt ra ngoài):

| Lớp | z-index | Nội dung |
|---|---|---|
| Nền | 0 | Ảnh nền |
| DepthLayer | 1 | Nội thất, bàn, robot. Con trực tiếp có `z-index = round(anchor.y + depthBias)`, khoảng 150–1086. Màn hình phase nằm trong wrapper của bàn. |
| TintOverlay | 2 | Lớp phủ pause / mất kết nối. `pointer-events: none`. |
| LabelLayer | 3 | Thẻ tên (`z = round(y)`), bong bóng (`z = 2000 + round(y)`), biển kanban, chip "+N" |
| FxLayer | 4 | Note bay, biển báo hệ thống |

Thẻ tên ở lớp riêng vì robot đứng sau bàn: nếu thẻ nằm trong robot, bàn sẽ che mất tên.

Cấp trang:

| Thành phần | z-index |
|---|---|
| Cảnh, TopBar, banner | auto |
| FloatingChat (dock và khung) | **40** |
| `Modal`: TaskDetailPanel, ListDrawer, WorkerInfoDialog | 50 (có sẵn) |
| Notice | 60 (có sẵn) |

Office không dùng z-index cấp trang nào khác ngoài 40. `NewSessionDialog` render bên trong khung chat nên thực tế nằm ở mức 40, vẫn phủ kín cảnh và TopBar.

**Hai quy tắc bắt buộc về `position: fixed`:**
1. Sân khấu có `transform: scale(...)`, nên không render `Modal` hay popover nào bên trong sân khấu. Mọi panel do `OfficeView` render, ngoài `SceneViewport`.
2. `FloatingChat` và mọi tổ tiên của nó không được có `transform`, `filter`, `backdrop-filter`, `contain`, `will-change: transform`. Vi phạm thì `NewSessionDialog` bị nhốt trong khung chat.

### F4. Scale và nhãn

`useSceneScale`: `scale = max(0.52, min(w / 1448, h / 1086))`, ghi `--scene-scale` và `--label-scale = clamp(0.85, 1 / scale, 1.9)` lên phần tử sân khấu. Sân khấu 1448x1086 với `transform: scale(var(--scene-scale))`, gốc trên-trái; phần tử bọc có kích thước đã nhân scale. Thẻ tên, bong bóng, biển, chip nhân `scale(var(--label-scale))` nên chữ giữ khoảng 12 px trên màn hình ở mọi cỡ cửa sổ. Không có `ResizeObserver` (jsdom): scale 1.

### F5. Reduced motion

- CSS `@media (prefers-reduced-motion: reduce)`: `animation: none` cho sprite (hiện frame 0 của đúng hàng trạng thái), `transition: none` cho robot, thẻ, lớp phủ; bong bóng không mờ dần.
- JS `usePrefersReducedMotion`: `useRouteWalker` nhảy thẳng tới đích; không sinh `FlyingNote` (số kanban tăng ngay).
- happy / error vẫn giữ đủ thời lượng với frame tĩnh và nhãn chữ "XONG" / "LỖI".

## G. Bố cục ban đầu (ước lượng, hệ 1448x1086)

Đọc từ ảnh nền: góc sau của sàn ở khoảng (725, 160); mép trái sàn x ≈ 50, mép phải x ≈ 1385; lan can trước y ≈ 905 trong đoạn x 400–970. Trục "xuống-phải" có độ dốc ≈ 0,34, trục "xuống-trái" ≈ 0,31. Thảm đỏ là một dải từ (60–215, 405–468) tới (455–560, 275–350). Thảm tím từ (735–815, 228–300) tới (1185–1390, 400–465).

**Bàn (Work Area).** `anchor` của ảnh bàn là giữa cạnh đáy. Robot đứng sau bàn: `slot.anchor = bàn + (34, -30)`; màn hình: `bàn + (-28, -92)`. Ba hàng chạy theo trục xuống-phải, cách nhau khoảng 160 px theo y tại cùng x.

| Hàng (gate) | Bàn: anchor ảnh bàn |
|---|---|
| Sau, gate (650, 372) | Z1 (760, 450) · Z2 (945, 513) · Z3 (1130, 576) |
| Giữa, gate (370, 445) | A1 (480, 520) · A2 (665, 583) · A3 (850, 646) · A4 (1035, 709) |
| Trước, gate (190, 540) | B1 (300, 620) · B2 (485, 683) · B3 (670, 746) |

Thứ tự lấp bàn (`layout.desks`): A2, Z2, B2, A3, A1, Z1, B3, Z3, B1, A4. Năm worker của demo vì thế ngồi cụm giữa thay vì dồn một hàng. Luân phiên 4 kiểu `workstation_*` theo chỉ số.

**Chỗ nghỉ (10 slot).**

| Slot | anchor | gate | Ghi chú |
|---|---|---|---|
| relax-1 (rug) | (140, 452) | (175, 500) | cạnh sofa |
| relax-2 (rug) | (250, 430) | (265, 478) | trước sofa |
| relax-3 (rug) | (330, 408) | (345, 455) | đèn / máy bán nước |
| relax-4 (rug) | (400, 385) | (415, 432) | bình nước |
| relax-5 (rug) | (465, 360) | (480, 410) | arcade |
| relax-6 (rug) | (535, 345) | (545, 395) | đầu thảm |
| relax-7 (plaza) | (585, 312) | (640, 380) | quầy cà phê |
| relax-8 (plaza) | (668, 308) | (640, 380) | |
| relax-9 (plaza) | (625, 348) | (640, 380) | |
| relax-10 (plaza) | (712, 338) | (640, 380) | |

**Pod (4 slot), gate chung (175, 548).** Ảnh `recharge_pod` tại (78, 512), (84, 592), (122, 668), (190, 728); robot đứng tại `pod + (46, 14)`.

**Nội thất.**

| Khu | Món: anchor |
|---|---|
| Relax | `bookshelf_lounge` (105, 398) · `sofa` (210, 402) · `floor_lamp` (290, 350) · `vending_machine` (350, 328) · `water_dispenser` (408, 306) · `arcade_cabinet` (472, 290) · `coffee_station` (628, 262) |
| Planning | `kanban_board` (930, 285), biển số (930, 300), đích của note (930, 215) · `flow_board` (1075, 328) · `planning_table` (1010, 398) · `hologram_table` (1285, 432) · `potted_palm` (790, 262) |
| Work | `server_rack` (1290, 522) và (1335, 560) · tối đa 4 chậu cây ở đầu các hàng bàn, implementer đặt sau khi bàn đã yên vị |

**Agent.** Planner (862, 335), cạnh bảng kanban. Orchestrator (1180, 440), cạnh `hologram_table`.

**Khác.** Biển báo hệ thống treo tại (725, 215). Chip "+N": desk (700, 850), relax (250, 300), pod (60, 720).

**Lối đi.** Trục chính chạy dọc mép dưới thảm đỏ, nối ba gate hàng bàn: (650, 372) → (370, 445) → (190, 540). Mỗi hàng bàn có một lối đi riêng nằm ngay sau hàng (chính là đường nối các chỗ đứng), chạy từ gate của hàng theo trục xuống-phải. Tuyến điển hình Relax → bàn A3: relax-3 → (345, 455) → (370, 445) → (884, 616). Robot không bao giờ cắt ngang một hàng bàn.

Thứ tự tinh chỉnh đề xuất: bàn và gate trước (quyết định tuyến), rồi Relax, rồi Planning. Dùng `?debug=grid`.

## H. Khung chat nổi

- **Dùng lại:** `<PlannerColumn />` và `<OrchestratorColumn />` render nguyên trạng, không prop. Chúng tự lấy state / actions, nên gate Duyệt / Sửa / Hủy, chọn phiên, Phiên mới, Gửi, Ngắt hoạt động y như dashboard.
- **Ghi đè chỉ bằng CSS của office**, dùng selector cấu trúc bắt đầu từ class của khung:
  - `.pane > section { min-height: 0; height: 100%; }` (bỏ `min-height: 28rem`);
  - `.pane > section > div:first-child > h2 { display: none; }` (tiêu đề trùng nhãn tab; chọn con trực tiếp để không ẩn tiêu đề của `NewSessionDialog`);
  - `.pane > section > div:first-child` giảm padding; phần thân `max-height: none` để vô hiệu media query 70vh.
- **Cấu trúc:** `<aside aria-label="Chat với agent">`, `position: fixed; right: 16px; bottom: 16px; z-index: 40`. Khung rộng 420 px, cao `min(620px, 100dvh - 7rem)`. Bên trong: tablist (Planner / Orchestrator, mỗi tab có avatar và huy hiệu) + nút thu gọn + một ô grid chứa cả hai pane chồng lên nhau.
- **Mount / ẩn:** cả hai pane luôn mount. Pane không hoạt động: `visibility: hidden; pointer-events: none`. Thu gọn: cả khung `visibility: hidden`, chỉ còn dock. Không dùng `display: none`, không dùng `transform`.
- **Dock khi thu gọn:** hai `button` avatar 56 px. Huy hiệu có chữ: "!" kèm văn bản ẩn "N bản nháp chờ duyệt" khi `pendingCount > 0`, chấm kèm "đang bận" khi `anim = processing`. `aria-label` đầy đủ, ví dụ "Mở chat Planner, 1 bản nháp chờ duyệt". Dữ liệu lấy từ hai `SceneAgent` đã tính cho cảnh, không tính lại.
- **Focus:** `dock.show(tab, opener)` nhớ phần tử mở. Sau khi hiện, focus vào textarea của pane (nếu không bị disabled), không thì focus tab. `Escape` trong khung (khi không có Modal nào mở; `Modal` đã `stopPropagation`) thì thu gọn và trả focus về `opener`. Khung không phải modal, không bẫy focus.
- **Bấm robot agent:** `onOpenChat(tab, jumpSessionId)`; nếu `jumpSessionId` khác null thì gọi `actions.selectPlannerSession` trước khi mở.
- **Nhớ:** `useChatDock` lưu `"<tab>:<open|closed>"` vào storage. Mặc định mở tab Planner ở lần đầu.
- **Màn hình hẹp (< 720 px):** `left: 0; right: 0; bottom: 0; width: auto; height: 70dvh`, bo góc trên; dock nằm góc dưới phải.
- **Chồng lớp:** `TaskDetailPanel` và `ListDrawer` (50) phủ lên chat (40). `ListDrawer` chỉ render khi `openTaskId === null`: mở task từ danh sách ticket thì list tạm ẩn, đóng task thì list hiện lại. Không bao giờ có hai bẫy focus cùng lúc.

## I. Kịch bản demo

- **Không sửa** `demo/fixtures.ts`, `demo-bridge-service.ts`, `App.tsx`. `createDemoState()` giữ nguyên 5 worker, nên `getByText("IDLE")` / `getByText("OFFLINE")` của test cũ không đổi.
- `useDemoDirector()` gọi trong `OfficeView`; không làm gì khi `useContext(BridgeContext).demo === false`. Mọi thay đổi đi qua `store.dispatch` bằng message cùng dạng server gửi (`worker.updated`, `task.updated`, `bus.event`, `system.status`) và `local/connection`; không có đường ghi state nào khác.
- Tham số `?scenario=` (chỉ có nghĩa khi `demo` và đang ở Office):

| Giá trị | Hành vi |
|---|---|
| (không có) hoặc `live` | Bộ đạo diễn chạy theo nhịp 2,5 s |
| `still` | Fixture gốc, không timer. Dùng để chụp ảnh Checkpoint A |
| `crowd` | Thêm 9 worker (tổng 14) đủ trạng thái và phase; tĩnh |
| `paused` | `dispatch_paused = true`; tĩnh |
| `ratelimit` | `rate_limited_until = now + 5 phút`, thêm 2 worker idle; tĩnh |
| `dead` | `orchestrator = "dead"`; tĩnh |
| `disconnected` | `connection.phase = "reconnecting"`; tĩnh. (Plan gọi là `offline`; đổi tên để khỏi lẫn với worker offline) |
| `fx` | Sau 600 ms phát một `completed` và một `failed`, rồi dừng. Dùng để chụp happy / error / note bay |

```ts
export type ScenarioName = "live" | "still" | "crowd" | "paused" | "ratelimit" | "dead" | "disconnected" | "fx";
export function parseScenario(search: string): ScenarioName;
/** Các action áp một lần để đưa state về biến thể tĩnh. Thuần. */
export function scenarioActions(name: ScenarioName, state: AppState, now: number): Action[];
/** Một nhịp của kịch bản sống: nhìn state hiện tại, trả các action của bước kế. Thuần, tất định theo tick. */
export function directorStep(state: AppState, tick: number, now: number): Action[];
export function useDemoDirector(): void;
```

- **Vòng đời:** biến thể tĩnh áp **một lần cho mỗi store** (đánh dấu bằng `WeakSet<Store>` cấp module), nên chuyển Dashboard ↔ Office không nhân đôi worker. `live` dùng một `setInterval`, dọn khi unmount; mount lại thì chạy tiếp từ state hiện tại vì `directorStep` quyết định theo state, không theo dòng thời gian cố định.
- **Nội dung vòng `live`** (khoảng 16 nhịp ≈ 40 s rồi lặp): task `assigned` của `w-sh-05` chuyển `running`; các task đang chạy nhận `task.progress` có `message` và tiến phase; `w-sh-02` hoàn thành rồi nhận task mới; `w-sh-03` nhận task, chạy, rồi `failed`; `w-sh-04` offline ↔ idle. Mỗi bước tự kiểm điều kiện trên state, không đủ điều kiện thì bỏ qua.
- `seq` của `bus.event` = `state.lastSeq + 1`, cùng cách `DemoBridgeService.pushBusEvent`. `task_id` mới có tiền tố `demo-`.
- Test: `scenarioActions` và `directorStep` test thuần bằng cách chạy qua `reducer`. Test khói `OfficeView` dùng `?scenario=still` (không timer).

## K. Ba chi tiết "bất ngờ"

1. **Màn hình bàn theo phase + giấy note bay lên kanban.**
   `WorkersScene.screens` cấp `DeskScreen` cho `Desk`; lớp phủ màn hình là một phần tử nhỏ đặt tại `DeskSlot.screen`, nội dung bằng gradient CSS theo `data-screen` (đọc ticket, dòng code chạy, thanh test, mũi tên đẩy, dấu tích). Trang trí, `aria-hidden`; phase vẫn có ở 5 chấm và `aria-label`.
   Khi `completed`, reducer thêm `NoteFx`; `FxLayer` vẽ `FlyingNote` từ chỗ đứng ở bàn tới `kanban.noteTarget` (x tuyến tính ở phần tử ngoài, y có đường cong ở phần tử trong). `kanbanCounts` trừ số note đang bay, nên số "CHỜ REVIEW" tăng đúng lúc note hết hạn; `KanbanBoard` nháy một nhịp khi số tăng.
2. **Rate limit → giờ cà phê; `dispatch_paused` → đèn dịu.**
   `useRateLimited` đổi một boolean; `buildWorkersScene` chuyển pool relax sang `compact` với plaza đứng trước, robot idle tự đi ra quầy cà phê bằng cơ chế tuyến có sẵn, nhãn phụ "nghỉ cà phê". Robot đang làm vẫn ở bàn. `SceneSignals` hiện biển "RATE LIMIT · còn mm:ss".
   Pause: `TintOverlay` phủ màu tối xanh, chuyển 800 ms, kèm biển "TẠM DỪNG GIAO VIỆC". Mất kết nối: mọi sprite `animation-play-state: paused`, lớp phủ xám, biển "MẤT KẾT NỐI BACKEND" (cảnh đứng hình vì dữ liệu đang cũ). `StatusBanners` vẫn hiện.
3. **Tủ server là đồng hồ tải.**
   `ServerRackGauge` phủ lên `server_rack` một cột đèn: `total = max_concurrency` (tối đa 8), `lit = running`, từ `rackGauge(status)`. Có `role="img"`, `aria-label` và thẻ chữ "Đang chạy 3 / 3" ở `LabelLayer`.

Không làm: trời đổi theo giờ, robot hút bụi, mức nước theo `seat_usage`.

## J. File ngoài `components/office/` bị sửa

| File | Sửa gì |
|---|---|
| `packages/web/src/components/AppShell.tsx` | Import `lazy`, `Suspense`, `useViewMode`, `ViewSwitchButton`. Tạo `viewSwitch = <ViewSwitchButton mode onChange />`. Khi `showDashboard`: `office` → `<Suspense fallback>` bọc `<OfficeView onOpenConnection viewSwitch />`; ngược lại `<Dashboard onOpenConnection topBarExtra={viewSwitch} />`. `ConnectScreen` và `NoticeArea` giữ nguyên. Khoảng 12 dòng. |
| `packages/web/src/components/Dashboard.tsx` | Thêm prop tùy chọn `topBarExtra?: ReactNode`, chuyển cho `TopBar`. 3 dòng. |
| `packages/web/src/components/topbar/TopBar.tsx` | Thêm prop tùy chọn `extraActions?: ReactNode`, render làm phần tử đầu trong `div.actions`. 3 dòng. Không sửa `topbar.module.css`. |
| `brainstorm/newUI/tools/build_office_assets.py` (mới, ngoài `packages/web`) | Xuất WebP vào `packages/web/src/components/office/assets/`, in bảng dung lượng. |

Không sửa: `config.ts` (khóa storage nằm ở `office/constants.ts`), `App.tsx`, `hooks/bridge-context.ts`, `state/*`, `services/*`, `demo/*`, `PlannerColumn.tsx`, `OrchestratorColumn.tsx`, `column.module.css`, `vite.config.ts`, `vitest.config.ts`, mọi file test cũ, `packages/protocol`.

Nút chuyển view: nhãn "Văn phòng" / "Dashboard", `aria-label` "Chuyển sang chế độ Văn phòng" / "Chuyển sang Dashboard". Các truy vấn của `App.test.tsx` không khớp nhãn này.

## L. Hiệu năng

- Đường nóng duy nhất là chat stream; nó không chạm cảnh (mục E1). Cần xác nhận bằng React Profiler một lần ở Task 8.
- Khoảng 45 phần tử định vị tuyệt đối, tối đa 12 animation `steps()` trên `background-position` và vài transition `transform`. Không đặt `will-change` thường trực; chỉ robot đang đi mới có.
- Ngân sách asset: nền WebP ≈ 0,35 MB; 5 sheet worker 1152x1152 ≈ 1,0–1,3 MB; khoảng 20 món nội thất ≈ 0,4 MB; 2 sheet agent + 2 avatar ≈ 0,1 MB. Tổng dưới 2,5 MB (ước lượng, script phải in số thật).
- Tải trước: `OfficeScene` tạo `Image()` cho nền và các skin đang có mặt; sân khấu có màu nền trơn trong lúc chờ.

## M. Điểm mở rộng và phần hoãn

- Thêm bàn, chỗ nghỉ, món nội thất: chỉ sửa `layout.ts`. Thêm skin: tăng `SKIN_COUNT` và thêm sheet (lưu ý sẽ đổi skin của mọi worker).
- Thêm biến thể demo: một nhánh trong `scenarioActions`.
- Hoãn: nhớ bàn theo máy, kéo thả bàn, tránh va chạm giữa các robot đang đi, âm thanh, tư thế ngồi, bố cục dọc riêng cho điện thoại. Chưa có yêu cầu nào cần đến.

## N. Rủi ro còn lại cho implementer

| Rủi ro | Cách xử lý |
|---|---|
| Tọa độ mục G lệch so với ảnh thật | Vòng chụp ảnh của Task 3; chỉ sửa `layout.ts` |
| Trình duyệt không nội suy `z-index` trong transition | Phương án dự phòng ở F2, không đổi model |
| Selector cấu trúc của khung chat gãy khi ai đó đổi markup của cột | Test khói kiểm `h2` của cột nằm đúng vị trí `section > div:first-child > h2` |
| 10 robot idle đứng sát nhau trên thảm đỏ hẹp | Chấp nhận chồng khoảng 25%; nếu xấu thì giãn slot rug sang plaza trong `layout.ts` |
| Robot đứng sau bàn bị màn hình che mặt | Chỉnh offset `(34, -30)` theo từng kiểu `workstation_*`; cho phép offset riêng trong `DeskSlot` |
