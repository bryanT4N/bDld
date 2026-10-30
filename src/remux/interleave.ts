import type { Fragment } from "./types";
import type { Mp4Writer } from "./writer";

export interface FragmentInput {
  timescale: number;
  fragments: AsyncIterator<Fragment>;
}

async function pull(input: FragmentInput): Promise<Fragment | undefined> {
  const r = await input.fragments.next();
  return r.done ? undefined : r.value;
}

/**
 * Write the inputs (input i becomes track i) in order of fragment start time in seconds,
 * holding at most one fragment per input.
 */
export async function interleave(writer: Mp4Writer, inputs: FragmentInput[]): Promise<void> {
  const heads = await Promise.all(inputs.map(pull));
  const startsBefore = (i: number, j: number) =>
    heads[i]!.baseDecodeTime * BigInt(inputs[j]!.timescale) < heads[j]!.baseDecodeTime * BigInt(inputs[i]!.timescale);
  for (;;) {
    let pick = -1;
    heads.forEach((head, i) => {
      if (head && (pick < 0 || startsBefore(i, pick))) pick = i;
    });
    if (pick < 0) return;
    await writer.writeFragment(pick, heads[pick]!);
    heads[pick] = await pull(inputs[pick]!);
  }
}
