import assert from "node:assert/strict";
import { test } from "node:test";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
  AUTO_TOKEN_BUDGET,
  autoTitlePrompt,
  buildEvidenceText,
  estimateTokens,
  MANUAL_TOKEN_BUDGET,
  manualTitlePrompt,
} from "../extensions/context.ts";
import { harness, MAIN_MODEL, response, waitFor } from "./helpers.ts";

test("automatic naming can be disabled and re-enabled while manual generation remains available", async (t) => {
  const h = await harness(t);
  h.addUser("修复登录");
  await h.configs.updateGlobal({ autoNaming: false });
  assert.equal((await h.engine.generate(h.ctx)).status, "skipped");
  assert.equal(h.requests.length, 0);
  assert.equal(h.title, undefined);
  assert.equal((await h.engine.generate(h.ctx, { manual: true })).status, "generated");
  h.setTitle(undefined);
  await h.configs.updateGlobal({ autoNaming: true });
  assert.equal((await h.engine.generate(h.ctx)).status, "generated");
});

test("disabling automatic naming during a request prevents the late title from being applied", async (t) => {
  const h = await harness(t);
  h.addUser("修复登录");
  let release!: (message: AssistantMessage) => void;
  h.respond(() => new Promise((resolve) => { release = resolve; }));
  const pending = h.engine.generate(h.ctx);
  await waitFor(() => h.requests.length === 1);
  await h.configs.updateGlobal({ autoNaming: false });
  release(response("迟到的标题"));
  assert.equal((await pending).status, "skipped");
  assert.equal(h.title, undefined);
});

test("no configured model means no request, even with fallback enabled or a manual action", async (t) => {
  const h = await harness(t, { configured: false });
  h.addUser("修复登录");
  await h.configs.updateGlobal({ fallbackToCurrentModel: true });
  assert.equal((await h.engine.generate(h.ctx, { manual: true })).status, "unconfigured");
  assert.equal(h.requests.length, 0);
  assert.equal(h.title, undefined);
});

