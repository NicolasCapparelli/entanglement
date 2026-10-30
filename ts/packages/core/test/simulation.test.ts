import { describe, test } from "vitest";

import { simulate } from "./simulation.js";

describe("automatic policies", () => {
  for (let seed = 1; seed <= 150; seed++) test(`seed ${seed} converges`, () => simulate(seed, false));
});

describe("asking, with random resolutions, restores and overwrites", () => {
  for (let seed = 1001; seed <= 1150; seed++) test(`seed ${seed} converges`, () => simulate(seed, true));
});
