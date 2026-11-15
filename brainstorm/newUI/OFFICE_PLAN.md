# Kế hoạch: chế độ xem "Virtual Office" cho `packages/web` (output của task-planner)

## Summary
Thêm view thứ hai (văn phòng isometric, DOM/CSS) song song dashboard 3 cột, code gọn trong `packages/web/src/components/office/`, bật bằng nút trên TopBar. 15 task, 4 checkpoint theo lát cắt dọc. Planner chỉ đọc code và asset, chưa chạy thử; mọi con số dung lượng là ước lượng.

## Assumptions
- View mặc định vẫn là dashboard, vì `App.test.tsx` render `<App demo />` và kỳ vọng đủ 3 cột.
- Được sửa tối thiểu ngoài `office/`: `AppShell.tsx`, `TopBar.tsx` (+ css), `config.ts`, `demo/*`, `App.tsx`. Không đụng `reducer.ts`, `types.ts`, `selectors.ts`, protocol.
- Trạng thái tạm của cảnh (bong bóng, happy/error, đang di chuyển) sống trong hook cục bộ của office, không đưa vào `AppState`.
- Không commit, không push (theo brief).

## 1. Tasks

**Task 1: Pipeline asset**
- What: script Pillow xuất nền sang WebP, 5 sheet worker thu ô 256 → 160–192 px (WebP có alpha), chép đồ nội thất được dùng, 2 atlas agent và 2 avatar.
- Affects: tạo `brainstorm/newUI/tools/build_office_assets.py`, `packages/web/public/office/**` (thư mục `public/` chưa tồn tại).
- Done when: chạy `uv run --with pillow python ...` ra đủ file; tổng `public/office` < 3 MB; script in bảng dung lượng; điểm neo `[128,234]` được quy đổi đúng theo tỉ lệ ô mới và ghi vào một file hằng số.
- Depends on: none. Effort: S

**Task 2: Khung chuyển view**
- What: thêm `STORAGE_KEYS.viewMode`; `AppShell` chọn `Dashboard` hoặc `OfficeView` (nạp bằng `React.lazy`); nút chuyển trên `TopBar` qua prop tùy chọn; tham số URL `?view=office` ghi đè storage (Chrome headless có localStorage rỗng nên bắt buộc phải có).
- Affects: `config.ts`, `components/AppShell.tsx`, `topbar/TopBar.tsx`, `topbar.module.css`; tạo `office/OfficeView.tsx`, `office/office.module.css`.
- Done when: `?demo=1&view=office` hiện TopBar + `StatusBanners` + khung rỗng; nút chuyển qua lại và nhớ sau refresh; ở dashboard không tải file `office/*`; test cũ qua nguyên trạng.
- Depends on: none. Effort: S

**Task 3: Cảnh tĩnh và hệ tọa độ**
- What: sân khấu 1448x1086 scale theo `ResizeObserver` (giữ 4:3); ảnh nền; bảng layout (bàn, sofa, máy bán nước, arcade, quầy cà phê, kanban, bàn họp, hologram table, recharge pod, cây) kèm tọa độ neo; `z-index` theo y.
- Affects: tạo `office/scene/OfficeScene.tsx`, `office/model/layout.ts`, `office/model/assets.ts` (URL qua `import.meta.env.BASE_URL`), `office/hooks/useSceneScale.ts`.
- Done when: ảnh chụp headless 1600x1000 và 1100x700 không có món nào lơ lửng, đè sai chiều sâu hay tràn khỏi sàn; có 10 bàn, ít nhất 6 chỗ nghỉ, ít nhất 3 pod.
- Depends on: 1, 2. Effort: M (chủ yếu là vòng lặp chụp và chỉnh tọa độ)

