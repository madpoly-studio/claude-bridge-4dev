import { Component } from "react";
import type { ContextType, ErrorInfo, ReactNode } from "react";
import { BridgeContext } from "../../hooks/bridge-context";
import { OFFICE_FAILED_NOTICE } from "./constants";

interface OfficeBoundaryProps {
  /** Gọi một lần khi Văn phòng hỏng: nơi dùng phải chuyển về dashboard (và ghi nhớ lựa chọn đó). */
  onFail: () => void;
  children: ReactNode;
}

interface OfficeBoundaryState {
  failed: boolean;
}

let noticeSeq = 0;

/**
 * Chặn lỗi của chế độ Văn phòng (chunk nạp lười không tải được, hoặc code ném lỗi lúc render): thay vì trắng trang,
 * báo cho người dùng bằng một thông báo nổi rồi nhờ nơi dùng quay về dashboard. Sau khi hỏng chỉ vẽ null,
 * nên không render lại cây con đã lỗi (không có vòng lặp lỗi).
 */
export class OfficeBoundary extends Component<OfficeBoundaryProps, OfficeBoundaryState> {
  static contextType = BridgeContext;
  declare context: ContextType<typeof BridgeContext>;

  state: OfficeBoundaryState = { failed: false };

  static getDerivedStateFromError(): OfficeBoundaryState {
    return { failed: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error("Chế độ Văn phòng lỗi, quay về dashboard:", error, info.componentStack);
    noticeSeq += 1;
    this.context?.store.dispatch({ type: "local/notice", notice: { id: `office-failed-${noticeSeq}`, kind: "error", text: OFFICE_FAILED_NOTICE } });
    this.props.onFail();
  }

  render(): ReactNode {
    return this.state.failed ? null : this.props.children;
  }
}
