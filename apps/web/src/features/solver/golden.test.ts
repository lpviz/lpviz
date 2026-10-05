import { expect, test } from "bun:test";
import { compareGolden, readGolden, runGolden } from "../../../../../scripts/golden";

// The whole solver path (worker → pack → unpack → apply → store) over every
// gallery problem and option combination, hashed on what the UI and the store
// see. Rebaseline deliberately with `bun scripts/golden.ts --write`.
test("the solver path reproduces scripts/golden.json", async () => {
  const { changed, missing } = compareGolden(await runGolden(), readGolden());
  expect(changed).toEqual([]);
  expect(missing).toEqual([]);
}, 60_000);