**Task 4: Mô hình thuần và unit test**
- What: `skinOf(worker_id)` bằng FNV-1a % 5; gán bàn, chỗ nghỉ, pod; `deriveWorkerScene(worker, task, effect)` trả `{zone, slot, anim, label, phase, bubble}`; `deriveAgentScene` cho planner và orchestrator.
- Affects: tạo `office/model/skin.ts`, `assign.ts`, `scene-state.ts` và các file `*.test.ts` cạnh chúng (vitest include `src/**/*.test.*`).
- Done when: test phủ skin ổn định và phân bố trên 1000 id, gán slot không trùng và có tràn, đủ mọi dòng của bảng ánh xạ, thêm ca lệch pha (worker `idle` nhưng task chưa terminal, worker `busy` nhưng thiếu task).
- Depends on: none (song song với 1–3). Effort: M

**Task 5: Robot worker theo trạng thái (chưa có chuyển động)**
- What: `WorkerRobot` (memo) là `button` có `aria-label`, sprite `steps()`, tên + nhãn chữ + 5 chấm phase. Bấm robot có task gọi `actions.openTask`; không có task thì mở thẻ nhỏ chứa `WorkerCard`. `OfficeView` tự mount `TaskDetailPanel` (hiện chỉ `Dashboard.tsx` mount).
- Affects: tạo `office/scene/WorkerRobot.tsx`, `office/scene/WorkerInfoPopover.tsx`; sửa `OfficeView.tsx`.
- Done when: demo hiện 5 worker đúng khu và animation; bấm `w-sh-01` mở drawer SH-129; bấm `w-sh-03` hiện thẻ IDLE; nhãn đọc được ở 1100x700.
- Depends on: 3, 4. Effort: M

**Checkpoint A: cảnh tĩnh + robot đúng trạng thái ở demo, có ảnh chụp.**

**Task 6: Fixture và kịch bản demo**: xem mục 4. Depends on: 4. Effort: M

**Task 7: Robot planner và orchestrator**
- What: `AgentRobot` dùng bảng frame tự khai (không đọc manifest lúc chạy), dấu "!" là phần tử DOM có nhãn "chờ duyệt"; bấm thì mở khung chat đúng tab.
- Affects: tạo `office/scene/AgentRobot.tsx`, `office/model/sprites.ts`.
- Done when: demo cho planner ở trạng thái alert (đang có `perm-1`); duyệt xong về idle; gửi tin thì processing khoảng 700 ms; orchestrator `dead` thì alert kèm nhãn chữ.
- Depends on: 3, 4. Effort: S

**Task 8: Khung chat nổi**
- What: `FloatingChat` có 2 tab, thu gọn thành 2 avatar kèm huy hiệu bận / chờ duyệt, nhớ tab và trạng thái thu gọn qua `lib/storage`.
- Affects: tạo `office/chat/FloatingChat.tsx` + css; có thể thêm prop tùy chọn cho `PlannerColumn` / `OrchestratorColumn` (xem mục 2).
- Done when: trong khung nổi làm được trọn Duyệt / Sửa / Hủy, chọn phiên, Phiên mới, gửi và Ngắt; `NewSessionDialog` nổi trên khung; form sửa không tràn ngang ở bề rộng 420 px; nháp đang gõ không mất khi đổi tab.
- Depends on: 2. Effort: M

**Task 9: Kanban, danh sách ticket, tràn worker**
- What: bảng kanban hiện 4 số từ `groupTickets`; bấm mở drawer chứa `TicketsTab`; chip "+N" mở drawer chứa `WorkersTab`.
- Affects: tạo `office/scene/KanbanBoard.tsx`, `office/panels/ListDrawer.tsx`.
- Done when: số trên bảng khớp tab Tickets của dashboard; mở task từ drawer ticket không kẹt focus; kịch bản 14 worker hiện đủ qua chip.
- Depends on: 3, 6. Effort: S

**Checkpoint B: dùng được trọn luồng planner / orchestrator trong Office.**

