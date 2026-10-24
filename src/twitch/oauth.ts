import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";

export interface TokenIdentity {
  readonly userId: string;
  readonly login: string;
  readonly scopes: readonly string[];
  readonly expiresAt: number;
}
interface StoredTokens { accessToken: string; refreshToken: string; expiresAt: number; }
export interface OAuthOptions {
  clientId: string; clientSecret: string; redirectUri: string;
  scopes: readonly string[]; tokenStorePath: string;
  fetch?: typeof fetch; now?: () => number;
}

export class OAuthError extends Error {
  constructor(message: string, readonly status = 0) { super(message); this.name = "OAuthError"; }
}

/** Token contents never leave this adapter except in an Authorization header. */
export class OAuthManager {
  private tokens: StoredTokens | undefined;
  private tokenIdentity: TokenIdentity | undefined;
  private refreshPromise: Promise<string> | undefined;
  private validationTimer: ReturnType<typeof setInterval> | undefined;
  private readonly fetcher: typeof fetch;
  private readonly now: () => number;

  constructor(private readonly options: OAuthOptions) {
    this.fetcher = options.fetch ?? fetch;
    this.now = options.now ?? Date.now;
  }
  get identity(): TokenIdentity | undefined { return this.tokenIdentity; }
  authorizationURL(state: string): string {
    if (!state) throw new OAuthError("OAuth state is required");
    const url = new URL("https://id.twitch.tv/oauth2/authorize");
    url.search = new URLSearchParams({ response_type: "code", client_id: this.options.clientId,
      redirect_uri: this.options.redirectUri, scope: this.options.scopes.join(" "), state }).toString();
    return url.toString();
  }
  async load(): Promise<boolean> {
    let parsed: unknown;
    try { parsed = JSON.parse(await readFile(this.options.tokenStorePath, "utf8")); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw new OAuthError("Unable to load token storage"); }
    const value = parsed as Partial<StoredTokens>;
    if (!value || typeof value.accessToken !== "string" || typeof value.refreshToken !== "string" || typeof value.expiresAt !== "number") {
      throw new OAuthError("Invalid token storage; connect Twitch again");
    }
    this.tokens = value as StoredTokens;
    await this.getAccessToken();
    await this.validate();
    return true;
  }
  async exchangeCode(code: string): Promise<TokenIdentity> {
    await this.requestTokens({ grant_type: "authorization_code", code, redirect_uri: this.options.redirectUri });
    return this.validate();
  }
  async getAccessToken(): Promise<string> {
    if (!this.tokens) throw new OAuthError("Connect Twitch to authorize this application", 401);
    if (this.tokens.expiresAt <= this.now() + 30_000) return this.refresh();
    return this.tokens.accessToken;
  }
  async refresh(rejectedToken?: string): Promise<string> {
    if (!this.tokens) throw new OAuthError("Connect Twitch again", 401);
    if (rejectedToken && this.tokens.accessToken !== rejectedToken) return this.tokens.accessToken;
    if (this.refreshPromise) return this.refreshPromise;
    this.refreshPromise = (async () => {
      const refreshToken = this.tokens?.refreshToken;
      if (!refreshToken) throw new OAuthError("Connect Twitch again", 401);
      await this.requestTokens({ grant_type: "refresh_token", refresh_token: refreshToken });
      if (!this.tokens) throw new OAuthError("Refresh failed", 401);
      return this.tokens.accessToken;
    })().finally(() => { this.refreshPromise = undefined; });
    return this.refreshPromise;
  }
  async validate(): Promise<TokenIdentity> {
    if (!this.tokens) throw new OAuthError("Connect Twitch again", 401);
    const response = await this.fetcher("https://id.twitch.tv/oauth2/validate", {
      headers: { Authorization: `OAuth ${this.tokens.accessToken}` }, signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) {
      if (response.status === 401) { this.tokens = undefined; this.tokenIdentity = undefined; }
      throw new OAuthError("Twitch token validation failed; reconnect if authorization was revoked", response.status);
    }
    const data = await response.json() as Record<string, unknown>;
    if (data.client_id !== this.options.clientId || typeof data.user_id !== "string" || !data.user_id ||
        typeof data.login !== "string" || !Array.isArray(data.scopes) || !data.scopes.every((x: unknown) => typeof x === "string") ||
        typeof data.expires_in !== "number") {
      this.tokens = undefined; this.tokenIdentity = undefined;
      throw new OAuthError("Token identity does not match this application", 401);
    }
    this.tokenIdentity = { userId: data.user_id, login: data.login, scopes: data.scopes as string[], expiresAt: this.now() + data.expires_in * 1000 };
    this.tokens.expiresAt = this.tokenIdentity.expiresAt;
    return this.tokenIdentity;
  }
  startValidation(onInvalid: (error: Error) => void): void {
    this.stopValidation();
    this.validationTimer = setInterval(() => {
      void this.getAccessToken().then(() => this.validate()).catch((error: unknown) => onInvalid(error instanceof Error ? error : new OAuthError("Token validation failed")));
    }, 60 * 60 * 1000);
    this.validationTimer.unref();
  }
  stopValidation(): void { if (this.validationTimer) clearInterval(this.validationTimer); this.validationTimer = undefined; }
  private async requestTokens(params: Record<string, string>): Promise<void> {
    let response: Response;
    try {
      response = await this.fetcher("https://id.twitch.tv/oauth2/token", { method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ client_id: this.options.clientId, client_secret: this.options.clientSecret, ...params }),
        signal: AbortSignal.timeout(15_000),
      });
    } catch { throw new OAuthError("Twitch token request could not be completed"); }
    if (!response.ok) {
      if (response.status === 400 || response.status === 401) { this.tokens = undefined; this.tokenIdentity = undefined; }
      throw new OAuthError("Twitch authorization failed; connect the account again", response.status);
    }
    const data = await response.json() as Record<string, unknown>;
    if (typeof data.access_token !== "string" || typeof data.refresh_token !== "string" || typeof data.expires_in !== "number") {
      throw new OAuthError("Twitch returned an incomplete token response");
    }
    this.tokens = { accessToken: data.access_token, refreshToken: data.refresh_token, expiresAt: this.now() + data.expires_in * 1000 };
    await mkdir(dirname(this.options.tokenStorePath), { recursive: true, mode: 0o700 });
    const temporary = `${this.options.tokenStorePath}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(this.tokens), { mode: 0o600 });
    await rename(temporary, this.options.tokenStorePath);
  }
}
