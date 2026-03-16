import http from "node:http";
import { URL, URLSearchParams } from "node:url";
import crypto from "node:crypto";
import open from "open";

export interface OAuthConfig {
  clientId: string;
  clientSecret: string;
  authUrl: string;
  tokenUrl: string;
  scopes: string[];
  redirectPort?: number;
}

export interface OAuthTokens {
  access_token: string;
  refresh_token?: string;
  expires_at?: number;
  token_type: string;
  scope?: string;
}

export async function performOAuthFlow(config: OAuthConfig): Promise<OAuthTokens> {
  const port = config.redirectPort ?? 9876;
  const redirectUri = `http://localhost:${port}/callback`;
  const state = crypto.randomBytes(16).toString("hex");

  const authParams = new URLSearchParams({
    client_id: config.clientId,
    response_type: "code",
    redirect_uri: redirectUri,
    scope: config.scopes.join(" "),
    state,
  });

  const authorizationUrl = `${config.authUrl}?${authParams.toString()}`;

  return new Promise((resolve, reject) => {
    const server = http.createServer(async (req, res) => {
      try {
        const url = new URL(req.url ?? "/", `http://localhost:${port}`);

        if (url.pathname !== "/callback") {
          res.writeHead(404);
          res.end("Not found");
          return;
        }

        const code = url.searchParams.get("code");
        const returnedState = url.searchParams.get("state");
        const error = url.searchParams.get("error");

        if (error) {
          res.writeHead(400);
          res.end(`OAuth error: ${error}`);
          server.close();
          reject(new Error(`OAuth error: ${error}`));
          return;
        }

        if (returnedState !== state) {
          res.writeHead(400);
          res.end("State mismatch");
          server.close();
          reject(new Error("OAuth state mismatch"));
          return;
        }

        if (!code) {
          res.writeHead(400);
          res.end("Missing authorization code");
          server.close();
          reject(new Error("Missing authorization code"));
          return;
        }

        // Exchange code for tokens
        const tokenParams = new URLSearchParams({
          grant_type: "authorization_code",
          code,
          redirect_uri: redirectUri,
          client_id: config.clientId,
          client_secret: config.clientSecret,
        });

        const tokenResponse = await fetch(config.tokenUrl, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: tokenParams.toString(),
        });

        if (!tokenResponse.ok) {
          const errText = await tokenResponse.text();
          throw new Error(`Token exchange failed: ${tokenResponse.status} ${errText}`);
        }

        const tokens = (await tokenResponse.json()) as Record<string, unknown>;

        const result: OAuthTokens = {
          access_token: tokens.access_token as string,
          refresh_token: tokens.refresh_token as string | undefined,
          token_type: (tokens.token_type as string) ?? "Bearer",
          scope: tokens.scope as string | undefined,
        };

        if (tokens.expires_in) {
          result.expires_at = Date.now() + (tokens.expires_in as number) * 1000;
        }

        res.writeHead(200, { "Content-Type": "text/html" });
        res.end("<html><body><h1>Authorization successful!</h1><p>You can close this window and return to your terminal.</p></body></html>");
        server.close();
        resolve(result);
      } catch (err) {
        res.writeHead(500);
        res.end("Internal error");
        server.close();
        reject(err);
      }
    });

    server.listen(port, () => {
      open(authorizationUrl).catch(() => {
        console.error(`Please open this URL in your browser:\n${authorizationUrl}`);
      });
    });

    // Timeout after 5 minutes
    setTimeout(() => {
      server.close();
      reject(new Error("OAuth flow timed out after 5 minutes"));
    }, 300000);
  });
}

export async function refreshOAuthToken(
  tokenUrl: string,
  clientId: string,
  clientSecret: string,
  refreshToken: string,
): Promise<OAuthTokens> {
  const params = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: clientId,
    client_secret: clientSecret,
  });

  const response = await fetch(tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString(),
  });

  if (!response.ok) {
    throw new Error(`Token refresh failed: ${response.status}`);
  }

  const tokens = (await response.json()) as Record<string, unknown>;

  return {
    access_token: tokens.access_token as string,
    refresh_token: (tokens.refresh_token as string) ?? refreshToken,
    token_type: (tokens.token_type as string) ?? "Bearer",
    expires_at: tokens.expires_in ? Date.now() + (tokens.expires_in as number) * 1000 : undefined,
  };
}
