import { md5 } from "./md5";

const MIXIN_KEY_ENC_TAB = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49, 33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41,
  13, 37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34,
  44, 52,
];

/** img_key and sub_key are the file names (without extension) of the two URLs in wbi_img_urls. */
export function wbiKeysFrom(imgUrls: string): { imgKey: string; subKey: string } | undefined {
  const [img, sub] = imgUrls.split(/-(?=https?:)/).map((u) => u.slice(u.lastIndexOf("/") + 1).split(".")[0] ?? "");
  return img && sub ? { imgKey: img, subKey: sub } : undefined;
}

/** Query string with `wts` and `w_rid` appended, as the web player signs WBI requests. */
export function signWbi(
  params: Record<string, string | number>,
  keys: { imgKey: string; subKey: string },
  nowSec: number,
): string {
  const raw = keys.imgKey + keys.subKey;
  const mixinKey = MIXIN_KEY_ENC_TAB.map((i) => raw[i] ?? "").join("").slice(0, 32);
  const all: Record<string, string> = { ...Object.fromEntries(Object.entries(params).map(([k, v]) => [k, String(v)])), wts: String(nowSec) };
  const query = Object.keys(all)
    .sort()
    .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(all[k]!.replace(/[!'()*]/g, ""))}`)
    .join("&");
  return `${query}&w_rid=${md5(query + mixinKey)}`;
}
