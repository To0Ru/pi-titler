# AGENTS.md — pi-titler

Pi Coding Agent 的会话自动命名扩展。本文件每次会话都会加载进上下文，**只放长期有效、每个 Agent 都必须知道的内容**，保持简短。

## 文档分工

| 文件 | 内容 | 写法 |
| :--- | :--- | :--- |
| `AGENTS.md` | 硬性约束、模块地图、命令、协作约定 | 很少改动；不写讨论过程和进度 |
| `docs/design.md` | 当前产品行为（触发、取材、模型、菜单、配置） | 改行为时**原地改写**，只描述现状 |
| `docs/decisions.md` | 决策记录：背景、选项、结论、状态（提议/采纳/替代） | 讨论中的提议只写这里，并标“提议” |
| `CHANGELOG.md` | 面向用户的变更 | 实现落地后更新 |
| `README.md` | 安装、配置、使用 | 面向用户 |

* 开始改代码前先读 `design.md`，以及 `decisions.md` 中“采纳·待实现”一节。
* 只有用户确认过的方案才进 `design.md`；Agent 建议、待定问题进 `decisions.md`。
* 不要把聊天过程逐条抄进文档；记录结论和理由即可。进度靠测试、CHANGELOG 和版本控制体现。
* `docs/archive/` 是旧版长文档存档，仅供查阅，不再维护。

## 设计文档不是教条

`design.md` 记录的是**当前方案**，不是不可挑战的约束。若有更好的思路（例如不同的触发时机、取材方式），应主动提出并说明比现状好在哪里，经用户同意后再改。真正不可违背的只有下面的硬性约束。

## 硬性约束

1. **依赖**：`@earendil-works/pi-*` 宿主包只能放在 `peerDependencies` 与 `devDependencies`，严禁放进 `dependencies`（重复实例会破坏运行时）。
2. **模型调用**：只用 `ctx.modelRegistry.complete/streamSimple`，用 `hasConfiguredAuth(model)` 检查鉴权；不直接引入第三方 SDK。选项以宿主实际类型为准，不为旧字段绕过类型检查。
3. **静默容错**：自动命名失败（超时、限流、无密钥）一律在 engine 内吸收，不得打断用户会话；不写替代标题，保留 Pi 默认名称。
4. **标题保护**：自动命名绝不覆盖已有标题（`pi.getSessionName()` 非空即跳过）；只有用户在 `/titler` 主动重新生成时可以替换。生成前记录会话与原标题，写入前再次校验，防止写到切换后的会话或覆盖用户刚改的名字。
5. **只读当前分支**：取材使用 `getBranch()`，不混入 `/tree` 中的其他分支。
6. **不擅自选模型**：未指定标题模型时不自动探测、不自动使用会话模型。
7. **类型**：TypeScript `strict`，不用 `any`；路径与终端宽度处理兼容 Windows/Linux/macOS 与 CJK。

## 模块地图

| 文件 | 职责 |
| :--- | :--- |
| `extensions/index.ts` | 生命周期与事件订阅、`/titler` 注册；不放模型调用和文本处理 |
| `extensions/engine.ts` | 触发判断、生成锁、模型调用、超时与写入校验 |
| `extensions/context.ts` | 当前分支取材、计数、提示词；不调用模型 |
| `extensions/config.ts` | 全局配置文件、会话配置快照、模型解析与鉴权 |
| `extensions/ui.ts` | 菜单、设置、模型选择 |
| `extensions/sanitize.ts` | 纯函数：标题清洗、CJK 显示宽度 |

## 命令与环境

* `npm run check`：严格类型检查 + 全部测试（模型响应为模拟，不发外部请求）。
* 用户实际运行全局 Pi **1.5.0**（`C:/Users/Lenovo/AppData/Roaming/npm/pi.ps1`）；项目开发依赖固定 1.5.0。不要把其他项目的依赖版本当成用户版本。
* 宿主文档：`C:/Users/Lenovo/AppData/Roaming/npm/node_modules/@earendil-works/pi-coding-agent/docs`；核对行为时优先读宿主源码与类型。
* PowerShell 读取中文文件需显式 UTF-8。当前目录不是 Git 仓库。
* 用户验收方式：在 Pi 中 `/reload` 后实测。

## 协作约定

* 讨论阶段先给出取舍和建议，**不要把自己的建议当成已定规则去实现**；用户确认后再改代码。
* 需要用户做选择时，列出选项并允许自由补充；问题未答完不要结束轮次。
* 面向用户的称谓要无歧义（如区分“标题模型”和“会话模型”，不单独说“当前模型”）。