**Task 10: Bộ theo dõi hiệu ứng tạm**
- What: hook so sánh `tasks` trước/sau và đọc `events` theo con trỏ `seq`, sinh hiệu ứng có hạn: bong bóng progress (~6 s), happy một lượt, error ~4 s kèm `fail_category`; giữ robot ở bàn cho tới khi hiệu ứng hết.
- Affects: tạo `office/hooks/useOfficeEffects.ts`, `office/model/effects.ts` (reducer thuần + test), `office/scene/SpeechBubble.tsx`.
- Done when: test reducer phủ completed, failed, cancelled, progress trùng `seq`, và loạt replay cũ không sinh hiệu ứng; kịch bản demo cho thấy happy rồi về Relax, error kèm bong bóng rồi về Relax.
- Depends on: 5, 6. Effort: M

**Task 11: Hoạt ảnh chuyển khu**
- What: transition `transform` khi đích đổi, dùng animation `move` trong lúc trượt, `scaleX(-1)` theo hướng đi; kết thúc bằng `transitionend` kèm timeout dự phòng; lần mount đầu không trượt.
- Affects: `WorkerRobot.tsx`, `office.module.css`.
- Done when: trong kịch bản demo, robot đi Relax → bàn → Relax không xuyên bàn sai chiều sâu ở các tuyến đã định; không robot nào kẹt ở `move` sau khi tới nơi.
- Depends on: 10. Effort: M

**Task 12: Trạng thái hệ thống trong cảnh**
- What: biển báo / đèn có nhãn chữ cho `dispatch_paused`, rate limit (`isRateLimited`), mất kết nối (`connection.phase === "reconnecting"`).
- Affects: tạo `office/scene/SceneSignals.tsx`.
- Done when: `?scenario=paused`, `ratelimit`, `offline` mỗi cái có ảnh chụp khác rõ và có chữ; `StatusBanners` vẫn hiện.
- Depends on: 3, 6. Effort: S

**Task 13: Reduced motion và a11y**
- What: dưới `prefers-reduced-motion` tắt keyframes và transition, hiện frame tĩnh đúng hàng trạng thái, bong bóng không mờ dần; kiểm thứ tự tab và focus ring.
- Done when: giả lập reduced motion thì không còn chuyển động, mọi trạng thái vẫn có nhãn chữ; đi hết robot → kanban → chat bằng bàn phím.
- Depends on: 11, 12. Effort: S

**Checkpoint C: đủ bảng ánh xạ và tương tác của brief.**

**Task 14: 2–3 chi tiết bất ngờ** (mục 6). Depends on: 10–12. Effort: M

**Task 15: Chốt**
- What: test khói `OfficeView` (mock `ResizeObserver`, chờ lazy bằng `findBy`), chạy `pnpm typecheck` và `pnpm --filter @claude-bridge/web test`, đo dung lượng, bộ ảnh chụp cuối, thêm đoạn README.
- Done when: hai lệnh qua; test cũ không sửa dòng nào; có ảnh cho mặc định, crowd, paused, ratelimit, chat mở; không commit.
- Depends on: tất cả. Effort: S

## 2. Dùng lại và tách nhỏ

Dùng nguyên trạng:
- `TopBar` (chỉ thêm prop tùy chọn), `StatusBanners`, `TaskDetailPanel`, `Modal` (variant drawer), `PhaseBar` compact, `NoticeArea`.
- `WorkerCard`, `WorkersTab`, `TicketsTab` (tự lấy state qua hook, không phụ thuộc `LogColumn`).
- `ChatStream`, `ChatInput`, `PermissionCard`, `NewSessionDialog`.
- Selector: `sortedWorkers`, `lastEndedAt`, `groupTickets`, `orchestratorSession`, `plannerSessions`, `sessionStream`, `isRateLimited`.
- Nhãn `WORKER_STATE_LABEL`, `TASK_STATE_LABEL`, `ORCHESTRATOR_LABEL` trong `state/event-format.ts`.

