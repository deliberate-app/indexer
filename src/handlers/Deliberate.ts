/**
 * Folds the Deliberate event stream into the debate's current state. Every contract
 * event carries the resulting state (reserves move additively, payouts arrive
 * pre-rounded), so the handlers mirror the debate without redoing any market math.
 *
 * Every handler opens with a single wave of reads. Handlers run twice - once concurrently
 * across the whole batch to warm the caches, once sequentially to fold - and it is that
 * first pass that turns a wave of `Promise.all` reads into one batched query per entity
 * for the entire batch, where awaiting them one after another would cost a round trip each.
 */
import { indexer } from "envio";

/** Addresses are normalized to lowercase, in entity IDs and fields alike. */
const addressOf = (raw: string) => raw.toLowerCase();

const argumentIdOf = (debateId: bigint, argumentId: bigint) => `${debateId}_${argumentId}`;
const participantIdOf = (debateId: bigint, account: string) => `${debateId}_${addressOf(account)}`;
const positionIdOf = (debateId: bigint, argumentId: bigint, account: string) =>
  `${debateId}_${argumentId}_${addressOf(account)}`;

indexer.onEvent({ contract: "Deliberate", event: "DebateCreated" }, async ({ event, context }) => {
  const debateId = event.params.debateId.toString();

  context.Debate.set({
    id: debateId,
    creator: addressOf(event.params.creator),
    contentURI: event.params.contentURI,
    lockingDuration: event.params.lockingDuration,
    editingEndTime: event.params.editingEndTime,
    ratingEndTime: event.params.ratingEndTime,
    feePercentage: event.params.feePercentage,
    identityRegistry: addressOf(event.params.identityRegistry),
    finished: false,
    approved: undefined,
    totalVotes: 0n,
    argumentsCount: 1n,
    participantsCount: 0n,
    finishedAt: undefined,
    // A creation-attached bounty follows as a BountyFunded event in the same transaction.
    bountyToken: undefined,
    bountyPool: 0n,
    bountyClaimed: 0n,
    bountySwept: false,
  });

  // The thesis is the debate's root argument: final from creation, without a market.
  context.Argument.set({
    id: argumentIdOf(event.params.debateId, 0n),
    debate_id: debateId,
    argumentId: 0n,
    parent_id: undefined,
    creator: addressOf(event.params.creator),
    isSupporting: undefined,
    contentURI: event.params.contentURI,
    finalizationTime: BigInt(event.block.timestamp),
    pro: 0n,
    con: 0n,
    votes: 0n,
    fees: 0n,
    feesEarned: 0n,
    rating: undefined,
  });
});

indexer.onEvent({ contract: "Deliberate", event: "Joined" }, async ({ event, context }) => {
  const debate = await context.Debate.getOrThrow(event.params.debateId.toString());

  context.Participant.set({
    id: participantIdOf(event.params.debateId, event.params.account),
    debate_id: event.params.debateId.toString(),
    account: addressOf(event.params.account),
    tokens: event.params.tokens,
  });

  // Joining is one-shot per account and debate (the contract rejects a second one),
  // so every event is a new participant.
  context.Debate.set({ ...debate, participantsCount: debate.participantsCount + 1n });
});

indexer.onEvent({ contract: "Deliberate", event: "ArgumentAdded" }, async ({ event, context }) => {
  const { debateId, argumentId, parentArgumentId, pro, con, finalizationTime } = event.params;
  // The creator's deposit seeds the market; the split is lossless, so the two reserves are it.
  const deposit = pro + con;

  const [debate, participant] = await Promise.all([
    context.Debate.getOrThrow(debateId.toString()),
    context.Participant.getOrThrow(participantIdOf(debateId, event.params.creator)),
  ]);

  context.Argument.set({
    id: argumentIdOf(debateId, argumentId),
    debate_id: debateId.toString(),
    argumentId,
    parent_id: argumentIdOf(debateId, parentArgumentId),
    creator: addressOf(event.params.creator),
    isSupporting: event.params.isSupporting,
    contentURI: event.params.contentURI,
    finalizationTime,
    pro,
    con,
    votes: deposit,
    fees: 0n,
    feesEarned: 0n,
    rating: undefined,
  });

  context.Debate.set({
    ...debate,
    argumentsCount: debate.argumentsCount + 1n,
    totalVotes: debate.totalVotes + deposit,
  });

  context.Participant.set({ ...participant, tokens: participant.tokens - deposit });
});

