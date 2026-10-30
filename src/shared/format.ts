const MB = 1024 ** 2;
const GB = 1024 ** 3;

export function formatBytes(n: number): string {
  if (n < MB) return `${Math.max(1, Math.round(n / 1024))} KB`;
  if (n < GB) return `${(n / MB).toFixed(n < 10 * MB ? 1 : 0)} MB`;
  return `${(n / GB).toFixed(2)} GB`;
}

/** `226/485 MB`: both values in the total's unit. */
export function formatProgress(done: number, total: number): string {
  const [unit, size, digits] = total >= GB ? ["GB", GB, 2] : total >= 10 * MB ? ["MB", MB, 0] : ["MB", MB, 1];
  return `${(done / size).toFixed(digits)}/${(total / size).toFixed(digits)} ${unit}`;
}

/** `1:58`, or `1:02:03` past an hour. */
export function formatClock(seconds: number): string {
  const s = Math.max(0, Math.ceil(seconds));
  const pad = (n: number) => String(n).padStart(2, "0");
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h ? `${h}:${pad(m)}:${pad(s % 60)}` : `${m}:${pad(s % 60)}`;
}