`PlannerColumn` / `OrchestratorColumn` đặt vào khung nổi được, nhưng vướng:
- **Chiều cao tối thiểu**: `column.module.css` có `.column { min-height: 28rem }`, khung nổi thấp hơn 448 px sẽ tràn. Ghi đè từ css của office bằng selector con (`.chatBody > section { min-height: 0; height: 100% }`), không cần sửa file cũ.
- **Media query theo viewport**: `@media (max-width: 1099px) .body { max-height: 70vh }` không biết gì về khung nổi; vô hại nếu khung có chiều cao cố định, nhưng cần kiểm ở cửa sổ hẹp.
- **Tiêu đề lặp**: `<h2>Planner</h2>` trong header trùng với nhãn tab; header còn `flex-wrap` nên ở 420 px sẽ xuống 2 dòng.
- **Lớp chồng**: `Modal` dùng z-index 50, Notice 60; khung nổi phải thấp hơn 50 để `NewSessionDialog` và `TaskDetailPanel` nổi lên trên.
- **Nháp bị mất**: `ChatInput` giữ nháp bằng `useState`; unmount tab không hoạt động là mất chữ đang gõ. Nên mount cả hai và ẩn bằng `hidden`.

Hai hướng cho kiến trúc sư chọn:
- (a) Bọc nguyên cột, ghi đè CSS, thêm prop tùy chọn `hideTitle`. Rẻ nhất, không đổi hành vi dashboard.
- (b) Tách phần ruột thành hook `usePlannerChat()` cho cả cột và khung nổi. Sạch hơn nhưng sửa file cũ nhiều hơn.

## 3. Dữ liệu còn thiếu và cách suy ra (không đổi protocol)

| Dòng | Có sẵn | Thiếu / bẫy | Cách suy |
|---|---|---|---|
| idle → Relax | `Worker.state` | Chỗ nghỉ cố định | Chỉ số trong `sortedWorkers`, tràn thì "+N" |
| busy + running | `current_task_id` → `tasks` | `worker.updated` và `task.updated` tới lệch nhau | Lấy task làm gốc: `current_task_id`, không có thì quét task chưa terminal theo `worker_id` |
| assigned | `Task.state` | assigned có thể kéo dài, robot không thể "đi" mãi | Đi tới bàn rồi đứng `idle` với nhãn "chờ runner khởi động" |
| phase | `Task.phase` (reducer đã cập nhật từ `task.progress`) | `null` khi chưa báo | 0 chấm sáng |
| bong bóng progress | `state.events` (`task.progress`, `payload.message`) | `ws/hub.ts` chỉ replay khi có `since_seq`, nên sau refresh `events` rỗng; không có "thời điểm nhận"; mảng tới 2000 phần tử | Hook đọc theo con trỏ `seq`, đóng dấu thời gian lúc nhận, bỏ event có `ts` cũ hơn ~60 s; sau refresh không có bong bóng cho tới progress kế tiếp |
| vừa completed | `Task.state`, `ended_at` | Không có khái niệm "vừa"; so `ended_at` với đồng hồ máy dễ lệch | So sánh `tasks` trước/sau trong lúc view đang mount; lần mount đầu không ăn mừng |
| vừa failed | `fail_category`, `fail_reason` | Như trên; `cancelled` không có trong bảng | Cùng cơ chế; cancelled về Relax, không chạy `error` |
| offline | `Worker.state`, `last_heartbeat` | Số pod hữu hạn | Slot pod + tràn |
| chuyển khu | không có | Vị trí trước đó và cờ "đang đi" | State cục bộ của `WorkerRobot` |
| planner | `plannerSessionId`, `sessions[].busy`, `permissions` | Nhiều phiên planner, một robot | Bận theo phiên đang chọn; alert nếu có permission ở bất kỳ phiên không phải orchestrator (giống `pendingElsewhere`) |
| orchestrator | `orchestratorSession().busy`, `status.orchestrator` | `restarting` / `stopped` chưa có trong bảng | `dead` → alert; `restarting` → processing + nhãn; `stopped` → idle mờ + nhãn |
| kanban | `groupTickets` | không | `useMemo` theo `tickets`, `tasks` |
| paused / rate limit / mất kết nối | `status.dispatch_paused`, `isRateLimited`, `connection.phase` | Rate limit cần `now` chạy | `useNow` 1 s chỉ khi đang bị giới hạn |

