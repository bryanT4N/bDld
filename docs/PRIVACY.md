# bDld 隐私政策

适用于浏览器扩展「bDld - B站视频离线缓存工具」（以下简称 bDld）。

生效日期：2026-10-29

## 收集的数据

bDld 不收集、不保存、不传输任何个人数据，包括浏览记录、账号信息、Cookie、设备信息与使用统计。bDld 没有自己的服务器，不使用任何统计或分析服务。

## 处理的数据

为下载使用者选定的视频，bDld 在使用者的浏览器中处理以下数据，处理结果不离开本机：

- **视频页信息**：使用者打开扩展的弹出窗口时，bDld 在当前 B 站视频页读取视频的标题、UP 主、封面地址、时长、分 P 信息与播放地址，以及页面是否处于登录状态（只判断是否登录，不读取账号）。这些数据只用于显示与下载，弹出窗口关闭后不保留。
- **下载任务**：任务的视频信息、所选的清晰度与编码、进度，保存在扩展的内存中，浏览器关闭后清除。
- **临时文件**：合并过程中的视频数据写入扩展自己的存储空间（OPFS），保存完成、失败或取消后删除。
- **下载记录**：合并好的文件通过浏览器的下载功能保存，记录在浏览器自身的下载列表中，由使用者管理。

## 网络请求

所有网络请求都由使用者的浏览器在本机发出，只发往以下地址：

- `www.bilibili.com`、`api.bilibili.com`：读取播放地址。数据不属于当前视频时，以页面自身的身份请求一次播放地址，携带页面自身的 Cookie，与在播放器中切换一次清晰度相同。
- `*.bilivideo.com`、`*.bilivideo.cn`、`*.akamaized.net`：B 站的媒体 CDN。下载媒体时不携带 Cookie。

bDld 不向其他任何地址发送请求。

## 权限

| 权限 | 用途 |
|---|---|
| `activeTab`、`scripting` | 打开弹出窗口时，在当前 B 站视频页读取视频信息与播放地址 |
| `offscreen` | 在后台文档中执行下载与合并 |
| `downloads` | 把合并好的文件交给浏览器下载，并确认已保存的文件是否存在 |
| `declarativeNetRequestWithHostAccess` | 为本扩展发往 B 站 CDN 的请求设置与 B 站播放器相同的 Referer、Origin 请求头；不影响其他请求 |
| `unlimitedStorage` | 合并时的临时文件可能达到 GB 级 |
| 主机权限：`bilibili.com` | 读取视频页的信息 |
| 主机权限：`bilivideo.com`、`bilivideo.cn`、`akamaized.net` | 从 B 站的媒体 CDN 下载视频 |

## 第三方

bDld 不与任何第三方共享数据。bDld 与哔哩哔哩无关联；使用者访问 B 站时适用哔哩哔哩自身的隐私政策。

## 变更

本政策如有变更，在项目的版本库中更新并注明生效日期。

## 联系

请在项目的版本库中提交 issue。

---

# bDld Privacy Policy

Applies to the browser extension "bDld - B站视频离线缓存工具" (bDld).

Effective date: 2026-10-29

**Data collected.** None. bDld does not collect, store or transmit personal data, including browsing history, account information, cookies, device information or usage statistics. bDld has no server of its own and uses no analytics.

**Data processed locally.** To download the video the user chooses, bDld processes the following in the user's browser only:

- When the user opens the popup on a Bilibili video page, bDld reads the video's title, uploader, cover URL, duration, parts and playback URLs, and whether the page is logged in (yes or no only; no account data). This is used for display and download and is not kept after the popup closes.
- Download tasks (video information, chosen quality and codec, progress) are held in the extension's memory and cleared when the browser closes.
- Video data being merged is written to the extension's own storage (OPFS) and deleted when the download is saved, fails or is canceled.
- The finished file is saved through the browser's download function and appears in the browser's own download list.

**Network requests.** All requests are made by the user's browser, only to `www.bilibili.com` and `api.bilibili.com` (playback URLs; when the page data is not for the current video, one playback-URL request is made from the page with the page's own cookies, as when switching quality in the player) and to Bilibili's media CDNs `*.bilivideo.com`, `*.bilivideo.cn` and `*.akamaized.net` (media download, without cookies). No other destinations are contacted.

**Permissions.** `activeTab` and `scripting` read the video information on the current Bilibili video page; `offscreen` runs download and merge in a background document; `downloads` saves the file and checks that a saved file still exists; `declarativeNetRequestWithHostAccess` sets the same Referer and Origin headers as Bilibili's player on this extension's own CDN requests only; `unlimitedStorage` allows temporary files of several GB; host permissions cover `bilibili.com` (page information) and `bilivideo.com`, `bilivideo.cn`, `akamaized.net` (media download).

**Third parties.** No data is shared with anyone. bDld is not affiliated with Bilibili; Bilibili's own privacy policy applies to the user's use of Bilibili.

**Changes and contact.** Changes are published in the project repository with a new effective date. Questions: open an issue in the project repository.
