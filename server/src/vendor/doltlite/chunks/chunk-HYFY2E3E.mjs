// packages/canonical/src/errors.ts
var CanonicalError = class extends Error {
  constructor(code, message, details) {
    super(message);
    this.code = code;
    this.details = details;
    this.name = "CanonicalError";
  }
  code;
  details;
};
function canonicalInvariant(condition, code, message, details) {
  if (!condition) throw new CanonicalError(code, message, details);
}

// packages/canonical/src/bytes.ts
var textEncoder = new TextEncoder();
var fatalTextDecoder = new TextDecoder("utf-8", { fatal: true });
function utf8(value) {
  const encoded = textEncoder.encode(value);
  try {
    if (fatalTextDecoder.decode(encoded) !== value) throw new CanonicalError("INVALID_UTF8", "Text contains an unpaired UTF-16 surrogate");
  } catch (error) {
    if (error instanceof CanonicalError) throw error;
    throw new CanonicalError("INVALID_UTF8", "Text cannot be represented as canonical UTF-8");
  }
  return encoded;
}
function decodeUtf8(value) {
  try {
    return fatalTextDecoder.decode(value);
  } catch {
    throw new CanonicalError("INVALID_UTF8", "Bytes are not valid UTF-8");
  }
}
function concatBytes(...parts) {
  const size = parts.reduce((sum, part) => sum + part.length, 0);
  const result = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}
