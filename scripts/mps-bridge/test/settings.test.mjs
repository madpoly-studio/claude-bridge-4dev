import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { isPathInside } from "../lib/paths.mjs";
import { parseSettingsFile, parseSettingsText, validateSettings } from "../lib/settings.mjs";
import { CA_FILE, REPO_A, REPO_B, WORKSPACE, abs, fakeFs, validRaw } from "./helpers.mjs";

const ctx = (fs = fakeFs()) => ({ workspace: WORKSPACE, fs });

/** @param {(raw: any) => void} mutate */
function errorsFor(mutate, fs) {
  const raw = validRaw();
  mutate(raw);
  const result = validateSettings(raw, ctx(fs));
  assert.equal(result.settings, null, "invalid settings must yield settings = null");
  return result.errors;
}

/** @param {string[]} errors @param {string} needle */
function assertHas(errors, needle) {
  assert.ok(errors.some((e) => e.includes(needle)), `expected an error containing ${JSON.stringify(needle)}, got:\n${errors.join("\n")}`);
}

describe("parseSettingsText", () => {
  it("S01 reports line and column", () => {
    const r = parseSettingsText('{\n  "a": 1,\n}');
    assert.equal(r.ok, false);
    assert.match(r.error, /^File không phải JSON hợp lệ \(dòng 3, cột 1\): /);
    assert.doesNotMatch(r.error, /position|line \d/);
  });

  it("accepts a UTF-8 BOM", () => {
    const r = parseSettingsText(`${String.fromCharCode(0xfeff)}{"a": 1}`);
    assert.deepEqual(r, { ok: true, raw: { a: 1 } });
  });

  it("strips _ keys at every depth, including inside arrays", () => {
    const r = parseSettingsText(JSON.stringify({ _x: 1, a: { _y: 2, b: [{ _z: 3, c: 4 }] } }));
    assert.deepEqual(r, { ok: true, raw: { a: { b: [{ c: 4 }] } } });
  });

  it("S00 for a missing file", () => {
    const r = parseSettingsFile(abs("does-not-exist", "settings.json"));
    assert.equal(r.ok, false);
    assert.match(r.error, /^Không tìm thấy .*settings\.json\. Chạy setup/);
  });

  it("reads a real file", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "mpsb-settings-"));
    try {
      const file = path.join(dir, "settings.json");
      writeFileSync(file, '{"_c": "x", "projects": ["SH"]}');
      assert.deepEqual(parseSettingsFile(file), { ok: true, raw: { projects: ["SH"] } });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("validateSettings: valid input", () => {
  it("normalises and applies defaults", () => {
    const raw = validRaw();
    delete raw.models;
    delete raw.ports;
    delete raw.max_concurrency;
    raw.repos.push({ name: "sh-tools", path: REPO_B.replace(/\\/g, "/"), project_key: "SH", base_branch: "main" });
    const r = validateSettings(raw, ctx());
    assert.deepEqual(r.errors, []);
    assert.ok(r.settings);
    assert.equal(r.settings.jira.url, "https://jira.example.com");
    assert.deepEqual(r.settings.ports, { bridge: 8787, web: 4173 });
    assert.deepEqual(r.settings.models, { planner: null, orchestrator: null, worker: null });
    assert.equal(r.settings.repos[1].workers, 1);
    assert.deepEqual(r.settings.repos[1].allowed_bash, []);
    assert.equal(r.settings.repos[1].path, REPO_B);
    assert.equal(r.settings.max_concurrency, 3, "Σ workers = 2 + 1");
    assert.deepEqual(r.warnings, []);
  });

  it("keeps an explicit max_concurrency and a CA bundle", () => {
    const raw = validRaw();
    raw.max_concurrency = 1;
    raw.jira.ca_bundle = CA_FILE;
    const r = validateSettings(raw, ctx());
    assert.equal(r.settings?.max_concurrency, 1);
    assert.equal(r.settings?.jira.ca_bundle, CA_FILE);
  });

  it("SW1 and SW2 warnings", () => {
    const raw = validRaw();
    raw.projects.push("OPS");
    raw.ports.bridge = 9000;
    const r = validateSettings(raw, ctx());
    assert.ok(r.settings);
    assertHas(r.warnings, "Project OPS chưa có repo nào");
    assertHas(r.warnings, "ws://127.0.0.1:9000/ws");
  });
});

describe("validateSettings: error catalogue", () => {
  const cases = [
    ["S02", () => null, "Nội dung gốc phải là một object"],
    ["S03 root", (r) => { r.repo = []; }, 'repo: Khóa "repo" không được hỗ trợ (gõ nhầm?). Khóa hợp lệ: jira, projects'],
    ["S03 nested", (r) => { r.repos[0].worker = 2; }, 'repos[0].worker: Khóa "worker" không được hỗ trợ'],
    ["S04", (r) => { r.jira.personal_token = "<JIRA_PERSONAL_TOKEN>"; }, 'jira.personal_token: Còn giá trị mẫu "<JIRA_PERSONAL_TOKEN>"'],
    ["S04 in list", (r) => { r.projects = ["<JIRA_PROJECT_KEY>"]; }, "projects[0]: Còn giá trị mẫu"],
    ["S04 repo path", (r) => { r.repos[0].path = "<DUONG_DAN_REPO>"; }, "repos[0].path: Còn giá trị mẫu"],
    ["S05", (r) => { delete r.jira.url; }, "jira.url: Thiếu giá trị bắt buộc."],
    ["S05 section", (r) => { delete r.jira; }, "jira: Thiếu giá trị bắt buộc."],
    ["S06 string", (r) => { r.repos[0].name = 5; }, "repos[0].name: Phải là chuỗi."],
    ["S06 list", (r) => { r.projects = "SH"; }, "projects: Phải là danh sách [...]."],
    ["S06 object", (r) => { r.ports = 8787; }, "ports: Phải là object {...}."],
    ["S06 string or null", (r) => { r.jira.ca_bundle = 1; }, "jira.ca_bundle: Phải là chuỗi hoặc null."],
    ["S10", (r) => { r.jira.url = "ftp://jira"; }, "jira.url: Phải là URL http(s) hợp lệ"],
    ["S11", (r) => { r.jira.personal_token = "abc def"; }, "jira.personal_token: Token không được chứa khoảng trắng"],
    ["S12", (r) => { r.jira.ca_bundle = "certs/corp.pem"; }, "jira.ca_bundle: Phải là đường dẫn tuyệt đối"],
    ["S13", (r) => { r.jira.ca_bundle = abs("certs", "missing.pem"); }, "jira.ca_bundle: Không tìm thấy file"],
    ["S20", (r) => { r.projects = []; }, "projects: Cần ít nhất một Jira project key."],
    ["S21", (r) => { r.projects = ["sh"]; r.repos[0].project_key = "sh"; }, 'projects[0]: "sh" không đúng dạng project key'],
    ["S22", (r) => { r.projects = ["SH", "SH"]; }, 'projects[1]: "SH" bị lặp.'],
    ["S30", (r) => { r.repos = []; }, "repos: Cần ít nhất một repo."],
    ["S31", (r) => { r.repos[0].name = "bad name"; }, 'repos[0].name: "bad name" chỉ được chứa chữ, số'],
    ["S32", (r) => { r.repos.push({ ...r.repos[0], name: "SH-GAME", path: REPO_B }); }, 'repos[1].name: "SH-GAME" trùng với repos[0]'],
    ["S33", (r) => { r.repos[0].path = "repos/sh-game"; }, "repos[0].path: Phải là đường dẫn tuyệt đối"],
    ["S34", (r) => { r.repos[0].path = abs("repos", "missing"); }, "repos[0].path: Không tìm thấy thư mục"],
    ["S36", (r) => { r.repos[0].path = path.join(WORKSPACE, "repos", "x"); }, "repos[0].path: Repo nằm bên trong thư mục làm việc"],
    ["S37", (r) => { r.repos[0].path = abs(); }, "repos[0].path: Thư mục làm việc"],
    ["S38", (r) => { r.repos[0].project_key = "OPS"; }, 'repos[0].project_key: "OPS" không có trong projects.'],
    ["S39", (r) => { r.repos[0].base_branch = "feature/x.lock"; }, 'repos[0].base_branch: "feature/x.lock" không phải tên nhánh hợp lệ'],
    ["S39 dotdot", (r) => { r.repos[0].base_branch = "a..b"; }, "không phải tên nhánh hợp lệ"],
    ["S40", (r) => { r.repos[0].workers = 0; }, "repos[0].workers: Phải là số nguyên ≥ 1."],
    ["S41", (r) => { r.repos[0].allowed_bash = ["npm test", " "]; }, "repos[0].allowed_bash[1]: Phải là chuỗi lệnh không rỗng"],
    ["S50", (r) => { r.models.worker = 3; }, "models.worker: Phải là tên model (chuỗi) hoặc null."],
    ["S51", (r) => { r.ports.web = 80; }, "ports.web: Phải là số nguyên từ 1024 đến 65535."],
    ["S52", (r) => { r.ports.web = 8787; }, "ports: bridge và web không được trùng cổng."],
    ["S53", (r) => { r.max_concurrency = 0; }, "max_concurrency: Phải là số nguyên ≥ 1 hoặc null."],
  ];
  for (const [id, mutate, needle] of cases) {
    it(id, () => {
      if (id === "S02") {
        const r = validateSettings(null, ctx());
        assert.equal(r.settings, null);
        assertHas(r.errors, needle);
        return;
      }
      assertHas(errorsFor(mutate), needle);
    });
  }

  it("S35 when the folder has no .git", () => {
    const noGit = abs("repos", "plain");
    assertHas(errorsFor((r) => { r.repos[0].path = noGit; }, fakeFs({ dirs: [noGit] })), "không phải git repo (không có .git)");
  });

  it("collects every error in one pass", () => {
    const errors = errorsFor((r) => {
      r.jira.personal_token = "<JIRA_PERSONAL_TOKEN>";
      r.repos[0].base_branch = "<NHANH_GOC>";
      r.ports.web = 1;
    });
    assert.equal(errors.length, 3);
  });

  it("placeholder detection reports the JSON path of the template values", () => {
    const errors = errorsFor((r) => {
      r.projects = ["<JIRA_PROJECT_KEY>"];
      r.repos[0] = {
        name: "<TEN_REPO>",
        path: "<DUONG_DAN_REPO>",
        project_key: "<JIRA_PROJECT_KEY>",
        base_branch: "<NHANH_GOC>",
        workers: 1,
        allowed_bash: [],
      };
    });
    for (const p of ["projects[0]", "repos[0].name", "repos[0].path", "repos[0].project_key", "repos[0].base_branch"]) {
      assertHas(errors, `${p}: Còn giá trị mẫu`);
    }
  });
});

describe("containment", () => {
  it("is checked in both directions, case-insensitively on Windows", () => {
    const root = abs("Work", "Bridge");
    assert.equal(isPathInside(root, path.join(root, "repos", "a")), true);
    assert.equal(isPathInside(path.join(root, "repos"), root), false);
    assert.equal(isPathInside(root, `${root}-evil`), false);
    if (process.platform === "win32") {
      assert.equal(isPathInside(root, path.join(root.toUpperCase(), "x")), true);
    }
  });

  it("S36 matches a differently-cased repo path on Windows", { skip: process.platform !== "win32" }, () => {
    assertHas(errorsFor((r) => { r.repos[0].path = path.join(WORKSPACE.toUpperCase(), "x"); }), "Repo nằm bên trong thư mục làm việc");
  });
});
