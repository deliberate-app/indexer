import { describe, expect, it } from "vitest";
import { createTestIndexer, indexer as runtime } from "envio";

/**
 * The chain the loaded config declares - config.local.yaml's anvil (31337) under the `just`
 * recipes, Gnosis under the hosted config. Taking it from the indexer rather than hard-coding it
 * keeps these tests passing whichever config is loaded.
 */
const CHAIN = runtime.chainIds[0]!;

// Entity IDs open with the chain, because one indexer serves every chain the contract is on.
const DEBATE = `${CHAIN}_0`;
const argumentId = (id: number) => `${DEBATE}_${id}`;
const participantId = (account: string) => `${DEBATE}_${account}`;
const positionId = (id: number, account: string) => `${argumentId(id)}_${account}`;

const AUTHOR = "0x00000000000000000000000000000000000000aa";
const RATER = "0x00000000000000000000000000000000000000bb";
// Texts arrive verbatim in the events - bytes of UTF-8, not a reference to fetch.
const THESIS = "Cities should close their centres to cars";
const ARGUMENT = "Air quality recovers within months";
const ALTERED = "Air quality recovers within months – Paris measured it in 2024";

const debateCreated = {
  contract: "Deliberate",
  event: "DebateCreated",
  params: {
    debateId: 0n,
    creator: AUTHOR,
    content: THESIS,
    lockingDuration: 60n,
    editingEndTime: 420n,
    ratingEndTime: 600n,
    feePercentage: 5n,
    identityRegistry: `0x${"00".repeat(20)}`,
  },
} as const;

const joined = (account: `0x${string}`) => ({
  contract: "Deliberate",
  event: "Joined",
  params: { debateId: 0n, account, tokens: 100n },
}) as const;

const argumentCreated = (
  argumentId: bigint,
  parentArgumentId: bigint,
  { pro, con }: { pro: bigint; con: bigint },
) => ({
  contract: "Deliberate",
  event: "ArgumentCreated",
  params: {
    debateId: 0n,
    argumentId,
    parentArgumentId,
    creator: AUTHOR,
    isSupporting: true,
    content: ARGUMENT,
    pro,
    con,
    finalizationTime: 60n,
  },
}) as const;

