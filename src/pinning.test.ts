import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { createTestIndexer, indexer } from "envio";
import { cidFromDigestHex } from "./pinning";

const CHAIN = indexer.chainIds[0]!;
const AUTHOR = "0x00000000000000000000000000000000000000aa";

/** A stub kubo: records the pin requests it is asked for and answers with `status`. */
function pinningNode(status = 200) {
  const pinned: string[] = [];
  const server: Server = createServer((request, response) => {
    const cid = new URL(request.url ?? "", "http://node").searchParams.get("arg");
    if (cid) pinned.push(cid);
    response.writeHead(status, { "content-type": "application/json" });
    response.end("{}");
  });
  return {
    pinned,
    async start() {
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      process.env.ENVIO_PIN_IPFS_API = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    },
    async stop() {
      delete process.env.ENVIO_PIN_IPFS_API;
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/** A debate whose thesis carries `contentURI`, as the create transaction emits it. */
const debateCreated = (debateId: bigint, contentURI: string) =>
  ({
    contract: "Deliberate",
    event: "DebateCreated",
    params: {
      debateId,
      creator: AUTHOR,
      contentURI,
      lockingDuration: 60n,
      editingEndTime: 420n,
      ratingEndTime: 600n,
      feePercentage: 5n,
    },
  }) as const;

let node: ReturnType<typeof pinningNode> | undefined;

afterEach(async () => {
  await node?.stop();
  node = undefined;
});

describe("the pinning backstop", () => {
  it("asks the node once per text, however often the handler runs", async () => {
    node = pinningNode();
    await node.start();

    // Handlers run twice - once to preload, once to fold - and the same text may be
    // referenced by several events in a batch. Routing the request through the Effect
    // API collapses all of that into one call per distinct digest; a bare fetch in the
    // handler would have fired one per handler run.
    const shared = `0x${"a1".repeat(32)}`;
    const other = `0x${"b2".repeat(32)}`;
    const test = createTestIndexer();
    await test.process({
      chains: {
        [CHAIN]: {
          simulate: [debateCreated(0n, shared), debateCreated(1n, shared), debateCreated(2n, other)],
        },
      },
    });

    // The two distinct requests go out concurrently, so compare them as a set.
    expect([...node.pinned].sort()).toEqual([cidFromDigestHex(shared), cidFromDigestHex(other)].sort());
  });

  it("folds the debate even when the node rejects the pin", async () => {
    node = pinningNode(500);
    await node.start();

    const test = createTestIndexer();
    await test.process({
      chains: { [CHAIN]: { simulate: [debateCreated(7n, `0x${"c3".repeat(32)}`)] } },
    });

    // Pinning is a backstop, not a gate: a node that is down, slow, or missing the
    // block must never hold up or crash the fold.
    expect(node.pinned).toHaveLength(1);
    expect((await test.Debate.getOrThrow("7")).creator).toBe(AUTHOR);
  });

  it("stays switched off when no pinning node is configured", async () => {
    node = pinningNode();
    await node.start();
    delete process.env.ENVIO_PIN_IPFS_API;

    const test = createTestIndexer();
    await test.process({
      chains: { [CHAIN]: { simulate: [debateCreated(8n, `0x${"d4".repeat(32)}`)] } },
    });

    expect(node.pinned).toEqual([]);
  });
});

describe("cidFromDigestHex", () => {
  it("rebuilds the CIDv1 a raw-leaves ipfs add produces", () => {
    // Fixture shared with the frontend: sha-256 of "Threatens habitability",
    // verified against a live kubo gateway.
    const digest = createHash("sha256").update("Threatens habitability").digest("hex");
    expect(cidFromDigestHex(`0x${digest}`)).toBe(
      "bafkreif3pscuobc3juosiyg7xkh4m6ilkatkg3igpsndpnlr4fzmygoubm",
    );
  });
});
