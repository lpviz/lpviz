import type { ResultTextBlock } from "@/features/solver/types";
import { el } from "@/ui/dom";

export const rowEl = (block: ResultTextBlock) => el("div", { className: block.className, text: block.text, attrs: block.index !== undefined ? { "data-index": String(block.index) } : {} });

// every block as a row, in order, inside one container
export function blocksContainer(blocks: readonly ResultTextBlock[]) {
  const c = el("div");
  for (const block of blocks) c.append(rowEl(block));
  return c;
}
