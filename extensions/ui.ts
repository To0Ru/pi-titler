import { DynamicBorder, type ExtensionAPI, type ExtensionCommandContext, type Theme } from "@earendil-works/pi-coding-agent";
import { Container, getKeybindings, Key, matchesKey, Spacer, Text, truncateToWidth, visibleWidth, wrapTextWithAnsi, type Component } from "@earendil-works/pi-tui";
import { ConfigStore, type ConfigPatch, type ModelReference, type TitlerConfig } from "./config.ts";
import { TitleEngine } from "./engine.ts";

type Scope = "session" | "global";
type Setting = "autoNaming" | "model" | "fallbackToCurrentModel" | "nameHistoricalSessions" | "maxWidth" | "inherit";
export interface SettingsChoice { scope: Scope; setting: Setting; selected: number }
interface PanelData { global: TitlerConfig; session: TitlerConfig; inherited: boolean }
interface SettingRow { setting: Setting; label: string; value: string; description: string }
type PanelTheme = Pick<Theme, "fg" | "bold">;
const plainTheme: PanelTheme = { fg: (_color, text) => text, bold: (text) => text };

/** Small terminal view, kept separate from persistence and model requests. */
export class SettingsPanel implements Component {
  private data: PanelData;
  private scope: Scope;
  private selected: number;
  private done: (value: SettingsChoice | undefined) => void;
  private repaint: () => void;
  private theme: PanelTheme;

  constructor(data: PanelData, scope: Scope, selected: number,
    done: (value: SettingsChoice | undefined) => void, repaint: () => void,
    theme: PanelTheme = plainTheme) {
    this.data = data;
    this.scope = scope;
    this.selected = selected;
    this.done = done;
    this.repaint = repaint;
    this.theme = theme;
  }

  private rows(): SettingRow[] {
    const config = this.data[this.scope];
    const onOff = (value: boolean) => value ? "开启" : "关闭";
    const rows: SettingRow[] = [
      { setting: "autoNaming", label: "自动命名", value: onOff(config.autoNaming),
        description: "自动为未命名会话生成标题；关闭后仍可手动重新生成。" },
      { setting: "model", label: "标题模型", value: config.model ? `${config.model.provider}/${config.model.id}` : "未配置",
        description: "选择用于生成标题的模型；未配置时不自动命名。" },
      { setting: "fallbackToCurrentModel", label: "失败时改用", value: config.fallbackToCurrentModel ? "会话模型" : "关闭",
        description: "标题模型失败或不可用时，改用当前对话所用的模型。" },
      { setting: "nameHistoricalSessions", label: "历史会话命名", value: onOff(config.nameHistoricalSessions),
        description: "允许为启用插件前已有的会话自动补生成标题。" },
      { setting: "maxWidth", label: "标题宽度", value: String(config.maxWidth),
        description: "标题的最大显示宽度；一个汉字通常占 2。" },
    ];
    if (this.scope === "session") rows.push({ setting: "inherit", label: "恢复全局配置",
      value: "",
      description: "清除本会话的独立配置，重新跟随全局设置。" });
    return rows;
  }

