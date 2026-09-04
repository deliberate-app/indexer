/**
 * Folds the identity registries a debate creator can pick from: the factory's creation events, and the
 * membership of every allowlist it cloned.
 *
 * The factory has an address; the allowlists it clones do not until it clones them, so each
 * `AllowlistRegistryCreated` event registers the new clone and its `MembershipSet` events are folded
 * from that block on. Circles registries emit nothing after creation - their admission is read from the
 * Circles Hub at join time - so a creation row is all there is to fold for them.
 */
import { indexer } from "envio";

/** Addresses are normalized to lowercase, in entity IDs and fields alike. */
const addressOf = (raw: string) => raw.toLowerCase();

/** Every entity ID opens with the chain it happened on, as in the Deliberate handlers. */
const registryIdOf = (chainId: number, registry: string) => `${chainId}_${addressOf(registry)}`;
const membershipIdOf = (chainId: number, registry: string, account: string) =>
  `${registryIdOf(chainId, registry)}_${addressOf(account)}`;

indexer.contractRegister(
  { contract: "IdentityRegistryFactory", event: "AllowlistRegistryCreated" },
  async ({ event, context }) => {
    context.chain.AllowlistIdentityRegistry.add(event.params.registry);
  },
);

indexer.onEvent(
  { contract: "IdentityRegistryFactory", event: "AllowlistRegistryCreated" },
  async ({ event, context }) => {
    context.IdentityRegistry.set({
      id: registryIdOf(event.chainId, event.params.registry),
      chainId: event.chainId,
      address: addressOf(event.params.registry),
      kind: "ALLOWLIST",
      owner: addressOf(event.params.owner),
      anchor: undefined,
      requireHuman: undefined,
      createdAt: BigInt(event.block.timestamp),
    });
  },
);

indexer.onEvent(
  { contract: "IdentityRegistryFactory", event: "CirclesRegistryCreated" },
  async ({ event, context }) => {
    context.IdentityRegistry.set({
      id: registryIdOf(event.chainId, event.params.registry),
      chainId: event.chainId,
      address: addressOf(event.params.registry),
      kind: "CIRCLES",
      owner: undefined,
      anchor: addressOf(event.params.anchor),
      requireHuman: event.params.requireHuman,
      createdAt: BigInt(event.block.timestamp),
    });
  },
);

indexer.onEvent(
  { contract: "AllowlistIdentityRegistry", event: "MembershipSet" },
  async ({ event, context }) => {
    const registryId = registryIdOf(event.chainId, event.srcAddress);

    context.Membership.set({
      id: membershipIdOf(event.chainId, event.srcAddress, event.params.account),
      registry_id: registryId,
      account: addressOf(event.params.account),
      member: event.params.member,
      updatedAt: BigInt(event.block.timestamp),
    });
  },
);

indexer.onEvent(
  { contract: "AllowlistIdentityRegistry", event: "OwnershipTransferred" },
  async ({ event, context }) => {
    const registry = await context.IdentityRegistry.get(registryIdOf(event.chainId, event.srcAddress));

    // The first transfer is the clone's initialization, emitted before the factory announces the
    // registry in the same transaction. The announcement carries that owner, so there is nothing to
    // fold until the row exists.
    if (registry === undefined) {
      return;
    }
    context.IdentityRegistry.set({ ...registry, owner: addressOf(event.params.newOwner) });
  },
);
