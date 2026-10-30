const LABELS: Record<number, string> = {
  127: "8K 超高清",
  126: "杜比视界",
  125: "HDR 真彩",
  120: "4K 超清",
  116: "1080P 60帧",
  112: "1080P 高码率",
  100: "智能修复",
  80: "1080P 高清",
  74: "720P 60帧",
  64: "720P 高清",
  32: "480P 清晰",
  16: "360P 流畅",
  6: "240P 极速",
};

export function qualityLabel(qn: number, height: number): string {
  return LABELS[qn] ?? `${height}P`;
}
