# @claude-bridge/web

Frontend SPA của claude-bridge (React 18 + TypeScript + Vite, CSS thuần với biến CSS). Giao diện 3 cột: Planner, Orchestrator, Log (Workers / Tickets / Events), kèm panel Chi tiết task.

## Chạy nhanh

```bash
pnpm install
pnpm --filter @claude-bridge/protocol build   # web import bản build dist/ của protocol
pnpm --filter @claude-bridge/web dev          # http://localhost:5173
```

- Demo không cần backend: mở `http://localhost:5173/?demo=1`. Dữ liệu mẫu có worker ở mọi trạng thái, task ở mọi state, ticket ở cả 4 nhóm, hội thoại planner có card duyệt đang chờ, orchestrator có turn hệ thống và cảnh báo `task.failed`, và luồng session của task. Mọi thao tác (gửi tin, duyệt/sửa/hủy, dừng giao việc, phiên mới) chỉ đổi state cục bộ.
- Kiểm tra: `pnpm --filter @claude-bridge/web test`, `pnpm --filter @claude-bridge/web typecheck`.

## Cấu hình

| Cấu hình | Mặc định | Ghi chú |
|---|---|---|
| `VITE_BRIDGE_WS_URL` | `ws://127.0.0.1:8787/ws` | Đặt lúc build (`.env`, `.env.local` hoặc biến môi trường). Người dùng vẫn sửa được ở màn hình Kết nối |
| URL WebSocket, pairing token | — | Nhập ở màn hình Kết nối. URL nhớ trong `localStorage` (`claude-bridge.ws-url`). Token (`claude-bridge.token`) mặc định chỉ ở `sessionStorage` (mất khi đóng tab); chọn **Ghi nhớ trên máy này** thì lưu `localStorage`, bỏ chọn thì xóa ngay. Token cũ đã có trong `localStorage` vẫn dùng được (ô ghi nhớ hiện đã chọn) |

Pairing token do backend in ra terminal khi khởi động. Dán một lần (chọn Ghi nhớ nếu muốn giữ qua lần mở trình duyệt sau); lần sau trang tự kết nối (nếu quyền Local Network Access đã cấp). Muốn đổi URL/token: bấm nút cắm điện ("Cài đặt kết nối") trên top bar.

Origin của trang phải nằm trong `allowed_origins` của backend. Khi dev, origin là `http://localhost:5173` (khác với `http://127.0.0.1:5173`); nếu backend báo "origin bị chặn", thêm đúng origin đang dùng.

## Build và triển khai lên host SSO

```bash
pnpm --filter @claude-bridge/web build    # ra packages/web/dist/
```

`dist/` là file tĩnh thuần (`index.html` + `assets/`), build với `base: "./"` nên đặt được ở root hoặc sub-path bất kỳ của host SSO. Chép nguyên thư mục lên host, ví dụ:

```bash
rsync -av --delete packages/web/dist/ sso-host:/var/www/claude-bridge/
```

Không cần rewrite route (SPA một trang, trạng thái demo chỉ dùng query `?demo=1`). Nên đặt `Cache-Control: no-cache` cho `index.html`; file trong `assets/` có hash nên cache lâu được. Nhớ thêm origin của host SSO (ví dụ `https://tools.example.com`) vào `allowed_origins` của backend.

## Chrome Local Network Access

Trang chạy trên host SSO (origin công khai) nhưng mở WebSocket tới `ws://127.0.0.1:<PORT>` trên máy người dùng. Chrome yêu cầu người dùng cấp quyền **Local Network Access** cho origin đó.

- Trang đọc trạng thái quyền qua `navigator.permissions.query({name: "local-network-access"})` (thử thêm tên cũ `"loopback-network"`; không hỗ trợ thì coi là "không xác định").
- Quyền ở trạng thái `prompt`: **không** tự kết nối khi tải trang; hiện nút **Kết nối**. Bấm nút thì Chrome hỏi quyền, chọn *Allow*.
- `granted` (hoặc trình duyệt không có cơ chế này) và đã có token: tự kết nối.
- `denied`: hướng dẫn mở cài đặt trang (biểu tượng bên trái thanh địa chỉ) → Local network access → Allow, rồi tải lại.

## Chế độ Văn phòng (thử nghiệm)

Chế độ xem thứ hai: văn phòng isometric, mỗi worker là một robot. Dashboard 3 cột vẫn là mặc định; chuyển qua lại bằng nút **Văn phòng / Dashboard** trên top bar (lựa chọn được nhớ trong localStorage). Cảnh chỉ suy ra từ `AppState` đã có, không thêm gì vào protocol hay reducer.

| URL | Hiện gì |
|---|---|
| `?demo=1&view=office` | Kịch bản sống: mỗi 2,5 s một bước (nhận task, chạy, báo progress, xong, lỗi, offline rồi quay lại) |
| `&scenario=still` | Fixture gốc, đứng yên |
| `&scenario=crowd` | 18 worker, có chip "+N" cho worker không có bàn |
| `&scenario=paused` / `ratelimit` / `dead` / `disconnected` | Dừng giao việc / rate limit (robot rảnh ra quầy cà phê) / orchestrator chết / mất kết nối |
| `&scenario=agents-home` / `planner-busy` / `orchestrator-busy` | Cả hai agent rảnh ở góc dưới-phải / planner đang trả lời ở khu Planning / orchestrator đang xử lý ở bàn điều phối |
| `&scenario=fx` | Sau 0,6 s: một task lỗi, một task xong (giấy note bay lên bảng kanban), một bong bóng progress |
| `&chat=closed` / `planner` / `orchestrator` | Ép trạng thái khung chat nổi cho lần tải đó |
| `&debug=grid` | Lưới 100 px, điểm neo và gate, dùng khi chỉnh `model/layout.ts` |

