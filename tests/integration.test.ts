import assert from "node:assert/strict";
import { dirname, resolve } from "node:path";
import { test } from "node:test";
import { discoverAndLoadExtensions, SessionManager, type ExtensionAPI, type ExtensionCommandContext, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { ConfigStore } from "../extensions/config.ts";
import { harness, response, temporaryDirectory, waitFor } from "./helpers.ts";

test("Pi 1.5.0 loads the package and dispatches actual registered events and /titler command", async (t) => {
  const h = await harness(t);
  const previousDirectory = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dirname(h.configs.path);
  const loaded = await (async () => {
    try { return await discoverAndLoadExtensions([resolve("extensions/index.ts")], process.cwd(), dirname(h.configs.path)); }
    finally {
      if (previousDirectory === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousDirectory;
    }
  })();
  assert.deepEqual(loaded.errors, []);
  assert.equal(loaded.extensions.length, 1);
  const extension = loaded.extensions[0];
  loaded.runtime.appendEntry = h.pi.appendEntry;
  loaded.runtime.getSessionName = h.pi.getSessionName;
  loaded.runtime.setSessionName = h.pi.setSessionName;
  const emit = async (event: { type: string; [key: string]: unknown }) => {
    for (const handler of extension.handlers.get(event.type) ?? []) await handler(event, h.ctx);
  };
  await emit({ type: "session_start", reason: "new" });
  assert.equal(extension.handlers.has("tool_execution_end"), false);
  const message = { role: "user", content: "实现标题配置菜单", timestamp: Date.now() };
  await emit({ type: "message_end", message });
  h.addUser(message.content);
  await waitFor(() => h.title !== undefined);
  assert.equal(h.requests.length, 1);
  const prompt = JSON.stringify(h.requests[0].context.messages);
  assert.match(prompt, /实现标题配置菜单/);
  const command = extension.commands.get("titler");
  assert.ok(command);
  h.setTitle("人工标题");
  let confirms = 0;
  const notifications: string[] = [];
  const ctx = {
    ...h.ctx,
    ui: {
      select: async () => "重新生成当前会话标题",
      confirm: async () => { confirms++; return false; },
      notify: (message: string) => notifications.push(message),
    },
  } as unknown as ExtensionCommandContext;
  await command.handler("", ctx);
  assert.equal(confirms, 0);
  assert.notEqual(h.title, "人工标题");
  assert.match(notifications[0], /标题已更新/);
  await emit({ type: "session_shutdown", reason: "quit" });
});

test("configuration snapshot survives a real Pi session file reopen", async (t) => {
  const directory = await temporaryDirectory(t);
  const manager = SessionManager.create(process.cwd(), directory);
  const configs = new ConfigStore(resolve(directory, "titler.json"));
  await configs.updateGlobal({ model: { provider: "test", id: "small" }, maxWidth: 48 });
  const ctx = { sessionManager: manager } as unknown as ExtensionContext;
  const pi = { appendEntry: (type: string, data: unknown) => { manager.appendCustomEntry(type, data); } } as ExtensionAPI;
  await configs.updateSession(pi, ctx, { fallbackToCurrentModel: true });
  manager.appendMessage({ role: "user", content: "实现配置菜单", timestamp: Date.now() });
  manager.appendMessage(response("好的"));
  const path = manager.getSessionFile();
  assert.ok(path);
  const restored = SessionManager.open(path);
  await configs.updateGlobal({ model: null, maxWidth: 20 });
  const config = await configs.effective({ sessionManager: restored } as unknown as ExtensionContext);
  assert.equal(config.maxWidth, 48);
  assert.equal(config.model?.id, "small");
  assert.equal(config.fallbackToCurrentModel, true);
});
