# 应用商店上架资料 / Store listing

素材：

| 文件 | 规格 |
|---|---|
| `icon-128.png` | 图标，128 × 128 |
| `promo-440x280.png` | 宣传图块，440 × 280 |
| `screenshot-1-ready.png` … `screenshot-4-done.png` | 截图，1280 × 800 |

截图由 `npm run screenshots` 生成，使用离线示例页面，不含 B 站内容。

---

## 中文

### 名称

bDld - B站视频离线缓存工具

### 简短说明

把正在观看的 B 站视频保存为一个标准 MP4 文件。下载与合并在本机浏览器中完成，不经过第三方服务器。

### 详细说明

bDld 在 B 站视频页上，把正在观看的视频下载并合并为一个标准 MP4 文件，保存到浏览器的下载列表。

功能：
- 缺省选择播放器当前的清晰度与编码，可改选清晰度与编码（AVC、HEVC、AV1，以视频提供的为准），显示预计大小。
- 视频流与音频流无损合并为普通 MP4，常见播放器与剪辑软件都能打开，拖动进度条即时响应。
- 显示下载进度、速度与剩余时间；关闭弹出窗口不影响下载。
- 文件进入浏览器的下载列表，遵守浏览器的下载设置；同名文件不覆盖。

工作方式：
- 读取视频页已经加载的播放数据；必要时以页面自身的身份请求一次播放地址，与在播放器中切换一次清晰度相同。
- 请求头、分段方式与并发方式与 B 站网页播放器相同，所有请求都由使用者的浏览器发出。
- 合并在本机完成，不需要安装其他程序。

隐私：没有自己的服务器，不做统计分析，不收集、不保存任何个人数据。

限制：只支持普通投稿视频（含分 P）；音频只保存 AAC；下载期间需要约两倍于视频大小的磁盘空间；不支持断点续传。

下载的内容仅供个人离线观看。使用者应遵守著作权相关法律与《哔哩哔哩用户协议》。bDld 与哔哩哔哩无关联。

开源许可：MIT。

### 单一用途说明

把使用者正在观看的 B 站视频保存为一个 MP4 文件。

### 权限理由

| 权限 | 理由 |
|---|---|
| `scripting` | 在当前 B 站视频页运行页面脚本，读取视频标题、清晰度列表与播放地址。 |
| `offscreen` | 在后台文档中执行下载与合并，并为合并好的文件生成 blob URL；service worker 不能完成这两项工作。 |
| `downloads` | 把合并好的 MP4 文件交给浏览器下载，并确认已保存的文件是否仍然存在。 |
| `declarativeNetRequestWithHostAccess` | B 站的媒体 CDN 拒绝不带 B 站 Referer 的请求。扩展用一条会话规则，只为本扩展自己发往 B 站 CDN 的请求设置与 B 站播放器相同的 Referer、Origin 请求头；不修改使用者浏览网页时的请求。 |
| `unlimitedStorage` | 合并时把视频数据写入扩展自己的临时文件（OPFS），文件可能达到 GB 级；保存完成后删除。 |
| 主机权限 `*://*.bilibili.com/*` | 判断当前标签页是否为 B 站视频页，并在该页面读取视频信息。 |
| 主机权限 `*://*.bilivideo.com/*`、`*://*.bilivideo.cn/*`、`*://*.akamaized.net/*` | 从 B 站的主 CDN 与备用 CDN 下载视频流与音频流。 |

远程代码：不使用。所有脚本都包含在扩展包中。

### 数据使用

- 不收集任何类别的用户数据（个人身份信息、健康信息、财务信息、身份验证信息、个人通信、位置、网络浏览记录、用户活动、网站内容）。
- 视频信息与视频数据只在使用者的浏览器中处理，不发送到任何服务器。
- 声明：不向第三方出售用户数据；不将用户数据用于与单一用途无关的目的；不将用户数据用于判断信用或发放贷款。

隐私政策：https://github.com/bryanT4N/bDld/blob/main/docs/PRIVACY.md

---

## English

### Name

bDld - B站视频离线缓存工具

### Short description

Save the Bilibili video you are watching as one standard MP4. Download and merge run in your browser, with no third-party servers.

### Full description

On a Bilibili video page, bDld downloads the video you are watching, merges it into one standard MP4 file and saves it to the browser's download list.

Features:
- Defaults to the quality and codec the page player is using; you can pick another quality and codec (AVC, HEVC, AV1, as offered by the video) and see the estimated size.
- Video and audio are merged losslessly into a regular MP4 that common players and editors open, with instant seeking.
- Shows progress, speed and time left; closing the popup does not stop the download.
- Files go to the browser's download list and follow its download settings; existing files are never overwritten.

How it works:
- Uses the playback data the page has already loaded; when needed, requests the playback URLs once from the page itself, as switching quality in the player does.
- Request headers, range segmentation and concurrency match Bilibili's web player, and every request is made by your own browser.
- Merging happens on your computer; nothing else needs to be installed.

Privacy: no server of its own, no analytics, no personal data collected or stored.

Limitations: regular user-uploaded videos only (including multi-part videos); AAC audio only; needs about twice the video size in free disk space while downloading; no resume.

Downloaded content is for personal offline viewing. Respect copyright law and Bilibili's terms of use. bDld is not affiliated with Bilibili.

Open source under the MIT license.

### Single purpose

Save the Bilibili video the user is watching as one MP4 file.

### Permission justifications

| Permission | Justification |
|---|---|
| `scripting` | Run a page script on the current Bilibili video page to read the title, the quality list and the playback URLs. |
| `offscreen` | Run download and merge in a background document and create a blob URL for the finished file; a service worker cannot do either. |
| `downloads` | Hand the merged MP4 to the browser's downloads and check that a saved file still exists. |
| `declarativeNetRequestWithHostAccess` | Bilibili's media CDN rejects requests without a Bilibili Referer. One session rule sets the same Referer and Origin headers as Bilibili's player, only on this extension's own requests to Bilibili's CDN; the user's browsing is not affected. |
| `unlimitedStorage` | Video data being merged is written to the extension's own temporary file (OPFS), which can reach several GB; it is deleted after saving. |
| Host `*://*.bilibili.com/*` | Recognise a Bilibili video tab and read the video information on that page. |
| Hosts `*://*.bilivideo.com/*`, `*://*.bilivideo.cn/*`, `*://*.akamaized.net/*` | Download the video and audio streams from Bilibili's primary and backup CDNs. |

Remote code: none. All scripts are included in the package.

### Data usage

- No user data of any category is collected (personally identifiable information, health, financial and payment, authentication, personal communications, location, web history, user activity, website content).
- Video information and video data are processed only in the user's browser and are not sent to any server.
- Certifications: user data is not sold to third parties, not used or transferred for purposes unrelated to the single purpose, and not used to determine creditworthiness or for lending.

Privacy policy: https://github.com/bryanT4N/bDld/blob/main/docs/PRIVACY.md
