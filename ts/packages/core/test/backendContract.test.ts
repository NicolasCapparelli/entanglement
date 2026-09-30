import { describe } from "vitest";

import { InMemoryBackend, InMemoryServer, ManualAccountSource } from "../src/index.js";
import { runBackendContract } from "./backendContract.js";

describe("InMemoryBackend", () => {
  runBackendContract(async () => {
    const server = new InMemoryServer();
    return {
      backend: new InMemoryBackend(server, new ManualAccountSource("alice")),
      otherAccount: new InMemoryBackend(server, new ManualAccountSource("bob")),
    };
  });
});
