# Prompt for Me（Prompt 嘴替）

[English](README.md)

Prompt for Me 会根据 DeepSeek Harness 中有界的会话历史和本地建议交互，推测你下一句可能想说什么。它只把建议写入输入框，绝不会代替你发送。

## 功能

- 只在输入框操作区增加一个 Sparkles 按钮。
- 全流程使用同一个 Trigger：点击按钮，或按 `Mod+Shift+Space`。
- 第一次触发生成三条建议，之后每次触发依次换一条。
- 当前批次用完后自动请求新一批；新请求只排除刚看过的一批，不让提示词无限增长，因此可以持续换批。
- 建议只写入草稿。你可以按 Enter 发送、先编辑、全部删除，或继续 Trigger。
- 不绕过 Harness 权限审批、不调用工具、不自动发送消息。

## 安装

推荐安装 Release 中已经构建好的 tarball，不需要执行构建脚本：

```sh
dsh plugin --profile web add https://github.com/ChuanTianML/prompt-for-me/releases/download/v0.1.0/dsh-prompt-for-me-0.1.0.tgz
```

安装后重启 `dsh web`。

也可以安装固定 Git 标签：

```sh
dsh plugin --profile web add github:ChuanTianML/prompt-for-me#v0.1.0
```

使用 pnpm 10 从 Git 安装时，可能需要在 Web profile 的 `pnpm-workspace.yaml` 中为 `allowBuilds` 添加 `dsh-prompt-for-me: true`，然后重新运行命令。`prepare` 脚本只复制 checkout 中的 Host 文件并包装 Client factory，不会下载任何内容。

更新或卸载：

```sh
dsh plugin --profile web update dsh-prompt-for-me
dsh plugin --profile web remove dsh-prompt-for-me
```

## 模型和 API Key

插件在 Harness Host 上调用 `ctx.llm`。默认优先复用当前会话的 provider/model，没有时使用 Harness 默认模型，因此使用的就是 DeepSeek Harness 已配置的 API Key。浏览器拿不到也不会读取这个 Key，插件没有单独的 Key。

如需固定辅助模型，可在 `cordis.patch.yml` 或更高优先级的 profile patch 中同时配置：

```yaml
- id: prompt-for-me
  name: dsh-prompt-for-me
  config:
    provider: deepseek-official
    model: deepseek-chat
```

## 数据与隐私

每次生成建议时，Host 可能把下列有界文本发送给当前选择的模型提供方：

- 当前草稿；
- 当前会话中近期的用户和助手文本；
- 最多 20 个历史会话中的近期用户原始提示词；
- 最多 50 条本地建议交互，如“换一条”“编辑”“原样提交”；
- 刚看过的一批候选，用于避免重复。

常见 API Key、token、password 和 Bearer token 会在模型调用前替换为 `[REDACTED_SECRET]`。插件不会收集附件、工具参数、文件、凭证或二进制内容；没有分析上报服务，只会调用 Harness 已选择的模型路由。

建议交互只保存在当前浏览器 `localStorage` 的 `dsh.prompt-for-me.outcomes.v1`。可在浏览器控制台清除：

```js
localStorage.removeItem('dsh.prompt-for-me.outcomes.v1')
```

DeepSeek Harness `0.1.0-rc.6` 尚未提供下游插件注册自定义持久化 session event 的公开接口。因此独立版不会把辅助模型请求和建议结果追加到 Harness session log；强行写入会导致原版运行时无法重新读取会话。这是独立版与实验性仓库内实现的主要差异，待官方开放事件注册接口后再补齐。

## 配置

所有生成限制均可在 `cordis.patch.yml` 中配置：

| 字段 | 默认值 | 含义 |
| --- | ---: | --- |
| `candidateCount` | `3` | 每批必须返回的建议数量。 |
| `maxCandidateBytes` | `4096` | 单条建议 UTF-8 上限。 |
| `maxDraftBytes` | `32768` | 草稿或编辑结果 UTF-8 上限。 |
| `maxCurrentContextBytes` | `65536` | 当前会话文本 JSON 预算。 |
| `maxHistorySessions` | `20` | 检查的历史会话数。 |
| `maxHistoryMessages` | `100` | 保留的历史用户提示词数。 |
| `maxHistoryBytes` | `65536` | 历史提示词 JSON 预算。 |
| `maxLocalOutcomes` | `50` | 浏览器本地建议交互上限。 |
| `maxOutputTokens` | `2048` | 辅助模型输出预算。 |
| `timeoutMs` | `30000` | 辅助模型调用超时。 |
| `shortcut` | `Mod+Shift+Space` | 跨平台 Trigger，也可设为 `disabled`。 |

## 开发

需要 Node.js 22.19 或更高版本。

```sh
npm run check
```

该命令会重新构建 Host/Client 静态产物、运行 Node 测试，并检查 npm 包内容。

## License

MIT
