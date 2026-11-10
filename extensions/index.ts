import { join } from "node:path";
import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { ConfigStore } from "./config.ts";
import { TitleEngine } from "./engine.ts";
import { showTitlerMenu } from "./ui.ts";

export default function titler(pi: ExtensionAPI): void {
  const configs = new ConfigStore(join(getAgentDir(), "titler.json"));
  const engine = new TitleEngine(pi, configs);

  pi.on("session_start", (_event, ctx) => engine.startSession(ctx));
  pi.on("session_tree", (_event, ctx) => engine.startSession(ctx));
  pi.on("session_shutdown", () => engine.dispose());
  pi.on("session_info_changed", () => engine.cancel());
  pi.on("message_end", (event, ctx) => {
    if (event.message.role === "user") engine.onUserMessage(ctx, event.message);
  });
  pi.on("agent_settled", (event, ctx) => engine.onSettled(ctx, event.aborted));
  pi.registerCommand("titler", {
    description: "自动会话命名：重新生成标题、选择模型和配置",
    handler: (_args, ctx) => showTitlerMenu(pi, ctx, configs, engine),
  });
}
