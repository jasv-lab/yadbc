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

## 2. Image and chart

Tagging `broker-v1.2.3` makes CI (`.github/workflows/broker-image.yml`) publish both:
- the image `ghcr.io/<owner>/yadbc-broker:1.2.3` (main also gets `:main` and `:sha-<commit>`);
- the chart `oci://ghcr.io/<owner>/charts/yadbc-broker`, version 1.2.3, already pointing at that image.

GitHub packages start private. To install without credentials, make both public once (the package's
settings on GitHub → Change visibility), even if the repository itself stays private.

To build the image yourself, run this from the repository root:

```bash
docker build -f src/Yadbc.Broker/Dockerfile -t <registry>/yadbc-broker:0.1.0 .
```

The image is chiseled .NET: non-root (uid 1654), no shell, and it runs with a read-only root filesystem.

## 3. Install

### From Rancher's Apps catalog
1. **Apps → Repositories → Create:** target *OCI repository*, URL `oci://ghcr.io/<owner>/charts`. This
   needs Rancher 2.9 or newer; older versions only take HTTP(S) and Git chart repositories.
2. **Apps → Charts → yadbc broker → Install** into a namespace such as `yadbc`. The form asks for the
   issuer URL, client id and client secret, then how it's exposed (Gateway HTTPRoute or Ingress) and the
   storage class.
3. **Secrets:** with *Existing Secret* left empty, the chart creates one. It generates the login key on the
   first install, reads it back on every upgrade, and keeps the Secret on uninstall.

### With Helm
A values file for your cluster (the full list is in `helm/yadbc-broker/values.yaml`):

```yaml
oidc:
  authority: https://login.microsoftonline.com/<tenant-id>/v2.0
  clientId: <application-client-id>
existingSecret: yadbc-broker   # or leave it out and pass oidc.clientSecret: the chart creates the Secret
httpRoute:                     # or ingress: { enabled: true, host: …, tlsSecretName: … }
  enabled: true
  hostname: yadbc.example.com
  gateway:
    name: <gateway>
    namespace: <gateway namespace>
    sectionName: <its listener for this hostname>
  allowedCIDRs: 203.0.113.0/24, 198.51.100.7/32   # optional, Envoy Gateway: only these networks get in
```

```bash
helm upgrade --install yadbc-broker oci://ghcr.io/<owner>/charts/yadbc-broker --version 0.1.0 -n yadbc --create-namespace -f my-values.yaml
```

From a checkout, use `deploy/helm/yadbc-broker` instead and set `image.repository`.

### GitOps (Argo CD, Flux)
`helm template` can't read the cluster, so a key generated at render time would change on every sync,
and stored logins would become unreadable. Create the Secret yourself and name it in `existingSecret`:

```bash
kubectl -n yadbc create secret generic yadbc-broker --from-literal=Broker__LoginKey="$(openssl rand -base64 32)" --from-literal=Broker__Oidc__ClientSecret='<client secret>'
```

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
