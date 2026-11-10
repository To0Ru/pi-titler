import { createHash } from "node:crypto";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { ConfigStore, isRecord, ORIGIN_ENTRY, resolveTitleModel } from "./config.ts";
import {
  branchCounts,
  buildEvidenceText,
  textContent,
  titlePrompt,
  userText,
} from "./context.ts";
import { sanitizeTitle } from "./sanitize.ts";

export type GenerationResult =
  | { status: "generated"; title: string }
  | { status: "unconfigured" | "busy" | "skipped" | "failed" };

interface Request {
  manual?: boolean;
  extra?: unknown;
}

interface SessionState {
  id: string;
  historical: boolean;
  users: number;
  isGenerating: boolean;
  controller?: AbortController;
  pending?: { ctx: ExtensionContext; request: Request };
  lastSignature?: string;
  retryAfter: number;
}

export class TitleEngine {
  private pi: ExtensionAPI;
  private configs: ConfigStore;
  private state?: SessionState;
  private timeoutMs: number;
  private cooldownMs: number;

  constructor(pi: ExtensionAPI, configs: ConfigStore, options: { timeoutMs?: number; cooldownMs?: number } = {}) {
    this.pi = pi;
    this.configs = configs;
    this.timeoutMs = options.timeoutMs ?? 15_000;
    this.cooldownMs = options.cooldownMs ?? 30_000;
  }

  /** Classify once and persist, so a new session remains eligible after a restart. */
  startSession(ctx: ExtensionContext): void {
    this.dispose();
    try {
      const entries = ctx.sessionManager.getEntries();
      const origin = [...entries].reverse().find((entry) => entry.type === "custom" && entry.customType === ORIGIN_ENTRY);
      const historical = origin?.type === "custom" && isRecord(origin.data) && typeof origin.data.historical === "boolean"
        ? origin.data.historical
        : entries.some((entry) => entry.type === "message" && entry.message.role === "user");
      const counts = branchCounts(ctx);
      this.state = {
        id: ctx.sessionManager.getSessionId(),
        historical,
        users: counts.users,
        isGenerating: false,
        retryAfter: 0,
      };
      if (!origin) this.pi.appendEntry(ORIGIN_ENTRY, { version: 1, historical });
    } catch {
      this.state = undefined;
    }
  }

  dispose(): void {
    this.state?.controller?.abort();
    this.state = undefined;
  }

  cancel(): void {
    if (!this.state) return;
    this.state.controller?.abort();
    this.state.pending = undefined;
    this.state.lastSignature = undefined;
    this.state.retryAfter = 0;
  }

  onUserMessage(ctx: ExtensionContext, message: unknown): void {
    try {
      const state = this.state;
      if (!state || !isRecord(message) || !userText(message.content)) return;
      // Pi emits message_end BEFORE appending it to the session file.
      state.users = branchCounts(ctx).users + 1;
      this.schedule(ctx, { extra: message });
    } catch {
      /* A secondary feature must not interrupt the conversation. */
    }
  }

  onSettled(ctx: ExtensionContext, aborted = false): void {
    if (!aborted) this.schedule(ctx);
  }

  private schedule(ctx: ExtensionContext, request: Request = {}): void {
    void this.generate(ctx, request);
  }

