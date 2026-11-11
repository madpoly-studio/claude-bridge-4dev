import type { BusErrorBody, BusErrorCode } from "@claude-bridge/protocol";

/** Lỗi nghiệp vụ của bus; tầng MCP / HTTP chuyển thành BusErrorBody. */
export class BusError extends Error {
  constructor(
    readonly code: BusErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "BusError";
  }

  toBody(): BusErrorBody {
    return { error: { code: this.code, message: this.message } };
  }
}

const HTTP_STATUS: Record<BusErrorCode, number> = {
  WORKER_NOT_IDLE: 409,
  WORKER_NOT_FOUND: 404,
  TICKET_ALREADY_ACTIVE: 409,
  CONCURRENCY_LIMIT: 409,
  DISPATCH_PAUSED: 409,
  TASK_NOT_FOUND: 404,
  TASK_NOT_ACTIVE: 409,
  TASK_ALREADY_TERMINAL: 409,
  INVALID_INPUT: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
};

export function httpStatusOf(code: BusErrorCode): number {
  return HTTP_STATUS[code];
}
