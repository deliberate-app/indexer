import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * The event signatures a config declares, in order. Read as text rather than parsed:
 * the two files are compared for drift, and every character of a signature - the
 * indexed markers, the tuple component names - is part of what must not drift.
 */
function declaredEvents(path: string): string[] {
  return readFileSync(path, "utf8")
    .split("\n")
    .flatMap((line) => {
      const signature = /^\s*-\s*event:\s*(\S.*?)\s*$/.exec(line)?.[1];
      return signature ? [signature] : [];
    });
}

describe("the two configs", () => {
  // config.yaml indexes the hosted Base Sepolia deployment, config.local.yaml the local
  // anvil chain. They differ in chain, address, and start block by design - but an event
  // added to one and forgotten in the other means the local run silently stops mirroring
  // what the hosted one indexes, which is exactly the kind of drift that only shows up
  // later, as a missing entity.
  it("declare the same events", () => {
    const hosted = declaredEvents("config.yaml");
    expect(hosted.length).toBeGreaterThan(0);
    expect(declaredEvents("config.local.yaml")).toEqual(hosted);
  });
});
