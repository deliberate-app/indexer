/**
 * The production pinning backstop: every argument text the indexer sees is re-pinned
 * on a kubo-compatible node, so content availability never depends on the authoring
 * client alone. The contract stores each text as the sha-256 multihash digest of an
 * IPFS raw-leaves block; the CID is reconstructed here exactly as the frontend does.
 *
 * Pinning is best-effort: it is idempotent, replays are harmless, and a failure must
 * never stall or crash indexing. Disabled unless ENVIO_PIN_IPFS_API is set (e.g.
 * http://127.0.0.1:5001 for the dev kubo node).
 *
 * The request goes through the Effect API rather than a bare `fetch`, because handlers
 * run twice - once in the parallel preload phase, once in the sequential processing
 * phase. An effect is run once per distinct input across both, deduplicated within the
 * batch, and (with `cache`) remembered across reruns, so a resync does not re-ask for
 * every text the node already holds.
 */
import { createEffect, S, type EffectCaller } from "envio";

const BASE32_ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";

function base32(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) {
    out += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  }
  return out;
}

/** Rebuilds the CIDv1 (raw codec, sha2-256) from a 0x-prefixed 32-byte digest. */
export function cidFromDigestHex(digestHex: string): string {
  const hex = digestHex.replace(/^0x/, "");
  const digest = new Uint8Array(hex.length / 2);
  for (let i = 0; i < digest.length; i++) {
    digest[i] = parseInt(hex.slice(2 * i, 2 * i + 2), 16);
  }
  // 0x01 CIDv1, 0x55 raw codec, 0x12 sha2-256, 0x20 digest length.
  const prefixed = new Uint8Array([0x01, 0x55, 0x12, 0x20, ...digest]);
  return `b${base32(prefixed)}`;
}

/** The pinning node's API root, or undefined when the backstop is switched off. */
const pinningApi = () => process.env.ENVIO_PIN_IPFS_API;

/**
 * A pin has to find and fetch the block before it can answer, which can take as long as
 * the network does. The cap is what keeps a missing text from holding up the fold: the
 * request is abandoned, not the indexing, and the next event or resync asks again.
 */
const PIN_TIMEOUT_MS = 10_000;

/**
 * Asks the pinning node to fetch and pin one content digest. Returns whether the node
 * acknowledged it - only an acknowledged pin is cached, so a node that was down, slow,
 * or missing the block is asked again on the next run.
 */
export const pinContent = createEffect(
  {
    name: "pinContent",
    // The CID is a pure function of the digest, so the digest is the whole cache key.
    input: S.string,
    output: S.boolean,
    // Pinning is a fetch across the network per call; the cap keeps a batch of fresh
    // arguments from opening one request per argument at once.
    rateLimit: { calls: 10, per: "second" },
    // A pinned CID stays pinned: a success never needs repeating, on this run or a later one.
    cache: true,
  },
  async ({ input: digestHex, context }) => {
    const api = pinningApi();
    if (!api) {
      // Unreachable via pinDigest, which does not call the effect at all when the
      // backstop is off - but a cached "false" would outlive switching it on.
      context.cache = false;
      return false;
    }

    const cid = cidFromDigestHex(digestHex);
    try {
      const response = await fetch(`${api}/api/v0/pin/add?arg=${cid}`, {
        method: "POST",
        signal: AbortSignal.timeout(PIN_TIMEOUT_MS),
      });
      if (!response.ok) {
        context.cache = false;
        context.log.warn(`Pinning ${cid} failed with status ${response.status}`);
        return false;
      }
      return true;
    } catch (error) {
      context.cache = false;
      context.log.warn(`Pinning ${cid} failed: ${String(error)}`);
      return false;
    }
  },
);

/**
 * Pins an argument's content, if the backstop is configured. Awaiting this does not
 * serialize the fold: in the preload phase every handler's pin request is issued
 * together, and the processing phase reads the memoized result.
 */
export async function pinDigest(context: { effect: EffectCaller }, digestHex: string): Promise<void> {
  if (!pinningApi()) return;
  await context.effect(pinContent, digestHex);
}
