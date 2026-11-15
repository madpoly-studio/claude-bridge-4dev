// Gán chỗ đứng cho worker. Thuần, tất định.

/** Chỉ số ổn định của worker = vị trí trong sortedWorkers. */
export function deskIndexOf(sortedWorkerIds: readonly string[]): Map<string, number> {
  const out = new Map<string, number>();
  sortedWorkerIds.forEach((id, i) => out.set(id, i));
  return out;
}

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
): SlotAssignment {
  const placed = new Map<string, string>();
  const overflow: string[] = [];
  const taken = new Set<number>();
  for (const c of candidates) {
    if (taken.size >= pool.length) {
      overflow.push(c.workerId);
      continue;
    }
    let at = mode === "stable" ? ((c.index % pool.length) + pool.length) % pool.length : 0;
    while (taken.has(at)) at = (at + 1) % pool.length;
    taken.add(at);
    placed.set(c.workerId, pool[at]!);
  }
  return { placed, overflow };
}

/**
 * Bàn cho các worker đang ở khu làm việc; hết bàn thật sự mới tràn. Thứ tự ưu tiên:
 * 1. bàn worker đang giữ ở lượt trước (`prev`), để không đổi bàn khi nó còn bận;
 * 2. bàn "nhà" desks[index] nếu còn trống;
 * 3. bàn trống đầu tiên (worker thứ 11 trở đi, hoặc bàn nhà đang có worker khác ngồi).
 * candidates đã sắp theo chỉ số ổn định. Không có `prev` thì kết quả chỉ phụ thuộc đầu vào (tất định).
 */
export function assignDesks(
  candidates: ReadonlyArray<{ workerId: string; index: number }>,
  desks: readonly string[],
  prev?: ReadonlyMap<string, string>,
): SlotAssignment {
  const taken = new Set<string>();
  const kept = new Map<string, string>();
  for (const c of candidates) {
    const desk = prev?.get(c.workerId);
    if (desk === undefined || taken.has(desk) || !desks.includes(desk)) continue;
    taken.add(desk);
    kept.set(c.workerId, desk);
  }

  const placed = new Map<string, string>();
  const overflow: string[] = [];
  for (const c of candidates) {
    const home = desks[c.index];
    const desk = kept.get(c.workerId) ?? (home !== undefined && !taken.has(home) ? home : desks.find((d) => !taken.has(d)));
    if (desk === undefined) {
      overflow.push(c.workerId);
      continue;
    }
    taken.add(desk);
    placed.set(c.workerId, desk);
  }
  return { placed, overflow };
}
