# bDld 设计说明

bDld 是一个浏览器扩展：在 B 站视频页上，一键把正在看的视频保存为一个完整的 MP4 文件。

本文写给参与开发的人，说明设计依据、模块划分和数据结构。面向使用者的说明见 README。

## 1. 目标与约束

- **只下载用户正在看的视频**：一次一个，不提供批量、不扫描空间或收藏夹。
- **请求方式与官方播放器一致**：取播放地址、下载媒体流的请求，在频率、请求头、分段方式上与播放器相同，不制造播放器不会发出的流量。
- **输出标准 MP4**：视频流与音频流无损合并为一个普通（非分片）MP4，任何播放器、剪辑软件都能打开，拖动进度条即时响应。
- **内存占用恒定**：下载和合并都以流式处理，内存占用与视频大小无关；GB 级视频也不应超过几十 MB。
- **使用习惯与普通下载一致**：文件进入浏览器的下载列表，遵守浏览器「下载前询问保存位置」等设置。
- **不依赖本地程序**：安装扩展即可使用，不需要另装 ffmpeg 或本地助手。
- **不收集任何数据**：扩展只与 B 站及其 CDN 通信，没有自己的服务器。

首个版本支持 Chrome 与 Edge（Chromium 内核，Manifest V3），只处理普通投稿视频（`www.bilibili.com/video/BV…`，含分 P）。番剧、课程、Firefox 留待后续版本，模块划分为它们预留了位置（见第 9 节）。

## 2. 实测依据

以下事实来自 2026-10-29 的实测，设计以此为准。

### 2.1 媒体 CDN

- 媒体地址形如 `https://upos-sz-mirrorcosov.bilivideo.com/upgcxcode/…/{cid}-1-{格式号}.m4s?…&deadline=…`，另有 `upos-hz-mirrorakam.akamaized.net` 等备用地址。境外线路的 `mirrorcosov` 由 Tencent EdgeOne 承载（响应头带 `eo-log-uuid`）。
- **必须带 B 站的 Referer**。对同一地址用 1 KB 的 Range 请求实测：

  | 请求头 | 结果 |
  |---|---|
  | 无 Referer（无论 UA） | 403 |
  | `Referer: chrome-extension://…` | 403 |
  | 无 User-Agent，带 B 站 Referer | 403 |
  | 浏览器 UA ＋ `Referer: https://www.bilibili.com/` | 206 |
  | 上一行再加 `Origin: chrome-extension://…` | 206 |

- 地址有效期由 `deadline` 参数决定，约 2 小时。
- **EdgeOne 会拦截部分客户端，返回 567 页面（`text/html`）。** 同一时段、同一地址：带浏览器请求头的 curl 请求成功（含不限终点的 `Range: bytes=0-`）；yt-dlp 的请求持续返回 567。原因未定位，可能是请求头组合或 TLS 特征。结论是：请求应由浏览器本身发出，请求头与播放器一致。
- 现有的几个下载扩展会把 567 页面保存成文件，因为它们写盘前不检查状态码。

### 2.2 m4s 结构

视频流与音频流各是一个分片 MP4（fMP4）文件：

```
ftyp (iso5, dash)
moov
  mvhd
  trak: tkhd, edts/elst, mdia(mdhd, hdlr, minf(vmhd|smhd, dinf, stbl(stsd + 空表)))
  mvex: mehd, trex
  udta
sidx            ← 分段索引，约 5 秒一段
moof + mdat     ← 重复，每对一段
```

- 不同视频的封装细节不同，合并器必须按标准通用处理，不能假定固定取值。两个实测样本的差异：

  | 项目 | 样本一（BV1ffso6xEyP） | 样本二（BV1LF4izVEnQ） |
  |---|---|---|
  | `ftyp` | `iso5`，含 `dash` | `isom` |
  | `sidx` 版本 | 1 | 0 |
  | `track_ID` | 视频、音频都是 1 | 视频 1，音频 2 |
  | `tfhd` 标志 | `0x020038` | `0x02002a`（含 sample-description-index，无默认大小） |
  | 音频 `trun` 标志 | `0x301`（每样本时长与大小） | `0x201`（只有每样本大小） |
  | 音频时基 | 48000 | 44100 |

