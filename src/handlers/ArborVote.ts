/**
 * Folds the ArborVote event stream into the debate's current state. Every contract
 * event carries the resulting state (reserves move additively, payouts arrive
 * pre-rounded), so the handlers mirror the debate without redoing any market math.
 */
import { indexer } from "envio";
import type { Debate } from "envio";
import { pinDigest } from "../pinning";

/** Phase.Status on-chain: 0 Uninitialized, 1 Editing, 2 Rating, 3 Tallying, 4 Finished. */
const PHASE_BY_STATUS: Record<number, Debate["phase"]> = {
  1: "EDITING",
  2: "RATING",
  3: "TALLYING",
  4: "FINISHED",
};

/** Addresses are normalized to lowercase, in entity IDs and fields alike. */
const addressOf = (raw: string) => raw.toLowerCase();

const argumentIdOf = (debateId: bigint, argumentId: bigint) => `${debateId}_${argumentId}`;
const participantIdOf = (debateId: bigint, account: string) => `${debateId}_${addressOf(account)}`;
const positionIdOf = (debateId: bigint, argumentId: bigint, account: string) =>
  `${debateId}_${argumentId}_${addressOf(account)}`;

indexer.onEvent({ contract: "ArborVote", event: "DebateCreated" }, async ({ event, context }) => {
  const debateId = event.params.debateId.toString();

  context.Debate.set({
    id: debateId,
    creator: addressOf(event.params.creator),
    contentURI: event.params.contentURI,
    timeUnit: event.params.timeUnit,
    editingEndTime: event.params.editingEndTime,
    ratingEndTime: event.params.ratingEndTime,
    phase: "EDITING",
    approved: undefined,
    totalVotes: 0n,
    argumentsCount: 1n,
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
    state: "FINAL",
    finalizationTime: BigInt(event.block.timestamp),
    pro: 0n,
    con: 0n,
    votes: 0n,
    fees: 0n,
    impact: undefined,
  });

  pinDigest(event.params.contentURI);
});

indexer.onEvent({ contract: "ArborVote", event: "Joined" }, async ({ event, context }) => {
  context.Participant.set({
    id: participantIdOf(event.params.debateId, event.params.account),
    debate_id: event.params.debateId.toString(),
    account: addressOf(event.params.account),
    tokens: event.params.tokens,
  });
});

indexer.onEvent({ contract: "ArborVote", event: "ArgumentAdded" }, async ({ event, context }) => {
  const { debateId, argumentId, parentArgumentId, pro, con, finalizationTime } = event.params;
  const deposit = pro + con;

  context.Argument.set({
    id: argumentIdOf(debateId, argumentId),
    debate_id: debateId.toString(),
    argumentId,
    parent_id: argumentIdOf(debateId, parentArgumentId),
    creator: addressOf(event.params.creator),
    isSupporting: event.params.isSupporting,
    contentURI: event.params.contentURI,
    state: "CREATED",
    finalizationTime,
    pro,
    con,
    votes: deposit,
    fees: 0n,
    impact: undefined,
  });

  const debate = await context.Debate.getOrThrow(debateId.toString());
  context.Debate.set({
    ...debate,
    argumentsCount: debate.argumentsCount + 1n,
    totalVotes: debate.totalVotes + deposit,
  });

  // The creator pays the deposit that seeds the argument's market.
  const participant = await context.Participant.getOrThrow(participantIdOf(debateId, event.params.creator));
  context.Participant.set({ ...participant, tokens: participant.tokens - deposit });

  pinDigest(event.params.contentURI);
});

indexer.onEvent({ contract: "ArborVote", event: "ArgumentAltered" }, async ({ event, context }) => {
  const argument = await context.Argument.getOrThrow(argumentIdOf(event.params.debateId, event.params.argumentId));
  context.Argument.set({
    ...argument,
    contentURI: event.params.contentURI,
    finalizationTime: event.params.finalizationTime,
  });

  pinDigest(event.params.contentURI);
});

