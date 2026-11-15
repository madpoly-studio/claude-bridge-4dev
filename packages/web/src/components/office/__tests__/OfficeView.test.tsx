import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { App } from "../../../App";
import chatCss from "../chat/floating-chat.module.css?raw";
import { AGENT_SPOT_DELAY_MS, OFFICE_STORAGE_KEYS } from "../constants";
import type { Point } from "../model/geometry";
import { OFFICE_LAYOUT } from "../model/layout";
import { installMemoryStorage } from "./memory-storage";

// Test khói: vào Văn phòng bằng ?view=office, kịch bản tĩnh (không timer). jsdom không có ResizeObserver: cảnh giữ scale 1.
function visit(search: string) {
  window.history.replaceState({}, "", `/${search}`);
}

beforeAll(installMemoryStorage);

beforeEach(() => {
  localStorage.clear();
  visit("?view=office&scenario=still&chat=planner");
});

afterEach(() => {
  cleanup();
  localStorage.clear();
  visit("");
});

async function renderOffice() {
  render(<App demo />);
  // OfficeView nạp lười.
  return screen.findByRole("main", { name: "Văn phòng" });
}

const at = (p: Point) => `translate(${p.x}px, ${p.y}px)`;
/** Phần tử định vị của robot (cha của nút bấm). */
const actorOf = (button: HTMLElement) => button.parentElement as HTMLElement;