- 视频 `trun` 带每样本大小与 CTS 偏移（标志 `0xa05`）。
- 视频 `elst` 的 media_time 不为 0（例：16000 时基下为 1920 或 2560），合并时必须保留，否则音画不同步。
- 播放地址接口返回的 `segment_base` 给出初始化段与索引的字节范围（如 `initialization: "0-937"`、`index_range: "938-7829"`）。

### 2.3 页面上可直接读取的数据

在视频页的页面环境（MAIN world）中：

- `window.__INITIAL_STATE__.videoData`：`bvid`、`aid`、`cid`、`title`、`pages`（分 P 列表）、`owner`、`duration`、`pic`。
- `window.__playinfo__.data`：服务端渲染时附带的播放地址，结构与播放地址接口的 `data` 相同（`dash.video[]`、`dash.audio[]`、`accept_quality` 等）。**它只对应页面首次加载的那个视频**；站内跳转到其他视频或分 P 后不会更新。未登录时其中最高只有 480P。
- `window.player`：播放器对象。`getManifest()` 返回当前播放的 `bvid`、`cid`、`p`；`getSession()` 返回会话标识。
- `localStorage.wbi_img_urls`：WBI 签名所需的两个密钥图片地址，以「-」连接。

播放器在站内跳转或切换清晰度时调用 `https://api.bilibili.com/x/player/wbi/playurl`（需 WBI 签名）。播放器下载媒体时，对同一地址发出多次 Range 请求，视频与音频同时进行。

### 2.4 扩展环境的实测

用一个临时扩展在 Chromium 中实测：

- 扩展页面直接 `fetch` 跨站地址时，请求带 `Sec-Fetch-Site: none`，不带 `Origin` 和 `Referer`，与播放器的请求不同。
- 加一条 DNR 会话规则后，`Referer`、`Origin`、`Sec-Fetch-Site` 都能改成播放器的取值（`https://www.bilibili.com/`、`https://www.bilibili.com`、`cross-site`）。`Sec-Fetch-Mode: cors`、`Sec-Fetch-Dest: empty` 本来就与播放器一致。
- 扩展页面的 `fetch` 默认会带上目标站的 Cookie，并使用 HTTP 缓存，所以媒体请求要设 `credentials: "omit"` 和 `cache: "no-store"`。
- 向 OPFS 按位置写入 1.5 GB，再从 OPFS 文件创建 blob URL，经 `chrome.downloads` 保存：写入用时 7.8 秒，下载完整完成，Chromium 各进程私有内存合计只增加约 26 MB。

## 3. 总体结构

```
弹出窗口 (popup)
   │ ① 询问当前标签页的视频
   ▼
service worker ── chrome.scripting.executeScript(world: MAIN) ──► 视频页
   │                                              读取页面数据；必要时以页面身份调用 playurl
   │ ② 创建下载任务
   ▼
offscreen 文档（下载引擎）
   ├─ 分段下载视频流、音频流（Range 请求，Referer 由 DNR 规则补上）
   ├─ 流式合并为普通 MP4，写入 OPFS 临时文件
   └─ 完成后生成 blob URL
   │ ③ 交给 service worker
   ▼
chrome.downloads.download(blob URL) ──► 浏览器下载列表 ──► 删除 OPFS 临时文件
```

各部分职责：

- **popup**：显示视频信息、清晰度选择、下载按钮、进度。只做展示和转发，不持有任务状态。
- **service worker**：消息路由；管理 offscreen 文档的生命周期；维护 DNR 会话规则；调用 `chrome.downloads`；更新图标角标。任务状态的唯一来源是 offscreen 引擎，service worker 只转发。
- **页面探针（page probe）**：一个通过 `executeScript` 注入 MAIN world 的函数，读取第 2.3 节的数据，返回可序列化的结果。不常驻页面，不改动页面的任何函数。
- **offscreen 下载引擎**：执行下载任务，持有任务状态机；因为 MV3 的 service worker 会被回收，也不能创建 blob URL，所以长任务放在 offscreen 文档（reason：`BLOBS`）。
- **remux 模块**：纯函数与流式类，不依赖任何扩展 API，可在 Node 中单独测试。

