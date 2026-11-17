/**
 * The end-to-end encryption scheme, version 1.
 *
 * Written out here because it has to be implemented twice -- once in
 * TypeScript for senders, once in Swift for the notification extension -- and
 * two implementations of a scheme that only mostly agree fail in the worst
 * possible way: everything looks fine until a message will not open, on
 * someone's phone, with no plaintext left anywhere to compare against.
 *
 *   content key   32 random bytes, per message
 *   body          AES-256-GCM(content key, 12-byte nonce) over UTF-8
 *   per device    ephemeral X25519 keypair
 *                 shared   = X25519(ephemeral private, device public)
 *                 wrapping = HKDF-SHA256(shared, salt = device pub || eph pub,
 *                                        info = "agentsignal/v1/wrap")
 *                 wrapped  = 12-byte nonce || AES-256-GCM(wrapping) over the
 *                            content key
 *
 * Two choices worth the words:
 *
 * The nonce is prepended to the wrapped key rather than stored beside it. It
 * is not secret, it is useless without the ciphertext it belongs to, and a
 * separate column is one more thing that can be written for the wrong row.
 *
 * Both public keys go into the HKDF salt. Without that binding, a wrap is
 * valid for any pair that happens to derive the same secret, and the wrap
 * stops being evidence of who it was for.
 *
 * Everything is plain WebCrypto: X25519, HKDF and AES-GCM are all available in
 * Node 22, in Workers, and in browsers, so a sender needs no dependency and
 * the SDK stays small enough to ship to the edge.
 */

import type { DevicePlatform } from './types.js';

export const CRYPTO_VERSION = 1;

const WRAP_INFO = 'agentsignal/v1/wrap';
const NONCE_BYTES = 12;
const KEY_BYTES = 32;

/** One device's sealed copy of the content key. */
export interface WrappedKey {
  device_id: string;
  /** base64: nonce || AES-GCM ciphertext of the content key */
  wrapped_key: string;
  /** base64: raw 32-byte X25519 public key, ephemeral to this message */
  ephemeral_public_key: string;
}

/** What a sender hands to `POST /v1/messages` under `sealed`. */
export interface SealedContent {
  /** base64 AES-GCM ciphertext of the plaintext body */
  ciphertext: string;
  /** base64 12-byte nonce for the body */
  nonce: string;
  keys: WrappedKey[];
}

export interface DeviceKey {
  device_id: string;
  /** base64 raw 32-byte X25519 public key */
  public_key: string;

  /*
    Which device this is, for a caller that has to say so.

    Sealing does not need either of these -- a device_id and a public key are
    the whole of what the scheme above uses -- but /v1/recipients/:key/keys
    hands these objects straight to the caller, and a client sealing to three
    devices otherwise has three UUIDs and no way to tell a person which is
    which, or to say afterwards in its own logs.

    OPTIONAL, and not because the server might omit them: it returns both, and
    both columns are NOT NULL. They are optional because the other direction of
    this type is a caller CONSTRUCTING one to seal with, which has no business
    knowing a device's name. Requiring them would make every seal call site
    invent a value it does not have.

    They were also absent from the endpoint between `unwrapped_base64` and
    `a_device_key_says_which_device`, so a client talking to a server in that
    range gets neither.
  */
  name?: string;
  platform?: DevicePlatform;
}

// ---------------------------------------------------------------------------
// Encoding helpers
// ---------------------------------------------------------------------------

export function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export function fromBase64(value: string): Uint8Array {
  const binary = atob(value);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

// ---------------------------------------------------------------------------
// The scheme
// ---------------------------------------------------------------------------

/**
 * Cloudflare's SubtleCrypto types predate X25519, so the algorithm object and
 * the raw key export both need narrowing. Runtime support is not in doubt --
 * the round-trip tests exercise this inside workerd, which is the most
 * constrained place we run it.
 */
type X25519Algorithm = { name: 'X25519'; public: CryptoKey };

// Derived from whatever SubtleCrypto is in scope rather than naming a DOM
// type, so this compiles the same under the Workers, Node and browser libs.
type DeriveAlgorithm = Parameters<SubtleCrypto['deriveBits']>[0];

function x25519(theirPublic: CryptoKey): DeriveAlgorithm {
  const algorithm: X25519Algorithm = { name: 'X25519', public: theirPublic };
  return algorithm as unknown as DeriveAlgorithm;
}

async function exportRaw(key: CryptoKey): Promise<Uint8Array> {
  const raw = (await crypto.subtle.exportKey('raw', key)) as unknown as ArrayBuffer;
  return new Uint8Array(raw);
}

async function wrappingKey(
  sharedSecret: ArrayBuffer,
  devicePublic: Uint8Array,
  ephemeralPublic: Uint8Array,
): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey(
    'raw',
    sharedSecret,
    'HKDF',
    false,
    ['deriveBits'],
  );

  const bits = await crypto.subtle.deriveBits(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      // Binding the wrap to this exact pair of keys.
      salt: concat(devicePublic, ephemeralPublic) as unknown as BufferSource,
      info: new TextEncoder().encode(WRAP_INFO) as unknown as BufferSource,
    },
    base,
    KEY_BYTES * 8,
  );

  return crypto.subtle.importKey('raw', bits, 'AES-GCM', false, [
    'encrypt',
    'decrypt',
  ]);
}

/**
 * Encrypt a message body once, and wrap the content key for each device.
 *
 * A device whose public key is missing or malformed is skipped rather than
 * failing the whole send: one bad row should not stop the other four people
 * from being told production is down. The caller sees which devices made it
 * and can decide whether the gap matters.
 */