describe("OfficeView (demo)", () => {
  it("mặc định vẫn là dashboard; nút trên top bar chuyển sang Văn phòng và nhớ lựa chọn", async () => {
    visit("");
    render(<App demo />);
    expect(screen.getByRole("region", { name: "Log" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Chuyển sang chế độ Văn phòng" }));
    expect(await screen.findByRole("main", { name: "Văn phòng" })).toBeTruthy();
    expect(localStorage.getItem(OFFICE_STORAGE_KEYS.viewMode)).toBe("office");
    expect(screen.queryByRole("region", { name: "Log" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Chuyển sang Dashboard" }));
    expect(screen.getByRole("region", { name: "Log" })).toBeTruthy();
    expect(localStorage.getItem(OFFICE_STORAGE_KEYS.viewMode)).toBe("dashboard");
  });

  it("?view=office không ghi storage; top bar và banner của dashboard vẫn có", async () => {
    await renderOffice();
    expect(localStorage.getItem(OFFICE_STORAGE_KEYS.viewMode)).toBeNull();
    expect(screen.getByRole("heading", { name: "claude-bridge" })).toBeTruthy();
    expect(screen.getByText("Dừng giao việc")).toBeTruthy();
    expect(screen.getByText("Chế độ demo")).toBeTruthy();
  });

  it("mỗi worker là một nút có aria-label mang tên và trạng thái bằng chữ", async () => {
    const main = await renderOffice();
    expect(within(main).getByRole("button", { name: /^w-sh-01, BUSY, SH-129, phase 2\/5: implementing/ })).toBeTruthy();
    expect(within(main).getByRole("button", { name: /^w-sh-02, BUSY, SH-128, phase 3\/5: testing/ })).toBeTruthy();
    expect(within(main).getByRole("button", { name: /^w-sh-03, IDLE\. Xem thông tin worker/ })).toBeTruthy();
    expect(within(main).getByRole("button", { name: /^w-sh-04, OFFLINE/ })).toBeTruthy();
    expect(within(main).getByRole("button", { name: /^w-sh-05, CHỜ RUNNER, SH-133/ })).toBeTruthy();
    // Thẻ tên dưới robot cũng có chữ (trang trí, aria-hidden).
    expect(within(main).getByText("CHỜ RUNNER")).toBeTruthy();
    expect(within(main).getByText("OFFLINE")).toBeTruthy();
  });

  it("bấm robot đang có task mở TaskDetailPanel; bấm robot rảnh mở thẻ worker", async () => {
    const main = await renderOffice();
    await act(async () => {
      fireEvent.click(within(main).getByRole("button", { name: /^w-sh-01, BUSY/ }));
    });
    const drawer = screen.getByRole("dialog");
    expect(within(drawer).getByText("RUNNING")).toBeTruthy();
    expect(within(drawer).getByText("agent/SH-129")).toBeTruthy();
    await act(async () => {
      fireEvent.click(within(drawer).getByRole("button", { name: "Đóng" }));
    });
    expect(screen.queryByRole("dialog")).toBeNull();

    fireEvent.click(within(main).getByRole("button", { name: /^w-sh-03, IDLE/ }));
    const info = screen.getByRole("dialog");
    expect(within(info).getByText("w-sh-03")).toBeTruthy();
    expect(within(info).getByText("IDLE")).toBeTruthy();
    fireEvent.click(within(info).getByRole("button", { name: "Đóng" }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("bảng kanban hiện số khớp tab Tickets và mở danh sách ticket; mở task từ danh sách không để hai dialog cùng lúc", async () => {
    const main = await renderOffice();
    const plaque = within(main).getByRole("button", { name: /^Bảng ticket: chờ giao 3, đang làm 3, review 1, lỗi 1/ });
    fireEvent.click(plaque);
    const list = screen.getByRole("dialog");
    expect(within(list).getByText(/CHỜ GIAO/)).toBeTruthy();
    expect(within(list).getByText("bị chặn bởi SH-128")).toBeTruthy();
    await act(async () => {
      fireEvent.click(within(list).getByRole("button", { name: "w-sh-01" }));
    });
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
    expect(within(screen.getByRole("dialog")).getByText("agent/SH-129")).toBeTruthy();
  });

  it("khung chat nổi: gate Duyệt dùng được; planner đang alert rồi hết sau khi duyệt", async () => {
    const main = await renderOffice();
    const chat = screen.getByRole("complementary", { name: "Chat với agent" });
    expect(within(main).getByRole("button", { name: /^Planner, cần bạn duyệt, 1 bản nháp chờ duyệt/ })).toBeTruthy();
    expect(within(chat).getByRole("tab", { name: /Planner/ }).getAttribute("aria-selected")).toBe("true");
    expect(within(chat).getByText("Bản nháp ticket")).toBeTruthy();
    await act(async () => {
      fireEvent.click(within(chat).getByRole("button", { name: "Duyệt và tạo ticket" }));
    });
    expect(within(chat).queryByText("Bản nháp ticket")).toBeNull();
    expect(within(chat).getByText(/Đã tạo SH-134/)).toBeTruthy();
    expect(within(main).getByRole("button", { name: /^Planner, rảnh/ })).toBeTruthy();
    expect(within(main).getByRole("button", { name: /^Bảng ticket: chờ giao 4/ })).toBeTruthy();
  });

  it("agent đứng đúng chỗ theo trạng thái ngay lần vẽ đầu; hết việc thì planner rời chỗ làm đi về góc home", async () => {
    const main = await renderOffice();
    const chat = screen.getByRole("complementary", { name: "Chat với agent" });
    const planner = actorOf(within(main).getByRole("button", { name: /^Planner, cần bạn duyệt/ }));
    const orchestrator = actorOf(within(main).getByRole("button", { name: /^Orchestrator, rảnh/ }));
    // Planner đang chờ duyệt: ở chỗ làm việc. Orchestrator rảnh: ở góc home. Không ai đang đi.
    expect(planner.style.transform).toBe(at(OFFICE_LAYOUT.planner.work.anchor));
    expect(orchestrator.style.transform).toBe(at(OFFICE_LAYOUT.orchestrator.home.anchor));
    expect(planner.dataset.moving).toBe("false");
    expect(orchestrator.dataset.moving).toBe("false");

    await act(async () => {
      fireEvent.click(within(chat).getByRole("button", { name: "Duyệt và tạo ticket" }));
    });
    // Vừa rảnh thì chưa đi ngay (nán lại AGENT_SPOT_DELAY_MS.home).
    expect(planner.style.transform).toBe(at(OFFICE_LAYOUT.planner.work.anchor));
    await waitFor(() => expect(planner.dataset.moving).toBe("true"), { timeout: AGENT_SPOT_DELAY_MS.home + 1_500 });
    // Chặng đầu của đường về: gate của chỗ làm việc.
    expect(planner.style.transform).toBe(at(OFFICE_LAYOUT.planner.work.gate));
    expect(orchestrator.style.transform).toBe(at(OFFICE_LAYOUT.orchestrator.home.anchor));
  });

  it("cả hai cột chat luôn mount (nháp không mất khi đổi tab); bấm robot orchestrator đổi tab", async () => {
    const main = await renderOffice();
    const chat = screen.getByRole("complementary", { name: "Chat với agent" });
    const draft = within(chat).getByLabelText("Nhắn cho planner") as HTMLTextAreaElement;
    fireEvent.change(draft, { target: { value: "đang gõ dở" } });
    fireEvent.click(within(main).getByRole("button", { name: /^Orchestrator, rảnh/ }));
    expect(within(chat).getByRole("tab", { name: /Orchestrator/ }).getAttribute("aria-selected")).toBe("true");
    expect(within(chat).getByLabelText("Nhắn cho orchestrator")).toBeTruthy();
    fireEvent.click(within(chat).getByRole("tab", { name: /Planner/ }));
    expect((within(chat).getByLabelText("Nhắn cho planner") as HTMLTextAreaElement).value).toBe("đang gõ dở");
  });

  it("khung chat nằm trong vùng cảnh (<main>) và định vị theo nó; data-open đổi theo mở / thu gọn", async () => {
    const main = await renderOffice();
    const chat = screen.getByRole("complementary", { name: "Chat với agent" });
    expect(main.contains(chat)).toBe(true);
    expect(getComputedStyle(chat).position).toBe("absolute");
    expect(chat.dataset.open).toBe("true");
    // Hình học khi mở chỉ đọc từ biến do useSceneScale ghi lên <main>, không có số cứng thứ hai trong CSS.
    const openRule = /\.root\[data-open="true"\]\s*\{([^}]*)\}/.exec(chatCss)?.[1] ?? "";
    expect(openRule).toContain("width: var(--chat-width");
    for (const side of ["top", "right", "bottom"]) expect(openRule).toContain(`${side}: var(--chat-gap`);

    fireEvent.click(within(chat).getByRole("button", { name: "Thu gọn khung chat" }));
    expect(chat.dataset.open).toBe("false");
    expect(within(chat).getByRole("button", { name: /^Mở chat Planner/ })).toBeTruthy();
  });

  it("selector cấu trúc của khung chat còn khớp markup của cột: mọi selector `.pane > section ...` trong CSS đều trúng phần tử thật", async () => {
    await renderOffice();
    const chat = screen.getByRole("complementary", { name: "Chat với agent" });
    const panes = [...chat.querySelectorAll<HTMLElement>('[role="tabpanel"]')];
    expect(panes).toHaveLength(2);
    // .pane chính là tabpanel: nếu markup của FloatingChat đổi thì phép thay thế bên dưới không còn đúng.
    for (const pane of panes) expect(pane.className).toContain("pane");

    // Đọc selector thẳng từ file CSS: sửa CSS hoặc sửa markup của PlannerColumn / OrchestratorColumn mà lệch nhau thì test này đỏ.
    const selectors = [...chatCss.matchAll(/^(\.pane > section[^{]*)\{/gm)].map((m) => m[1]!.trim());
    expect(selectors).toContain(".pane > section > div:first-child > h2");
    expect(selectors.length).toBeGreaterThanOrEqual(6);
    for (const selector of selectors) {
      const scoped = selector.replace(/^\.pane/, ":scope");
      const hits = panes.flatMap((pane) => [...pane.querySelectorAll(scoped)]);
      expect(hits.length, `selector không còn trúng phần tử nào: ${selector}`).toBeGreaterThan(0);
    }

    // Các quy tắc chung cho cả hai cột phải trúng ở cả hai pane, và chỉ ẩn đúng tiêu đề trùng nhãn tab.
    for (const [i, name] of ["Planner", "Orchestrator"].entries()) {
      const pane = panes[i]!;
      expect(pane.querySelectorAll(":scope > section")).toHaveLength(1);
      const hidden = pane.querySelectorAll(":scope > section > div:first-child > h2");
      expect([...hidden].map((h) => h.textContent)).toEqual([name]);
      // CSS của khung chat được nạp thật trong test (vitest.config.ts): tiêu đề trùng nhãn tab đúng là bị ẩn.
      expect(getComputedStyle(hidden[0]!).display).toBe("none");
      expect(pane.querySelector(":scope > section > div:nth-child(2)")).toBeTruthy();
      expect(pane.querySelector(":scope > section > div:nth-child(3) textarea")).toBeTruthy();
    }
  });

  it("tablist: phím mũi tên đổi tab và giữ focus trên tab mới, không nhảy vào ô nhập", async () => {
    await renderOffice();
    const chat = screen.getByRole("complementary", { name: "Chat với agent" });
    const plannerTab = within(chat).getByRole("tab", { name: /Planner/ });
    const orchestratorTab = within(chat).getByRole("tab", { name: /Orchestrator/ });
    plannerTab.focus();

    fireEvent.keyDown(plannerTab, { key: "ArrowRight" });
    expect(orchestratorTab.getAttribute("aria-selected")).toBe("true");
    expect(document.activeElement).toBe(orchestratorTab);
    // Roving tabindex: chỉ tab đang chọn nằm trong thứ tự Tab.
    expect(orchestratorTab.tabIndex).toBe(0);
    expect(plannerTab.tabIndex).toBe(-1);

    fireEvent.keyDown(orchestratorTab, { key: "ArrowLeft" });
    expect(plannerTab.getAttribute("aria-selected")).toBe("true");
    expect(document.activeElement).toBe(plannerTab);

    // Bấm tab cũng không đẩy focus vào ô nhập.
    fireEvent.click(orchestratorTab);
    expect(orchestratorTab.getAttribute("aria-selected")).toBe("true");
    expect(document.activeElement?.tagName).not.toBe("TEXTAREA");
  });

  it("mở chat từ bên ngoài (robot, nút dock) thì focus vào ô nhập của tab đó", async () => {
    const main = await renderOffice();
    const chat = screen.getByRole("complementary", { name: "Chat với agent" });
    fireEvent.click(within(main).getByRole("button", { name: /^Orchestrator, rảnh/ }));
    expect(document.activeElement).toBe(within(chat).getByLabelText("Nhắn cho orchestrator"));

    fireEvent.click(within(chat).getByRole("button", { name: "Thu gọn khung chat" }));
    fireEvent.click(within(chat).getByRole("button", { name: /^Mở chat Planner/ }));
    expect(document.activeElement).toBe(within(chat).getByLabelText("Nhắn cho planner"));
  });

  it("thu gọn trả focus: về robot đã mở nếu còn trong trang, không thì về nút dock của tab đang chọn", async () => {
    visit("?view=office&scenario=still&chat=closed");
    const main = await renderOffice();
    const chat = screen.getByRole("complementary", { name: "Chat với agent" });

    // Mở bằng nút dock: nút đó bị gỡ khi khung mở, nên thu gọn phải đưa focus về nút dock mới của tab đang chọn.
    fireEvent.click(within(chat).getByRole("button", { name: /^Mở chat Orchestrator/ }));
    fireEvent.keyDown(within(chat).getByLabelText("Nhắn cho orchestrator"), { key: "Escape" });
    expect(document.activeElement).toBe(within(chat).getByRole("button", { name: /^Mở chat Orchestrator/ }));

    // Mở bằng dock, đổi tab bằng phím mũi tên rồi thu gọn bằng nút: về nút dock của tab mới.
    fireEvent.click(within(chat).getByRole("button", { name: /^Mở chat Orchestrator/ }));
    const orchestratorTab = within(chat).getByRole("tab", { name: /Orchestrator/ });
    orchestratorTab.focus();
    fireEvent.keyDown(orchestratorTab, { key: "ArrowLeft" });
    fireEvent.click(within(chat).getByRole("button", { name: "Thu gọn khung chat" }));
    expect(document.activeElement).toBe(within(chat).getByRole("button", { name: /^Mở chat Planner/ }));
    expect(document.activeElement).not.toBe(document.body);

    // Mở bằng robot (vẫn còn trong trang): thu gọn trả focus về chính robot đó.
    const robot = within(main).getByRole("button", { name: /^Orchestrator, rảnh/ });
    fireEvent.click(robot);
    fireEvent.keyDown(within(chat).getByLabelText("Nhắn cho orchestrator"), { key: "Escape" });
    expect(document.activeElement).toBe(robot);
  });

  it("thu gọn còn dock 2 avatar có nhãn; Escape trong khung cũng thu gọn", async () => {
    await renderOffice();
    const chat = screen.getByRole("complementary", { name: "Chat với agent" });
    fireEvent.click(within(chat).getByRole("button", { name: "Thu gọn khung chat" }));
    const open = within(chat).getByRole("button", { name: "Mở chat Planner, 1 bản nháp chờ duyệt" });
    expect(within(chat).getByRole("button", { name: /^Mở chat Orchestrator/ })).toBeTruthy();
    expect(localStorage.getItem(OFFICE_STORAGE_KEYS.chatDock)).toBe("planner:closed");
    fireEvent.click(open);
    expect(within(chat).queryByRole("button", { name: /^Mở chat Planner/ })).toBeNull();
    fireEvent.keyDown(within(chat).getByLabelText("Nhắn cho planner"), { key: "Escape" });
    expect(within(chat).getByRole("button", { name: /^Mở chat Planner/ })).toBeTruthy();
  });

  it("các kịch bản hệ thống có biển chữ trong cảnh, StatusBanners vẫn hiện", async () => {
    visit("?view=office&scenario=paused&chat=closed");
    let main = await renderOffice();
    expect(within(main).getByText("TẠM DỪNG GIAO VIỆC")).toBeTruthy();
    expect(screen.getByText("assign_task sẽ bị từ chối. Task đang chạy không bị ảnh hưởng.")).toBeTruthy();
    cleanup();

    visit("?view=office&scenario=disconnected&chat=closed");
    main = await renderOffice();
    expect(within(main).getByText("MẤT KẾT NỐI BACKEND")).toBeTruthy();
    expect(within(main).getByTestId("office-stage").getAttribute("data-frozen")).toBe("true");
    cleanup();

    visit("?view=office&scenario=crowd&chat=closed");
    main = await renderOffice();
    expect(within(main).getByRole("button", { name: /^Còn 2 worker đang làm, chưa có bàn/ })).toBeTruthy();
  });
});
