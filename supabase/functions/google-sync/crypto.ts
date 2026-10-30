const encoder = new TextEncoder();
export interface Grant {
  user: string;
  refresh: string;
  scopes?: string[];
}
function decode(value: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(
    atob(value.replace(/-/g, "+").replace(/_/g, "/")),
    (c) => c.charCodeAt(0),
  );
}
async function key(secret: string) {
  const bytes = decode(secret);
  if (bytes.length !== 32) throw new Error("invalid_encryption_key");
  return await crypto.subtle.importKey("raw", bytes, "AES-GCM", false, [
    "encrypt",
    "decrypt",
  ]);
}
// Same format as Nuxt's sealed-cookie utility: IV(12), GCM tag(16), ciphertext.
// Authenticated additional data binds a stored grant to its Supabase owner.
export async function openGrant(
  value: string,
  secret: string,
  owner: string,
): Promise<Grant> {
  const data = decode(value);
  const ciphertext = new Uint8Array(data.length - 12);
  ciphertext.set(data.subarray(28));
  ciphertext.set(data.subarray(12, 28), data.length - 28);
  const plaintext = await crypto.subtle.decrypt(
    {
      name: "AES-GCM",
      iv: data.subarray(0, 12),
      additionalData: encoder.encode(`htp_google_grant:${owner}`),
    },
    await key(secret),
    ciphertext,
  );
  const grant = JSON.parse(new TextDecoder().decode(plaintext));
  if (
    grant.user !== owner || typeof grant.refresh !== "string" || !grant.refresh
  ) throw new Error("invalid_grant");
  return grant;
}
export async function sealGrant(grant: Grant, secret: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = new Uint8Array(
    await crypto.subtle.encrypt(
      {
        name: "AES-GCM",
        iv,
        additionalData: encoder.encode(`htp_google_grant:${grant.user}`),
      },
      await key(secret),
      encoder.encode(JSON.stringify(grant)),
    ),
  );
  const result = new Uint8Array(12 + data.length);
  result.set(iv);
  result.set(data.subarray(data.length - 16), 12);
  result.set(data.subarray(0, data.length - 16), 28);
  return btoa(String.fromCharCode(...result)).replace(/\+/g, "-").replace(
    /\//g,
    "_",
  ).replace(/=+$/, "");
}
export async function authorized(
  actual: string | null,
  expected: string,
): Promise<boolean> {
  if (!actual || !expected) return false;
  const [a, b] = await Promise.all(
    [actual, expected].map((v) =>
      crypto.subtle.digest("SHA-256", encoder.encode(v))
    ),
  );
  const av = new Uint8Array(a), bv = new Uint8Array(b);
  let difference = 0;
  for (let i = 0; i < av.length; i++) difference |= av[i] ^ bv[i];
  return difference === 0;
}