indexer.onEvent({ contract: "Deliberate", event: "ArgumentAltered" }, async ({ event, context }) => {
  const argument = await context.Argument.getOrThrow(argumentIdOf(event.params.debateId, event.params.argumentId));

  context.Argument.set({
    ...argument,
    contentURI: event.params.contentURI,
    finalizationTime: event.params.finalizationTime,
  });
});

indexer.onEvent({ contract: "Deliberate", event: "ArgumentMoved" }, async ({ event, context }) => {
  const argument = await context.Argument.getOrThrow(argumentIdOf(event.params.debateId, event.params.argumentId));
  // The move re-parents the argument and re-seeds its market at a new approval; the deposit
  // total (and so votes) is unchanged, only the pro/con split.
  context.Argument.set({
    ...argument,
    parent_id: argumentIdOf(event.params.debateId, event.params.newParentArgumentId),
    pro: event.params.pro,
    con: event.params.con,
  });
});

indexer.onEvent({ contract: "Deliberate", event: "Staked" }, async ({ event, context }) => {
  const { debateId, argumentId, staker, data } = event.params;
  const net = data.voteTokensStaked - data.fee;
  const positionId = positionIdOf(debateId, argumentId, staker);

  const [argument, debate, participant, held] = await Promise.all([
    context.Argument.getOrThrow(argumentIdOf(debateId, argumentId)),
    context.Debate.getOrThrow(debateId.toString()),
    context.Participant.getOrThrow(participantIdOf(debateId, staker)),
    context.Position.get(positionId),
  ]);

  // The quote fixes the rounding: the bought reserve shrinks by the shares that
  // leave the pool, the opposite reserve absorbs the net stake.
  context.Argument.set({
    ...argument,
    pro: data.isPro ? argument.pro + net - data.sharesOut : argument.pro + net,
    con: data.isPro ? argument.con + net : argument.con + net - data.sharesOut,
    votes: argument.votes + net,
    fees: argument.fees + data.fee,
    feesEarned: argument.feesEarned + data.fee,
  });

  context.Debate.set({ ...debate, totalVotes: debate.totalVotes + net });

  context.Participant.set({ ...participant, tokens: participant.tokens - data.voteTokensStaked });

  const position = held ?? {
    id: positionId,
    argument_id: argumentIdOf(debateId, argumentId),
    participant_id: participantIdOf(debateId, staker),
    account: addressOf(staker),
    proShares: 0n,
    conShares: 0n,
  };
  context.Position.set({
    ...position,
    proShares: position.proShares + (data.isPro ? data.sharesOut : 0n),
    conShares: position.conShares + (data.isPro ? 0n : data.sharesOut),
  });

  context.Stake.set({
    id: `${event.chainId}_${event.block.number}_${event.logIndex}`,
    argument_id: argumentIdOf(debateId, argumentId),
    staker: addressOf(staker),
    isPro: data.isPro,
    voteTokensStaked: data.voteTokensStaked,
    fee: data.fee,
    sharesOut: data.sharesOut,
    timestamp: BigInt(event.block.timestamp),
  });
});

indexer.onEvent({ contract: "Deliberate", event: "ArgumentRated" }, async ({ event, context }) => {
  // The emitted rating is signed - zero at the market's undecided price, negative meaning refuted.
  // The sway on the parent is the rating clamped at zero, negated if the argument attacks, both
  // recoverable from the stored stance; the clamp itself is not stored.
  const argument = await context.Argument.getOrThrow(argumentIdOf(event.params.debateId, event.params.argumentId));
  context.Argument.set({ ...argument, rating: event.params.rating });
});