export async function seal(
  plaintext: string,
  devices: DeviceKey[],
): Promise<{ sealed: SealedContent; skipped: string[] }> {
  const contentKeyBytes = crypto.getRandomValues(new Uint8Array(KEY_BYTES));
  const nonce = crypto.getRandomValues(new Uint8Array(NONCE_BYTES));

  const contentKey = await crypto.subtle.importKey(
    'raw',
    contentKeyBytes as unknown as BufferSource,
    'AES-GCM',
    false,
    ['encrypt'],
  );

  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: nonce as unknown as BufferSource },
      contentKey,
      new TextEncoder().encode(plaintext) as unknown as BufferSource,
    ),
  );

  const keys: WrappedKey[] = [];
  const skipped: string[] = [];

  for (const device of devices) {
    try {
      const devicePublic = fromBase64(device.public_key);
      if (devicePublic.length !== KEY_BYTES) throw new Error('bad key length');

      const theirs = await crypto.subtle.importKey(
        'raw',
        devicePublic as unknown as BufferSource,
        { name: 'X25519' },
        false,
        [],
      );

      // Ephemeral per device per message, so one unwrapped message does not
      // unwrap the others.
      const ephemeral = await crypto.subtle.generateKey({ name: 'X25519' }, true, [
        'deriveBits',
      ]);

      const shared = await crypto.subtle.deriveBits(
        x25519(theirs),
        (ephemeral as CryptoKeyPair).privateKey,
        KEY_BYTES * 8,
      );

      const ephemeralPublic = await exportRaw((ephemeral as CryptoKeyPair).publicKey);

      const wrapKey = await wrappingKey(shared, devicePublic, ephemeralPublic);
      const wrapNonce = crypto.getRandomValues(new Uint8Array(NONCE_BYTES));

      const wrapped = new Uint8Array(
        await crypto.subtle.encrypt(
          { name: 'AES-GCM', iv: wrapNonce as unknown as BufferSource },
          wrapKey,
          contentKeyBytes as unknown as BufferSource,
        ),
      );

      keys.push({
        device_id: device.device_id,
        wrapped_key: toBase64(concat(wrapNonce, wrapped)),
        ephemeral_public_key: toBase64(ephemeralPublic),
      });
    } catch {
      skipped.push(device.device_id);
    }
  }

  return {
    sealed: {
      ciphertext: toBase64(ciphertext),
      nonce: toBase64(nonce),
      keys,
    },
    skipped,
  };
}

/**
 * The other direction, which the device performs.
 *
 * Implemented here as well as in Swift so the scheme can be round-tripped in
 * a test. A spec that has only ever been written down is a spec nobody has
 * checked.
 */
export async function unseal(
  sealed: Pick<SealedContent, 'ciphertext' | 'nonce'>,
  wrapped: Pick<WrappedKey, 'wrapped_key' | 'ephemeral_public_key'>,
  devicePrivateKey: CryptoKey,
  devicePublicKey: Uint8Array,
): Promise<string> {
  const ephemeralPublic = fromBase64(wrapped.ephemeral_public_key);

  const theirs = await crypto.subtle.importKey(
    'raw',
    ephemeralPublic as unknown as BufferSource,
    { name: 'X25519' },
    false,
    [],
  );

  const shared = await crypto.subtle.deriveBits(
    x25519(theirs),
    devicePrivateKey,
    KEY_BYTES * 8,
  );

  const wrapKey = await wrappingKey(shared, devicePublicKey, ephemeralPublic);

  const wrappedBytes = fromBase64(wrapped.wrapped_key);
  const wrapNonce = wrappedBytes.slice(0, NONCE_BYTES);
  const wrapBody = wrappedBytes.slice(NONCE_BYTES);

  const contentKeyBytes = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: wrapNonce as unknown as BufferSource },
    wrapKey,
    wrapBody as unknown as BufferSource,
  );

  const contentKey = await crypto.subtle.importKey(
    'raw',
    contentKeyBytes,
    'AES-GCM',
    false,
    ['decrypt'],
  );

  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: fromBase64(sealed.nonce) as unknown as BufferSource },
    contentKey,
    fromBase64(sealed.ciphertext) as unknown as BufferSource,
  );

  return new TextDecoder().decode(plaintext);
}

/**
 * A fresh X25519 keypair for something that wants to be sent sealed content.
 *
 * Here rather than in whichever package happens to need it, for the reason
 * this file exists at all: the scheme is implemented twice and two
 * implementations that only mostly agree fail invisibly. Key generation is
 * part of the scheme -- the curve, and the encodings the two halves are stored
 * in -- so it belongs next to seal and unseal.
 *
 * The public half comes back RAW, which is the 32 bytes the wrap salt is built
 * from and the shape the API validates. The private half comes back PKCS8,
 * because that is the only export WebCrypto offers for a private X25519 key
 * and therefore the only thing that can be written down and imported again.
 */
export async function generateEncryptionKeypair(): Promise<{
  publicKey: string;
  privateKey: string;
}> {
  const pair = (await crypto.subtle.generateKey({ name: 'X25519' }, true, [
    'deriveBits',
  ])) as CryptoKeyPair;

  const raw = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));
  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey('pkcs8', pair.privateKey));
  return { publicKey: toBase64(raw), privateKey: toBase64(pkcs8) };
}

/** Read back a private key written by generateEncryptionKeypair. */
export async function importEncryptionPrivateKey(privateKey: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'pkcs8',
    fromBase64(privateKey) as unknown as BufferSource,
    { name: 'X25519' },
    false,
    ['deriveBits'],
  );
}
