import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionCommandContext, ExtensionUIContext, KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import { DEFAULT_CONFIG } from "../extensions/config.ts";
import { displayWidth } from "../extensions/sanitize.ts";
import { SettingsPanel, showTitlerMenu, type SettingsChoice } from "../extensions/ui.ts";
import { harness } from "./helpers.ts";

test("Tab switches the edit scope without saving; Enter targets the visible scope", () => {
  let choice: SettingsChoice | undefined;
  let closed = false;
  const view = new SettingsPanel({ global: { ...DEFAULT_CONFIG }, session: { ...DEFAULT_CONFIG, maxWidth: 24 }, inherited: false },
    "session", 0, (value) => { choice = value; closed = true; }, () => undefined);
  assert.match(view.render(80).join("\n"), /\[本会话\]|独立配置/);
  const lines = view.render(80);
  assert.equal(lines[0], "─".repeat(80));
  assert.equal(lines.at(-1), "─".repeat(80));
  assert.ok(lines.some((line) => line.startsWith(" → 自动命名")));
  view.handleInput("\t");
  assert.equal(closed, false);
  assert.match(view.render(80).join("\n"), /\[全局\]/);
  view.handleInput("\r");
  assert.deepEqual(choice, { scope: "global", setting: "autoNaming", selected: 0 });
});

type NavigationStep =
  | { kind: "select"; title: string | RegExp; answer?: string; options?: string[] }
  | { kind: "settings"; keys: string[]; contains: RegExp };

function navigationContext(h: Awaited<ReturnType<typeof harness>>, steps: NavigationStep[]) {
  const notifications: string[] = [];
  const custom: ExtensionUIContext["custom"] = (factory) => new Promise((resolve, reject) => {
    const step = steps.shift();
    if (step?.kind !== "settings") { reject(new Error("Unexpected settings panel")); return; }
    const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text } as Theme;
    Promise.resolve(factory({ requestRender: () => undefined } as unknown as TUI,
      theme, {} as KeybindingsManager, resolve)).then((component) => {
      assert.match(component.render(80).join("\n"), step.contains);
      for (const key of step.keys) component.handleInput?.(key);
    }).catch(reject);
  });
  const ctx = {
    ...h.ctx,
    ui: {
      select: async (title: string, options: string[]) => {
        const step = steps.shift();
        assert.equal(step?.kind, "select");
        if (step.kind !== "select") throw new Error("Expected selector");
        if (typeof step.title === "string") assert.equal(title, step.title);
        else assert.match(title, step.title);
        if (step.options) assert.deepEqual(options, step.options);
        return step.answer;
      },
      custom,
      notify: (message: string) => notifications.push(message),
    },
  } as unknown as ExtensionCommandContext;
  return { ctx, notifications };
}

test("Esc returns model → provider → settings → home, preserving scope without saving", async (t) => {
  const h = await harness(t);
  const initialConfig = await h.configs.readGlobal();
  const steps: NavigationStep[] = [
    { kind: "select", title: "Titler", answer: "设置", options: ["重新生成当前会话标题", "设置"] },
    { kind: "settings", keys: ["\t", "j", "\r"], contains: /\[本会话\]/ },
    { kind: "select", title: /选择已配置鉴权的提供商/, answer: "test" },
    { kind: "select", title: "标题模型 · test" },
    { kind: "select", title: /选择已配置鉴权的提供商/ },
    { kind: "settings", keys: ["\x1b"], contains: /\[全局\]/ },
    { kind: "select", title: "Titler", options: ["重新生成当前会话标题", "设置"] },
  ];
  const { ctx, notifications } = navigationContext(h, steps);
  await showTitlerMenu(h.pi, ctx, h.configs, h.engine);
  assert.deepEqual(notifications, []);
  assert.equal(steps.length, 0);
  assert.deepEqual(await h.configs.readGlobal(), initialConfig);
  assert.equal(h.configs.readSession(h.ctx), undefined);
});

