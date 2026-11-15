# Brief: chế độ xem "Virtual Office" cho claude-bridge web

## Mục tiêu

Thêm một **chế độ xem thứ hai** cho `packages/web`: văn phòng isometric pixel art, nơi mỗi worker là một robot.
Dashboard 3 cột hiện tại giữ nguyên, người dùng chuyển qua lại bằng một nút trên top bar (nhớ lựa chọn bằng
`lib/storage`). Mục đích là thử xem cách nhìn này có hiệu quả không, nên phải dễ gỡ: code nằm gọn trong một thư mục
(`components/office/`), không sửa hành vi của dashboard cũ.

Chủ dự án cho quyền chủ động về thiết kế và muốn được bất ngờ. Ưu tiên: cảnh sống động, đọc trạng thái trong 1 giây,
chi tiết vui nhưng làm đến nơi. Ít tính năng mà chỉn chu hơn nhiều tính năng dở dang.

## Ràng buộc cứng

- **Chỉ sửa `packages/web`** (và thêm asset). Không đổi protocol, backend, runner. Mọi thứ trong cảnh suy ra từ
  `AppState` đã có (`state/types.ts`, `state/selectors.ts`).
- Không thêm thư viện render (không Pixi, Phaser, canvas engine). DOM + CSS: ảnh nền, sprite đặt tuyệt đối, animation
  bằng `steps()` hoặc đổi `background-position`. Khoảng 10 robot là đủ nhẹ.
- Chạy được ở `?demo=1` (xem `demo/fixtures.ts`, `services/demo-bridge-service.ts`) để kiểm tra không cần backend.
- Skin worker **ổn định**: `skin = hash(worker_id) % 5` (hàm băm thuần, ví dụ FNV-1a). Cùng `worker_id` luôn ra cùng
  skin, qua refresh và qua máy khác. Không phụ thuộc thứ tự hay số lượng worker.
- Giữ quy ước của repo: TypeScript strict, CSS module, comment và chuỗi UI bằng tiếng Việt, `memo` cho item lặp,
  mọi trạng thái có nhãn chữ (không chỉ dựa vào màu / hình), link ngoài đi qua `safeHref`.
- `prefers-reduced-motion`: tắt animation và chuyển động, vẫn hiện đúng trạng thái.
- Không commit, không push. Chủ dự án tự xem rồi quyết định.

## Asset (đã có, nằm trong `brainstorm/newUI/sprites/`, thư mục này chưa được git theo dõi)

| Asset | Đường dẫn | Ghi chú |
|---|---|---|
| Nền văn phòng trống | `Empty Isometric Sky-Office Interior.png` | 1448x1086 RGB. Đã vẽ sẵn 3 khu: thảm đỏ trên-trái (Relax), thảm tím trên-phải (Planning), viền vàng ở giữa và dưới (Work Area) |
| Robot worker, 5 skin, có animation | `robot_workers_animated/workerN_sheet.png` + `manifest.json` | Ô 256x256, 6 hàng: `idle`, `work`, `move`, `error`, `sleep`, `happy`. Điểm neo chạm đất `[128, 234]` trong mỗi ô. fps và số frame trong manifest. Xem chạy thử: `preview.html` |
| Planner (robot trắng bay) | `office_isometric_sprite_pack/agents/planner_animation_atlas.png` + `planner_animation_manifest.json`, `planner_avatar.png` | Ô 128x116. State: idle, talk, thinking, happy, alert, processing. Độ phân giải thấp, hiển thị nhỏ. Một số frame `processing` bị cắt mép, kiểm tra trước khi dùng |
| Orchestrator | `.../agents/orchestrator_animation_atlas.png` + manifest, `orchestrator_avatar.png` | Như trên |
| Đồ nội thất, 42 món | `office_isometric_sprite_pack/furniture/*.png` + `manifest.json` (có `zone` gợi ý cho từng món) | Bàn làm việc 4 kiểu (~160x120 px, cùng tỉ lệ với ảnh nền), ghế, sofa, máy bán nước, quầy cà phê, máy arcade, bảng kanban, flow board, bàn họp, hologram table, server rack, recharge pod, robot hút bụi, cây cảnh... |
| Ảnh concept | `brainstorm/newUI/virtual-office.png` | Hình dung tổng thể. Không phải spec |

Sheet worker sinh bằng `brainstorm/newUI/tools/gen_worker_sheets.py` (`uv run --with pillow python ...`). Có thể sửa
script để thêm / chỉnh animation hoặc đổi kích thước ô.

Việc cần làm với asset: chép những gì dùng vào `packages/web/public/office/`, **giảm dung lượng** (mỗi sheet worker
đang ~1.1 MB PNG, nền 2.5 MB; nên xuất WebP hoặc giảm kích thước ô, mục tiêu cả bộ dưới ~3 MB), và chỉ nạp khi vào
chế độ Office.

