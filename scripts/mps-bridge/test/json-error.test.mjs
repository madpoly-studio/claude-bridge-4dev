import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { jsonErrorOffset } from "../lib/json-error.mjs";
import { parseSettingsText } from "../lib/settings.mjs";

describe("m1: JSON syntax errors never echo file content", () => {
  it("an unquoted token (V8 'Unexpected token' form) keeps line/col and drops the source text", () => {
    const secret = "glpat-SECRET123";
    const r = parseSettingsText(`{\n  "jira": {\n    "personal_token": ${secret}\n  }\n}`);
    assert.equal(r.ok, false);
    assert.match(r.error, /^File không phải JSON hợp lệ \(dòng 3, cột 23\): Unexpected token\. /);
    assert.ok(!r.error.includes("SECRET"), r.error);
    assert.ok(!r.error.includes("personal_token"), r.error);
  });

  it("a broken literal is located too", () => {
    const r = parseSettingsText('{"a": tru}');
    assert.equal(r.ok, false);
    assert.match(r.error, /\(dòng 1, cột 7\): Unexpected token/);
    assert.ok(!r.error.includes("tru}"));
  });

  it("punctuation tokens are kept, they carry no secret", () => {
    const r = parseSettingsText('{"a": }');
    assert.equal(r.ok, false);
    assert.match(r.error, /\(dòng 1, cột 7\): Unexpected token '}'\. /);
  });

  it("V8 positional messages still report line/col without the position text", () => {
    const r = parseSettingsText('{\n  "a": 1,\n}');
    assert.match(r.error, /^File không phải JSON hợp lệ \(dòng 3, cột 1\): Expected double-quoted property name\. /);
  });
});

describe("jsonErrorOffset", () => {
  it("returns -1 for valid JSON", () => {
    assert.equal(jsonErrorOffset('{"a": [1, -2.5e3, true, null, "x\\"y"], "b": {}}'), -1);
  });

  it("finds the first error", () => {
    assert.equal(jsonErrorOffset('{"a" 1}'), 5);
    assert.equal(jsonErrorOffset("[1, 2,]"), 6);
    assert.equal(jsonErrorOffset('{"a": 1} x'), 9);
    assert.equal(jsonErrorOffset('{"a": "x'), 8);
  });
});
