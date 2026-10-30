import type { PositionalWriter } from "../remux";

export interface TempFile {
  writer: PositionalWriter;
  file(): Promise<File>;
  /** Discard partial writes and delete the file; safe to call more than once. */
  remove(): Promise<void>;
}

export async function createTempFile(name: string): Promise<TempFile> {
  const root = await navigator.storage.getDirectory();
  const handle = await root.getFileHandle(name, { create: true });
  const writable = await handle.createWritable({ keepExistingData: false });
  let open = true;
  return {
    writer: {
      write: (data, position) => {
        const bytes = data as Uint8Array<ArrayBuffer>;
        return writable.write(position === undefined ? bytes : { type: "write", position, data: bytes });
      },
      async close() {
        open = false;
        await writable.close();
      },
    },
    file: () => handle.getFile(),
    async remove() {
      if (open) {
        open = false;
        await writable.abort().catch(() => {});
      }
      await root.removeEntry(name).catch(() => {});
    },
  };
}

/** Delete every temp file; called when the engine starts, before any task exists. */
export async function removeAllTempFiles(): Promise<void> {
  const root = await navigator.storage.getDirectory();
  for await (const name of root.keys()) {
    await root.removeEntry(name, { recursive: true }).catch(() => {});
  }
}

export async function freeSpace(): Promise<number | undefined> {
  const { quota, usage } = await navigator.storage.estimate();
  return quota === undefined || usage === undefined ? undefined : quota - usage;
}
