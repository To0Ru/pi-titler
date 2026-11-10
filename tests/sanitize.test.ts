import assert from "node:assert/strict";
import { test } from "node:test";
import { displayWidth, sanitizeTitle, truncateTitle } from "../extensions/sanitize.ts";

test("titles use terminal width for mixed CJK and ASCII", () => {
  assert.equal(sanitizeTitle("标题：《修复 OAuth 回调超时》。"), "修复 OAuth 回调超时");
  assert.equal(truncateTitle("修复 OAuth 回调超时", 9), "修复 OAut");
  assert.equal(displayWidth(sanitizeTitle("汉".repeat(50))), 40);
});

test("grapheme boundaries survive width truncation", () => {
  assert.equal(truncateTitle("e\u0301x", 1), "e\u0301");
  assert.equal(truncateTitle("👩‍💻编码", 2), "👩‍💻");
  assert.equal(truncateTitle("👩‍💻编码", 1), "");
});

test("terminal controls, quotation wrappers and explanations do not reach titles", () => {
  assert.equal(sanitizeTitle('\x1b[31m"Title: Fix OAuth"\x1b[0m\nExplanation'), "Fix OAuth");
  assert.equal(sanitizeTitle("<think>private</think>\n修复登录"), "修复登录");
  assert.equal(sanitizeTitle("```text\n修复登录\n```"), "修复登录");
  assert.equal(sanitizeTitle("NO_TITLE"), "");
  assert.equal(sanitizeTitle("!!!"), "");
  assert.equal(sanitizeTitle("优化 C++ 与 .NET"), "优化 C++ 与 .NET");
});
