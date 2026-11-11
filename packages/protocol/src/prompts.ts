// Prompt giao việc cho worker (system design mục 6).
export function buildWorkerPrompt(args: { ticket_key: string; task_id: string; notes: string | null }): string {
  return [
    `Thực hiện ticket ${args.ticket_key} theo flow worker.`,
    `task_id: ${args.task_id}`,
    `Ghi chú từ orchestrator: ${args.notes ?? "(không có)"}`,
    "Báo tiến độ bằng report_progress khi đổi phase.",
    "Kết thúc bằng complete_task (kèm mr_url, branch, summary) hoặc fail_task (kèm category, reason).",
  ].join("\n");
}

/** Regex khóa ticket Jira, dùng để lấy `ticket_key` từ kết quả tool tạo issue. */
export const JIRA_KEY_RE = /\b([A-Z][A-Z0-9_]+-\d+)\b/;
