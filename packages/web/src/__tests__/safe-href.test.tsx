import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { ExternalLink } from "../components/common/ExternalLink";
import { safeHref } from "../lib/safe-href";
import { jiraBaseUrl, ticketUrl } from "../state/selectors";
import { makeTicket } from "./helpers";

afterEach(cleanup);

describe("safeHref", () => {
  it("chỉ nhận http/https tuyệt đối", () => {
    expect(safeHref("https://gitlab.x/g/p/-/merge_requests/1")).toBe("https://gitlab.x/g/p/-/merge_requests/1");
    expect(safeHref("  http://jira.x/browse/SH-1  ")).toBe("http://jira.x/browse/SH-1");
    expect(safeHref("HTTPS://Jira.X/a")).toBe("https://jira.x/a");
  });

  it("chặn scheme nguy hiểm, URL tương đối và giá trị lạ", () => {
    for (const bad of [
      "javascript:alert(1)",
      " JavaScript:alert(1)",
      "java\tscript:alert(1)",
      "data:text/html,<script>alert(1)</script>",
      "vbscript:msgbox(1)",
      "file:///etc/passwd",
      "//evil.example/x",
      "/relative/path",
      "not a url",
      "",
    ]) {
      expect(safeHref(bad), bad).toBeNull();
    }
    expect(safeHref(null)).toBeNull();
    expect(safeHref(undefined)).toBeNull();
    expect(safeHref(42)).toBeNull();
  });

  it("URL Jira suy ra bỏ qua ticket có URL không an toàn", () => {
    const tickets = [makeTicket({ key: "SH-1", url: "javascript:alert(1)//browse/SH-1" }), makeTicket({ key: "SH-2" })];
    expect(jiraBaseUrl(tickets)).toBe("https://jira.test");
    expect(ticketUrl("SH-1", tickets)).toBe("https://jira.test/browse/SH-1");
  });
});

describe("ExternalLink", () => {
  it("URL an toàn: link mở tab mới với noopener noreferrer", () => {
    render(<ExternalLink href="https://gitlab.x/mr/1">MR !1</ExternalLink>);
    const a = screen.getByRole("link", { name: "MR !1" });
    expect(a.getAttribute("href")).toBe("https://gitlab.x/mr/1");
    expect(a.getAttribute("target")).toBe("_blank");
    expect(a.getAttribute("rel")).toBe("noopener noreferrer");
  });

  it("URL không an toàn: chữ thường, không có link", () => {
    render(
      <ExternalLink href="javascript:alert(1)" fallback={<span>không hợp lệ</span>}>
        MR
      </ExternalLink>,
    );
    expect(screen.queryByRole("link")).toBeNull();
    expect(screen.getByText("không hợp lệ")).toBeTruthy();

    cleanup();
    render(<ExternalLink href="javascript:alert(1)">SH-1</ExternalLink>);
    expect(screen.queryByRole("link")).toBeNull();
    expect(screen.getByText("SH-1").tagName).toBe("SPAN");
  });
});
