import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createTestIndexer } from "envio";
import { cidFromDigestHex } from "./pinning";

const AUTHOR = "0x00000000000000000000000000000000000000aa";
const RATER = "0x00000000000000000000000000000000000000bb";
const THESIS_URI = `0x${"11".repeat(32)}`;
const ARGUMENT_URI = `0x${"22".repeat(32)}`;
const ALTERED_URI = `0x${"33".repeat(32)}`;

const debateCreated = {
  contract: "ArborVote",
  event: "DebateCreated",
  params: {
    debateId: 0n,
    creator: AUTHOR,
    contentURI: THESIS_URI,
    timeUnit: 60n,
    editingEndTime: 420n,
    ratingEndTime: 600n,
  },
} as const;

const joined = (account: `0x${string}`) => ({
  contract: "ArborVote",
  event: "Joined",
  params: { debateId: 0n, account, tokens: 100n },
}) as const;

const argumentAdded = (
  argumentId: bigint,
  parentArgumentId: bigint,
  { pro, con }: { pro: bigint; con: bigint },
) => ({
  contract: "ArborVote",
  event: "ArgumentAdded",
  params: {
    debateId: 0n,
    argumentId,
    parentArgumentId,
    creator: AUTHOR,
    isSupporting: true,
    contentURI: ARGUMENT_URI,
    pro,
    con,
    finalizationTime: 60n,
  },
}) as const;

describe("the ArborVote indexer", () => {
  it("folds a full debate lifecycle into the domain entities", async () => {
    const indexer = createTestIndexer();

    // The numbers mirror the contract unit tests: an argument seeded at 80%
    // approval (reserves 2/8), rated down with 20 tokens (fee 1, net 19,
    // 26 shares out), redeemed for the pre-rounded payout of 24.
    await indexer.process({
      chains: {
        31337: {
          simulate: [
            debateCreated,
            joined(AUTHOR),
            joined(RATER),
            argumentAdded(1n, 0n, { pro: 2n, con: 8n }),
            {
              contract: "ArborVote",
              event: "ArgumentAltered",
              params: { debateId: 0n, argumentId: 1n, contentURI: ALTERED_URI, finalizationTime: 90n },
            },
            { contract: "ArborVote", event: "ArgumentFinalized", params: { debateId: 0n, argumentId: 1n } },
            { contract: "ArborVote", event: "PhaseAdvanced", params: { debateId: 0n, newPhase: 2n } },
            {
              contract: "ArborVote",
              event: "Staked",
              params: {
                debateId: 0n,
                argumentId: 1n,
                staker: RATER,
                data: { isPro: false, voteTokensStaked: 20n, fee: 1n, sharesOut: 26n },
              },
            },
            { contract: "ArborVote", event: "PhaseAdvanced", params: { debateId: 0n, newPhase: 3n } },
            {
              contract: "ArborVote",
              event: "ArgumentImpactCalculated",
              params: { debateId: 0n, argumentId: 1n, impact: 90n },
            },
            { contract: "ArborVote", event: "DebateFinished", params: { debateId: 0n, approved: true } },
            {
              contract: "ArborVote",
              event: "SharesRedeemed",
              params: { debateId: 0n, argumentId: 1n, account: RATER, proShares: 0n, conShares: 26n, payout: 24n },
            },
            {
              contract: "ArborVote",
              event: "FeesClaimed",
              params: { debateId: 0n, argumentId: 1n, creator: AUTHOR, fees: 1n },
            },
          ],
        },
      },
    });

    const debate = await indexer.Debate.getOrThrow("0");
    expect(debate.phase).toBe("FINISHED");
    expect(debate.approved).toBe(true);
    expect(debate.argumentsCount).toBe(2n);
    expect(debate.totalVotes).toBe(29n); // 10 deposit + 19 net stake

    const thesis = await indexer.Argument.getOrThrow("0_0");
    expect(thesis.state).toBe("FINAL");
    expect(thesis.parent_id).toBeUndefined();
    expect(thesis.contentURI).toBe(THESIS_URI);

    const argument = await indexer.Argument.getOrThrow("0_1");
    expect(argument.parent_id).toBe("0_0");
    expect(argument.state).toBe("FINAL");
    expect(argument.contentURI).toBe(ALTERED_URI);
    expect(argument.finalizationTime).toBe(90n);
    expect(argument.pro).toBe(21n); // 2 + 19 net
    expect(argument.con).toBe(1n); // 8 + 19 - 26 shares out
    expect(argument.votes).toBe(29n);
    expect(argument.fees).toBe(0n); // accrued 1, then claimed
    expect(argument.impact).toBe(90n);

    // Token balances mirror the chain: the author paid the deposit and claimed
    // the fee, the correcting rater redeemed at a profit.
    const author = await indexer.Participant.getOrThrow(`0_${AUTHOR}`);
    expect(author.tokens).toBe(91n); // 100 - 10 deposit + 1 fee
    const rater = await indexer.Participant.getOrThrow(`0_${RATER}`);
    expect(rater.tokens).toBe(104n); // 100 - 20 staked + 24 payout

    const position = await indexer.Position.getOrThrow(`0_1_${RATER}`);
    expect(position.proShares).toBe(0n);
    expect(position.conShares).toBe(0n); // redeemed
  });

  it("keeps a debate mid-flight consistent while it is still being edited", async () => {
    const indexer = createTestIndexer();

    await indexer.process({
      chains: {
        31337: {
          simulate: [debateCreated, joined(AUTHOR), argumentAdded(1n, 0n, { pro: 5n, con: 5n })],
        },
      },
    });

    const debate = await indexer.Debate.getOrThrow("0");
    expect(debate.phase).toBe("EDITING");
    expect(debate.approved).toBeUndefined();
    expect(debate.totalVotes).toBe(10n);

    const argument = await indexer.Argument.getOrThrow("0_1");
    expect(argument.state).toBe("CREATED");
    expect(argument.impact).toBeUndefined();

    const author = await indexer.Participant.getOrThrow(`0_${AUTHOR}`);
    expect(author.tokens).toBe(90n);
  });

  it("moves an argument beneath its new parent", async () => {
    const indexer = createTestIndexer();

    await indexer.process({
      chains: {
        31337: {
          simulate: [
            debateCreated,
            joined(AUTHOR),
            argumentAdded(1n, 0n, { pro: 5n, con: 5n }),
            argumentAdded(2n, 0n, { pro: 5n, con: 5n }),
            {
              contract: "ArborVote",
              event: "ArgumentMoved",
              params: { debateId: 0n, argumentId: 2n, newParentArgumentId: 1n, oldParentArgumentId: 0n },
            },
          ],
        },
      },
    });

    const moved = await indexer.Argument.getOrThrow("0_2");
    expect(moved.parent_id).toBe("0_1");
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
