// Hằng số của chế độ Văn phòng. File duy nhất trong office/ mà view-mode.ts và ViewSwitchButton.tsx được import.

export const OFFICE_STORAGE_KEYS = {
  viewMode: "claude-bridge.view-mode",
  chatDock: "claude-bridge.office-chat",
} as const;

export const VIEW_QUERY_PARAM = "view";
export const SCENARIO_QUERY_PARAM = "scenario";
export const DEBUG_QUERY_PARAM = "debug";
export const DEBUG_GRID_VALUE = "grid";
/** `?chat=closed|planner|orchestrator`: ép trạng thái khung chat cho lần tải đó (dùng khi chụp ảnh), không ghi storage. */
export const CHAT_QUERY_PARAM = "chat";

/** Thời lượng hiệu ứng tạm (ms). */
export const FX_MS = {
  bubble: 6_000,
  happy: 1_800,
  error: 4_000,
  cancelBubble: 3_000,
  note: 1_200,
} as const;

/** Tốc độ đi của robot, px của hệ cảnh mỗi giây. */
export const WALK_SPEED_PX_S = 250;
export const MIN_SEGMENT_MS = 250;
/** Bỏ waypoint cách điểm trước dưới ngưỡng này. */
export const ROUTE_MIN_GAP_PX = 24;
/**
 * Agent chỉ đổi chỗ khi trạng thái mới đã giữ đủ lâu: bận chớp nhoáng không làm nó rời góc,
 * và nghỉ giữa hai lượt xử lý liền nhau không làm nó quay về rồi lại đi lên.
 */
export const AGENT_SPOT_DELAY_MS = { work: 200, home: 1_200 } as const;
/** Thời gian chờ thêm trước khi coi như transitionend bị lỡ. */
export const WALK_FALLBACK_SLACK_MS = 200;

export const MIN_SCENE_SCALE = 0.52;
export const LABEL_SCALE_MIN = 0.85;
export const LABEL_SCALE_MAX = 1.9;
/** Nhãn co ngược theo scale^-số mũ: chữ gần giữ cỡ trên màn hình nhưng không phình quá ở cửa sổ nhỏ. */
export const LABEL_SCALE_EXPONENT = 0.72;

/**
 * Hình học của khung chat đang mở, nguồn duy nhất cho cả bản đồ lẫn CSS của khung: computeSceneFit tính từ các số này,
 * useSceneScale ghi kết quả thành biến CSS (--chat-width, --chat-gap) và data-chat-layout mà floating-chat.module.css đọc.
 */
/** Khe quanh khung chat: tới mép trên / dưới / phải của vùng cảnh và tới mép phải của bản đồ. */
export const CHAT_GAP_PX = 8;
export const CHAT_MIN_WIDTH_PX = 380;
export const CHAT_MAX_WIDTH_PX = 560;
/** Vùng cảnh hẹp hơn mức này: khung chat thành bottom sheet đè lên bản đồ thay vì đứng cạnh. */
export const CHAT_SHEET_BELOW_PX = 720;
/** Thời lượng bản đồ trượt / co khi mở hoặc thu gọn khung chat (đổi cỡ cửa sổ thì không trượt). */
export const SCENE_FIT_TRANSITION_MS = 260;
/** Cửa sổ hẹp hơn mức này thì lần đầu khung chat thu gọn để không che cảnh. */
export const CHAT_DEFAULT_OPEN_MIN_WIDTH = 1500;

export const MAX_RACK_LEDS = 8;
export const DEMO_TICK_MS = 2_500;
export const DEMO_FX_DELAY_MS = 600;

/** Thông báo khi Văn phòng không tải / không vẽ được và giao diện tự quay về dashboard. */
export const OFFICE_FAILED_NOTICE = "Không tải được chế độ Văn phòng, đã chuyển về Dashboard. Tải lại trang rồi thử lại.";
