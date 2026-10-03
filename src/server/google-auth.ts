export type GoogleAuthConfig = {
  clientId?: string;
  clientSecret?: string;
  refreshToken?: string;
};

const oauthTokenUrl = 'https://oauth2.googleapis.com/token';

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

export class GoogleAuth {
  private accessTokenValue?: string;
  private accessTokenExpiresAt = 0;
  private accessTokenRequest?: Promise<string>;

  constructor(private config: GoogleAuthConfig) {}

  get configured() {
    return !!(
      this.config.clientId &&
      this.config.clientSecret &&
      this.config.refreshToken
    );
  }

  private redact(value: string) {
    return [
      this.config.clientSecret,
      this.config.refreshToken,
      this.accessTokenValue,
    ]
      .filter((secret): secret is string => !!secret)
      .reduce(
        (message, secret) =>
          message
            .replaceAll(secret, '[redacted]')
            .replaceAll(encodeURIComponent(secret), '[redacted]'),
        value,
      );
  }

  private async responseJson(response: Response, service: string) {
    const payload: unknown = await response.json().catch(() => undefined);
    if (!response.ok) {
      const errorMessage =
        isRecord(payload) &&
        isRecord(payload.error) &&
        typeof payload.error.message === 'string'
          ? payload.error.message
          : isRecord(payload) && typeof payload.error_description === 'string'
            ? payload.error_description
            : isRecord(payload) && typeof payload.error === 'string'
              ? payload.error
              : response.statusText || 'Unknown error';
      throw new Error(
        `${service} returned HTTP ${response.status}: ${this.redact(errorMessage)}`,
      );
    }
    if (!isRecord(payload))
      throw new Error(`${service} returned an invalid response.`);
    return payload;
  }

  private async accessToken() {
    if (!this.configured)
      throw new Error('Google APIs are not configured with OAuth credentials.');
    if (this.accessTokenValue && Date.now() < this.accessTokenExpiresAt)
      return this.accessTokenValue;

    const request =
      this.accessTokenRequest ??
      (this.accessTokenRequest = this.refreshAccessToken());
    try {
      return await request;
    } finally {
      if (this.accessTokenRequest === request)
        this.accessTokenRequest = undefined;
    }
  }

  private async refreshAccessToken(): Promise<string> {
    const response = await fetch(oauthTokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: this.config.clientId!,
        client_secret: this.config.clientSecret!,
        refresh_token: this.config.refreshToken!,
        grant_type: 'refresh_token',
      }),
    });
    const payload = await this.responseJson(response, 'Google OAuth');
    if (
      typeof payload.access_token !== 'string' ||
      !payload.access_token ||
      typeof payload.expires_in !== 'number'
    )
      throw new Error('Google OAuth did not return a valid access token.');
    this.accessTokenValue = payload.access_token;
    this.accessTokenExpiresAt =
      Date.now() + Math.max(0, payload.expires_in - 60) * 1000;
    return payload.access_token;
  }

  async request<T>(url: string, init: RequestInit = {}): Promise<T> {
    const token = await this.accessToken();
    const headers = new Headers(init.headers);
    headers.set('Authorization', `Bearer ${token}`);
    const response = await fetch(url, { ...init, headers });
    const service =
      new URL(url).hostname === 'gmail.googleapis.com'
        ? 'Gmail API'
        : 'Google API';
    return (await this.responseJson(response, service)) as T;
  }
}