Lưu ý về hướng nhìn: robot worker chỉ có một hướng (mặt quay về phía người xem, hơi lệch phải), không có tư thế ngồi.
Trong ảnh concept robot đứng **sau hoặc cạnh bàn**, bàn che phần bánh xích, trông như đang ngồi làm. Có thể lật ngang
sprite (`scaleX(-1)`) khi cần quay sang trái. Sắp theo chiều sâu bằng `z-index` theo tọa độ y của điểm neo.

## Ánh xạ dữ liệu → cảnh

| Dữ liệu | Thể hiện |
|---|---|
| `Worker.state = idle` | Robot ở khu Relax (sofa, máy bán nước, arcade...), animation `idle` |
| `Worker.state = busy`, task `running` | Robot ở bàn của nó trong Work Area, animation `work`. Bàn cố định theo worker |
| Task `assigned` (chờ runner) | Robot đang đi tới bàn, animation `move` |
| `Task.phase` (5 phase) | Thanh 5 chấm nhỏ dưới tên, hoặc icon trên màn hình bàn |
| `task.progress` (payload.message) | Bong bóng thoại trên đầu robot, tự mờ sau vài giây |
| Task vừa `completed` | `happy` một lượt, rồi về Relax |
| Task vừa `failed` | `error` vài giây + bong bóng ghi `fail_category`, rồi về Relax |
| `Worker.state = offline` | `sleep`, ở recharge pod hoặc góc riêng |
| Chuyển khu | Trượt vị trí bằng CSS transition, trong lúc trượt dùng animation `move` |
| Phiên planner | Robot planner ở khu Planning. `busy` → processing, có permission chờ duyệt → alert + dấu "!", còn lại idle |
| Orchestrator | Robot orchestrator ở vị trí điều phối (hologram table / dashboard). `busy` → processing, health `dead` → alert |
| Nhóm ticket (`selectors.ts`) | Bảng kanban ở khu Planning hiện số ticket từng cột; bấm mở danh sách ticket (dùng lại `TicketsTab`) |
| `dispatch_paused`, rate limit, mất kết nối | Thể hiện trong cảnh (đèn cảnh báo, biển báo...) và vẫn giữ `StatusBanners` |

## Tương tác

- Bấm robot worker đang có task → `TaskDetailPanel` có sẵn (`local/open-task`). Không có task → thẻ thông tin nhỏ
  (dùng lại nội dung `WorkerCard`).
- **Khung chat nổi** góc dưới phải, 2 tab Planner / Orchestrator, thu gọn được, dùng lại `PlannerColumn` /
  `OrchestratorColumn` (hoặc phần ruột của chúng: `ChatStream`, `ChatInput`, `PermissionCard`, chọn phiên, phiên mới).
  Gate duyệt ticket (Duyệt / Sửa / Hủy) phải dùng được đầy đủ trong khung này. Khi thu gọn: 2 avatar, có huy hiệu
  khi agent đang bận hoặc có permission chờ.
- Bấm robot planner / orchestrator → mở khung chat ở tab tương ứng.
- Tên worker (`worker_id`) và nhãn trạng thái luôn đọc được dưới mỗi robot. Mỗi robot là `button` có `aria-label`.
- Cảnh co giãn theo cửa sổ, giữ tỉ lệ 4:3 của ảnh nền; mọi tọa độ tính theo hệ 1448x1086 rồi scale.
- Nhiều worker hơn số bàn / chỗ nghỉ đã định: vẫn phải hiện đủ (thêm hàng, hoặc chip "+N" mở danh sách).

## Phần "bất ngờ" (chọn 2-3 thứ, làm kỹ)

Gợi ý, không bắt buộc: robot hút bụi chạy quanh sàn; màn hình trên bàn đổi theo phase; trời ngoài cửa sổ đổi theo giờ
máy (lớp phủ màu); khi `dispatch_paused` đèn văn phòng dịu xuống; khi bị rate limit robot rủ nhau ra quầy cà phê;
task hoàn thành thì có giấy note bay lên bảng kanban. Tự do đề xuất cái khác hợp với dữ liệu thật.

## Kiểm tra

- Unit test (vitest) cho phần thuần: hàm băm skin (ổn định, phân bố), gán bàn / chỗ nghỉ, suy trạng thái cảnh của
  worker từ `AppState`. Test component ở mức khói. `pnpm typecheck` và `pnpm --filter @claude-bridge/web test` phải qua,
  test cũ không được hỏng.
- **Phải nhìn kết quả bằng mắt.** Chạy `pnpm --filter @claude-bridge/web dev`, mở `?demo=1`, chụp bằng Chrome headless
  (`"C:/Program Files/Google/Chrome/Application/chrome.exe" --headless --screenshot=<file> --window-size=1600,1000 <url>`)
  rồi đọc ảnh, chỉnh tọa độ bàn ghế và robot cho đến khi không món nào lơ lửng, đè nhau sai chiều sâu, hay tràn khỏi sàn.
  Nếu fixture demo không đủ trạng thái (idle, busy ở nhiều phase, assigned, failed, offline, permission chờ), bổ sung fixture.
