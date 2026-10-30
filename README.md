<div align="center">

<img src="docs/store/icon-128.png" width="88" alt="bDld">

# bDld

B 站视频离线缓存工具

[![Release](https://img.shields.io/github/v/release/bryanT4N/bDld)](https://github.com/bryanT4N/bDld/releases)
[![License](https://img.shields.io/github/license/bryanT4N/bDld)](LICENSE)
![Chrome / Edge](https://img.shields.io/badge/Chrome%20%2F%20Edge-116%2B-4285F4)

<img src="docs/images/popup-downloading.png" width="340" alt="bDld 弹出窗口">

</div>

在 B 站视频页点一下扩展图标，把正在观看的视频保存为一个标准 MP4 文件。

## 特点

- **与正常观看一致**：请求由浏览器发出，请求头与分段方式与网页播放器相同。
- **无损完整**：视频流与音频流原样合并为标准 MP4，任何播放器都能打开、拖动。
- **默认即所见**：自动选用播放器当前的清晰度与编码，需要时再展开改选。
- **不收集任何数据**：没有服务器，没有统计，只与 B 站及其 CDN 通信。

## 安装

1. 在 [Releases](https://github.com/bryanT4N/bDld/releases) 下载最新的 `bDld-<版本>.zip`，解压到一个固定目录。
2. 打开 `chrome://extensions`（Edge 为 `edge://extensions`），开启「开发者模式」。
3. 点击「加载已解压的扩展程序」，选择解压后的目录。

应用商店版本上架后，将在此处提供链接。

## 使用

打开任意 `bilibili.com/video/` 视频页，点击工具栏上的 bDld 图标，再点击「下载」。文件保存到浏览器的下载目录，关闭弹出窗口不影响下载。

登录 B 站后，可下载账号可用的更高清晰度。

## 工作原理

1. 读取视频页已加载的播放数据；数据不属于当前视频时，以页面身份请求一次播放地址，与在播放器中切换清晰度相同。
2. 由浏览器按播放器的方式分段下载视频流与音频流。
3. 在本机流式合并为标准 MP4，内存占用与视频大小无关。
4. 交给浏览器保存，与普通下载相同。

请求方式与正常观看保持一致，目的是避免其他下载工具遇到的拦截，但不能保证 B 站今后不限制此类请求。详见 [设计说明](docs/DESIGN.md)。

## 隐私

所有请求都由使用者的浏览器在本机发出，只发往 B 站及其 CDN。bDld 不收集、不保存任何个人数据。权限用途见 [隐私政策](docs/PRIVACY.md)。

## 限制

- 只支持普通投稿视频（含分 P），不支持番剧、课程与直播。
- 音频只保存 AAC。
- 下载期间需要约两倍于视频大小的磁盘空间；不支持断点续传。

## 开发

```
npm ci
npm run build    # 构建到 dist
npm test         # 单元测试
npm run package  # 生成 release/bDld-<版本>.zip
```

检查脚本与开发约定见 [CONTRIBUTING.md](CONTRIBUTING.md)，版本记录见 [CHANGELOG.md](CHANGELOG.md)。

## 许可证

[MIT](LICENSE)

下载的内容仅供个人离线观看，请遵守著作权相关法律与《哔哩哔哩用户协议》。bDld 与哔哩哔哩无关联。