test("selecting a model saves to the visible scope and returns to settings before home", async (t) => {
  const h = await harness(t);
  const steps: NavigationStep[] = [
    { kind: "select", title: "Titler", answer: "设置" },
    { kind: "settings", keys: ["\t", "j", "\r"], contains: /\[本会话\]/ },
    { kind: "select", title: /选择已配置鉴权的提供商/, answer: "test" },
    { kind: "select", title: "标题模型 · test", answer: "main-large — Main model" },
    { kind: "settings", keys: ["\x1b"], contains: /标题模型\s+test\/main-large/ },
    { kind: "select", title: "Titler" },
  ];
  const { ctx, notifications } = navigationContext(h, steps);
  await showTitlerMenu(h.pi, ctx, h.configs, h.engine);
  assert.deepEqual(notifications, []);
  assert.equal(steps.length, 0);
  assert.deepEqual((await h.configs.readGlobal()).model, { provider: "test", id: "main-large" });
  assert.equal(h.configs.readSession(h.ctx), undefined);
});

test("scope switch clamps the selection, Escape cancels, and narrow terminals keep correct width", () => {
  let choice: SettingsChoice | undefined;
  let closed = false;
  const view = new SettingsPanel({ global: { ...DEFAULT_CONFIG }, session: { ...DEFAULT_CONFIG }, inherited: true },
    "session", 5, (value) => { choice = value; closed = true; }, () => undefined);
  view.handleInput("\t");
  view.handleInput("\r");
  assert.equal(choice?.setting, "maxWidth");
  for (const width of [0, 1, 12, 32, 80]) {
    for (const line of view.render(width)) assert.ok(displayWidth(line) <= width);
  }
  closed = false;
  view.handleInput("\x1b");
  assert.equal(closed, true);
  assert.equal(choice, undefined);
});

test("moving across settings keeps the help area, footer and frame at a fixed height", () => {
  const config = { ...DEFAULT_CONFIG, model: { provider: "提供商", id: "long-model-id-".repeat(20) } };
  for (const width of [28, 40, 68, 80]) {
    const view = new SettingsPanel({ global: config, session: config, inherited: true },
      "session", 0, () => undefined, () => undefined);
    const initial = view.render(width);
    const footer = (lines: string[]) => lines.findIndex((line) => line.includes("Tab"));
    for (let index = 0; index < 6; index++) {
      const lines = view.render(width);
      assert.equal(lines.length, initial.length, `selection ${index} at width ${width}`);
      assert.equal(footer(lines), footer(initial));
      assert.equal(lines.at(-1), "─".repeat(width));
      for (const line of lines) assert.ok(displayWidth(line) <= width);
      view.handleInput("j");
    }
  }
});

test("CJK labels share one value column and long model names stay on a single row", () => {
  const config = { ...DEFAULT_CONFIG, model: { provider: "提供商", id: "model" },
    fallbackToCurrentModel: true, nameHistoricalSessions: true, maxWidth: 42 };
  const view = new SettingsPanel({ global: config, session: config, inherited: false },
    "session", 0, () => undefined, () => undefined);
  const lines = view.render(80);
  const values = ["提供商/model", "会话模型", "开启", "42"];
  const columns = values.map((value) => {
    const line = lines.find((line) => line.includes(value));
    assert.ok(line, `missing ${value}`);
    return displayWidth(line.slice(0, line.indexOf(value)));
  });
  assert.equal(new Set(columns).size, 1);
  assert.equal(lines.find((line) => line.includes("恢复全局配置"))?.trim(), "恢复全局配置");
  const longConfig = { ...config, model: { provider: "提供商", id: "model".repeat(40) } };
  const longView = new SettingsPanel({ global: longConfig, session: longConfig, inherited: false },
    "session", 0, () => undefined, () => undefined);
  const longLines = longView.render(80);
  assert.equal(longLines.length, lines.length);
  assert.match(longLines.find((line) => line.includes("标题模型")) ?? "", /…/);
});
