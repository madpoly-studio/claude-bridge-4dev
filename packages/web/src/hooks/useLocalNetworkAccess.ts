// Trạng thái quyền Local Network Access (Chrome) cho kết nối loopback ws://127.0.0.1.
import { useEffect, useState } from "react";

export type LnaState = "granted" | "prompt" | "denied" | "unknown";

/** Chrome đã dùng cả hai tên trong các giai đoạn triển khai LNA. */
export const LNA_PERMISSION_NAMES = ["local-network-access", "loopback-network"] as const;

interface PermissionsLike {
  query(descriptor: { name: string }): Promise<PermissionStatus>;
}

export async function queryLocalNetworkAccess(
  permissions: PermissionsLike | undefined = typeof navigator !== "undefined"
    ? (navigator.permissions as unknown as PermissionsLike | undefined)
    : undefined,
): Promise<{ state: LnaState; status: PermissionStatus | null }> {
  if (!permissions || typeof permissions.query !== "function") return { state: "unknown", status: null };
  for (const name of LNA_PERMISSION_NAMES) {
    try {
      const status = await permissions.query({ name });
      return { state: status.state as LnaState, status };
    } catch {
      // Tên quyền không được hỗ trợ: thử tên tiếp theo.
    }
  }
  return { state: "unknown", status: null };
}

export function useLocalNetworkAccess(enabled = true): { state: LnaState; checked: boolean } {
  const [result, setResult] = useState<{ state: LnaState; checked: boolean }>({ state: "unknown", checked: !enabled });

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    let status: PermissionStatus | null = null;
    const onChange = () => {
      if (status && !cancelled) setResult({ state: status.state as LnaState, checked: true });
    };
    queryLocalNetworkAccess().then((r) => {
      if (cancelled) return;
      status = r.status;
      status?.addEventListener?.("change", onChange);
      setResult({ state: r.state, checked: true });
    });
    return () => {
      cancelled = true;
      status?.removeEventListener?.("change", onChange);
    };
  }, [enabled]);

  return result;
}