function compareBytes(left, right) {
  const size = Math.min(left.length, right.length);
  for (let index = 0; index < size; index += 1) {
    const difference = left[index] - right[index];
    if (difference !== 0) return difference < 0 ? -1 : 1;
  }
  return left.length === right.length ? 0 : left.length < right.length ? -1 : 1;
}
function equalBytes(left, right) {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) difference |= left[index] ^ right[index];
  return difference === 0;
}
function bytesToHex(value) {
  return [...value].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
function hexToBytes(value) {
  if (!/^(?:[0-9a-fA-F]{2})*$/u.test(value)) throw new CanonicalError("SCHEMA_INVALID", "Hex text is malformed");
  return Uint8Array.from({ length: value.length / 2 }, (_unused, index) => Number.parseInt(value.slice(index * 2, index * 2 + 2), 16));
}
function copyBytes(value) {
  return Uint8Array.from(value);
}

// packages/canonical/src/cbor.ts
var DEFAULT_DECODE_LIMITS = Object.freeze({
  maxBytes: 16 * 1024 * 1024,
  maxDepth: 64,
  maxArrayItems: 1e6,
  maxMapItems: 1e5,
  maxTextBytes: 4 * 1024 * 1024,
  maxBlobBytes: 16 * 1024 * 1024
});
var MAX_UINT64 = (1n << 64n) - 1n;
var POSITIVE_BIGNUM_TAG = 2n;
var NEGATIVE_BIGNUM_TAG = 3n;
function encodeHead(major, value) {
  canonicalInvariant(value >= 0n && value <= MAX_UINT64, "INTEGER_OUT_OF_RANGE", "CBOR integer is outside uint64 range");
  if (value < 24n) return Uint8Array.of(major << 5 | Number(value));
  if (value <= 0xffn) return Uint8Array.of(major << 5 | 24, Number(value));
  if (value <= 0xffffn) return Uint8Array.of(major << 5 | 25, Number(value >> 8n), Number(value & 0xffn));
  if (value <= 0xffffffffn) {
    const bytes2 = new Uint8Array(5);
    bytes2[0] = major << 5 | 26;
    new DataView(bytes2.buffer).setUint32(1, Number(value), false);
    return bytes2;
  }
  const bytes = new Uint8Array(9);
  bytes[0] = major << 5 | 27;
  new DataView(bytes.buffer).setBigUint64(1, value, false);
  return bytes;
}
function magnitudeBytes(value) {
  canonicalInvariant(value > MAX_UINT64, "INTEGER_OUT_OF_RANGE", "CBOR bignum must exceed uint64 range");
  const octets = [];
  for (let remaining = value; remaining > 0n; remaining >>= 8n) octets.push(Number(remaining & 0xffn));
  octets.reverse();
  return Uint8Array.from(octets);
}
function encodeBigint(value) {
  const negative = value < 0n;
  const magnitude = negative ? -1n - value : value;
  if (magnitude <= MAX_UINT64) return encodeHead(negative ? 1 : 0, magnitude);
  const bytes = magnitudeBytes(magnitude);
  return concatBytes(
    encodeHead(6, negative ? NEGATIVE_BIGNUM_TAG : POSITIVE_BIGNUM_TAG),
    encodeHead(2, BigInt(bytes.length)),
    bytes
  );
}
function isMap(value) {
  return value instanceof Map;
}
function encodeCanonicalCbor(value) {
  if (value === null) return Uint8Array.of(246);
  if (value === false) return Uint8Array.of(244);
  if (value === true) return Uint8Array.of(245);
  if (typeof value === "bigint") return encodeBigint(value);
  if (typeof value === "string") {
    const bytes = utf8(value);
    return concatBytes(encodeHead(3, BigInt(bytes.length)), bytes);
  }
  if (value instanceof Uint8Array) return concatBytes(encodeHead(2, BigInt(value.length)), value);
  if (Array.isArray(value)) return concatBytes(encodeHead(4, BigInt(value.length)), ...value.map(encodeCanonicalCbor));
  if (isMap(value)) {
    const entries = [...value].map(([key, item]) => ({ key: encodeCanonicalCbor(key), value: encodeCanonicalCbor(item) })).sort((a, b) => a.key.length === b.key.length ? compareBytes(a.key, b.key) : a.key.length - b.key.length);
    for (let index = 1; index < entries.length; index += 1) canonicalInvariant(!equalBytes(entries[index - 1].key, entries[index].key), "CBOR_NON_CANONICAL", "Duplicate canonical CBOR map key");
    return concatBytes(encodeHead(5, BigInt(entries.length)), ...entries.flatMap((entry) => [entry.key, entry.value]));
  }
  throw new CanonicalError("SCHEMA_INVALID", "Value is not supported by the deterministic CBOR profile");
}
var Decoder = class {
  constructor(input, limits) {
    this.input = input;
    this.limits = limits;
    canonicalInvariant(input.length <= limits.maxBytes, "CBOR_LIMIT_EXCEEDED", "CBOR input exceeds byte limit");
  }
  input;
  limits;
  offset = 0;
  decode() {
    const value = this.value(0);
    canonicalInvariant(this.offset === this.input.length, "CBOR_INVALID", "Trailing bytes after CBOR value");
    return value;
  }
  byte() {
    canonicalInvariant(this.offset < this.input.length, "CBOR_INVALID", "Unexpected end of CBOR input");
    return this.input[this.offset++];
  }
  bytes(size) {
    canonicalInvariant(Number.isSafeInteger(size) && size >= 0 && this.offset + size <= this.input.length, "CBOR_INVALID", "Invalid or truncated CBOR byte range");
    const value = this.input.slice(this.offset, this.offset + size);
    this.offset += size;
    return value;
  }
  argument(additional) {
    if (additional < 24) return BigInt(additional);
    const read = (size) => {
      const bytes = this.bytes(size);
      const view = new DataView(bytes.buffer, bytes.byteOffset, size);
      return size === 1 ? BigInt(bytes[0]) : size === 2 ? BigInt(view.getUint16(0, false)) : size === 4 ? BigInt(view.getUint32(0, false)) : view.getBigUint64(0, false);
    };
    if (additional === 24) {
      const v = read(1);
      canonicalInvariant(v >= 24n, "CBOR_NON_CANONICAL", "Non-shortest CBOR integer");
      return v;
    }
    if (additional === 25) {
      const v = read(2);
      canonicalInvariant(v > 0xffn, "CBOR_NON_CANONICAL", "Non-shortest CBOR integer");
      return v;
    }
    if (additional === 26) {
      const v = read(4);
      canonicalInvariant(v > 0xffffn, "CBOR_NON_CANONICAL", "Non-shortest CBOR integer");
      return v;
    }
    if (additional === 27) {
      const v = read(8);
      canonicalInvariant(v > 0xffffffffn, "CBOR_NON_CANONICAL", "Non-shortest CBOR integer");
      return v;
    }
    if (additional === 31) throw new CanonicalError("CBOR_NON_CANONICAL", "Indefinite-length CBOR is prohibited");
    throw new CanonicalError("CBOR_INVALID", "Reserved CBOR additional information");
  }
  bignum(tag, depth) {
    canonicalInvariant(tag === POSITIVE_BIGNUM_TAG || tag === NEGATIVE_BIGNUM_TAG, "CBOR_INVALID", "Unsupported CBOR tag");
    canonicalInvariant(depth < this.limits.maxDepth, "CBOR_LIMIT_EXCEEDED", "CBOR nesting exceeds limit");
    const initial = this.byte(), major = initial >> 5, additional = initial & 31;
    canonicalInvariant(major === 2, "CBOR_INVALID", "CBOR bignum payload must be a byte string");
    const argument = this.argument(additional);
    canonicalInvariant(argument <= BigInt(Number.MAX_SAFE_INTEGER), "CBOR_LIMIT_EXCEEDED", "CBOR bignum is too large");
    const size = Number(argument);
    canonicalInvariant(size <= this.limits.maxBlobBytes, "CBOR_LIMIT_EXCEEDED", "CBOR bignum exceeds blob limit");
    const bytes = this.bytes(size);
    canonicalInvariant(bytes.length > 8 && bytes[0] !== 0, "CBOR_NON_CANONICAL", "CBOR bignum is not minimally encoded");
    let magnitude = 0n;
    for (const byte of bytes) magnitude = magnitude << 8n | BigInt(byte);
    canonicalInvariant(magnitude > MAX_UINT64, "CBOR_NON_CANONICAL", "CBOR bignum must use the ordinary integer representation");
    return tag === POSITIVE_BIGNUM_TAG ? magnitude : -1n - magnitude;
  }
  value(depth) {
    canonicalInvariant(depth <= this.limits.maxDepth, "CBOR_LIMIT_EXCEEDED", "CBOR nesting exceeds limit");
    const initial = this.byte(), major = initial >> 5, additional = initial & 31;
    if (major === 7) {
      if (additional === 20) return false;
      if (additional === 21) return true;
      if (additional === 22) return null;
      throw new CanonicalError("CBOR_INVALID", "Floating point and unsupported simple CBOR values are prohibited");
    }
    const argument = this.argument(additional);
    if (major === 6) return this.bignum(argument, depth + 1);
    if (major === 0) return argument;
    if (major === 1) return -1n - argument;
    canonicalInvariant(argument <= BigInt(Number.MAX_SAFE_INTEGER), "CBOR_LIMIT_EXCEEDED", "CBOR collection is too large");
    const size = Number(argument);
    if (major === 2) {
      canonicalInvariant(size <= this.limits.maxBlobBytes, "CBOR_LIMIT_EXCEEDED", "CBOR blob exceeds limit");
      return this.bytes(size);
    }
    if (major === 3) {
      canonicalInvariant(size <= this.limits.maxTextBytes, "CBOR_LIMIT_EXCEEDED", "CBOR text exceeds limit");
      return decodeUtf8(this.bytes(size));
    }
    if (major === 4) {
      canonicalInvariant(size <= this.limits.maxArrayItems, "CBOR_LIMIT_EXCEEDED", "CBOR array exceeds item limit");
      return Array.from({ length: size }, () => this.value(depth + 1));
    }
    if (major === 5) {
      canonicalInvariant(size <= this.limits.maxMapItems, "CBOR_LIMIT_EXCEEDED", "CBOR map exceeds item limit");
      const map = /* @__PURE__ */ new Map();
      let previous;
      for (let index = 0; index < size; index += 1) {
        const start = this.offset, key = this.value(depth + 1);
        canonicalInvariant(typeof key === "bigint" || typeof key === "string" || key instanceof Uint8Array, "CBOR_INVALID", "Unsupported CBOR map key");
        const encoded = this.input.slice(start, this.offset);
        if (previous !== void 0) canonicalInvariant(previous.length === encoded.length ? compareBytes(previous, encoded) < 0 : previous.length < encoded.length, "CBOR_NON_CANONICAL", "CBOR map keys are duplicate or incorrectly ordered");
        previous = encoded;
        map.set(key, this.value(depth + 1));
      }
      return map;
    }
    throw new CanonicalError("CBOR_INVALID", `Unsupported CBOR major type ${major}`);
  }
};
function decodeCanonicalCbor(input, limits) {
  return new Decoder(input, limits).decode();
}
function assertCanonicalCbor(input, limits) {
  const value = decodeCanonicalCbor(input, limits);
  canonicalInvariant(equalBytes(encodeCanonicalCbor(value), input), "CBOR_NON_CANONICAL", "CBOR bytes are not canonical");
  return value;
}

// packages/canonical/src/hash.ts
var HASH_DOMAINS = Object.freeze({
  transaction: "chronolog/transaction",
  schema: "chronolog/schema",
  executionManifest: "chronolog/execution-manifest",
  queryResult: "chronolog/query-result",
  expectation: "chronolog/expectation",
  module: "chronolog/module",
  entropy: "chronolog/entropy",
  platformObject: "chronolog/platform-object"
});
function bufferSource(value) {
  return Uint8Array.from(value).buffer;
}
function domainSeparatedBytes(domain, payload) {
  const name = utf8(HASH_DOMAINS[domain]);
  const size = new Uint8Array(4);
  new DataView(size.buffer).setUint32(0, name.length, false);
  return concatBytes(size, name, Uint8Array.of(0), payload);
}
async function sha256(payload) {
  return new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", bufferSource(payload)));
}
async function hashDomain(domain, payload) {
  return sha256(domainSeparatedBytes(domain, payload));
}

// node_modules/.pnpm/@noble+hashes@1.8.0/node_modules/@noble/hashes/esm/utils.js
function isBytes(a) {
  return a instanceof Uint8Array || ArrayBuffer.isView(a) && a.constructor.name === "Uint8Array";
}
function abytes(b, ...lengths) {
  if (!isBytes(b))
    throw new Error("Uint8Array expected");
  if (lengths.length > 0 && !lengths.includes(b.length))
    throw new Error("Uint8Array expected of length " + lengths + ", got length=" + b.length);
}
function aexists(instance, checkFinished = true) {
  if (instance.destroyed)
    throw new Error("Hash instance has been destroyed");
  if (checkFinished && instance.finished)
    throw new Error("Hash#digest() has already been called");
}
function aoutput(out, instance) {
  abytes(out);
  const min = instance.outputLen;
  if (out.length < min) {
    throw new Error("digestInto() expects output buffer of length at least " + min);
  }
}
function clean(...arrays) {
  for (let i = 0; i < arrays.length; i++) {
    arrays[i].fill(0);
  }
}
function createView(arr) {
  return new DataView(arr.buffer, arr.byteOffset, arr.byteLength);
}
function rotr(word, shift) {
  return word << 32 - shift | word >>> shift;
}
function utf8ToBytes(str) {
  if (typeof str !== "string")
    throw new Error("string expected");
  return new Uint8Array(new TextEncoder().encode(str));
}
function toBytes(data) {
  if (typeof data === "string")
    data = utf8ToBytes(data);
  abytes(data);
  return data;
}
var Hash = class {
};
function createHasher(hashCons) {
  const hashC = (msg) => hashCons().update(toBytes(msg)).digest();
  const tmp = hashCons();
  hashC.outputLen = tmp.outputLen;
  hashC.blockLen = tmp.blockLen;
  hashC.create = () => hashCons();
  return hashC;
}

// node_modules/.pnpm/@noble+hashes@1.8.0/node_modules/@noble/hashes/esm/_md.js
function setBigUint64(view, byteOffset, value, isLE) {
  if (typeof view.setBigUint64 === "function")
    return view.setBigUint64(byteOffset, value, isLE);
  const _32n = BigInt(32);
  const _u32_max = BigInt(4294967295);
  const wh = Number(value >> _32n & _u32_max);
  const wl = Number(value & _u32_max);
  const h = isLE ? 4 : 0;
  const l = isLE ? 0 : 4;
  view.setUint32(byteOffset + h, wh, isLE);
  view.setUint32(byteOffset + l, wl, isLE);
}
function Chi(a, b, c) {
  return a & b ^ ~a & c;
}
function Maj(a, b, c) {
  return a & b ^ a & c ^ b & c;
}
var HashMD = class extends Hash {
  constructor(blockLen, outputLen, padOffset, isLE) {
    super();
    this.finished = false;
    this.length = 0;
    this.pos = 0;
    this.destroyed = false;
    this.blockLen = blockLen;
    this.outputLen = outputLen;
    this.padOffset = padOffset;
    this.isLE = isLE;
    this.buffer = new Uint8Array(blockLen);
    this.view = createView(this.buffer);
  }
  update(data) {
    aexists(this);
    data = toBytes(data);
    abytes(data);
    const { view, buffer, blockLen } = this;
    const len = data.length;
    for (let pos = 0; pos < len; ) {
      const take = Math.min(blockLen - this.pos, len - pos);
      if (take === blockLen) {
        const dataView = createView(data);
        for (; blockLen <= len - pos; pos += blockLen)
          this.process(dataView, pos);
        continue;
      }
      buffer.set(data.subarray(pos, pos + take), this.pos);
      this.pos += take;
      pos += take;
      if (this.pos === blockLen) {
        this.process(view, 0);
        this.pos = 0;
      }
    }
    this.length += data.length;
    this.roundClean();
    return this;
  }
  digestInto(out) {
    aexists(this);
    aoutput(out, this);
    this.finished = true;
    const { buffer, view, blockLen, isLE } = this;
    let { pos } = this;
    buffer[pos++] = 128;
    clean(this.buffer.subarray(pos));
    if (this.padOffset > blockLen - pos) {
      this.process(view, 0);
      pos = 0;
    }
    for (let i = pos; i < blockLen; i++)
      buffer[i] = 0;
    setBigUint64(view, blockLen - 8, BigInt(this.length * 8), isLE);
    this.process(view, 0);
    const oview = createView(out);
    const len = this.outputLen;
    if (len % 4)
      throw new Error("_sha2: outputLen should be aligned to 32bit");
    const outLen = len / 4;
    const state = this.get();
    if (outLen > state.length)
      throw new Error("_sha2: outputLen bigger than state");
    for (let i = 0; i < outLen; i++)
      oview.setUint32(4 * i, state[i], isLE);
  }
  digest() {
    const { buffer, outputLen } = this;
    this.digestInto(buffer);
    const res = buffer.slice(0, outputLen);
    this.destroy();
    return res;
  }
  _cloneInto(to) {
    to || (to = new this.constructor());
    to.set(...this.get());
    const { blockLen, buffer, length, finished, destroyed, pos } = this;
    to.destroyed = destroyed;
    to.finished = finished;
    to.length = length;
    to.pos = pos;
    if (length % blockLen)
      to.buffer.set(buffer);
    return to;
  }
  clone() {
    return this._cloneInto();
  }
};
var SHA256_IV = /* @__PURE__ */ Uint32Array.from([
  1779033703,
  3144134277,
  1013904242,
  2773480762,
  1359893119,
  2600822924,
  528734635,
  1541459225
]);

// node_modules/.pnpm/@noble+hashes@1.8.0/node_modules/@noble/hashes/esm/sha2.js
var SHA256_K = /* @__PURE__ */ Uint32Array.from([
  1116352408,
  1899447441,
  3049323471,
  3921009573,
  961987163,
  1508970993,
  2453635748,
  2870763221,
  3624381080,
  310598401,
  607225278,
  1426881987,
  1925078388,
  2162078206,
  2614888103,
  3248222580,
  3835390401,
  4022224774,
  264347078,
  604807628,
  770255983,
  1249150122,
  1555081692,
  1996064986,
  2554220882,
  2821834349,
  2952996808,
  3210313671,
  3336571891,
  3584528711,
  113926993,
  338241895,
  666307205,
  773529912,
  1294757372,
  1396182291,
  1695183700,
  1986661051,
  2177026350,
  2456956037,
  2730485921,
  2820302411,
  3259730800,
  3345764771,
  3516065817,
  3600352804,
  4094571909,
  275423344,
  430227734,
  506948616,
  659060556,
  883997877,
  958139571,
  1322822218,
  1537002063,
  1747873779,
  1955562222,
  2024104815,
  2227730452,
  2361852424,
  2428436474,
  2756734187,
  3204031479,
  3329325298
]);
var SHA256_W = /* @__PURE__ */ new Uint32Array(64);
var SHA256 = class extends HashMD {
  constructor(outputLen = 32) {
    super(64, outputLen, 8, false);
    this.A = SHA256_IV[0] | 0;
    this.B = SHA256_IV[1] | 0;
    this.C = SHA256_IV[2] | 0;
    this.D = SHA256_IV[3] | 0;
    this.E = SHA256_IV[4] | 0;
    this.F = SHA256_IV[5] | 0;
    this.G = SHA256_IV[6] | 0;
    this.H = SHA256_IV[7] | 0;
  }
  get() {
    const { A, B, C, D, E, F, G, H } = this;
    return [A, B, C, D, E, F, G, H];
  }
  // prettier-ignore
  set(A, B, C, D, E, F, G, H) {
    this.A = A | 0;
    this.B = B | 0;
    this.C = C | 0;
    this.D = D | 0;
    this.E = E | 0;
    this.F = F | 0;
    this.G = G | 0;
    this.H = H | 0;
  }
  process(view, offset) {
    for (let i = 0; i < 16; i++, offset += 4)
      SHA256_W[i] = view.getUint32(offset, false);
    for (let i = 16; i < 64; i++) {
      const W15 = SHA256_W[i - 15];
      const W2 = SHA256_W[i - 2];
      const s0 = rotr(W15, 7) ^ rotr(W15, 18) ^ W15 >>> 3;
      const s1 = rotr(W2, 17) ^ rotr(W2, 19) ^ W2 >>> 10;
      SHA256_W[i] = s1 + SHA256_W[i - 7] + s0 + SHA256_W[i - 16] | 0;
    }
    let { A, B, C, D, E, F, G, H } = this;
    for (let i = 0; i < 64; i++) {
      const sigma1 = rotr(E, 6) ^ rotr(E, 11) ^ rotr(E, 25);
      const T1 = H + sigma1 + Chi(E, F, G) + SHA256_K[i] + SHA256_W[i] | 0;
      const sigma0 = rotr(A, 2) ^ rotr(A, 13) ^ rotr(A, 22);
      const T2 = sigma0 + Maj(A, B, C) | 0;
      H = G;
      G = F;
      F = E;
      E = D + T1 | 0;
      D = C;
      C = B;
      B = A;
      A = T1 + T2 | 0;
    }
    A = A + this.A | 0;
    B = B + this.B | 0;
    C = C + this.C | 0;
    D = D + this.D | 0;
    E = E + this.E | 0;
    F = F + this.F | 0;
    G = G + this.G | 0;
    H = H + this.H | 0;
    this.set(A, B, C, D, E, F, G, H);
  }
  roundClean() {
    clean(SHA256_W);
  }
  destroy() {
    this.set(0, 0, 0, 0, 0, 0, 0, 0);
    clean(this.buffer);
  }
};
var sha2562 = /* @__PURE__ */ createHasher(() => new SHA256());

// node_modules/.pnpm/@noble+hashes@1.8.0/node_modules/@noble/hashes/esm/sha256.js
var sha2563 = sha2562;

// packages/canonical/src/sync-hash.ts
function sha256Sync(bytes) {
  return sha2563(bytes);
}
function createSha256() {
  const hash = sha2563.create();
  const writer = {
    update(bytes) {
      hash.update(typeof bytes === "string" ? utf8(bytes) : bytes);
      return writer;
    },
    digest() {
      return hash.digest();
    }
  };
  return writer;
}

// packages/canonical/src/schema.ts
function integerMap(entries) {
  const map = /* @__PURE__ */ new Map();
  for (const [key, value] of entries) if (value !== void 0) map.set(BigInt(key), value);
  return map;
}
function expectMap(value, name) {
  canonicalInvariant(value instanceof Map, "SCHEMA_INVALID", `${name} must be a map`);
  return value;
}
function expectArray(value, name) {
  canonicalInvariant(Array.isArray(value), "SCHEMA_INVALID", `${name} must be an array`);
  return value;
}
function expectBytes(value, name, length) {
  canonicalInvariant(value instanceof Uint8Array, "SCHEMA_INVALID", `${name} must be bytes`);
  if (length !== void 0) canonicalInvariant(value.length === length, "SCHEMA_INVALID", `${name} must contain ${length} bytes`);
  return Uint8Array.from(value);
}
function expectString(value, name) {
  canonicalInvariant(typeof value === "string", "SCHEMA_INVALID", `${name} must be text`);
  return value;
}
function expectBoolean(value, name) {
  canonicalInvariant(typeof value === "boolean", "SCHEMA_INVALID", `${name} must be boolean`);
  return value;
}
function expectBigint(value, name) {
  canonicalInvariant(typeof value === "bigint", "SCHEMA_INVALID", `${name} must be integer`);
  return value;
}
function expectUint(value, name, maximum = BigInt(Number.MAX_SAFE_INTEGER)) {
  const n = expectBigint(value, name);
  canonicalInvariant(n >= 0n && n <= maximum && n <= BigInt(Number.MAX_SAFE_INTEGER), "INTEGER_OUT_OF_RANGE", `${name} is outside range`);
  return Number(n);
}
function expectUint64(value, name) {
  const n = expectBigint(value, name);
  canonicalInvariant(n >= 0n && n <= (1n << 64n) - 1n, "INTEGER_OUT_OF_RANGE", `${name} is outside uint64`);
  return n;
}
function expectInt64(value, name) {
  const n = expectBigint(value, name);
  canonicalInvariant(n >= -(1n << 63n) && n <= (1n << 63n) - 1n, "INTEGER_OUT_OF_RANGE", `${name} is outside int64`);
  return n;
}
function required(map, key, name) {
  const value = map.get(BigInt(key));
  if (value === void 0) throw new CanonicalError("SCHEMA_INVALID", `Missing required field ${name}`);
  return value;
}
function optional(map, key) {
  return map.get(BigInt(key));
}
function assertKnownIntegerKeys(map, keys, name) {
  const known = new Set(keys.map(BigInt));
  for (const key of map.keys()) canonicalInvariant(typeof key === "bigint" && known.has(key), "SCHEMA_INVALID", `${name} contains an unknown field`);
}

export {
  CanonicalError,
  canonicalInvariant,
  utf8,
  decodeUtf8,
  concatBytes,
  compareBytes,
  equalBytes,
  bytesToHex,
  hexToBytes,
  copyBytes,
  DEFAULT_DECODE_LIMITS,
  encodeCanonicalCbor,
  decodeCanonicalCbor,
  assertCanonicalCbor,
  HASH_DOMAINS,
  domainSeparatedBytes,
  sha256,
  hashDomain,
  sha256Sync,
  createSha256,
  integerMap,
  expectMap,
  expectArray,
  expectBytes,
  expectString,
  expectBoolean,
  expectBigint,
  expectUint,
  expectUint64,
  expectInt64,
  required,
  optional,
  assertKnownIntegerKeys
};
/*! Bundled license information:

@noble/hashes/esm/utils.js:
  (*! noble-hashes - MIT License (c) 2022 Paul Miller (paulmillr.com) *)
*/