describe("the Deliberate indexer", () => {
  it("folds a full debate lifecycle into the domain entities", async () => {
    const indexer = createTestIndexer();

    // The numbers mirror the contract unit tests: an argument seeded at 80%
    // approval (reserves 2/8), rated down with 20 tokens (fee 1, net 19,
    // 26 shares out), redeemed for the pre-rounded payout of 24.
    await indexer.process({
      chains: {
        [CHAIN]: {
          simulate: [
            debateCreated,
            joined(AUTHOR),
            joined(RATER),
            argumentCreated(1n, 0n, { pro: 2n, con: 8n }),
            {
              contract: "Deliberate",
              event: "ArgumentAltered",
              params: { debateId: 0n, argumentId: 1n, content: ALTERED, finalizationTime: 90n },
            },
            {
              contract: "Deliberate",
              event: "Staked",
              params: {
                debateId: 0n,
                argumentId: 1n,
                staker: RATER,
                data: { isPro: false, voteTokensStaked: 20n, fee: 1n, sharesOut: 26n },
              },
            },
            {
              contract: "Deliberate",
              event: "ArgumentRated",
              params: { debateId: 0n, argumentId: 1n, rating: 90n, subtreeStake: 29n },
            },
            { contract: "Deliberate", event: "DebateFinished", params: { debateId: 0n, approved: true } },
            {
              contract: "Deliberate",
              event: "SharesRedeemed",
              params: { debateId: 0n, argumentId: 1n, account: RATER, proShares: 0n, conShares: 26n, payout: 24n },
            },
            {
              contract: "Deliberate",
              event: "FeesClaimed",
              params: { debateId: 0n, argumentId: 1n, creator: AUTHOR, fees: 1n },
            },
          ],
        },
      },
    });

    const debate = await indexer.Debate.getOrThrow(DEBATE);
    expect(debate.finished).toBe(true);
    expect(debate.approved).toBe(true);
    expect(debate.finishedAt).toBeDefined();
    expect(debate.argumentsCount).toBe(2n);
    expect(debate.participantsCount).toBe(2n);
    expect(debate.totalStake).toBe(29n); // 10 deposit + 19 net stake

    const thesis = await indexer.Argument.getOrThrow(argumentId(0));
    expect(thesis.parent_id).toBeUndefined();
    expect(thesis.content).toBe(THESIS);
    // The rating folds into its parent's numerator weighted by the stake the event carries, the
    // same sum of products the contract accumulates: one supporting child at 90 over 29 stake.
    expect(thesis.descendantsNumerator).toBe(90n * 29n);
    expect(thesis.subtreeStake).toBe(0n); // the thesis is never rated, so nothing writes its own

    const argument = await indexer.Argument.getOrThrow(argumentId(1));
    expect(argument.parent_id).toBe(argumentId(0));
    expect(argument.content).toBe(ALTERED); // the alteration replaced the text it was created with
    expect(argument.finalizationTime).toBe(90n);
    expect(argument.pro).toBe(21n); // 2 + 19 net
    expect(argument.con).toBe(1n); // 8 + 19 - 26 shares out
    expect(argument.stake).toBe(29n);
    expect(argument.fees).toBe(0n); // accrued 1, then claimed
    expect(argument.feesEarned).toBe(1n); // what staking on it has paid its author, claimed or not
    expect(argument.rating).toBe(90n);

    // Token balances mirror the chain: the author paid the deposit and claimed
    // the fee, the correcting rater redeemed at a profit.
    const author = await indexer.Participant.getOrThrow(participantId(AUTHOR));
    expect(author.tokens).toBe(91n); // 100 - 10 deposit + 1 fee
    const rater = await indexer.Participant.getOrThrow(participantId(RATER));
    expect(rater.tokens).toBe(104n); // 100 - 20 staked + 24 payout

    // The append-only histories keep what the folded entities flatten away: the stake
    // that moved the market, and the redemption that settled it.
    const [stake] = await indexer.Stake.getAll();
    expect(stake).toMatchObject({
      argument_id: argumentId(1),
      staker: RATER,
      isPro: false,
      voteTokensStaked: 20n,
      fee: 1n,
      sharesOut: 26n,
    });
    const [redemption] = await indexer.Redemption.getAll();
    expect(redemption).toMatchObject({
      argument_id: argumentId(1),
      account: RATER,
      proShares: 0n,
      conShares: 26n,
      payout: 24n,
    });

    const position = await indexer.Position.getOrThrow(positionId(1, RATER));
    expect(position.proShares).toBe(0n);
    expect(position.conShares).toBe(0n); // redeemed
    // The position links back to its participant, so the debate's positions are
    // reachable as `Participant.positions` - the array the batch-redeem flow reads.
    expect(position.participant_id).toBe(participantId(RATER));
  });

  it("folds the bounty lifecycle: funding, top-up, claim, and sweep", async () => {
    const indexer = createTestIndexer();
    const TOKEN = "0x00000000000000000000000000000000000000CC";

    await indexer.process({
      chains: {
        [CHAIN]: {
          simulate: [
            debateCreated,
            // The creation-attached funding arrives as its own event right after DebateCreated.
            {
              contract: "Deliberate",
              event: "BountyFunded",
              params: { debateId: 0n, funder: AUTHOR, token: TOKEN, amount: 300n, pool: 300n },
            },
            joined(AUTHOR),
            joined(RATER),
            // A top-up by someone else raises the pool; the event carries the resulting total.
            {
              contract: "Deliberate",
              event: "BountyFunded",
              params: { debateId: 0n, funder: RATER, token: TOKEN, amount: 50n, pool: 350n },
            },
            { contract: "Deliberate", event: "DebateFinished", params: { debateId: 0n, approved: true } },
            {
              contract: "Deliberate",
              event: "BountyClaimed",
              params: { debateId: 0n, account: RATER, excess: 4n, amount: 7n },
            },
            {
              contract: "Deliberate",
              event: "BountySwept",
              params: { debateId: 0n, creator: AUTHOR, amount: 343n },
            },
          ],
        },
      },
    });

    const debate = await indexer.Debate.getOrThrow(DEBATE);
    expect(debate.bountyToken).toBe(TOKEN.toLowerCase());
    expect(debate.bountyPool).toBe(350n);
    expect(debate.bountyClaimed).toBe(7n);
    expect(debate.bountySwept).toBe(true);
    expect(debate.participantsCount).toBe(2n);
    expect(debate.finishedAt).toBeDefined();

    // Both fundings are kept, each with the pool it produced - the creation deposit
    // and the top-up that followed it.
    const fundings = await indexer.BountyFunding.getAll();
    expect(fundings.map((funding) => [funding.funder, funding.amount, funding.pool])).toEqual([
      [AUTHOR, 300n, 300n],
      [RATER, 50n, 350n],
    ]);

    // The claim is one-shot per participant, so it is keyed like one.
    const claim = await indexer.BountyClaim.getOrThrow(participantId(RATER));
    expect(claim.debate_id).toBe(DEBATE);
    expect(claim.excess).toBe(4n);
    expect(claim.amount).toBe(7n);

    // The claim pays ERC-20, never vote tokens.
    const rater = await indexer.Participant.getOrThrow(participantId(RATER));
    expect(rater.tokens).toBe(100n);
  });

  it("keeps a debate mid-flight consistent while it is still being edited", async () => {
    const indexer = createTestIndexer();

    await indexer.process({
      chains: {
        [CHAIN]: {
          simulate: [debateCreated, joined(AUTHOR), argumentCreated(1n, 0n, { pro: 5n, con: 5n })],
        },
      },
    });

    const debate = await indexer.Debate.getOrThrow(DEBATE);
    expect(debate.finished).toBe(false);
    expect(debate.approved).toBeUndefined();
    expect(debate.totalStake).toBe(10n);

    const argument = await indexer.Argument.getOrThrow(argumentId(1));
    expect(argument.content).toBe(ARGUMENT);
    expect(argument.rating).toBeUndefined();

    const author = await indexer.Participant.getOrThrow(participantId(AUTHOR));
    expect(author.tokens).toBe(90n);
  });

  it("moves an argument beneath its new parent, re-seeding its market", async () => {
    const indexer = createTestIndexer();

    await indexer.process({
      chains: {
        [CHAIN]: {
          simulate: [
            debateCreated,
            joined(AUTHOR),
            argumentCreated(1n, 0n, { pro: 5n, con: 5n }),
            argumentCreated(2n, 0n, { pro: 5n, con: 5n }),
            {
              contract: "Deliberate",
              event: "ArgumentMoved",
              // Re-seeded at 80% approval: the deposit is re-split 2 pro / 8 con.
              params: { debateId: 0n, argumentId: 2n, newParentArgumentId: 1n, oldParentArgumentId: 0n, pro: 2n, con: 8n },
            },
          ],
        },
      },
    });

    const moved = await indexer.Argument.getOrThrow(argumentId(2));
    expect(moved.parent_id).toBe(argumentId(1));
    expect(moved.pro).toBe(2n);
    expect(moved.con).toBe(8n);
    expect(moved.stake).toBe(10n); // the deposit is unchanged by a move
  });
});
