<div align="center">

# pi-titler

**给 [Pi Coding Agent](https://pi.dev) 的会话自动起一个好标题。**

用你指定的轻量模型，在后台为每个会话生成简短、准确、描述**这个会话具体在做什么**的标题。

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Pi](https://img.shields.io/badge/pi-%E2%89%A5%201.5.0-8A2BE2)](https://pi.dev)
[![Node](https://img.shields.io/badge/node-%E2%89%A5%2022.19-339933)](https://nodejs.org)

</div>

---

## 为什么需要它

Pi 默认把第一条用户消息当作会话名称。会话一多，`/resume` 列表里全是“你好”“看看这个项目”“继续”，很难找到要恢复的会话。同一个项目里开多个 Agent 时更明显，它们的开场白往往差不多。

pi-titler 读取当前会话的内容，用一次轻量模型调用生成标题。例如：

| Pi 默认名称 | pi-titler 生成的标题 |
| :--- | :--- |
| 你好 | 为博客添加 RSS 订阅 |
| 看看这个项目 | 排查 Docker 镜像构建失败 |
| 帮我看一下这个报错 | 修复 Redis 连接池泄漏 |
| 继续昨天的工作 | 购物车页面迁移到 Vue 3 |
| Can you check the tests? | Fix flaky Playwright login test |

## 特性

- **按会话任务命名**：标题描述这个 Agent 在做的具体任务，不会把同一项目的会话都叫成“开发 xxx 项目”。读文件、列目录这类准备动作不会被当成任务。
- **一次调用、上下文很短**：在本地把会话压缩成纯文本摘要，只保留用户请求、助手回复的开头和工具足迹（改了哪些文件、跑了哪些命令），再调用一次模型。即使是很长的会话，单次请求也只有约 1–2k token。
- **能分清主线和插曲**：手动重新生成时，按时间线和每段投入量判断主线任务，不会被最后几轮临时测试带偏。
- **中英文都能排好**：按终端显示宽度截断（一个汉字占 2 列），语言跟随你的消息，代码标识符保留原文。
- **不覆盖已有标题**：自动命名不会覆盖已有标题，包括你用 `/name` 设置的。失败时静默，不打断对话，也不会写入一个截断的替代标题。
- **费用可控**：只使用你明确指定的标题模型，不会自动挑选模型。失败后改用会话模型需要手动开启。
- **两级配置**：支持全局配置和单个会话的独立配置，可在 `/titler` 菜单中修改，也可直接编辑 JSON 文件。

## 安装

需要 Pi **≥ 1.5.0**、Node.js **≥ 22.19**。

```sh
pi install git:github.com/To0Ru/pi-titler
```

如果 Pi 已在运行，安装后执行 `/reload`。

<details>
<summary>其他安装方式</summary>

```sh
# 只在本次启动中试用，不写入设置
pi -e git:github.com/To0Ru/pi-titler

# 从本地目录安装（开发用）
git clone https://github.com/To0Ru/pi-titler.git
pi install ./pi-titler
```

</details>

## 快速开始

1. 在 Pi 中输入 `/titler`，进入 **设置**。
2. 按 **Tab** 切换到 **全局**，选择 **标题模型**，再选提供商和模型。列表只显示 Pi 中已配置鉴权的模型。
3. 正常对话即可，标题会在后台自动生成。

> [!NOTE]
> **未配置标题模型时，pi-titler 不会发送任何请求**，会话保持 Pi 的默认名称。建议选用速度快、价格低的小模型。

## 工作方式

### 自动命名

从会话开始到命名成功，会在以下时机尝试：

| 时机 | 行为 |
| :--- | :--- |
| 每次发送用户消息 | 与主模型同时发起请求。任务明确时，几秒内就会出现标题；只是问候或意图不清时先跳过。 |
| 每轮回答结束 | 结合助手的回复和工具足迹再试一次。 |
| 第 3 条用户消息 | 如果仍未命名，根据已有对话强制生成。 |

命名成功后标题保持不变，不会随对话进展自动改名。想更新时可以手动重新生成。

### 手动重新生成

`/titler` → **重新生成当前会话标题**，会根据整个会话的主线重新命名，并**直接替换**当前标题（包括手动设置的），无需确认。生成失败时保留原标题。

### 会发送给标题模型的内容

只读取 `/tree` 中的**当前分支**，在本地整理成纯文本摘要后发送：

| 包含 | 不包含 |
| :--- | :--- |
| 用户消息（代码块折叠为 `[代码 N 行]`） | 系统提示词、注入的 `AGENTS.md` 与环境信息 |
| 助手可见回复的开头 | 思考过程 |
| 工具足迹：`修改 src/app.ts×3｜命令 npm test` | 工具输出、编辑内容等参数正文 |
| 当前分支的 compaction 摘要（仅手动） | 其他分支及其摘要 |

## 配置

### `/titler` 菜单

```
/titler
├── 重新生成当前会话标题
└── 设置           Tab 切换「本会话 / 全局」
    ├── 自动命名        开启
    ├── 标题模型        provider/model-id
    ├── 失败时改用      关闭 | 会话模型
    ├── 历史会话命名    关闭
    ├── 标题宽度        40
    └── 恢复全局配置    （仅本会话）
```

↑↓ 选择，Enter 修改，Esc 逐级返回。

### 配置文件

全局配置位于 `~/.pi/agent/titler.json`；如果设置了 `PI_CODING_AGENT_DIR`，则位于该目录下。修改后对下一次命名立即生效。

```json
{
  "version": 1,
  "autoNaming": true,
  "model": { "provider": "openai", "id": "gpt-4o-mini" },
  "fallbackToCurrentModel": false,
  "nameHistoricalSessions": false,
  "maxWidth": 40
}
```

示例中的 `model` 仅作演示，请填写 Pi 模型列表中实际存在的提供商和模型标识。

| 字段 | 默认值 | 说明 |
| :--- | :--- | :--- |
| `autoNaming` | `true` | 是否自动命名。关闭后仍可手动重新生成。 |
| `model` | `null` | 标题模型 `{ provider, id }`。为 `null` 时不命名。 |
| `fallbackToCurrentModel` | `false` | 标题模型失败或不可用时，改用当前对话所用的模型。 |
| `nameHistoricalSessions` | `false` | 是否为安装插件前就存在的旧会话补生成标题。 |
| `maxWidth` | `40` | 标题最大显示宽度（8–120），一个汉字约占 2。 |

### 会话独立配置

会话默认实时继承全局配置。在 **本会话** 范围内**第一次保存任意修改**时，会复制当时完整的配置作为本会话的独立配置，此后整套配置都不再跟随全局。独立配置随会话保存，恢复会话后仍然有效。选择 **恢复全局配置** 可重新跟随全局。

## FAQ

<details>
<summary><b>为什么我的会话没有被命名？</b></summary>

依次检查：

- 是否已配置标题模型，并且该模型在 Pi 中已配置鉴权；
- 自动命名是否开启；
- 会话是否已有标题（自动命名不会覆盖）；
- 是否是安装插件前就存在的旧会话（需开启“历史会话命名”）。

模型调用失败后会等待 30 秒，下一次对话时再重试。也可以随时通过 `/titler` 手动生成。
</details>

<details>
<summary><b>会增加多少费用？</b></summary>

每次请求约 1–2k 输入 token，输出不超过几十个 token。通常一个会话只会成功命名一次。在任务明确之前，每条消息可能会触发一次很短的请求；内容相同的请求会去重。
</details>

<details>
<summary><b>会影响主对话吗？</b></summary>

不会。标题请求在后台独立进行，单次最多等待 15 秒，不会进入主模型的上下文。所有错误都在插件内部处理。
</details>

<details>
<summary><b>非交互模式（print / RPC）能用吗？</b></summary>

自动命名可以使用；`/titler` 菜单只在 TUI 中可用，其他模式请直接编辑配置文件。
</details>

## 开发

```sh
git clone https://github.com/To0Ru/pi-titler.git
cd pi-titler
npm ci
npm run check   # 严格类型检查 + 测试
pi -e ./extensions/index.ts   # 在 Pi 中加载本地代码试用
```

测试使用 Pi 1.5.0 的真实扩展加载器与会话管理器，模型响应为模拟数据，不会使用你的密钥或产生费用。架构与设计说明见 [`docs/design.md`](docs/design.md)，设计取舍见 [`docs/decisions.md`](docs/decisions.md)。

欢迎提交 Issue 和 PR。

## License

[MIT](LICENSE)
