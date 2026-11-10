import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

export interface ModelReference { provider: string; id: string }
export interface TitlerConfig {
  version: 1;
  autoNaming: boolean;
  model: ModelReference | null;
  fallbackToCurrentModel: boolean;
  nameHistoricalSessions: boolean;
  maxWidth: number;
}
export type ConfigPatch = Partial<Omit<TitlerConfig, "version">>;
export const CONFIG_ENTRY = "pi-titler:config";
export const ORIGIN_ENTRY = "pi-titler:origin";
export const DEFAULT_CONFIG: Readonly<TitlerConfig> = Object.freeze({
  version: 1, autoNaming: true, model: null, fallbackToCurrentModel: false,
  nameHistoricalSessions: false, maxWidth: 40,
});

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseConfig(value: unknown): TitlerConfig {
  if (!isRecord(value)) throw new Error("Titler 配置必须是 JSON 对象。");
  if (value.version !== undefined && value.version !== 1) throw new Error("不支持此 Titler 配置版本。");
  const merged = { ...DEFAULT_CONFIG, ...value };
  let model: ModelReference | null = null;
  if (merged.model !== null) {
    if (!isRecord(merged.model) || typeof merged.model.provider !== "string" ||
        typeof merged.model.id !== "string" || !merged.model.provider.trim() || !merged.model.id.trim()) {
      throw new Error("model 必须是 null 或包含 provider、id 的对象。");
    }
    model = { provider: merged.model.provider.trim(), id: merged.model.id.trim() };
  }
  if (typeof merged.autoNaming !== "boolean" || typeof merged.fallbackToCurrentModel !== "boolean" ||
      typeof merged.nameHistoricalSessions !== "boolean") {
    throw new Error("自动命名、回退和历史会话开关必须是布尔值。");
  }
  if (!Number.isInteger(merged.maxWidth) || merged.maxWidth < 8 || merged.maxWidth > 120) {
    throw new Error("标题宽度必须是 8 到 120 之间的整数。");
  }
  return { version: 1, autoNaming: merged.autoNaming, model, fallbackToCurrentModel: merged.fallbackToCurrentModel,
    nameHistoricalSessions: merged.nameHistoricalSessions, maxWidth: merged.maxWidth };
}

function hasCode(error: unknown, code: string): boolean {
  return isRecord(error) && error.code === code;
}

/** No global cache: inherited sessions see edits from other Pi processes. */
export class ConfigStore {
  readonly path: string;
  constructor(path: string) { this.path = path; }

  async readGlobal(): Promise<TitlerConfig> {
    try {
      return parseConfig(JSON.parse((await readFile(this.path, "utf8")).replace(/^\uFEFF/, "")) as unknown);
    } catch (error) {
      if (hasCode(error, "ENOENT")) return { ...DEFAULT_CONFIG };
      throw error;
    }
  }

  /** Merge under an exclusive lock, then atomically replace only our own file. */
  async updateGlobal(patch: ConfigPatch): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    const lockPath = `${this.path}.lock`;
    let lock: Awaited<ReturnType<typeof open>> | undefined;
    for (let attempt = 0; attempt < 40; attempt++) {
      try { lock = await open(lockPath, "wx", 0o600); break; }
      catch (error) {
        if (!hasCode(error, "EEXIST")) throw error;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    }
    if (!lock) throw new Error(`配置文件正在使用中。若 Pi 曾异常退出，请检查并移除残留锁：${lockPath}`);
    const temporary = `${this.path}.${randomUUID()}.tmp`;
    try {
      const config = parseConfig({ ...await this.readGlobal(), ...patch });
      const output = await open(temporary, "wx", 0o600);
      try {
        await output.writeFile(`${JSON.stringify(config, null, 2)}\n`, "utf8");
        await output.sync();
      } finally { await output.close(); }
      await rename(temporary, this.path);
    } finally {
      await unlink(temporary).catch(() => undefined);
      await lock.close();
      await unlink(lockPath);
    }
  }

  readSession(ctx: ExtensionContext): TitlerConfig | undefined {
    // Settings belong to the whole session, so /tree navigation does not revert them.
    const entries = ctx.sessionManager.getEntries();
    for (let index = entries.length - 1; index >= 0; index--) {
      const entry = entries[index];
      if (entry.type !== "custom" || entry.customType !== CONFIG_ENTRY) continue;
      if (!isRecord(entry.data) || entry.data.version !== 1) throw new Error("无法读取会话 Titler 配置。");
      if (entry.data.mode === "inherit") return undefined;
      if (entry.data.mode === "snapshot") return parseConfig(entry.data.config);
      throw new Error("未知的 Titler 会话配置模式。");
    }
    return undefined;
  }

  async effective(ctx: ExtensionContext): Promise<TitlerConfig> {
    return this.readSession(ctx) ?? await this.readGlobal();
  }

  async updateSession(pi: ExtensionAPI, ctx: ExtensionContext, patch: ConfigPatch): Promise<void> {
    const sessionId = ctx.sessionManager.getSessionId();
    const config = parseConfig({ ...await this.effective(ctx), ...patch });
    if (ctx.sessionManager.getSessionId() !== sessionId) throw new Error("会话已切换，未保存配置。");
    pi.appendEntry(CONFIG_ENTRY, { version: 1, mode: "snapshot", config });
  }

  restoreInheritance(pi: ExtensionAPI): void {
    pi.appendEntry(CONFIG_ENTRY, { version: 1, mode: "inherit" });
  }
}

/** Resolve only the explicitly selected model; fallback is attempted by the engine. */
export function resolveTitleModel(ctx: ExtensionContext, config: TitlerConfig): Model<Api> | undefined {
  if (!config.model) return undefined;
  const model = ctx.modelRegistry.find(config.model.provider, config.model.id);
  return model && ctx.modelRegistry.hasConfiguredAuth(model) ? model : undefined;
}