## 4. 关键决定

### 4.1 播放地址的来源

按顺序：

1. 页面的 `__playinfo__` 属于当前视频（其地址路径中的 cid 等于 `player.getManifest().cid`）时，直接使用，不发任何额外请求。
2. 否则由页面探针在页面环境内调用 `/x/player/wbi/playurl`，带页面自身的 Cookie，参数与播放器切换清晰度时相同（`bvid`、`cid`、`qn=127`、`fnval=4048`、`fnver=0`、`fourk=1`、`session` 等），WBI 签名使用 `localStorage.wbi_img_urls` 中的密钥。这一次请求与用户在播放器里切换一次清晰度等价。

不采用的做法：

- 在 service worker 中调用接口：请求不带页面的 Referer，Cookie 受 SameSite 限制，请求特征与播放器不同，容易触发风控（实测 B 站空间列表接口在非浏览器环境中多次返回 412 与 -352）。
- 改写页面的 `fetch` / `XMLHttpRequest` 截取播放器的响应：对页面有侵入，可能被页面检测或与页面脚本冲突，B 站改版时也更易失效。
- 未登录时使用 `try_look` 参数获取更高清晰度：这不是普通浏览会发出的请求。未登录时只提供播放器给出的清晰度，并提示登录。

### 4.2 媒体下载

- 在 offscreen 文档中用 `fetch` 下载。扩展对 CDN 域名有主机权限，不受 CORS 限制。
- 用一条 DNR 会话规则，为**本扩展自己发起的**、发往 B 站媒体 CDN 的请求设置 `Referer: https://www.bilibili.com/`、`Origin: https://www.bilibili.com`、`Sec-Fetch-Site: cross-site`，使请求头与播放器一致。条件用 `initiatorDomains: [chrome.runtime.id]` 限定，用户正常浏览时的请求不受影响。User-Agent 等其余请求头由浏览器生成，不做修改。
- 媒体请求设 `credentials: "omit"`、`cache: "no-store"`，与播放器一致，也避免缓存条件请求。
- 分段方式与播放器相同：先请求 `segment_base` 给出的初始化段和索引，再按 `sidx` 的分段边界，每次请求若干段（合计约 4 MiB）的字节范围。
- 视频流与音频流各一个连接，同时进行（与播放器相同），不再增加并发。
- 一个请求失败时，按「主地址 → 备用地址」轮换重试，指数退避，最多 5 次。返回 403 且已超过 `deadline` 时，任务以「地址过期，请重新下载」结束。
- 返回内容不是媒体（状态码不是 206，或 `Content-Type` 是 `text/html`）时，任务立即失败并说明原因，**不把错误页面当成视频保存**。

### 4.3 合并与保存

- **输出普通 MP4，而不是分片 MP4。** 普通 MP4 的兼容性和拖动响应最好。做法：先写 `ftyp` 和一个 64 位长度的 `mdat` 头，把两路样本按解码时间交错写入 `mdat`，同时在内存中累积样本表；全部写完后在文件末尾写 `moov`，再回到 `mdat` 头写入真实长度。样本表每个样本约 16 字节，两小时 4K60 视频约 7 MB。
- **按编码无关的方式合并。** `stsd`（样本描述，含 avcC/hvcC/av1C/esds/dfLa/dec3 以及 HDR 等附加信息）原样从源文件复制，`tkhd`、`edts`、`mdhd`、`hdlr`、`vmhd`/`smhd`、`dinf` 也从源文件复制，只重建 `stts`、`ctts`、`stss`、`stsz`、`stsc`、`stco`/`co64`，并更新各处时长和 `track_ID`。因此支持 B 站提供的所有编码，且不丢失源文件的任何编码参数。
- **写入 OPFS 临时文件**（扩展自己的源私有文件系统）：磁盘支撑，可以按位置写入，不需要用户授权。扩展申请 `unlimitedStorage`。
- **交给浏览器下载**：完成后从 OPFS 文件得到 `File`（磁盘支撑的 Blob），创建 blob URL，由 service worker 调用 `chrome.downloads.download`。下载完成或失败后撤销 URL、删除临时文件。代价是保存时多一次磁盘复制，换来与普通下载一致的体验。

