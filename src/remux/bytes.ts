export class RemuxError extends Error {
  override name = "RemuxError";
}

/** Bounds-checked big-endian reader over untrusted bytes. */
export class Reader {
  private readonly view: DataView;
  pos: number;

  constructor(
    readonly buf: Uint8Array,
    pos: number,
    readonly end: number,
    private readonly what: string,
  ) {
    this.view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    this.pos = pos;
  }

  private take(n: number): number {
    if (this.pos + n > this.end) throw new RemuxError(`${this.what} is truncated`);
    const at = this.pos;
    this.pos += n;
    return at;
  }

  skip(n: number): void {
    this.take(n);
  }
  u8(): number {
    return this.view.getUint8(this.take(1));
  }
  u16(): number {
    return this.view.getUint16(this.take(2));
  }
  u24(): number {
    const at = this.take(3);
    return (this.view.getUint8(at) << 16) | this.view.getUint16(at + 1);
  }
  u32(): number {
    return this.view.getUint32(this.take(4));
  }
  i32(): number {
    return this.view.getInt32(this.take(4));
  }
  u64(): bigint {
    return this.view.getBigUint64(this.take(8));
  }
  /** A 64-bit value that must fit in a JS number (offsets, sizes). */
  u64n(): number {
    const v = this.u64();
    if (v > BigInt(Number.MAX_SAFE_INTEGER)) throw new RemuxError(`${this.what} has an out-of-range 64-bit value`);
    return Number(v);
  }
  fourcc(): string {
    const at = this.take(4);
    return String.fromCharCode(...this.buf.subarray(at, at + 4));
  }
}

/** Growable big-endian byte builder. */
export class Bytes {
  private buf = new Uint8Array(256);
  private view = new DataView(this.buf.buffer);
  length = 0;

  private reserve(n: number): number {
    if (this.length + n > this.buf.length) {
      let cap = this.buf.length * 2;
      while (cap < this.length + n) cap *= 2;
      const next = new Uint8Array(cap);
      next.set(this.buf.subarray(0, this.length));
      this.buf = next;
      this.view = new DataView(next.buffer);
    }
    const at = this.length;
    this.length += n;
    return at;
  }

  u8(v: number): this {
    const at = this.reserve(1);
    this.view.setUint8(at, v);
    return this;
  }
  u16(v: number): this {
    const at = this.reserve(2);
    this.view.setUint16(at, v);
    return this;
  }
  u24(v: number): this {
    const at = this.reserve(3);
    this.view.setUint8(at, v >>> 16);
    this.view.setUint16(at + 1, v & 0xffff);
    return this;
  }
  u32(v: number): this {
    const at = this.reserve(4);
    this.view.setUint32(at, v);
    return this;
  }
  i32(v: number): this {
    const at = this.reserve(4);
    this.view.setInt32(at, v);
    return this;
  }
  u64(v: number | bigint): this {
    const at = this.reserve(8);
    this.view.setBigUint64(at, BigInt(v));
    return this;
  }
  fourcc(s: string): this {
    const at = this.reserve(4);
    for (let i = 0; i < 4; i++) this.buf[at + i] = s.charCodeAt(i);
    return this;
  }
  bytes(b: Uint8Array): this {
    const at = this.reserve(b.length);
    this.buf.set(b, at);
    return this;
  }
  zeros(n: number): this {
    this.reserve(n);
    this.buf.fill(0, this.length - n, this.length);
    return this;
  }
  done(): Uint8Array {
    return this.buf.slice(0, this.length);
  }
}

export const U32_MAX = 0xffffffff;

export function box(type: string, ...children: Uint8Array[]): Uint8Array {
  const size = 8 + children.reduce((n, c) => n + c.length, 0);
  if (size > U32_MAX) throw new RemuxError(`${type} box too large`);
  const out = new Bytes().u32(size).fourcc(type);
  for (const c of children) out.bytes(c);
  return out.done();
}

export function fullBox(type: string, version: number, flags: number, body: Uint8Array): Uint8Array {
  return box(type, new Bytes().u8(version).u24(flags).bytes(body).done());
}

/** ceil(value * to / from) without floating-point error. */
export function rescaleUp(value: number, from: number, to: number): number {
  if (from === to) return value;
  const num = BigInt(value) * BigInt(to);
  const den = BigInt(from);
  return Number((num + den - 1n) / den);
}
