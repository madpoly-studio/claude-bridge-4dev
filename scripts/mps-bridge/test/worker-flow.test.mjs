import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { WORKER_FAIL_CATEGORIES, WORKER_PHASES, humanCommand, renderWorkerFlow } from "../lib/worker-flow.mjs";

const input = {
  repo: "sh-game",
  projectKey: "SH",
  baseBranch: "release/1.2",
  testCommands: ["npm test", "dotnet build:*"],
  workspace: "D:/mps-claude-bridge",
};

describe("renderWorkerFlow", () => {
  it("mentions every phase and fail category in backticks", () => {
    const md = renderWorkerFlow(input);
    for (const word of [...WORKER_PHASES, ...WORKER_FAIL_CATEGORIES]) {
      assert.ok(md.includes(`\`${word}\``), `missing \`${word}\``);
    }
  });

  it("substitutes the base branch in the checkout and push lines", () => {
    const md = renderWorkerFlow(input);
    assert.ok(md.includes("git checkout -B feature/<ticket_key>-<slug> origin/release/1.2"));
    assert.ok(md.includes("-o merge_request.target=release/1.2 "));
    assert.ok(md.startsWith("# Flow worker cho repo sh-game\n"));
    assert.ok(md.includes("(project SH)"));
    assert.doesNotMatch(md, /\{\{|\}\}/);
    assert.doesNotMatch(md, /\r/);
  });

  it("M1: rebases only a new branch; a reused remote branch merges the base instead", () => {
    const md = renderWorkerFlow(input);
    const pushing = md.slice(md.indexOf("### 5. pushing"), md.indexOf("### 6. mr_created"));
    const rebaseAt = pushing.indexOf("**Nhánh mới**");
    const mergeAt = pushing.indexOf("**Nhánh dùng lại**");
    assert.ok(rebaseAt !== -1 && mergeAt > rebaseAt);
    assert.ok(pushing.slice(rebaseAt, mergeAt).includes("`git rebase origin/release/1.2`"));
    assert.ok(pushing.slice(rebaseAt, mergeAt).includes("`git rebase --abort`"));
    const reused = pushing.slice(mergeAt);
    assert.ok(reused.includes("**không** rebase"));
    assert.ok(reused.includes("`git merge --no-edit origin/release/1.2`"));
    assert.ok(reused.includes("`git merge --abort`"));
    assert.ok(reused.includes('fail_task(category="conflict"'));
    assert.ok(md.includes("**nhánh dùng lại**") && md.includes("(**nhánh mới**)"), "step 2 tells the worker which case it is in");
  });

  it("M2: forbids reading outside the worktree and names the workspace", () => {
    const md = renderWorkerFlow(input);
    assert.ok(md.includes("Không đọc, tìm kiếm, liệt kê hay sửa bất kỳ thứ gì ngoài"));
    assert.ok(md.includes("`git diff --no-index`"));
    assert.ok(md.includes("`D:/mps-claude-bridge` ngoài worktree của bạn"));
  });

  it("lists the test commands as a person would type them, or says there are none", () => {
    const md = renderWorkerFlow({ ...input, testCommands: ["npm test", "dotnet build:*", "Bash(make check:*)"] });
    assert.ok(md.includes("Lệnh build/test được phép chạy: `npm test`, `dotnet build`, `make check`"));
    assert.ok(renderWorkerFlow({ ...input, testCommands: [] }).includes("(không có lệnh nào được cấu hình"));
  });

  it("keeps $ sequences in user values literally", () => {
    assert.ok(renderWorkerFlow({ ...input, testCommands: ["echo $&"] }).includes("`echo $&`"));
  });
});

describe("humanCommand (m8)", () => {
  it("strips the Bash(...) wrapper and a trailing :*", () => {
    assert.equal(humanCommand("Bash(npm test)"), "npm test");
    assert.equal(humanCommand("dotnet build:*"), "dotnet build");
    assert.equal(humanCommand(" Bash(git log:*) "), "git log");
    assert.equal(humanCommand("make"), "make");
  });
});
