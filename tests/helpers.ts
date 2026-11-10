import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { TestContext } from "node:test";
import type { Api, AssistantMessage, Context, Model, ModelsSimpleStreamOptions } from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import { ConfigStore } from "../extensions/config.ts";
import { TitleEngine } from "../extensions/engine.ts";

export async function temporaryDirectory(t: TestContext): Promise<string> {
  const root = resolve(".tmp", "tests");
  await mkdir(root, { recursive: true });
  const directory = await mkdtemp(join(root, "titler-"));
  t.after(async () => {
    if (!directory.startsWith(`${root}\\`) && !directory.startsWith(`${root}/`)) throw new Error("Unexpected test path");
    await rm(directory, { recursive: true, force: true });
  });
  return directory;
}

export const TITLE_MODEL = { id: "title-small", provider: "test", name: "Title model", api: "openai-completions" } as Model<Api>;
export const MAIN_MODEL = { ...TITLE_MODEL, id: "main-large", name: "Main model" };
export function response(text: string): AssistantMessage {
  return {
    role: "assistant", content: [{ type: "text", text }], api: "openai-completions",
    provider: "test", model: "title-small", stopReason: "stop", timestamp: Date.now(),
    usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  };
}

export interface CapturedRequest { model: Model<Api>; context: Context; options?: ModelsSimpleStreamOptions }

export async function harness(t: TestContext, options: { configured?: boolean; historical?: boolean; timeoutMs?: number } = {}) {
  const directory = await temporaryDirectory(t);
  const configs = new ConfigStore(join(directory, "titler.json"));
  if (options.configured !== false) await configs.updateGlobal({ model: { provider: "test", id: "title-small" } });
  const entries: SessionEntry[] = [];
  const requests: CapturedRequest[] = [];
  let title: string | undefined;
  let sessionId = "session-a";
  let nextId = 0;
  let branch: SessionEntry[] | undefined;
  let authenticate = (_model: Model<Api>) => true;
  let responder: (request: CapturedRequest) => Promise<AssistantMessage> = async () => response("修复 OAuth 登录回调超时");
  const base = () => ({ id: String(++nextId), parentId: entries.at(-1)?.id ?? null, timestamp: new Date().toISOString() });
  const addUser = (text: string) => {
    const message = { role: "user" as const, content: text, timestamp: Date.now() };
    entries.push({ ...base(), type: "message", message });
    return message;
  };
  const addTool = (id: string, text = "tool result") => entries.push({ ...base(), type: "message", message: {
    role: "toolResult", toolCallId: id, toolName: "read", content: [{ type: "text", text }], isError: false, timestamp: Date.now(),
  } });
  if (options.historical) addUser("过去的任务");
  const api = {
    appendEntry(customType: string, data?: unknown) { entries.push({ ...base(), type: "custom", customType, data }); },
    getSessionName: () => title,
    setSessionName: (name: string) => { title = name; },
  } satisfies Pick<ExtensionAPI, "appendEntry" | "getSessionName" | "setSessionName">;
  const registry = {
    find: (provider: string, id: string) => [TITLE_MODEL, MAIN_MODEL].find((model) => model.provider === provider && model.id === id),
    hasConfiguredAuth: (model: Model<Api>) => authenticate(model),
    getAll: () => [TITLE_MODEL, MAIN_MODEL],
    streamSimple(model: Model<Api>, context: Context, options?: ModelsSimpleStreamOptions) {
      const request = { model, context, options };
      requests.push(request);
      const stream = createAssistantMessageEventStream();
      void responder(request).then((result) => stream.end(result), () => stream.end({ ...response(""), stopReason: "error" }));
      return stream;
    },
  } satisfies Pick<ExtensionContext["modelRegistry"], "find" | "hasConfiguredAuth" | "getAll" | "streamSimple">;
  const ctx = {
    mode: "tui", hasUI: true, model: MAIN_MODEL, modelRegistry: registry,
    sessionManager: { getSessionId: () => sessionId, getEntries: () => entries, getBranch: () => branch ?? entries },
  } as unknown as ExtensionContext;
  const pi = api as ExtensionAPI;
  const engine = new TitleEngine(pi, configs, { timeoutMs: options.timeoutMs ?? 500, cooldownMs: 30_000 });
  engine.startSession(ctx);
  t.after(() => engine.dispose());
  return {
    configs, ctx, pi, engine, entries, requests, addUser, addTool,
    get title() { return title; },
    setTitle: (name: string | undefined) => { title = name; },
    switchSession: () => { sessionId = "session-b"; },
    setBranch: (value: SessionEntry[]) => { branch = value; },
    authenticate: (fn: typeof authenticate) => { authenticate = fn; },
    respond: (fn: typeof responder) => { responder = fn; },
  };
}

export async function waitFor(condition: () => boolean): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Expected condition did not become true");
}
