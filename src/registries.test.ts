import { describe, expect, it } from "vitest";
import { createTestIndexer, indexer as runtime } from "envio";

const CHAIN = runtime.chainIds[0]!;

const OWNER = "0x00000000000000000000000000000000000000aa";
const NEW_OWNER = "0x00000000000000000000000000000000000000ab";
const MEMBER = "0x00000000000000000000000000000000000000cc";
const OTHER = "0x00000000000000000000000000000000000000dd";
const ALLOWLIST = "0x0000000000000000000000000000000000000a11";
const CIRCLES = "0x0000000000000000000000000000000000000c11";
const ZERO: `0x${string}` = `0x${"00".repeat(20)}`;
const FACTORY = "0x0000000000000000000000000000000000000fac";

const registryId = (address: string) => `${CHAIN}_${address}`;
const membershipId = (registry: string, account: string) => `${registryId(registry)}_${account}`;

const allowlistCreated = {
  contract: "IdentityRegistryFactory",
  event: "AllowlistRegistryCreated",
  srcAddress: FACTORY,
  params: { registry: ALLOWLIST, owner: OWNER },
} as const;

const circlesCreated = {
  contract: "IdentityRegistryFactory",
  event: "CirclesRegistryCreated",
  srcAddress: FACTORY,
  params: { registry: CIRCLES, anchor: ZERO, requireHuman: true },
} as const;

const membershipSet = (account: `0x${string}`, member: boolean) =>
  ({
    contract: "AllowlistIdentityRegistry",
    event: "MembershipSet",
    srcAddress: ALLOWLIST,
    params: { account, member },
  }) as const;

describe("the identity registry indexer", () => {
  it("records what the factory created", async () => {
    const indexer = createTestIndexer();

    await indexer.process({ chains: { [CHAIN]: { simulate: [allowlistCreated, circlesCreated] } } });

    const allowlist = await indexer.IdentityRegistry.getOrThrow(registryId(ALLOWLIST));
    expect(allowlist.kind).toBe("ALLOWLIST");
    expect(allowlist.factory).toBe(FACTORY);
    expect(allowlist.owner).toBe(OWNER);
    expect(allowlist.anchor).toBeUndefined();

    const circles = await indexer.IdentityRegistry.getOrThrow(registryId(CIRCLES));
    expect(circles.kind).toBe("CIRCLES");
    expect(circles.owner).toBeUndefined();
    expect(circles.anchor).toBe(ZERO);
    expect(circles.requireHuman).toBe(true);
  });

  it("follows an allowlist's membership from the clone the factory announced", async () => {
    const indexer = createTestIndexer();

    await indexer.process({
      chains: {
        [CHAIN]: {
          simulate: [
            allowlistCreated,
            membershipSet(MEMBER, true),
            membershipSet(OTHER, true),
            membershipSet(OTHER, false),
          ],
        },
      },
    });

    const member = await indexer.Membership.getOrThrow(membershipId(ALLOWLIST, MEMBER));
    expect(member.member).toBe(true);
    expect(member.registry_id).toBe(registryId(ALLOWLIST));

    // A removed account keeps its row, so the list's history stays readable.
    const removed = await indexer.Membership.getOrThrow(membershipId(ALLOWLIST, OTHER));
    expect(removed.member).toBe(false);
  });

  it("follows an allowlist's owner, and ignores the transfer that initialized it", async () => {
    const indexer = createTestIndexer();

    await indexer.process({
      chains: {
        [CHAIN]: {
          simulate: [
            // The clone's own initialization fires before the factory announces it.
            {
              contract: "AllowlistIdentityRegistry",
              event: "OwnershipTransferred",
              srcAddress: ALLOWLIST,
              params: { previousOwner: ZERO, newOwner: OWNER },
            },
            allowlistCreated,
            {
              contract: "AllowlistIdentityRegistry",
              event: "OwnershipTransferred",
              srcAddress: ALLOWLIST,
              params: { previousOwner: OWNER, newOwner: NEW_OWNER },
            },
          ],
        },
      },
    });

    const allowlist = await indexer.IdentityRegistry.getOrThrow(registryId(ALLOWLIST));
    expect(allowlist.owner).toBe(NEW_OWNER);
  });
});
