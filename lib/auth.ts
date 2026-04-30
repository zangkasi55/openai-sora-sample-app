export const AUTH_COOKIE_NAME = "sora_app_session";
export const AUTH_COOKIE_MAX_AGE_SECONDS = 7 * 24 * 60 * 60;

const STATIC_PASSWORD = "S!rJ!Mth2b3s3";
const TOKEN_SALT = "sora-sample-app-static-login-v1";

const toHex = (buffer: ArrayBuffer): string =>
  Array.from(new Uint8Array(buffer))
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");

export const createAuthToken = async (): Promise<string> => {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`${TOKEN_SALT}:${STATIC_PASSWORD}`),
  );
  return toHex(digest);
};

export const isValidPassword = (password: unknown): boolean =>
  typeof password === "string" && password === STATIC_PASSWORD;

export const isValidAuthToken = async (token: string | undefined): Promise<boolean> =>
  Boolean(token) && token === await createAuthToken();