indexer.onEvent({ contract: "ArborVote", event: "ArgumentMoved" }, async ({ event, context }) => {
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

indexer.onEvent({ contract: "ArborVote", event: "ArgumentFinalized" }, async ({ event, context }) => {
  const argument = await context.Argument.getOrThrow(argumentIdOf(event.params.debateId, event.params.argumentId));
  context.Argument.set({ ...argument, state: "FINAL" });
});

indexer.onEvent({ contract: "ArborVote", event: "PhaseAdvanced" }, async ({ event, context }) => {
  const debate = await context.Debate.getOrThrow(event.params.debateId.toString());
  const phase = PHASE_BY_STATUS[Number(event.params.newPhase)];
  if (phase === undefined) {
    throw new Error(`PhaseAdvanced carried an unknown phase status ${event.params.newPhase}`);
  }
  context.Debate.set({ ...debate, phase });
});

indexer.onEvent({ contract: "ArborVote", event: "Staked" }, async ({ event, context }) => {
  const { debateId, argumentId, staker, data } = event.params;
  const net = data.voteTokensStaked - data.fee;

  // The quote fixes the rounding: the bought reserve shrinks by the shares that
  // leave the pool, the opposite reserve absorbs the net stake.
  const argument = await context.Argument.getOrThrow(argumentIdOf(debateId, argumentId));
  context.Argument.set({
    ...argument,
    pro: data.isPro ? argument.pro + net - data.sharesOut : argument.pro + net,
    con: data.isPro ? argument.con + net : argument.con + net - data.sharesOut,
    votes: argument.votes + net,
    fees: argument.fees + data.fee,
  });

  const debate = await context.Debate.getOrThrow(debateId.toString());
  context.Debate.set({ ...debate, totalVotes: debate.totalVotes + net });

  const participant = await context.Participant.getOrThrow(participantIdOf(debateId, staker));
  context.Participant.set({ ...participant, tokens: participant.tokens - data.voteTokensStaked });

  const positionId = positionIdOf(debateId, argumentId, staker);
  const position = (await context.Position.get(positionId)) ?? {
    id: positionId,
    argument_id: argumentIdOf(debateId, argumentId),
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

indexer.onEvent({ contract: "ArborVote", event: "ArgumentImpactCalculated" }, async ({ event, context }) => {
  const argument = await context.Argument.getOrThrow(argumentIdOf(event.params.debateId, event.params.argumentId));
  context.Argument.set({ ...argument, impact: event.params.impact });
});

indexer.onEvent({ contract: "ArborVote", event: "DebateFinished" }, async ({ event, context }) => {
  const debate = await context.Debate.getOrThrow(event.params.debateId.toString());
  context.Debate.set({ ...debate, phase: "FINISHED", approved: event.params.approved });
});

indexer.onEvent({ contract: "ArborVote", event: "SharesRedeemed" }, async ({ event, context }) => {
  const { debateId, argumentId, account } = event.params;

  const participant = await context.Participant.getOrThrow(participantIdOf(debateId, account));
  context.Participant.set({ ...participant, tokens: participant.tokens + event.params.payout });

  // The contract zeroes every redeemed side; the event carries exactly what was held.
  const position = await context.Position.getOrThrow(positionIdOf(debateId, argumentId, account));
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

indexer.onEvent({ contract: "ArborVote", event: "FeesClaimed" }, async ({ event, context }) => {
  const { debateId, argumentId, creator } = event.params;

  // The contract zeroes the accrued fees and credits them to the creator.
  const argument = await context.Argument.getOrThrow(argumentIdOf(debateId, argumentId));
  context.Argument.set({ ...argument, fees: 0n });

  const participant = await context.Participant.getOrThrow(participantIdOf(debateId, creator));
  context.Participant.set({ ...participant, tokens: participant.tokens + event.params.fees });
});
