/**
 * The production pinning backstop: every argument text the indexer sees is re-pinned
 * on a kubo-compatible node, so content availability never depends on the authoring
 * client alone. The contract stores each text as the sha-256 multihash digest of an
 * IPFS raw-leaves block; the CID is reconstructed here exactly as the frontend does.
 *
 * Pinning is best-effort and fire-and-forget: it is idempotent, replays are harmless,
 * and a failure must never stall or crash indexing. Disabled unless ENVIO_PIN_IPFS_API
 * is set (e.g. http://127.0.0.1:5001 for the dev kubo node).
 */

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

/** Asks the pinning node to fetch and pin the content behind an on-chain digest. */
export function pinDigest(digestHex: string): void {
  const api = process.env.ENVIO_PIN_IPFS_API;
  if (!api) return;

  const cid = cidFromDigestHex(digestHex);
  fetch(`${api}/api/v0/pin/add?arg=${cid}`, { method: "POST" }).catch(() => {
    // Best-effort: the next resync or a later event will try again.
  });
}
