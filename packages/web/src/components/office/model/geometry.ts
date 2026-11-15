// Hình học của cảnh. Mọi tọa độ theo hệ ảnh nền 1448x1086, gốc trên-trái, y hướng xuống.

export const SCENE_W = 1448;
export const SCENE_H = 1086;

export interface Point {
  x: number;
  y: number;
}

export type ZoneId = "desk" | "relax" | "pod";
/** Chỗ của agent: home là góc đứng mặc định, work là chỗ làm việc của nó. */
export type AgentSpot = "home" | "work";
/** 1: sprite nguyên bản (mặt hơi lệch phải); -1: lật ngang. */
export type Facing = 1 | -1;

export function distance(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}
