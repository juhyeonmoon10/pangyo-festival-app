# Personal Web Deployment 1.2

- Personal repository: `juhyeonmoon10/pangyo-festival-app`.
- Production site: https://pangyo-festival-app.vercel.app
- UI-only demo: https://pangyo-festival-app.vercel.app/?demo=1
- Deployment trigger: push to the personal repository's `main` branch.
- Build command: `node tools/build-web.cjs`.

The build uses Vercel Build Output API v3. Only allowlisted browser files,
vendor libraries/licenses, and club logos enter `.vercel/output/static`.
Legacy `api/`, SQL, environment files, test reports, and local documents are
not published as website files. No server functions are built.

This deploy does not apply SQL, change Auth configuration, or modify ORBIT.
The browser retains its existing Supabase integration. Real Google login and
physical NFC still require end-to-end account/device verification. Demo
points and QR vouchers are not valid rewards; production issuance/redemption
and adding review text later remain unavailable until their server contracts
are implemented and approved.

## Verification

Run `node tests/web-build-unit.cjs` before publishing. After deployment,
check `/deployment-info.json`, the 1.2 UI, `/nfc`, and confirm that private
paths and legacy `/api` routes return 404. Browser smoke tests must intercept
Supabase requests so deployment verification cannot modify shared data.

## Rollback

Use Vercel's previous successful production deployment for an immediate
rollback. Do not reset the working tree or run database rollback SQL for a
static UI deployment. Keep the Git commit and deployment ID in the local
deployment verification report.