Về hiệu năng: `useBridgeState()` render lại toàn cây mỗi lần store đổi, kể cả khi chat đang stream. Reducer giữ nguyên tham chiếu các nhánh không đổi, nên mô hình cảnh `useMemo` theo `workers`, `tasks`, `status` và robot `memo` với props nguyên thủy là đủ.

## 4. Asset và fixture demo

**Asset**
- Nền 1448x1086 xuất WebP q≈82, ước ~300–400 KB.
- Sheet worker: thu ô xuống 160–192 px (robot chỉ chiếm khoảng 165x205 trong ô 256; bàn trong cảnh ~160x120), ước ~150–250 KB mỗi skin.
- Đồ nội thất: chỉ chép khoảng 20 món được dùng, không dùng `furniture_atlas.png` (790 KB), ước ~0,5 MB.
- Agent: 2 atlas + 2 avatar ~190 KB. Tổng ước ~2–2,5 MB.
- Nạp lười: `OfficeView` qua `React.lazy`; ảnh chỉ được tham chiếu trong cây office; preload nền và các skin đang có mặt, hiện nền màu trơn trong lúc chờ.
- URL đặt qua inline style hoặc biến CSS từ TS, vì `base: "./"` làm `url(/office/...)` trong CSS module hỏng khi deploy ở sub-path.
- File trong `public/` không có hash, nên thêm `?v=` hằng số để tránh cache cũ.
- Atlas planner: manifest khai 5 frame `processing` nhưng ảnh có 6, vài frame bị cắt mép hoặc dính dấu "!". Chọn tay 3–4 frame sạch. `thinking`, `happy`, `alert` chỉ có 1 frame, thêm nhún bằng CSS.

**Fixture (Task 6)**
- Bẫy: `App.test.tsx` dùng `getByText("IDLE")` và `getByText("OFFLINE")` (khớp đúng một). Thêm worker idle hoặc offline vào `createDemoState()` sẽ làm hỏng test cũ; chỉ thêm worker BUSY là an toàn.
- Giữ `createDemoState()` gần nguyên; tùy chọn thêm 2–3 worker busy ở phase `understanding`, `pushing`, `mr_created`.
- Tạo `demo/office-scenario.ts`:
  - Biến thể tĩnh qua `?scenario=crowd|paused|ratelimit|dead|offline`, dùng để chụp ảnh.
  - Bộ "đạo diễn" theo timer phát `task.updated`, `worker.updated`, `bus.event`: assigned → running → progress → completed, một task failed, một worker offline rồi quay lại.
  - Chỉ chạy khi demo và đang ở view office; dọn timer khi unmount; không chạy trong test cũ.
- Done when: mỗi trạng thái brief liệt kê (idle, busy nhiều phase, assigned, failed, offline, permission chờ) có ảnh chụp tương ứng; `App.test.tsx` không sửa dòng nào.

## 5. Rủi ro và câu hỏi cho kiến trúc sư

| Rủi ro | Impact | Mitigation |
|---|---|---|
| Chỉnh tọa độ bằng mắt tốn nhiều vòng lặp | Med | Bảng layout tách riêng; thêm `?debug=grid` vẽ điểm neo |
| Nhãn scale theo cảnh, không đọc được ở cửa sổ nhỏ | High | Nhãn co ngược theo `--scene-scale`; chụp ở 1100x700 |
| Robot trượt thẳng xuyên qua bàn sai chiều sâu | Med | Tuyến 2 đoạn qua lối đi, hoặc đổi z-index giữa đường |
| Sau refresh không có bong bóng, không ăn mừng | Low | Ghi rõ là hành vi chấp nhận; không dựa vào đồng hồ máy |
| Fixture mới làm hỏng test cũ | High | Kịch bản riêng; chỉ thêm worker BUSY vào fixture gốc |
| Re-render cả cảnh khi chat stream | Med | `useMemo` + `memo`, đo bằng React Profiler |
| Hai drawer chồng nhau (ticket → task), bẫy focus kép | Med | Đóng drawer ticket trước khi mở task |
| Kịch bản demo để rò timer | Med | Dọn khi unmount; không khởi động trong test |
| jsdom thiếu `ResizeObserver`, lazy bất đồng bộ | Low | Guard / mock; `findBy` |
| Vượt ngân sách 3 MB | Low | Script in tổng; giảm ô sheet hoặc chất lượng |