  render(width: number): string[] {
    if (width <= 0) return [];
    const rows = this.rows();
    this.selected = Math.min(this.selected, rows.length - 1);
    const theme = this.theme;
    const tabs = this.scope === "session"
      ? `${theme.fg("accent", "[本会话]")}    ${theme.fg("muted", "全局")}`
      : `${theme.fg("muted", "本会话")}    ${theme.fg("accent", "[全局]")}`;
    const state = this.scope === "global" ? "所有继承全局的会话共用；不改写已有标题。"
      : this.data.inherited ? "正在继承全局；首次修改会固定整套会话配置。" : "使用会话独立配置；已停止与全局同步。";
    // Match Pi's ExtensionSelectorComponent, including its spacing and colors.
    // Always use the supplied theme: jiti's module cache may not share Pi's global theme.
    const container = new Container();
    const border = () => new DynamicBorder((text) => theme.fg("border", text));
    container.addChild(border());
    container.addChild(new Spacer(1));
    container.addChild(new Text(theme.fg("accent", theme.bold("Titler 设置")), 1, 0));
    container.addChild(new Spacer(1));
    container.addChild(new Text(tabs, 1, 0));
    container.addChild(new Text(theme.fg("muted", state), 1, 0));
    container.addChild(new Spacer(1));
    const maxLabelWidth = Math.max(...rows.map((row) => visibleWidth(row.label)));
    for (const [index, row] of rows.entries()) {
      const isSelected = index === this.selected;
      container.addChild({
        invalidate() {},
        render(rowWidth) {
          const padding = Math.min(1, Math.max(0, Math.floor((rowWidth - 1) / 2)));
          const innerWidth = Math.max(0, rowWidth - padding * 2);
          const labelWidth = Math.min(maxLabelWidth, Math.max(0, innerWidth - 6));
          const valueWidth = Math.max(0, innerWidth - labelWidth - 4);
          const label = truncateToWidth(row.label, labelWidth, "");
          const gap = " ".repeat(labelWidth - visibleWidth(label) + 2);
          const value = truncateToWidth(row.value, valueWidth, "…");
          const line = `${isSelected ? "→ " : "  "}${label}${gap}${value}`;
          return [" ".repeat(padding) + theme.fg(isSelected ? "accent" : "text",
            truncateToWidth(line, innerWidth, "")) + " ".repeat(padding)];
        },
      });
    }
    // Keep both scope tabs equally tall; global settings have no inheritance action.
    if (rows.length < 6) container.addChild(new Spacer(6 - rows.length));
    container.addChild(new Spacer(1));
    const description = rows[this.selected].description;
    container.addChild({
      invalidate() {},
      render(helpWidth) {
        const padding = Math.min(1, Math.max(0, Math.floor((helpWidth - 1) / 2)));
        const innerWidth = Math.max(1, helpWidth - padding * 2);
        const lines = wrapTextWithAnsi(description, innerWidth);
        // Two reserved lines prevent navigation from moving the footer and border.
        return Array.from({ length: 2 }, (_, index) => {
          const line = (lines[index] ?? "") + (index === 1 && lines.length > 2 ? "…" : "");
          return " ".repeat(padding) + theme.fg("muted", truncateToWidth(line, innerWidth, "…"));
        });
      },
    });
    container.addChild(new Spacer(1));
    container.addChild(new Text(theme.fg("dim", "Tab 切换范围  ↑↓ 选择  Enter 修改  Esc 返回首页"), 1, 0));
    container.addChild(new Spacer(1));
    container.addChild(border());
    return container.render(width).map((line) => truncateToWidth(line, width, ""));
  }

  invalidate(): void { /* No cached layout. */ }

  handleInput(input: string): void {
    const keys = getKeybindings();
    if (keys.matches(input, "tui.select.cancel")) { this.done(undefined); return; }
    if (matchesKey(input, Key.tab) || matchesKey(input, Key.shift("tab"))) {
      this.scope = this.scope === "session" ? "global" : "session";
      this.selected = Math.min(this.selected, this.rows().length - 1);
    } else if (keys.matches(input, "tui.select.up") || input === "k") {
      this.selected = Math.max(0, this.selected - 1);
    } else if (keys.matches(input, "tui.select.down") || input === "j") {
      this.selected = Math.min(this.rows().length - 1, this.selected + 1);
    } else if (keys.matches(input, "tui.select.confirm") || input === "\n") {
      this.done({ scope: this.scope, setting: this.rows()[this.selected].setting, selected: this.selected });
      return;
    }
    this.repaint();
  }
}

async function chooseModel(ctx: ExtensionCommandContext): Promise<ModelReference | null | undefined> {
  const models = ctx.modelRegistry.getAll().filter((model) => ctx.modelRegistry.hasConfiguredAuth(model));
  const clear = "不配置标题模型（停止自动命名）";
  const sessionId = ctx.sessionManager.getSessionId();
  while (ctx.sessionManager.getSessionId() === sessionId) {
    const provider = await ctx.ui.select("标题模型 · 选择已配置鉴权的提供商", [clear,
      ...Array.from(new Set(models.map((model) => model.provider))).sort()]);
    if (provider === undefined || ctx.sessionManager.getSessionId() !== sessionId) return undefined;
    if (provider === clear) return null;
    const available = models.filter((model) => model.provider === provider);
    const labels = available.map((model) => `${model.id} — ${model.name}`);
    const chosen = await ctx.ui.select(`标题模型 · ${provider}`, labels);
    if (ctx.sessionManager.getSessionId() !== sessionId) return undefined;
    if (chosen === undefined) continue; // Esc from models returns to providers.
    const model = available[labels.indexOf(chosen)];
    if (model) return { provider: model.provider, id: model.id };
  }
  return undefined;
}

