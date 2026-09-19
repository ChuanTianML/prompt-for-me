# Changelog

## 0.6.1

### 修复

- 自动建议生成期间，添加图片、进入计划模式、产生排队意图或会话状态变化会取消请求，迟到结果不再出现。原生输入框拒绝建议时，不再错误地显示预览卡片；旧客户端的预览降级保持不变。
- 保存设置期间继续修改自动建议开关、快捷键或模型时，新修改会保留为未保存状态，不再被较早的保存结果覆盖。
- 历史会话列表和内容读取受请求超时与取消控制。取消后不再继续读取其他会话或调用模型；普通历史读取失败仍允许使用当前会话生成建议。

### Fixes

- Cancel automatic generation when attachments, plan mode, queued intent, or session state make the composer ineligible. Ignore late results and respect native composer rejection without displaying a fallback card. Older clients retain their existing preview fallback.
- Preserve edits to automatic suggestions, shortcuts, and model selection made while an earlier settings save is pending. These newer edits remain unsaved.
- Apply request timeout and cancellation to historical session listing and reads. Do not continue history reads or start a model call after cancellation. Ordinary history read failures still allow generation from the current conversation.

No features, default settings, or production dependencies changed.
