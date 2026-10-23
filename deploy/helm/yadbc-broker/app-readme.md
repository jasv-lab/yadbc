# yadbc broker

The team catalog behind yadbc's **Shared connections**: people sign in with your identity provider
(Entra ID or any OIDC) and install the database connections their colleagues share, logins included.
It never connects to a database itself.

Before installing: register an app with your identity provider (redirect URI
`https://<host>/auth/callback`, scopes `openid profile email`; in Entra an app role `yadbc.admin` for
admins), and decide how it's reached: a Gateway listener or an Ingress with TLS.

After installing: `https://<host>/healthz` answers `"ok"`, and in yadbc *Shared connections…* →
`https://<host>` → *Sign in*.