  async generate(ctx: ExtensionContext, request: Request = {}): Promise<GenerationResult> {
    const state = this.state;
    let ownsLock = false;
    try {
      if (!state || state.id !== ctx.sessionManager.getSessionId()) return { status: "skipped" };
      if (!request.manual && this.pi.getSessionName()?.trim()) return { status: "skipped" };
      if (state.isGenerating) {
        if (!request.manual) state.pending = { ctx, request };
        return { status: "busy" };
      }
      state.isGenerating = true;
      ownsLock = true;
      const controller = new AbortController();
      state.controller = controller;
      const originalName = this.pi.getSessionName();

      const evidence = buildEvidenceText(ctx, {
        manual: Boolean(request.manual),
        extraUserMessage: request.extra,
      });
      if (!evidence.hasUser) return { status: "skipped" };

      const config = await this.configs.effective(ctx);
      if (!request.manual && !config.autoNaming) return { status: "skipped" };
      if (!config.model) return { status: "unconfigured" };
      if (!request.manual && (state.historical && !config.nameHistoricalSessions || Date.now() < state.retryAfter)) {
        return { status: "skipped" };
      }
      if (controller.signal.aborted || this.state !== state) return { status: "skipped" };

      const force = Boolean(request.manual) || state.users >= 3;
      const signature = createHash("sha256")
        .update(JSON.stringify({ config, text: evidence.text, force, manual: Boolean(request.manual) }))
        .digest("hex");
      if (!request.manual && signature === state.lastSignature) return { status: "skipped" };
      state.lastSignature = signature;

      const candidates: Model<Api>[] = [];
      const primary = resolveTitleModel(ctx, config);
      if (primary) candidates.push(primary);
      if (
        config.fallbackToCurrentModel &&
        ctx.model &&
        ctx.modelRegistry.hasConfiguredAuth(ctx.model) &&
        !candidates.some((model) => model.id === ctx.model?.id && model.provider === ctx.model?.provider)
      ) {
        candidates.push(ctx.model);
      }

      for (const model of candidates) {
        if (controller.signal.aborted) return { status: "skipped" };
        try {
          const prompt = titlePrompt(config.maxWidth, force, Boolean(request.manual));
          const output = await this.requestTitle(ctx, model, prompt, evidence.text, controller.signal);
          if (controller.signal.aborted) return { status: "skipped" };
          // NO_TITLE is a deliberate semantic deferral, not a provider failure.
          if (!force && output.trim() === "NO_TITLE") return { status: "skipped" };
          const title = sanitizeTitle(output, config.maxWidth);
          if (!title) continue;

          // Honor external config edits made while the request was running.
          if (!request.manual && !(await this.configs.effective(ctx)).autoNaming) return { status: "skipped" };
          if (
            this.state !== state ||
            ctx.sessionManager.getSessionId() !== state.id ||
            this.pi.getSessionName() !== originalName ||
            controller.signal.aborted
          ) {
            return { status: "skipped" };
          }
          if (!request.manual && this.pi.getSessionName()?.trim()) return { status: "skipped" };

          this.pi.setSessionName(title);
          return { status: "generated", title };
        } catch {
          if (controller.signal.aborted) return { status: "skipped" };
        }
      }

      state.retryAfter = Date.now() + this.cooldownMs;
      return { status: "failed" };
    } catch {
      if (state) state.retryAfter = Date.now() + this.cooldownMs;
      return { status: "failed" };
    } finally {
      if (state && ownsLock) {
        state.isGenerating = false;
        state.controller = undefined;
        const pending = state.pending;
        state.pending = undefined;
        if (pending && this.state === state) this.schedule(pending.ctx);
      }
    }
  }

  private async requestTitle(
    ctx: ExtensionContext,
    model: Model<Api>,
    systemPrompt: string,
    content: string,
    parentSignal: AbortSignal
  ): Promise<string> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onAbort: (() => void) | undefined;
    try {
      const interrupted = new Promise<never>((_resolve, reject) => {
        onAbort = () => {
          controller.abort();
          reject(new Error("Title request cancelled"));
        };
        parentSignal.addEventListener("abort", onAbort, { once: true });
        timer = setTimeout(onAbort, this.timeoutMs);
        if (parentSignal.aborted) onAbort();
      });
      const stream = ctx.modelRegistry.streamSimple(
        model,
        {
          systemPrompt,
          messages: [{ role: "user", content, timestamp: Date.now() }],
        },
        {
          reasoning: "low",
          cacheRetention: "none",
          maxTokens: 256,
          maxRetries: 0,
          timeoutMs: this.timeoutMs,
          signal: controller.signal,
        }
      );
      const result = await Promise.race([stream.result(), interrupted]);
      if (result.stopReason === "error" || result.stopReason === "aborted" || result.stopReason === "length") {
        throw new Error("Title model did not complete successfully");
      }
      return textContent(result.content);
    } finally {
      if (timer) clearTimeout(timer);
      if (onAbort) parentSignal.removeEventListener("abort", onAbort);
      controller.abort();
    }
  }
}
