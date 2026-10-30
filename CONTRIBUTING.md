# 参与开发

- 修改前先阅读 [docs/DESIGN.md](docs/DESIGN.md)。设计变化时同步更新该文档，只写现状；版本变化写入 [CHANGELOG.md](CHANGELOG.md)。
- 提交前运行 `npm run typecheck` 与 `npm test`。修改 remux 模块时运行 `npm run verify:remux`；修改下载引擎或弹出窗口时运行 `npm run check:engine` 与 `npm run check:popup`。这些检查都在本机完成。
- `npm run e2e` 会访问 B 站。请只在必要时运行一次，不要循环运行或批量重试。
- 不引入运行时依赖。
- 界面文字与中文文档使用书面、简练的表述，同一个意思只用一个词。
- 真实的 B 站媒体文件不纳入版本库。

## 检查脚本

| 命令 | 内容 |
|---|---|
| `npm run typecheck` | TypeScript 类型检查 |
| `npm run verify:remux` | 合并结果与 `ffmpeg -c copy` 逐包对照（pts、dts、时长、关键帧标志、大小、MD5） |
| `npm run smoke` | 在 Chromium 中加载扩展，确认 service worker 注册成功 |
| `npm run check:engine` | 本地服务器模拟 CDN，检查下载引擎（重试、拦截页、地址过期、排队、取消、临时文件清理） |
| `npm run check:popup` | 把 B 站域名解析到本地 HTTPS 服务器，离线检查弹出窗口与完整下载流程 |
| `npm run check:speed` | 在限速的本地 CDN 上对照实际速度与显示的速度 |
| `npm run screenshots` | 生成 README 与应用商店使用的截图 |
| `npm run e2e` | 打开一个真实的公开视频，下载一次并检查结果 |

## 环境变量

| 变量 | 用途 | 缺省 |
|---|---|---|
| `FFMPEG_DIR` | ffmpeg 与 ffprobe 所在目录 | 从 `PATH` 查找 |
| `CHROMIUM_PATH` | 可加载未打包扩展的 Chromium（品牌版 Chrome 不接受 `--load-extension`） | Playwright 安装的 Chromium（`npx playwright-core install chromium`） |
| `BDLD_REAL_FIXTURES` | 真实 B 站 m4s 样本目录（`video-avc.m4s`、`video-hevc.m4s`、`video-av1.m4s`、`audio-aac.m4s`），不纳入版本库 | 使用 ffmpeg 生成的样本 |
| `OPENSSL` | 生成临时证书所用的 openssl | Git for Windows 自带的 openssl，其次 `PATH` |
| `BDLD_EXTENSION_DIR` | 浏览器检查加载的扩展目录，例如解压后的发布包 | `dist` |