Câu hỏi cần quyết:
1. Điểm chuyển view đặt ở `AppShell` hay trong `Dashboard`? Ai giữ state view, và `?view=` có ghi vào storage không?
2. Asset để ở `public/office` như brief (URL tay, không hash), hay trong `components/office/assets` rồi import (có hash, xóa một thư mục là sạch)?
3. Khung chat: hướng (a) bọc cột + ghi đè CSS, hay (b) tách hook? Mount cả hai tab hay một? Khi thu gọn có giữ mount không?
4. Hiệu ứng tạm: một hook + reducer cục bộ ở `OfficeView` như đề xuất, hay cách khác? Thời lượng happy, error, bong bóng là bao nhiêu?
5. Bàn "cố định theo worker": theo chỉ số sắp xếp `worker_id` (dịch chỗ khi thêm worker), hay nhớ thứ tự gặp lần đầu trong localStorage (ổn định trên một máy, khác nhau giữa các máy)?
6. Task `assigned` lâu: đứng chờ ở bàn, hay cách khác? Task `cancelled` thể hiện ra sao?
7. Tuyến di chuyển: đường thẳng hay qua điểm trung gian? z-index trong lúc đi tính thế nào?
8. Robot planner đại diện phiên đang chọn hay gộp mọi phiên? Bấm robot đang alert có tự chuyển sang phiên có permission không?
9. Bộ đạo diễn demo lấy `store` bằng cách nào? Hook hiện chỉ lộ state và actions; thêm `useBridgeStore`, hay khởi động từ `App.tsx`?
10. Màn hình hẹp (< 900 px): hỗ trợ Office với chat dạng bottom sheet, hay báo "dùng dashboard"?
11. Kỹ thuật sprite: một keyframes theo số frame (6 và 4) + biến CSS cho hàng, `background-size` theo phần trăm? `happy` (không loop) phát lại bằng cách đổi `key`?

## 6. Chi tiết "bất ngờ" khả thi nhất

1. **Màn hình bàn theo phase + giấy note bay lên kanban khi completed** (M, ~0,5 ngày). Dùng `Task.phase` và chuyển tiếp completed của Task 10; số ở cột "CHỜ REVIEW" tăng đúng lúc note chạm bảng. Dữ liệu thật hoàn toàn, nối robot với kanban.
2. **Rate limit → giờ cà phê, `dispatch_paused` → đèn dịu** (S–M, ~0,5 ngày). Robot idle kéo ra `coffee_station`, biển đếm ngược tới `rate_limited_until`; robot đang làm vẫn ở bàn. Paused là một lớp phủ CSS + biển "Tạm dừng giao việc". Cả hai nằm sẵn trong Task 12, chỉ thêm phần di chuyển.
3. **Đồ vật là đồng hồ đo** (S, ~2–3 giờ). Đèn `server_rack` sáng theo `running / max_concurrency`; mức nước `water_dispenser` theo `seat_usage.utilization`. Có nhãn chữ khi hover / focus.

Dự phòng: trời đổi theo giờ máy (S–M) cần mặt nạ polygon vùng cửa kính vì ảnh nền là một lớp phẳng. Robot hút bụi (S) chỉ là trang trí, làm sau cùng nếu còn thời gian.

## Execution order
1. Task 1, 2, 4 song song.
2. Task 3 → 5. **Checkpoint A** (ảnh chụp cảnh tĩnh + robot).
3. Task 6, 7, 8 song song (file khác nhau) → 9. **Checkpoint B**.
4. Task 10 → 11; Task 12 song song với 10. Task 13. **Checkpoint C**.
5. Task 14 → 15. **Checkpoint D**: chủ dự án xem, không commit.

Ghi chú: `packages/backend/src/ws/hub.ts` dòng ~323 chỉ replay bus event khi client gửi `since_seq`.
