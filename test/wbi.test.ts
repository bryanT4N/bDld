import { describe, expect, it } from "vitest";
import { md5 } from "../src/probe/md5";
import { signWbi, wbiKeysFrom } from "../src/probe/wbi";

describe("md5", () => {
  it.each([
    ["", "d41d8cd98f00b204e9800998ecf8427e"],
    ["a", "0cc175b9c0f1b6a831c399e269772661"],
    ["abc", "900150983cd24fb0d6963f7d28e17f72"],
    ["message digest", "f96b697d7cb7938d525a2f31aaf161d0"],
    ["abcdefghijklmnopqrstuvwxyz", "c3fcd3d76192e4007dfb496cca67e13b"],
    ["ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789", "d174ab98d277d9f5a5611c2c9f419d9f"],
    ["12345678901234567890123456789012345678901234567890123456789012345678901234567890", "57edf4a22be3c955ac49da2e2107b67a"],
  ])("RFC 1321 vector %j", (input, digest) => {
    expect(md5(input)).toBe(digest);
  });

  it("hashes the UTF-8 encoding", () => {
    expect(md5("中文")).toBe("a7bac2239fcdcb3a067903d8077c4a07");
  });
});

describe("WBI", () => {
  it("extracts keys from localStorage.wbi_img_urls", () => {
    expect(
      wbiKeysFrom(
        "https://i0.hdslb.com/bfs/wbi/7cd084941338484aae1ad9425b84077c.png-https://i0.hdslb.com/bfs/wbi/4932caff0ff746eab6f01bf08b70ac45.png",
      ),
    ).toEqual({ imgKey: "7cd084941338484aae1ad9425b84077c", subKey: "4932caff0ff746eab6f01bf08b70ac45" });
    expect(wbiKeysFrom("")).toBeUndefined();
  });

  it("matches the published signing example", () => {
    const keys = { imgKey: "7cd084941338484aae1ad9425b84077c", subKey: "4932caff0ff746eab6f01bf08b70ac45" };
    expect(signWbi({ foo: "114", bar: "514", zab: 1919810 }, keys, 1702204169)).toBe(
      "bar=514&foo=114&wts=1702204169&zab=1919810&w_rid=8f6f2b5b3d485fe1886cec6a0be8c5d4",
    );
  });

  it("strips !'()* from values and percent-encodes", () => {
    const keys = { imgKey: "0".repeat(32), subKey: "1".repeat(32) };
    expect(signWbi({ q: "a b!(c)*'" }, keys, 1).split("&w_rid")[0]).toBe("q=a%20bc&wts=1");
  });
});
