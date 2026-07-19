# Production deployment and optional Cloudflare Tunnel

This runbook covers two ways to deploy the nurse scheduler:

1. Run the core Docker stack directly on localhost, a private LAN, or a temporary
   server IP.
2. Add Cloudflare Tunnel later, after a domain and Cloudflare account are ready.

Cloudflare is an ingress option. It does not change the application, job protocol,
Workspace YAML, backend, or Redis architecture.

## Repository status

The repository uses this Compose topology:

```text
Core deployment
  browser -> web:3000 -> backend:8000 -> redis:6379

Optional Cloudflare deployment
  browser -> Cloudflare HTTPS -> cloudflared -> web:3000
                                      web -> backend -> redis
```

The landed topology has these properties:

- `make up` starts the core `web + backend + redis` stack (base + direct overlay)
  without Cloudflare credentials.
- `cloudflared` is added through the separate `docker/compose.cloudflare.yml`
  overlay (`make up-cloudflare`).
- Only `web` is reachable by users. Backend and Redis remain private.
- Production initially uses one backend worker and a named Redis volume.

## Deployment modes

| Mode | Public address | Cloudflare account/domain | Intended use |
| --- | --- | --- | --- |
| Local | `http://localhost:3000` | Not required | Development and single-machine use |
| Private LAN | `http://192.168.x.x:3000` | Not required | Trusted local network |
| Temporary server IP | `http://server-ip:3000` | Not required | Short-lived evaluation only |
| Cloudflare Tunnel | `https://scheduler.example.com` | Required | Public production ingress |

Do not put real nursing or scheduling data through an unencrypted public-IP
deployment. Use HTTPS ingress before treating the server as production.

## Core deployment without Cloudflare

Configure the exact browser-facing origin:

```dotenv
PUBLIC_ORIGIN=http://localhost:3000
```

Use a LAN address instead when other machines need access:

```dotenv
PUBLIC_ORIGIN=http://192.168.1.50:3000
```

Then run:

```bash
make verify-deploy
make build
make up
```

No Cloudflare token should be required for these commands. The core services are:

- `web`, with host port 3000 published for direct access;
- `backend`, reachable only on the Compose network;
- `redis`, reachable only on the Compose network and backed by a named volume.

## Add Cloudflare later

Cloudflare recommends a remotely managed tunnel for Docker deployments. The
connector makes outbound connections to Cloudflare and routes the configured
hostname to the internal web service.

Official references:

- [Cloudflare Tunnel overview](https://developers.cloudflare.com/tunnel/)
- [Create a remotely managed tunnel](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/get-started/create-remote-tunnel/)
- [Publish an application](https://developers.cloudflare.com/tunnel/setup/)
- [Tunnel tokens](https://developers.cloudflare.com/tunnel/advanced/tunnel-tokens/)
- [Firewall requirements](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/configure-tunnels/tunnel-with-firewall/)

### 1. Add the domain to Cloudflare

Create a Cloudflare account, add the domain, and update the registrar's
nameservers to the values Cloudflare assigns. Wait until Cloudflare reports the
zone as active.

Choose a hostname for the scheduler. This guide uses:

```text
scheduler.example.com
```

Replace it with the real hostname in every command and setting below.

### 2. Create a named tunnel

In the Cloudflare dashboard:

1. Open **Networking > Tunnels**.
2. Select **Create a tunnel**.
3. Give it a stable name, such as `nurse-scheduler-production`.
4. Select the Docker connector instructions.
5. Copy the tunnel token.

The token can run a connector for the tunnel. Treat it as a production secret.
Do not put it in Git, a Dockerfile, documentation, ticket text, or shell history.

### 3. Publish the application

Add a **Published application** route:

| Setting | Value |
| --- | --- |
| Hostname | `scheduler.example.com` |
| Service type | `HTTP` |
| Service URL | `http://web:3000` |

Use `web`, not `localhost`. The connector runs inside Compose and reaches Next.js
through the `web` service name.

Do not publish routes for `backend:8000` or `redis:6379`.

### 4. Store the token outside Git

The preferred target uses a Docker secret file:

```bash
mkdir -p docker/secrets
chmod 700 docker/secrets
printf '%s' '<tunnel-token>' > docker/secrets/cloudflare-tunnel-token
chmod 600 docker/secrets/cloudflare-tunnel-token
```

Add `docker/secrets/` to `.gitignore` before creating the real token file.

Set the public origin in the production environment:

```dotenv
PUBLIC_ORIGIN=https://scheduler.example.com
```

`PUBLIC_ORIGIN` must match the public scheme and hostname exactly. It drives the
BFF's cookie security policy. Do not add a path or trailing application route.

### 5. Add the optional Compose overlay

This is the executable configuration from `docker/compose.cloudflare.yml`, with
its explanatory comments omitted:

```yaml
services:
  cloudflared:
    # Pinned by digest (cloudflared 2026.7.2).
    image: cloudflare/cloudflared:latest@sha256:4f6655284ab3d252b7f28fedb19fe6c8fc82ee5b1295c20ac74d475e5398a52d
    command:
      - tunnel
      - --no-autoupdate
      - run
      - --token-file
      - /run/secrets/cloudflare_tunnel_token
    secrets:
      - cloudflare_tunnel_token
    networks:
      - ingress
    depends_on:
      web:
        condition: service_healthy
    restart: unless-stopped

secrets:
  cloudflare_tunnel_token:
    file: secrets/cloudflare-tunnel-token
```

`networks: [ingress]` is load-bearing: `ingress` is the segmented network defined
by the base `docker/compose.yml` where `web` also lives, so the connector can
reach `web:3000` but not `backend` or `redis`. Omitting it would attach
`cloudflared` to a separate default network and the tunnel could not reach web.
The image is already digest-pinned; bump the tag comment and the digest together.

Start the core stack plus the tunnel:

```bash
APP_VERSION="$(tr -d '[:space:]' < VERSION)" \
PUBLIC_ORIGIN="https://scheduler.example.com" \
docker compose \
  -f docker/compose.yml \
  -f docker/compose.cloudflare.yml \
  up -d --build
```

A wrapper keeps the normal operator command:

```bash
make up-cloudflare
```

Ordinary `make up` stays Cloudflare-free.

### 6. Remove the direct public path

The tunnel does not require public inbound ports 80, 443, or 3000. `cloudflared`
connects outward to Cloudflare, normally on port 7844 over TCP or UDP.

When Cloudflare is enabled:

- block public inbound TCP 3000 in the cloud firewall/security group;
- keep backend port 8000 and Redis port 6379 unpublished;
- allow the host to make outbound TCP and UDP connections on port 7844;
- keep only the administrative access required for the server.

The landed Compose layout keeps direct port publishing out of the base file:

```text
docker/compose.yml              # web/backend/redis, no public host port
docker/compose.direct.yml       # adds web 3000:3000 for localhost/LAN/IP use
docker/compose.cloudflare.yml   # adds cloudflared, no web host port
```

The production firewall must still block direct port 3000 access so users cannot
bypass Cloudflare.

### 7. Verify the public deployment

Check service state:

```bash
APP_VERSION="$(tr -d '[:space:]' < VERSION)" \
PUBLIC_ORIGIN="https://scheduler.example.com" \
docker compose \
  -f docker/compose.yml \
  -f docker/compose.cloudflare.yml \
  ps
```

Check public health:

```bash
curl -fsS https://scheduler.example.com/api/health
```

Verify all of the following:

- the page loads without a TLS warning;
- `/api/health` returns the same `appVersion` as the root `VERSION` file;
- direct requests to `http://server-ip:3000` are blocked;
- backend and Redis have no host port bindings;
- a valid optimization starts and receives SSE progress;
- interrupting and reconnecting the browser stream resumes with
  `Last-Event-ID` and does not duplicate progress/log entries;
- disconnecting the browser does not cancel the job;
- the completed XLSX downloads through the public hostname;
- restarting the backend preserves queued and completed Redis jobs;
- Redis unavailability makes health/readiness fail closed.

## Environment reference

| Variable | Required | Purpose |
| --- | --- | --- |
| `PUBLIC_ORIGIN` | Yes at runtime | Exact browser-facing origin. Use HTTPS with Cloudflare. |
| `APP_VERSION` | Supplied by build wrapper | Stamps web and backend from root `VERSION`. |
| `BACKEND_API_URL` | Set by Compose | Private BFF target, normally `http://backend:8000`. |
| `JOB_BACKEND` | Set by Compose | `redis` in production; `memory` in local backend tests. |
| `JOB_REDIS_URL` | Set by Compose | Private Redis connection, normally `redis://redis:6379/0`. |
| `JOB_REDIS_KEY_PREFIX` | Set by Compose | Versioned namespace for retained job records. |
| Cloudflare tunnel token | Cloudflare mode only | Authenticates the optional connector; use a secret file. |

Never expose `BACKEND_API_URL`, `JOB_REDIS_URL`, the Redis key prefix, or the
tunnel token to browser JavaScript.

## Routine Cloudflare operations

### View tunnel logs

```bash
APP_VERSION="$(tr -d '[:space:]' < VERSION)" \
PUBLIC_ORIGIN="https://scheduler.example.com" \
docker compose \
  -f docker/compose.yml \
  -f docker/compose.cloudflare.yml \
  logs -f cloudflared
```

### Rotate an exposed token

1. Rotate or replace the connector token in Cloudflare.
2. Replace `docker/secrets/cloudflare-tunnel-token` and restore mode `600`.
3. Restart only `cloudflared`.
4. Confirm the connector and public health endpoint are healthy.

### Disable Cloudflare without changing the app

Stop the connector and return to the direct-access Compose overlay:

```bash
APP_VERSION="$(tr -d '[:space:]' < VERSION)" \
PUBLIC_ORIGIN="https://scheduler.example.com" \
docker compose \
  -f docker/compose.yml \
  -f docker/compose.cloudflare.yml \
  stop cloudflared
```

Change `PUBLIC_ORIGIN` to the direct address before starting direct access. Do
not keep an HTTPS Cloudflare origin while serving the application from a plain
HTTP IP address.

## Troubleshooting

### Tunnel is healthy but returns 502

Confirm the published application service URL is exactly:

```text
http://web:3000
```

Then check that `web` is healthy on the Compose network.

### No healthy connector

Check the token file, tunnel identity, container logs, DNS, and outbound port
7844 access. A token from another tunnel or account will not attach to the
intended connector.

### Web container restarts

Inspect web logs. A common cause is a missing or malformed `PUBLIC_ORIGIN`.
Cloudflare production must use the exact HTTPS hostname:

```dotenv
PUBLIC_ORIGIN=https://scheduler.example.com
```

### Optimization progress does not stream

Use a named tunnel. Quick `trycloudflare.com` tunnels are development-only and do
not support this application's SSE requirement. Check the browser event request,
web/BFF logs, backend logs, and whether `Last-Event-ID` crosses the BFF on
reconnect.

## Scope limits

- Cloudflare Tunnel does not make a single Docker host highly available.
- Redis RDB persistence does not provide zero-loss recovery from an abrupt host
  failure.
- Running solver execution is not checkpointed. A lost worker produces a retained
  `worker_lost` failure and must be resubmitted.
- Public identity/access controls, WAF policy, rate limits, AOF, replicated Redis,
  and multiple backend workers require separate operational decisions.
