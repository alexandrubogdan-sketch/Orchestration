# Runbook: local Hatchet setup

Hatchet (hatchet-lite) needs a one-time tenant + API token before `api`/
`worker` can dispatch or run tasks. This is a manual step because
hatchet-lite creates its default tenant on first boot, and the token is
tenant-scoped.

## First-time setup

1. `make dev` — boots postgres, redis, hatchet, api, worker. The
   api/worker containers will fail to authenticate until step 3; that's
   expected on a fresh checkout.
2. Open http://localhost:8888, log in with the default seeded admin:
   - Email: `admin@example.com`
   - Password: `Admin123!!`
   - Change this password immediately in any environment reachable
     outside your laptop.
3. In the dashboard: Settings → API Tokens → Create API Token. Copy it.
4. Paste the token into `.env` as `HATCHET_CLIENT_TOKEN=<token>`.
5. `docker compose restart api worker`.
6. Verify the round-trip: `curl -X POST localhost:3000/dev/dispatch-hello-world -H 'content-type: application/json' -d '{"message":"hi"}'`
   then check the `worker` container logs for `hello-world task executed`,
   and confirm the run shows up under Runs in the Hatchet dashboard.

## Alternative: CLI token creation (no dashboard login)

```
docker compose run --rm hatchet /hatchet/hatchet-admin token create \
  --config /config --tenant-id <default-tenant-id>
```

The default tenant id is visible in the dashboard URL after first login,
or via `docker compose logs hatchet | grep tenant`.

## Known gap

This flow has not been exercised against a live Docker daemon as part of
this delivery (the build environment had no Docker available — see the
Milestone 0 summary). Treat step 2's default credentials and the exact
CLI flags in step "Alternative" as best-effort based on Hatchet's
published docs as of mid-2026; confirm against
https://docs.hatchet.run/self-hosting/hatchet-lite if `hatchet-lite`'s
image has changed its defaults since.