indexer.onEvent({ contract: "Deliberate", event: "DebateFinished" }, async ({ event, context }) => {
  const debate = await context.Debate.getOrThrow(event.params.debateId.toString());
  // The finish time anchors the bounty claim window (CLAIM_WINDOW after it).
  context.Debate.set({
    ...debate,
    finished: true,
    approved: event.params.approved,
    finishedAt: BigInt(event.block.timestamp),
  });
});

indexer.onEvent({ contract: "Deliberate", event: "BountyFunded" }, async ({ event, context }) => {
  // The event carries the resulting pool, so funding folds without arithmetic drift; the amount
  // is what actually arrived (fee-on-transfer tokens fund less than was sent).
  const debate = await context.Debate.getOrThrow(event.params.debateId.toString());
  context.Debate.set({
    ...debate,
    bountyToken: addressOf(event.params.token),
    bountyPool: event.params.pool,
  });

  context.BountyFunding.set({
    id: `${event.chainId}_${event.block.number}_${event.logIndex}`,
    debate_id: event.params.debateId.toString(),
    funder: addressOf(event.params.funder),
    amount: event.params.amount,
    pool: event.params.pool,
    timestamp: BigInt(event.block.timestamp),
  });
});

indexer.onEvent({ contract: "Deliberate", event: "BountyClaimed" }, async ({ event, context }) => {
  // The claim pays ERC-20, not vote tokens - the settle-and-claim's redemptions and fee credits
  // arrive as their own SharesRedeemed/FeesClaimed events and are folded there.
  const debate = await context.Debate.getOrThrow(event.params.debateId.toString());
  context.Debate.set({ ...debate, bountyClaimed: debate.bountyClaimed + event.params.amount });

  context.BountyClaim.set({
    id: participantIdOf(event.params.debateId, event.params.account),
    debate_id: event.params.debateId.toString(),
    account: addressOf(event.params.account),
    excess: event.params.excess,
    amount: event.params.amount,
    timestamp: BigInt(event.block.timestamp),
  });
});

indexer.onEvent({ contract: "Deliberate", event: "BountySwept" }, async ({ event, context }) => {
  const debate = await context.Debate.getOrThrow(event.params.debateId.toString());
  context.Debate.set({ ...debate, bountySwept: true });
});

indexer.onEvent({ contract: "Deliberate", event: "SharesRedeemed" }, async ({ event, context }) => {
  const { debateId, argumentId, account } = event.params;

  const [participant, position] = await Promise.all([
    context.Participant.getOrThrow(participantIdOf(debateId, account)),
    // The contract zeroes every redeemed side; the event carries exactly what was held.
    context.Position.getOrThrow(positionIdOf(debateId, argumentId, account)),
  ]);

  context.Participant.set({ ...participant, tokens: participant.tokens + event.params.payout });

  context.Position.set({
    ...position,
    proShares: position.proShares - event.params.proShares,
    conShares: position.conShares - event.params.conShares,
  });

  context.Redemption.set({
    id: `${event.chainId}_${event.block.number}_${event.logIndex}`,
    argument_id: argumentIdOf(debateId, argumentId),
    account: addressOf(account),
    proShares: event.params.proShares,
    conShares: event.params.conShares,
    payout: event.params.payout,
    timestamp: BigInt(event.block.timestamp),
  });
});

indexer.onEvent({ contract: "Deliberate", event: "FeesClaimed" }, async ({ event, context }) => {
  const { debateId, argumentId, creator } = event.params;

  const [argument, participant] = await Promise.all([
    context.Argument.getOrThrow(argumentIdOf(debateId, argumentId)),
    context.Participant.getOrThrow(participantIdOf(debateId, creator)),
  ]);

  // The contract zeroes the accrued fees and credits them to the creator; `feesEarned`
  // is the lifetime total and stands.
  context.Argument.set({ ...argument, fees: 0n });

  context.Participant.set({ ...participant, tokens: participant.tokens + event.params.fees });
});
