// Thread-key encoding shared with the control plane: per UTF-8 byte, keep
// unreserved characters [A-Za-z0-9._~-], percent-encode everything else as
// %XX with uppercase hex. The encoded form is used verbatim as a directory
// name and an object-storage key segment, so both sides must agree exactly.

export function encodeThreadKey(raw: string): string {
  const bytes = new TextEncoder().encode(raw);
  let out = "";
  for (const byte of bytes) {
    const unreserved =
      (byte >= 0x41 && byte <= 0x5a) || // A-Z
      (byte >= 0x61 && byte <= 0x7a) || // a-z
      (byte >= 0x30 && byte <= 0x39) || // 0-9
      byte === 0x2d || // -
      byte === 0x2e || // .
      byte === 0x5f || // _
      byte === 0x7e; //  ~
    out += unreserved
      ? String.fromCharCode(byte)
      : `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
  }
  return out;
}

export function decodeThreadKey(encoded: string): string {
  const bytes: number[] = [];
  for (let i = 0; i < encoded.length; i++) {
    const ch = encoded[i]!;
    if (ch === "%") {
      const hex = encoded.slice(i + 1, i + 3);
      if (!/^[0-9A-Fa-f]{2}$/.test(hex)) {
        throw new Error(`invalid percent escape at offset ${i}`);
      }
      bytes.push(Number.parseInt(hex, 16));
      i += 2;
    } else {
      const code = ch.charCodeAt(0);
      if (code > 0x7f) throw new Error(`non-ASCII character at offset ${i}`);
      bytes.push(code);
    }
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(bytes));
}
