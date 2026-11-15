// Mô tả sprite sheet và phép tính biến CSS cho animation steps(). Không import asset.
import type { Point } from "./geometry";

export type WorkerAnim = "idle" | "work" | "move" | "error" | "sleep" | "happy";
export type AgentAnim = "idle" | "processing" | "alert" | "off";

export interface AnimSpec {
  row: number;
  frames: number;
  fps: number;
  loop: boolean;
}

export interface SheetSpec<A extends string> {
  cols: number;
  rows: number;
  /** Kích thước hiển thị của một ô trong hệ cảnh (không phải kích thước file). */
  display: { w: number; h: number };
  /** Điểm chạm đất trong ô hiển thị. */
  anchor: Point;
  anims: Record<A, AnimSpec>;
}

const WORKER_CELL = 132;
/** Tỉ lệ điểm neo trong ô, theo manifest của gen_worker_sheets.py: [128, 234] / 256. */
const WORKER_ANCHOR_RATIO = { x: 0.5, y: 0.915 };

/** 6x6, khớp ANIMS trong gen_worker_sheets.py (hàng, số frame, fps). */
export const WORKER_SHEET: SheetSpec<WorkerAnim> = {
  cols: 6,
  rows: 6,
  display: { w: WORKER_CELL, h: WORKER_CELL },
  anchor: { x: WORKER_CELL * WORKER_ANCHOR_RATIO.x, y: Math.round(WORKER_CELL * WORKER_ANCHOR_RATIO.y) },
  anims: {
    idle: { row: 0, frames: 6, fps: 6, loop: true },
    work: { row: 1, frames: 6, fps: 8, loop: true },
    move: { row: 2, frames: 4, fps: 8, loop: true },
    error: { row: 3, frames: 4, fps: 10, loop: true },
    sleep: { row: 4, frames: 4, fps: 2, loop: true },
    happy: { row: 5, frames: 6, fps: 10, loop: false },
  },
};

/** Phần thân robot trong ô hiển thị (vùng bấm, vị trí bong bóng). */
export const WORKER_BODY = { w: Math.round(WORKER_CELL * 0.6), h: Math.round(WORKER_CELL * 0.8) };

/** Agent là ảnh một frame (bản nét nhất của bộ asset); chuyển động do CSS đảm nhận. anchor.y lớn hơn h: robot lơ lửng. */
export const PLANNER_SHEET: SheetSpec<"idle"> = {
  cols: 1,
  rows: 1,
  display: { w: 96, h: 95 },
  anchor: { x: 50, y: 116 },
  anims: { idle: { row: 0, frames: 1, fps: 1, loop: true } },
};

export const ORCHESTRATOR_SHEET: SheetSpec<"idle"> = {
  cols: 1,
  rows: 1,
  display: { w: 100, h: 97 },
  anchor: { x: 52, y: 120 },
  anims: { idle: { row: 0, frames: 1, fps: 1, loop: true } },
};

/** Biến CSS đã tính sẵn cho một animation. Mọi phần trăm được chia ở đây, CSS không chia cho (cols - 1). */
export interface SpriteVars {
  "--cols": number;
  "--rows": number;
  "--row-pos": string;
  "--end-x": string;
  "--frames": number;
  "--dur": string;
  "--iter": string;
}

const pct = (v: number) => `${Math.round(v * 1e4) / 100}%`;

/**
 * Sheet vẽ bằng background-size (cols*100%, rows*100%), nên frame i nằm ở background-position-x = i / (cols - 1).
 * Keyframes chạy từ 0 tới --end-x bằng steps(frames, jump-none): frame cuối cũng là giá trị kết thúc,
 * nên animation không lặp dừng ở frame cuối thay vì trượt sang ô trống.
 */
export function spriteVars<A extends string>(sheet: SheetSpec<A>, anim: A, iterations?: number): SpriteVars {
  const spec = sheet.anims[anim];
  const iter = iterations ?? (spec.loop ? Infinity : 1);
  return {
    "--cols": sheet.cols,
    "--rows": sheet.rows,
    "--row-pos": sheet.rows > 1 ? pct(spec.row / (sheet.rows - 1)) : "0%",
    "--end-x": sheet.cols > 1 ? pct((spec.frames - 1) / (sheet.cols - 1)) : "0%",
    "--frames": spec.frames,
    "--dur": `${Math.round((spec.frames / spec.fps) * 1000)}ms`,
    "--iter": Number.isFinite(iter) ? String(iter) : "infinite",
  };
}
