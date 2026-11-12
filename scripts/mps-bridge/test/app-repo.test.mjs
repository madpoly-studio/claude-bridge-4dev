import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { normaliseRepoUrl } from "../lib/app-repo.mjs";

const OFFICIAL = "github.com/madpoly-studio/claude-bridge-4dev";

describe("normaliseRepoUrl (m4)", () => {
  for (const url of [
    "https://github.com/madpoly-studio/claude-bridge-4dev.git",
    "https://github.com/madpoly-studio/claude-bridge-4dev/",
    "https://someone@github.com/madpoly-studio/claude-bridge-4dev.git",
    "HTTPS://GitHub.com/Madpoly-Studio/claude-bridge-4dev",
    "git@github.com:madpoly-studio/claude-bridge-4dev.git",
    "git@github.com:madpoly-studio/claude-bridge-4dev",
    "ssh://git@github.com/madpoly-studio/claude-bridge-4dev.git",
    "ssh://git@github.com:22/madpoly-studio/claude-bridge-4dev.git",
  ]) {
    it(url, () => assert.equal(normaliseRepoUrl(url), OFFICIAL));
  }

  it("keeps different repos different", () => {
    assert.notEqual(normaliseRepoUrl("git@github.com:someone-else/claude-bridge-4dev.git"), OFFICIAL);
    assert.notEqual(normaliseRepoUrl("https://gitlab.example.com/madpoly-studio/claude-bridge-4dev.git"), OFFICIAL);
  });

  it("setup.mjs carries an identical copy (it cannot import lib/)", () => {
    const body = (file) => {
      const text = readFileSync(new URL(file, import.meta.url), "utf8");
      const start = text.indexOf("function normaliseRepoUrl(url) {");
      return text.slice(start, text.indexOf("\n}\n", start));
    };
    assert.equal(body("../setup.mjs"), body("../lib/app-repo.mjs"));
  });
});