`?view=office|dashboard` chỉ có tác dụng cho lần tải đó và không ghi vào localStorage.

Đọc cảnh: robot ở thảm đỏ là IDLE, ở bàn là đang có task (màn hình bàn đổi theo phase, 5 chấm dưới tên là phase), cạnh pod bên trái là OFFLINE. Bấm robot đang có task để mở chi tiết task; bấm bảng kanban để mở danh sách ticket; bấm robot Planner / Orchestrator để mở khung chat (ở chỗ nào cũng bấm được). Skin của robot là `fnv1a32(worker_id) % 5`, nên cùng một worker luôn có cùng hình trên mọi máy.

Hai agent có hai chỗ (`model/layout.ts`, `planner` / `orchestrator`): góc `home` ở góc dưới-phải của sàn (planner bên trái, orchestrator bên phải) và chỗ `work` ở khu Planning. Rảnh thì đứng ở `home`. Khi phiên của agent bận (bạn vừa nhắn cho nó) thì nó tự đi lên chỗ `work`, xong việc lại đi về; planner đang chờ bạn duyệt bản nháp vẫn ở chỗ `work` với dấu "!". Orchestrator `dead` / `stopped` / `restarting` đứng ở `home` với trạng thái tương ứng. Robot chỉ đổi chỗ khi trạng thái mới giữ đủ lâu (`AGENT_SPOT_DELAY_MS`: 0,2 s để đi lên, 1,2 s để đi về), nên một lượt bận chớp nhoáng không làm nó chạy qua chạy lại. Đường đi dùng chung `useRouteWalker` với worker; `prefers-reduced-motion` thì nhảy thẳng tới đích.

Toàn bộ code nằm trong `src/components/office/` (`model/` thuần và có test, `scene/` vẽ, `chat/`, `panels/`, `demo/`, `assets/`). Ngoài thư mục đó chỉ có ba chỗ nối: `AppShell.tsx` (chọn view, nạp lười), `Dashboard.tsx` và `TopBar.tsx` (một prop tùy chọn để đặt nút chuyển). Gỡ tính năng: xóa thư mục `office/` và hoàn tác ba file này.

Ảnh trong `assets/` (WebP, khoảng 1,8 MB, chỉ tải khi vào Văn phòng) do script sinh từ ảnh gốc trong `brainstorm/newUI/sprites/`. Ảnh gốc không nằm trong repo (khoảng 16 MB), chỉ có script; cần có bộ ảnh đó tại đường dẫn trên thì mới sinh lại được:

```bash
uv run --with pillow python brainstorm/newUI/tools/build_office_assets.py
```

Lưu ý khi chạy test bằng Node 25 trở lên: Node có sẵn một `localStorage` toàn cục chưa cấu hình, che mất bản của jsdom và làm hỏng các test dùng localStorage (kể cả test có từ trước). Chạy với `NODE_OPTIONS=--no-experimental-webstorage pnpm --filter @claude-bridge/web test`.

## Kiến trúc

```
src/
  ws/transport.ts       Transport tối thiểu (WebSocket mặc định; thay được bằng relay)
  ws/client.ts          BridgeClient: auth → subscribe{since_seq} → snapshot/replay → live;
                        request/response theo id có timeout; reconnect backoff; mã đóng WS_CLOSE
  state/reducer.ts      Reducer thuần trên ServerMessage + action cục bộ
  state/store.ts        Store đồng bộ (useSyncExternalStore) để service đọc state mới nhất ngay
  state/selectors.ts    Nhóm ticket, lọc event, chọn session, URL Jira, token
  state/stream.ts       Diễn giải message SDK: gộp tool đọc, turn hệ thống, chip tool, dòng log task
  state/permission-draft.ts  Ánh xạ input tool tạo issue → bản nháp ticket; Sửa chỉ ghi lại trường đã đổi
  lib/safe-href.ts      Chỉ cho http/https cho mọi link từ dữ liệu server (dùng qua components/common/ExternalLink)
  lib/token-storage.ts  Nơi lưu pairing token (sessionStorage / localStorage khi chọn ghi nhớ)
  services/             BridgeActions: live (WebSocket) và demo (state cục bộ); thông báo trình duyệt
  hooks/                Context, LNA, đồng hồ, auto-scroll
  components/           TopBar, StatusBanners, Planner/Orchestrator/Log column, TaskDetailPanel...
  demo/fixtures.ts      Dữ liệu mẫu cho ?demo=1
```

Replay khi reconnect: client giữ `lastSeq` (seq lớn nhất đã nhận, hoặc `replay.done.last_seq`) và gửi lại làm `since_seq`. Bus event được chèn theo seq và khử trùng theo seq, nên server gửi chồng hay lệch thứ tự cũng không mất/trùng. Luồng session được mở lại bằng `session.open`/`task.open` với `since` = id cuối đã có, record khử trùng theo id.

Chỉ giữ trong bộ nhớ các luồng đang hiển thị (phiên planner đang chọn, orchestrator, task đang mở). Đóng panel task hoặc đổi phiên planner thì bỏ luồng cũ và bỏ qua `session.event` của nó (backend chưa có `session.unsubscribe`/`task.close` nên vẫn đẩy tới); mở lại thì tải lại lịch sử từ đầu. Khi `session.history` có `truncated: true` (hoặc luồng vượt `MAX_STREAM_RECORDS`), đầu luồng hiện dòng "Đã ẩn các sự kiện cũ hơn".

Lần kết nối đầu tiên `subscribe` không gửi `since_seq` để backend tự quyết lượng replay.
