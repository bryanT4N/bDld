# bDld

bDld 是一个 Chrome / Edge 扩展：在 B 站视频页上，把正在看的视频保存为一个 MP4 文件。

- 视频流与音频流无损合并为一个普通 MP4，常见播放器与剪辑软件都能打开，拖动进度条即时响应。
- 文件进入浏览器的下载列表，遵守浏览器「下载前询问保存位置」等设置。
- 不需要另装 ffmpeg 或其他本地程序。
- 下载请求的请求头、分段方式与 B 站播放器一致。

设计依据见 [docs/DESIGN.md](docs/DESIGN.md)。

## 安装

扩展尚未上架应用商店，以「未打包的扩展」方式加载：

1. 安装 Node.js 20 或更高版本。
2. 在项目目录执行：

   ```
   npm ci
   npm run build
   ```

   构建结果在 `dist` 目录。
3. 打开 `chrome://extensions`（Edge 为 `edge://extensions`），开启「开发者模式」。
4. 点击「加载已解压的扩展程序」，选择 `dist` 目录。

浏览器版本要求：Chrome 或 Edge 116 及以上。

## 使用

1. 打开一个 `www.bilibili.com/video/` 开头的视频页面。
2. 点击工具栏上的 bDld 图标。弹出窗口显示封面、标题、UP 主，以及将要下载的清晰度、编码与大小。
3. 点击「下载」。缺省下载播放器当前播放的清晰度与编码；需要其他清晰度或编码时，可展开后改选。
4. 窗口显示下载进度、速度与剩余时间。关闭窗口不影响下载，扩展图标上的角标显示进度。
5. 完成后点击「在文件夹中显示」打开文件所在位置。

文件名格式：`标题[ - P分P号 分P标题] [BV号] 清晰度.mp4`。

播放器的清晰度与编码无法读取时，缺省选择最高清晰度，编码依次选择 AVC、HEVC、AV1（AVC 的兼容性最好，AV1 的文件最小）。

未登录时只能下载播放器提供的清晰度（通常最高 480P）。登录 B 站后可下载账号可用的更高清晰度。

## 隐私

- 扩展只与 B 站及其 CDN 通信，没有自己的服务器，不收集、不上传任何数据。
- 读取播放地址时，请求由视频页面自身发出，与在播放器里切换一次清晰度相同。
- 下载媒体时不携带 Cookie。
- 扩展不保存任何设置。

## 限制

- 只支持普通投稿视频（含分 P），不支持番剧、课程、直播。
- 不支持 Firefox。
- 音频只保存 AAC，暂不提供 Hi-Res（FLAC）与杜比全景声。
- 不支持断点续传；下载过程中关闭浏览器，任务失败。
- 一次下载一个视频，其余任务排队。
- 下载期间需要约两倍于视频大小的磁盘空间：一份是扩展的临时文件，一份是浏览器保存的文件。临时文件在保存完成后删除。
- 在站内跳转到另一个视频后，如果提示「页面信息与正在播放的视频不一致」，刷新页面即可。

## 开发

### 目录

| 目录 | 内容 |
|---|---|
| `src/remux` | 把 m4s（分片 MP4）合并为普通 MP4；纯函数，不依赖扩展 API |
| `src/engine` | offscreen 文档中的下载引擎：任务状态机、分段下载、OPFS 临时文件 |
| `src/background` | service worker：消息路由、offscreen 文档、DNR 规则、浏览器下载、角标 |
| `src/probe` | 注入视频页的页面探针，及其返回数据的校验 |
| `src/popup` | 弹出窗口 |
| `src/shared` | 共用的数据结构、文件名与清晰度规则 |
| `scripts` | 构建与各项检查脚本 |
| `test` | 单元测试 |

### 命令

| 命令 | 作用 |
|---|---|
| `npm run build` | 构建到 `dist` |
| `npm run typecheck` | TypeScript 类型检查 |
| `npm test` | 单元测试（Vitest） |
| `npm run verify:remux` | 合并结果与 `ffmpeg -c copy` 逐包对照 |
| `npm run smoke` | 在 Chromium 中加载 `dist`，确认 service worker 注册成功 |
| `npm run check:engine` | 用本地服务器模拟 CDN，检查下载引擎（重试、567 拦截页、地址过期、排队、取消、临时文件清理） |
| `npm run check:popup` | 把 B 站域名解析到本地 HTTPS 服务器，离线检查弹出窗口、页面探针、请求头改写与完整下载流程 |
| `npm run e2e` | 打开一个真实的公开视频，下载一次并用 ffprobe 检查结果 |

`verify:remux` 对照的内容：每个包的 pts、dts、时长、关键帧标志、大小与 MD5，以及各路流的起始时间与时长，并确认输出是普通（非分片）MP4。

### 环境变量

| 变量 | 用途 | 缺省 |
|---|---|---|
| `FFMPEG_DIR` | ffmpeg 与 ffprobe 所在目录，例如 `C:\Users\<用户>\AppData\Local\Microsoft\WinGet\Packages\yt-dlp.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe\ffmpeg-N-127043-g5a54fcf75e-win64-gpl\bin` | 从 `PATH` 查找 |
| `CHROMIUM_PATH` | 可加载未打包扩展的 Chromium（品牌版 Chrome 会忽略 `--load-extension`） | Playwright 安装的最新 Chromium |
| `BDLD_REAL_FIXTURES` | 真实 B 站 m4s 样本目录，含 `video-avc.m4s`、`video-hevc.m4s`、`video-av1.m4s`、`audio-aac.m4s` | 无样本时，`verify:remux` 只对照 ffmpeg 生成的样本，`check:engine` 与 `check:popup` 改用生成的样本 |
| `OPENSSL` | `check:popup` 生成临时证书所用的 openssl | Git for Windows 自带的 openssl，其次 `PATH` |

真实样本不纳入版本库。

Chromium 可用 `npx playwright-core install chromium` 安装。

### 关于 e2e

B 站的 CDN 对访问频率敏感。`npm run e2e` 每次只打开一个页面、下载一个短视频，不做任何重试；遇到 567、412 等拦截时如实报告。请不要循环运行。

## 许可证

[MIT](LICENSE)