不采用的做法：

- 在内存中拼接 Blob 再下载：峰值内存与文件大小同阶。
- ffmpeg.wasm：体积约 30 MB；输入与输出都要放进 wasm 内存，大文件会超出上限。
- `showSaveFilePicker` 直接写入目标文件：每次都要弹出选择窗口，且需要页面内的用户手势，与「一键下载」不符。
- 分别下载两个 m4s 文件：使用者还要自己合并。

### 4.4 文件名

`{标题}[ - P{n} {分P标题}] [{BV号}] {清晰度}.mp4`。移除 Windows 文件名中的非法字符（`\ / : * ? " < > |` 和控制字符），去掉末尾的点和空格，整体截断到 150 个字符以内（BV 号和清晰度部分保留）。

### 4.5 清晰度与编码的默认选择

- 清晰度：默认选当前账号可用的最高清晰度，可在弹出窗口中改选。
- 视频编码：默认「兼容优先」，同一清晰度下按 AVC → HEVC → AV1 选择；设置中可改为「体积优先」，按 AV1 → HEVC → AVC 选择。
- 音频：默认选码率最高的 AAC。Hi-Res（FLAC）与杜比全景声留到后续版本作为选项。

## 5. 数据结构

```ts
// 页面探针的返回结果（跨越 executeScript 边界，在 service worker 中校验）
type ProbeResult =
  | { kind: "not-video-page" }
  | { kind: "error"; message: string }
  | { kind: "ok"; video: VideoInfo; offer: PlayOffer };

interface VideoInfo {
  bvid: string; aid: number; cid: number; p: number;
  title: string; partTitle?: string;    // 多 P 时才有
  owner: string; durationSec: number; coverUrl: string;
  loggedIn: boolean;
}

interface PlayOffer {
  videos: VideoStream[];               // dash.video
  audios: AudioStream[];               // dash.audio
  fetchedAt: number;                   // 毫秒；用于判断地址是否接近过期
  source: "playinfo" | "playurl";
}

interface StreamCommon {
  urls: string[];                      // 主地址在前，备用地址在后
  bandwidth: number;                   // bit/s，用于估算体积
  codecs: string;
  initRange: [number, number];         // segment_base.initialization
  indexRange: [number, number];        // segment_base.index_range
}
interface VideoStream extends StreamCommon {
  qn: number; codec: "avc" | "hevc" | "av1";
  width: number; height: number; frameRate: string;
}
interface AudioStream extends StreamCommon { id: number; }

// 下载任务：一个判别联合表示的状态机，由 offscreen 引擎持有
type TaskPhase =
  | { phase: "queued" }
  | { phase: "preparing" }                                      // 取初始化段与索引
  | { phase: "downloading"; doneBytes: number; totalBytes: number; bytesPerSec: number }
  | { phase: "finalizing" }                                     // 写 moov、回填 mdat 长度
  | { phase: "saving"; downloadId?: number }                    // chrome.downloads 进行中
  | { phase: "done"; downloadId: number; fileName: string }
  | { phase: "failed"; reason: FailureReason; message: string }
  | { phase: "canceled" };

type FailureReason =
  | "network" | "url-expired" | "not-media" | "storage-full" | "remux" | "internal";

interface DownloadTask {
  id: string;
  video: VideoInfo;
  chosen: { video: VideoStream; audio: AudioStream };
  fileName: string;
  createdAt: number;
  state: TaskPhase;
}
```