test("clear first user message triggers naming immediately with plain text evidence", async (t) => {
  const h = await harness(t);
  const msg = { role: "user" as const, content: "修复 OAuth 登录回调超时", timestamp: Date.now() };
  h.engine.onUserMessage(h.ctx, msg);
  await waitFor(() => h.title !== undefined);
  assert.equal(h.requests.length, 1);
  const userContent = String(h.requests[0].context.messages[0].content);
  assert.match(userContent, /用户请求：/);
  assert.match(userContent, /修复 OAuth 登录回调超时/);
  assert.doesNotMatch(userContent, /^{/); // 不是 JSON 格式
  assert.equal(h.requests[0].options?.cacheRetention, "none");
  assert.equal(h.requests[0].options?.reasoning, "low");
  assert.equal(h.requests[0].options?.maxRetries, 0);
});

test("settlement names pure Q&A without any tools, but aborted runs do not trigger", async (t) => {
  const h = await harness(t);
  h.addUser("解释 OAuth 授权码流程");
  h.engine.onSettled(h.ctx, true);
  assert.equal(h.requests.length, 0);
  h.engine.onSettled(h.ctx);
  await waitFor(() => h.title !== undefined);
  assert.equal(h.requests.length, 1);
});

test("greetings defer with NO_TITLE without cooldown penalty, settled retries with tool footprint, third forces title", async (t) => {
  const h = await harness(t);
  // 模拟初次问候返回 NO_TITLE
  h.respond(async (request) => {
    const prompt = request.context.systemPrompt ?? "";
    return response(prompt.includes("Produce a concise") ? "日常交流" : "NO_TITLE");
  });

  h.addUser("你好");
  assert.equal((await h.engine.generate(h.ctx)).status, "skipped");
  assert.equal(h.title, undefined);

  // NO_TITLE 之后不进入 cooldown，加了工具后在 settled 时可以立即重新尝试
  h.entries.push({
    id: "tool-call-1",
    parentId: null,
    timestamp: new Date().toISOString(),
    type: "message",
    message: {
      ...response("已为你查询状态"),
      content: [
        { type: "text", text: "已为你查询状态" },
        { type: "toolCall", id: "c1", name: "read", arguments: { path: "README.md" } },
      ],
      timestamp: Date.now(),
    },
  });
  h.entries.push({
    id: "tool-res-1",
    parentId: "tool-call-1",
    timestamp: new Date().toISOString(),
    type: "message",
    message: {
      role: "toolResult",
      toolCallId: "c1",
      toolName: "read",
      content: [{ type: "text", text: "README_SECRET_CONTENT" }],
      isError: false,
      timestamp: Date.now(),
    },
  });

  // settled 触发
  h.engine.onSettled(h.ctx);
  await waitFor(() => h.requests.length >= 2);
  const settledEvidence = String(h.requests.at(-1)?.context.messages[0].content);
  assert.match(settledEvidence, /足迹：读取 README\.md（准备动作）/);
  assert.doesNotMatch(settledEvidence, /README_SECRET_CONTENT/); // 不泄露工具输出内容

  // 第 3 条消息强制命名，不再允许 NO_TITLE
  h.addUser("在吗");
  const third = { role: "user", content: "第三条问候", timestamp: Date.now() };
  h.engine.onUserMessage(h.ctx, third);
  await waitFor(() => h.title === "日常交流");
  assert.match(String(h.requests.at(-1)?.context.messages[0].content), /第三条问候/);
});

test("concurrent triggers share one request, automatic naming protects names, manual naming replaces", async (t) => {
  const h = await harness(t);
  h.addUser("修复登录");
  let release!: (message: AssistantMessage) => void;
  h.respond(() => new Promise((resolve) => { release = resolve; }));
  const first = h.engine.generate(h.ctx);
  await waitFor(() => h.requests.length === 1);
  assert.equal((await h.engine.generate(h.ctx)).status, "busy");
  release(response("修复登录"));
  await first;
  assert.equal(h.requests.length, 1);
  h.setTitle("用户手动标题");
  assert.equal((await h.engine.generate(h.ctx)).status, "skipped");
  h.respond(async () => response("重新生成的标题"));
  assert.equal((await h.engine.generate(h.ctx, { manual: true })).status, "generated");
  assert.equal(h.title, "重新生成的标题");
});

test("renaming while a request is running never gets overwritten", async (t) => {
  const h = await harness(t);
  h.addUser("修复登录");
  let release!: (message: AssistantMessage) => void;
  h.respond(() => new Promise((resolve) => { release = resolve; }));
  const pending = h.engine.generate(h.ctx, { manual: true });
  await waitFor(() => h.requests.length === 1);
  h.setTitle("更新后的用户标题");
  release(response("迟到的标题"));
  assert.equal((await pending).status, "skipped");
  assert.equal(h.title, "更新后的用户标题");
});

test("a late response cannot name another session after switching", async (t) => {
  const h = await harness(t);
  h.addUser("修复登录");
  let release!: (message: AssistantMessage) => void;
  h.respond(() => new Promise((resolve) => { release = resolve; }));
  const pending = h.engine.generate(h.ctx);
  await waitFor(() => h.requests.length === 1);
  h.switchSession();
  release(response("旧会话标题"));
  assert.equal((await pending).status, "skipped");
  assert.equal(h.title, undefined);
});

test("provider failures preserve names; current-model fallback requires an explicit opt-in", async (t) => {
  const h = await harness(t);
  h.addUser("修复登录");
  h.respond(async ({ model }) => {
    if (model.id !== MAIN_MODEL.id) throw new Error("429");
    return response("回退标题");
  });
  h.setTitle("原名");
  assert.equal((await h.engine.generate(h.ctx, { manual: true })).status, "failed");
  assert.equal(h.title, "原名");
  assert.deepEqual(h.requests.map((request) => request.model.id), ["title-small"]);
  await h.configs.updateGlobal({ fallbackToCurrentModel: true });
  assert.equal((await h.engine.generate(h.ctx, { manual: true })).status, "generated");
  assert.equal(h.title, "回退标题");
});

test("missing authentication never dispatches a request", async (t) => {
  const h = await harness(t);
  h.addUser("修复登录");
  h.authenticate(() => false);
  assert.equal((await h.engine.generate(h.ctx)).status, "failed");
  assert.equal(h.requests.length, 0);
});

test("a missing configured model only falls back when authorized", async (t) => {
  const h = await harness(t);
  h.addUser("修复登录");
  await h.configs.updateGlobal({ model: { provider: "removed", id: "missing" } });
  assert.equal((await h.engine.generate(h.ctx)).status, "failed");
  assert.equal(h.requests.length, 0);
  await h.configs.updateGlobal({ fallbackToCurrentModel: true });
  assert.equal((await h.engine.generate(h.ctx, { manual: true })).status, "generated");
  assert.equal(h.requests[0].model.id, MAIN_MODEL.id);
});

test("the third user message queued during generation is not lost after a semantic deferral", async (t) => {
  const h = await harness(t);
  h.addUser("你好");
  h.addUser("在吗");
  let release!: (message: AssistantMessage) => void;
  h.respond(() => new Promise((resolve) => { release = resolve; }));
  const first = h.engine.generate(h.ctx);
  await waitFor(() => h.requests.length === 1);
  h.engine.onUserMessage(h.ctx, { role: "user", content: "还在", timestamp: Date.now() });
  h.addUser("还在");
  h.respond(async () => response("日常交流"));
  release(response("NO_TITLE"));
  await first;
  await waitFor(() => h.title === "日常交流");
  assert.equal(h.requests.length, 2);
  assert.match(h.requests[1].context.systemPrompt ?? "", /Produce a concise/);
  assert.equal(String(h.requests[1].context.messages[0].content).split("还在").length - 1, 1);
});

test("timeout aborts the request, releases the lock and permits a later manual retry", async (t) => {
  const h = await harness(t, { timeoutMs: 20 });
  h.addUser("修复登录");
  h.respond(() => new Promise(() => undefined));
  assert.equal((await h.engine.generate(h.ctx)).status, "failed");
  assert.equal(h.requests[0].options?.signal?.aborted, true);
  assert.equal((await h.engine.generate(h.ctx)).status, "skipped");
  h.respond(async () => response("重新尝试"));
  assert.equal((await h.engine.generate(h.ctx, { manual: true })).status, "generated");
});

test("historical sessions stay excluded across reload until explicitly enabled", async (t) => {
  const h = await harness(t, { historical: true });
  h.addUser("继续过去的任务");
  h.engine.startSession(h.ctx);
  assert.equal((await h.engine.generate(h.ctx)).status, "skipped");
  assert.equal(h.requests.length, 0);
  await h.configs.updateGlobal({ nameHistoricalSessions: true });
  assert.equal((await h.engine.generate(h.ctx)).status, "generated");
});

test("a plugin-created session remains new when restored", async (t) => {
  const h = await harness(t);
  h.addUser("修复登录");
  h.engine.startSession(h.ctx);
  assert.equal((await h.engine.generate(h.ctx)).status, "generated");
});

test("evidence excludes system/AGENTS/branch_summary, folds code fences, and respects token budgets", async (t) => {
  const h = await harness(t);
  h.addUser("# AGENTS.md instructions for project\n<INSTRUCTIONS>SECRET_BACKGROUND</INSTRUCTIONS>");
  h.addUser("实现核心功能：\n```typescript\nconst a = 1;\nconst b = 2;\nconsole.log(a+b);\n```");
  h.addUser("好的"); // 琐碎消息，应合并
  h.addUser("顺便跑一下测试，不要改动其它部分");

  // 添加一些带有大段输出的工具和 edit 参数
  h.entries.push({
    id: "e-assistant-1",
    parentId: null,
    timestamp: new Date().toISOString(),
    type: "message",
    message: {
      ...response("已修改代码并测试"),
      content: [
        { type: "text", text: "已修改代码并测试" },
        { type: "toolCall", id: "t1", name: "edit", arguments: { path: "extensions/context.ts", oldText: "X".repeat(500), newText: "Y".repeat(500) } },
      ],
      timestamp: Date.now(),
    },
  });
  h.entries.push({
    id: "e-tool-1",
    parentId: "e-assistant-1",
    timestamp: new Date().toISOString(),
    type: "message",
    message: {
      role: "toolResult",
      toolCallId: "t1",
      toolName: "edit",
      content: [{ type: "text", text: "TOOL_SECRET_OUTPUT_12345" }],
      isError: false,
      timestamp: Date.now(),
    },
  });
  // 注入被放弃分支的 summary，应当被排除
  h.entries.push({
    id: "e-branch-summary",
    parentId: null,
    timestamp: new Date().toISOString(),
    type: "branch_summary",
    summary: "ABANDONED_BRANCH_SUMMARY",
  } as any);

  // 1. 自动模式证据检查
  const autoEvidence = buildEvidenceText(h.ctx, { manual: false });
  assert.ok(autoEvidence.hasUser);
  assert.match(autoEvidence.text, /\[代码 3 行\]/); // 代码块被折叠
  assert.doesNotMatch(autoEvidence.text, /SECRET_BACKGROUND/); // 排除 AGENTS.md 注入
  assert.doesNotMatch(autoEvidence.text, /ABANDONED_BRANCH_SUMMARY/); // 排除 branch_summary
  assert.doesNotMatch(autoEvidence.text, /TOOL_SECRET_OUTPUT/); // 排除工具输出正文
  assert.doesNotMatch(autoEvidence.text, /X{50}/); // 排除 edit 参数正文
  assert.match(autoEvidence.text, /足迹：修改 extensions\/context\.ts/); // 工具足迹提炼
  assert.ok(estimateTokens(autoEvidence.text) <= AUTO_TOKEN_BUDGET);

  // 2. 手动模式证据检查
  const manualEvidence = buildEvidenceText(h.ctx, { manual: true });
  assert.ok(manualEvidence.hasUser);
  assert.match(manualEvidence.text, /近期（最近 2 轮）：/);
  assert.match(manualEvidence.text, /整体足迹/);
  assert.ok(estimateTokens(manualEvidence.text) <= MANUAL_TOKEN_BUDGET);

  // 3. 提示词区分检查
  const autoPrompt = autoTitlePrompt(40, false);
  const manualPrompt = manualTitlePrompt(40);
  assert.notEqual(autoPrompt, manualPrompt);
  assert.match(autoPrompt, /NO_TITLE/);
  assert.match(manualPrompt, /main line/i);
});

test("long English and Chinese conversations stay strictly within token budgets", async (t) => {
  const h = await harness(t);
  // 模拟长会话：20 段不同任务与大量工具调用
  for (let i = 1; i <= 20; i++) {
    h.addUser(`这是第 ${i} 个任务：我们需要优化模块 ${i} 的数据库查询和索引性能。详细信息参考文档描述。`);
    h.entries.push({
      id: `call-${i}`,
      parentId: null,
      timestamp: new Date().toISOString(),
      type: "message",
      message: {
        ...response(`已完成第 ${i} 个优化步骤。`),
        content: [
          { type: "text", text: `已完成第 ${i} 个优化步骤。` },
          { type: "toolCall", id: `c-${i}`, name: "edit", arguments: { path: `src/module_${i}.ts` } },
          { type: "toolCall", id: `cb-${i}`, name: "bash", arguments: { command: `npm test -- filter=${i}` } },
        ],
        timestamp: Date.now(),
      },
    });
    h.entries.push({
      id: `res-${i}`,
      parentId: `call-${i}`,
      timestamp: new Date().toISOString(),
      type: "message",
      message: {
        role: "toolResult",
        toolCallId: `c-${i}`,
        toolName: "edit",
        content: [{ type: "text", text: "success" }],
        isError: false,
        timestamp: Date.now(),
      },
    });
  }

  const autoEv = buildEvidenceText(h.ctx, { manual: false });
  assert.ok(estimateTokens(autoEv.text) <= AUTO_TOKEN_BUDGET);

  const manualEv = buildEvidenceText(h.ctx, { manual: true });
  assert.ok(estimateTokens(manualEv.text) <= MANUAL_TOKEN_BUDGET);
  // 验证包含分段时间线与更早段合并
  assert.match(manualEv.text, /时间线（较早）：/);
  assert.match(manualEv.text, /更早 \d+ 段/);
});
