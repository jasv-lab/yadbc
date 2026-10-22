# Deploying the yadbc broker

The broker is optional. It's the team catalog behind **Shared connections** (design: `docs/design.md`
§10b): a single small pod with ASP.NET and SQLite on a volume, and no database access of its own. People
sign in through your OIDC provider and install the connections their colleagues share. Code is in
`src/Yadbc.Broker`, tests in `tests/Yadbc.Broker.Tests`, and the Helm chart in `helm/yadbc-broker`.

## 1. Identity provider

### Entra ID
App registrations → New registration, single tenant.
- **Authentication** → Add a platform → **Web**, redirect URI `https://<your host>/auth/callback`.
- **Certificates & secrets** → New client secret (it goes into the Secret below).
- **Token configuration** → Add optional claim → ID → `email`.
- **App roles** → Create app role: allowed member types *Users/Groups*, value **`yadbc.admin`**. Assign it
  under Enterprise applications → (your app) → Users and groups. Admins can edit and delete any share;
  a role change takes effect at that person's next sign-in.
- Overview → the **tenant id** and **application (client) id** go into your values.

### Any other OIDC provider (Keycloak, Authentik, …)
A confidential client with the same redirect URI and scopes `openid profile email`. In your values:
- `oidc.authority`: the issuer URL (e.g. `https://sso.example.com/realms/team`)
- `oidc.idClaims: [sub]`: the stable user id claim
- `oidc.adminClaim` / `oidc.adminValue`: where admin comes from (e.g. `groups` / `yadbc-admins`)
- `oidc.useUserInfo: true` if names and emails aren't in the ID token

## 2. Image

CI (`.github/workflows/broker-image.yml`) publishes it to `ghcr.io/<owner>/yadbc-broker`: `:main` and
`:sha-<commit>` from the main branch, and `:1.2.3` from a `broker-v1.2.3` tag. Pin a version tag in your
values. While the package is private, the cluster needs a pull secret for ghcr.io (`imagePullSecrets`).

To build it yourself, run this from the repository root:

```bash
docker build -f src/Yadbc.Broker/Dockerfile -t <registry>/yadbc-broker:0.1.0 .
```

```bash
docker push <registry>/yadbc-broker:0.1.0
```

The image is chiseled .NET: non-root (uid 1654), no shell, and it runs with a read-only root filesystem.

## 3. Install

The broker's Secret holds the key that encrypts stored logins, plus the OIDC client secret. Create it in
the cluster; it never goes into values or git:

```bash
kubectl -n yadbc create secret generic yadbc-broker --from-literal=Broker__LoginKey="$(openssl rand -base64 32)" --from-literal=Broker__Oidc__ClientSecret='<client secret>'
```

A values file for your cluster (the full list is in `helm/yadbc-broker/values.yaml`):

```yaml
image:
  repository: <registry>/yadbc-broker
oidc:
  authority: https://login.microsoftonline.com/<tenant-id>/v2.0
  clientId: <application-client-id>
httpRoute:            # or ingress: { enabled: true, host: …, tlsSecretName: … }
  enabled: true
  parentRefs:
    - name: <gateway>
      namespace: <gateway namespace>
  hostnames: [yadbc.example.com]
```

```bash
helm upgrade --install yadbc-broker deploy/helm/yadbc-broker -n yadbc -f my-values.yaml
```

Or render it for GitOps (Argo CD, Flux): `helm template yadbc-broker deploy/helm/yadbc-broker -n yadbc -f my-values.yaml`.

Check `https://<your host>/healthz`; it should answer `"ok"`. Then in yadbc: **Shared connections…** →
`https://<your host>` → **Sign in**.

## Operating it

- **Data:** `/data/broker.db` on the chart's volume claim, which is kept on uninstall. Nightly copies go
  to `/data/backups` (the last 7). They cover a bad write, not the loss of the volume; back up the
  volume itself the way you back up the rest of the cluster.
- **The login key** (`Broker__LoginKey`) encrypts every stored share login. If it's lost, the owners
  have to enter their logins again; if it's changed, the stored ones become unreadable. Keep a copy
  wherever your cluster's secrets are backed up.
- **One replica, Recreate.** SQLite is opened by one process with an exclusive lock, which is also what
  makes it safe on NFS-backed volumes.
- **TLS** ends at your Gateway or Ingress. The broker takes the scheme from `X-Forwarded-Proto`, so the
  OIDC redirect is `https`.
- **Signing a device out:** people do it from yadbc. There's no admin UI for it yet.