remux 模块的数据：

```ts
interface TrackInit {           // 从 m4s 的 moov 解析
  timescale: number;            // mdhd
  handler: "vide" | "soun";
  boxes: { tkhd: Uint8Array; edts?: Uint8Array; mdhd: Uint8Array; hdlr: Uint8Array;
           mediaHeader: Uint8Array; dinf: Uint8Array; stsd: Uint8Array };
  trex: { duration: number; size: number; flags: number };
}

interface Fragment {            // 一对 moof + mdat
  baseDecodeTime: bigint;       // tfdt
  samples: { duration: number; size: number; flags: number; cto: number }[];
  payload: Uint8Array;          // 该段全部样本的字节，按顺序连续
}
```

合并器的接口：

```ts
class Mp4Writer {
  constructor(out: PositionalWriter, tracks: TrackInit[]);
  async start(): Promise<void>;                          // 写 ftyp 与 mdat 头
  async writeFragment(track: number, f: Fragment): Promise<void>;
  async finish(): Promise<void>;                         // 写 moov，回填 mdat 长度
}

interface PositionalWriter {
  write(data: Uint8Array, position?: number): Promise<void>;
  close(): Promise<void>;
}
```

调度两路输入时，总是先写「下一段起始时间（以秒计）更早」的那一路，保证交错写入，且每一路最多缓冲一段。

## 6. 权限

| 权限 | 用途 |
|---|---|
| `activeTab`、`scripting` | 用户打开弹出窗口时，在当前 B 站标签页运行页面探针 |
| `offscreen` | 创建下载引擎所在的 offscreen 文档 |
| `downloads` | 把合并好的文件交给浏览器下载 |
| `declarativeNetRequestWithHostAccess` | 为本扩展发往 CDN 的请求设置 Referer 与 Origin |
| `storage`、`unlimitedStorage` | 保存设置；OPFS 临时文件 |
| 主机权限 `*://*.bilibili.com/*`、`*://*.bilivideo.com/*`、`*://*.bilivideo.cn/*`、`*://*.akamaized.net/*` | 页面探针；媒体下载 |

不申请 `tabs`、`cookies`、`webRequest`、`<all_urls>`。

## 7. 幂等与恢复

- 创建 offscreen 文档前先检查是否已存在。
- DNR 会话规则用固定 ID，每次先移除再添加。
- 引擎启动时清理 OPFS 中所有不属于进行中任务的临时文件（上次浏览器异常退出遗留的文件）。
- service worker 被回收后重新启动时，向 offscreen 引擎查询任务列表，不自行保存任务状态。
- 首个版本不支持断点续传；浏览器关闭时进行中的任务视为失败。

## 8. 验证

- **remux 单元测试**（Node，Vitest）：box 解析与写出；默认值与每样本字段的组合；`elst` 与 CTS 偏移；64 位长度；`stco` 与 `co64` 的切换。
- **remux 对照测试**（脚本，可重复运行）：用真实的 B 站 m4s 样本，分别由 bDld 和 `ffmpeg -c copy` 合并，用 `ffprobe -show_packets -show_data_hash md5` 逐包比较两路流的 pts、dts、时长、关键帧标志和数据哈希，必须完全一致。
- **端到端测试**（Playwright 加载未打包扩展）：打开一个公开视频页，经 service worker 发起下载，确认文件出现在下载目录、时长与页面一致、`ffprobe` 能读出两路流。
- **人工验证**：在已登录的 Chrome 中加载扩展，下载一个高清晰度视频，用系统播放器播放并拖动进度条。

## 9. 扩展方向

- 番剧与课程：页面探针按页面类型分派到不同的「来源」实现（接口为 `/pgc/player/web/v2/playurl` 等），下载引擎与 remux 不变。
- Firefox：没有 offscreen API，下载引擎改为在 background page 中运行；其余模块不变。
- 弹幕、封面、简介一并保存；Hi-Res 与杜比音轨选项；断点续传。
