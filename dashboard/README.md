# CyberRange-Net dashboard

React 18 + Vite, plain JavaScript. Read-only view of the scoring and verification API.

## Run in dev

```bash
npm install --prefix dashboard
npm run dev --prefix dashboard
```

The dev server proxies `VITE_API_BASE` (default `/api`) to `DASHBOARD_PROXY_TARGET`
(default `http://localhost:8080`). Set the target to the orchestrator host, for example:

```bash
DASHBOARD_PROXY_TARGET=http://10.10.30.10:8080 npm run dev --prefix dashboard
```

## Mock mode (no backend)

```bash
VITE_MOCK=1 npm run dev --prefix dashboard
```

All data comes from `src/fixtures/`. The containment matrix is the 4-team, 12-segment
expected matrix. Admin actions are simulated; reset returns the 409 refusal.

## Build and test

```bash
npm run build --prefix dashboard     # writes dashboard/dist/
npm test --prefix dashboard          # node:test, pure helpers only
```

## Notes

- Tokens are held in component state only. They are never stored.
- The containment heatmap reads `matrix` (observed) and `expected` from
  `GET /verification/latest`. The API spec does not define these fields yet; the view says so
  when they are missing.
- The dashboard only calls the API. It is meant to sit on VLAN 30 and must not be reachable
  from an exercise VLAN.
