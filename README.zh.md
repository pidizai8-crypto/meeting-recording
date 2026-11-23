# DSH 会议录音

面向 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（`dsh`）的本地优先会议录音插件。

它可以录制麦克风、Windows 默认播放设备或两者混音；在本机用 SenseVoice 转写；按声音把发言分组；并保存富文本记事本、会议历史和生成的会议纪要。

## 功能

- **三种录音来源**——麦克风、Windows 系统声音（WASAPI 回环）或两者混音。
- **本地转写**——SenseVoice 通过 DSH 官方语音服务在本机运行。可选中文（默认）或自动识别语言。
- **发言人分组**——随包提供的 CAM++ 声纹模型在同一音源内区分声音，标为 `1`、`2`、`3`……证据不足的语音段显示为**待确认**，不会静默归到错误的人。
- **富文本记事本**——加粗、文字颜色、标题、项目符号和编号列表、时间戳。选中文字、覆盖输入或在记事本内复制粘贴时，已有样式会保留。
- **会议历史**——回看、重命名、删除或在文件夹中打开会议。录音、转写、记事本和纪要会一起归档。
- **会议纪要**——把转写和记事本交给 DSH 默认模型生成 Markdown 纪要。

## 要求

- DeepSeek Harness **0.2.2-rc.5** 或更新版本（`<0.3.0`）。
- 启用官方**语音输入**插件及本机 **SenseVoice**。首次使用时 DSH 会下载语音模型（约 241 MB）。
- **Windows 10/11** 的桌面端可录制系统声音；麦克风来源也可在受支持的 Chromium 浏览器中使用 `dsh web`。
- 不需要 Python 或外部语音服务。声纹模型使用 DSH 已内置的 `sherpa-onnx-node` 运行时。

## 安装

在 DSH 环境执行：

```sh
dsh plugin --profile <配置名> add github:pidizai8-crypto/meeting-recording
```

DSH 桌面端可打开**插件 → 添加插件**，安装包或 GitHub 仓库。需要时按 DSH 提示刷新或重启。

GitHub Release 也会附带安装包；市场条目使用 `tarball:` 地址时会优先安装它。

安装后打开会话右侧栏，新建会议标签页，首次使用时在面板准备语音模型。

## 隐私

- 音频、PCM、转写、记事本和历史都留在本机。会议保存在浏览器 IndexedDB，归档写入本机 DSH 配置目录。
- 转写过程不上传任何内容。只有你点击**生成总结**时，转写和记事本会发送给 DSH 默认模型。
- 语音与声纹模型都在本机运行。插件没有遥测，也不需要外部 API 密钥。
- 录音需要麦克风权限；网页版录制系统声音时使用浏览器的屏幕共享选择器。

## 限制

- **发言人分组不是身份识别。** 编号只表示声音相近，不是姓名；多人同时说话、耳语或发言不足约两秒时可能分错。需要时在转写里手动纠正。
- 系统声音录制的是 **Windows 默认播放设备**，不支持单独捕获某个应用的声音。
- 转写目前支持中文和自动识别。中文不清晰时仍可能被识别成日文；面板会把这类语音段标为需回听，而不是直接显示文字。
- 记事本调色板为固定色值，在部分自定义主题下对比度可能低于 WCAG 正文目标。
- 下载和归档文件内部仍使用 Markdown 以便迁移；编辑器本身是富文本界面，不暴露 Markdown 源码。

## 开发

插件是纯 ESM，没有运行时 npm 依赖；React 和 Cordis 服务由 DSH 提供。

```sh
npm run build   # 从源码模块重新生成 client.js
npm test        # Node 单元测试
```

`tests/notebook-editor.browser.mjs` 是隔离的 ProseMirror 浏览器测试，需要临时安装 `react`、`react-dom`、`esbuild`，不包含在 `npm test` 中。

目录：

| 路径 | 作用 |
|---|---|
| `index.js` | Host 路由、语音引擎桥接、归档与回环注册 |
| `capture.js` | 浏览器音频采集、VAD 分段、PCM 转换 |
| `speaker-turns.js` / `speaker-groups.js` | 换人检测与匿名发言人原型 |
| `voice-embedding.js` / `voice-engine/` | CAM++、Silero ONNX 运行时与模型 |
| `notebook-*.js` / `panel.js` | 富文本记事本与会议界面 |
| `store.js` / `library.js` / `archive.js` | IndexedDB、历史与本地归档 |

## 第三方声明

随包模型和编辑器依赖保留原始许可证。完整文本见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)、`voice-engine/` 下的许可证文件，以及 `vendor/notebook-editor.vendor.js` 文件头的许可证清单。

## 许可证

MIT，见 [LICENSE](LICENSE)。随包语音模型与编辑器依赖保留各自许可证，详见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
