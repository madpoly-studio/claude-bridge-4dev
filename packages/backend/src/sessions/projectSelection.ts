// Project đang chọn (mục 10.2): theo từng kết nối WS, và một giá trị chung cho status.project_key / snapshot
// (bridge là công cụ một người dùng, project chọn gần nhất là project hiện tại).
import type { WsClient } from "../ws/hub.js";

export class ProjectSelection {
  private readonly perClient = new WeakMap<WsClient, string>();
  private currentKey: string | null;

  constructor(private readonly projects: readonly string[]) {
    this.currentKey = projects[0] ?? null;
  }

  current(): string | null {
    return this.currentKey;
  }

  forClient(client: WsClient): string | null {
    return this.perClient.get(client) ?? this.currentKey;
  }

  isKnown(projectKey: string): boolean {
    return this.projects.includes(projectKey);
  }

  /** true nếu project chung thay đổi. */
  select(client: WsClient, projectKey: string): boolean {
    this.perClient.set(client, projectKey);
    if (this.currentKey === projectKey) return false;
    this.currentKey = projectKey;
    return true;
  }
}