async function editSettings(pi: ExtensionAPI, ctx: ExtensionCommandContext, configs: ConfigStore,
  engine: TitleEngine): Promise<void> {
  let scope: Scope = "session";
  let selected = 0;
  const sessionId = ctx.sessionManager.getSessionId();
  while (ctx.sessionManager.getSessionId() === sessionId) {
    const global = await configs.readGlobal();
    const snapshot = configs.readSession(ctx);
    const choice = await ctx.ui.custom<SettingsChoice | undefined>((tui, theme, _keys, done) =>
      new SettingsPanel({ global, session: snapshot ?? global, inherited: snapshot === undefined },
        scope, selected, done, () => tui.requestRender(), theme));
    if (!choice || ctx.sessionManager.getSessionId() !== sessionId) return;
    scope = choice.scope;
    selected = choice.selected;
    if (choice.setting === "inherit") {
      if (configs.readSession(ctx) !== undefined) {
        configs.restoreInheritance(pi);
        engine.cancel();
      }
      continue;
    }
    const current = scope === "session" ? await configs.effective(ctx) : await configs.readGlobal();
    let patch: ConfigPatch | undefined;
    if (choice.setting === "model") {
      const model = await chooseModel(ctx);
      if (model !== undefined && JSON.stringify(model) !== JSON.stringify(current.model)) patch = { model };
    } else if (choice.setting === "maxWidth") {
      const answer = await ctx.ui.input("标题显示宽度（8–120；一个汉字约占 2）", String(current.maxWidth));
      if (answer !== undefined) {
        const maxWidth = Number(answer.trim());
        if (!Number.isInteger(maxWidth) || maxWidth < 8 || maxWidth > 120) {
          ctx.ui.notify("请输入 8 到 120 之间的整数。", "warning");
        } else if (maxWidth !== current.maxWidth) patch = { maxWidth };
      }
    } else {
      patch = { [choice.setting]: !current[choice.setting] };
    }
    if (!patch || ctx.sessionManager.getSessionId() !== sessionId) continue;
    if (scope === "global") await configs.updateGlobal(patch);
    else await configs.updateSession(pi, ctx, patch);
    engine.cancel();
  }
}

export async function showTitlerMenu(pi: ExtensionAPI, ctx: ExtensionCommandContext,
  configs: ConfigStore, engine: TitleEngine): Promise<void> {
  try {
    if (ctx.mode !== "tui") {
      ctx.ui.notify(`/titler 菜单需要 Pi 交互终端。也可编辑配置文件：${configs.path}`, "warning");
      return;
    }
    const sessionId = ctx.sessionManager.getSessionId();
    while (ctx.sessionManager.getSessionId() === sessionId) {
      const choice = await ctx.ui.select("Titler", ["重新生成当前会话标题", "设置"]);
      if (!choice || ctx.sessionManager.getSessionId() !== sessionId) return;
      if (choice === "重新生成当前会话标题") {
        const result = await engine.generate(ctx, { manual: true });
        if (ctx.sessionManager.getSessionId() !== sessionId) return;
        const messages = {
          unconfigured: "请先在 /titler → 设置 → 标题模型中选择模型。",
          busy: "标题正在生成，请稍后重试。",
          skipped: "本次未修改标题；可能尚无对话内容或会话状态已变化。",
          failed: "未能生成标题，已保留原名。请检查模型与鉴权配置。",
        };
        ctx.ui.notify(result.status === "generated" ? `标题已更新：${result.title}` : messages[result.status],
          result.status === "generated" ? "info" : "warning");
        return;
      } else {
        await editSettings(pi, ctx, configs, engine);
      }
    }
  } catch (error) {
    ctx.ui.notify(`Titler：${error instanceof Error ? error.message : "操作失败，原有设置已保留。"}`, "warning");
  }
}
