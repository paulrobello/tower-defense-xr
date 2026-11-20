# Deploy Checklist — `rift-bastion.pardev.net`

Hosting: GitHub Pages on a custom `*.pardev.net` domain (house recipe in `reference-projects.md`).
Run the steps **strictly in order**. Steps 2 and 3 are the ones that break the site if reordered.

> [!IMPORTANT]
> Nothing below runs until Paul approves. `public/CNAME` must **not** exist in the repo before step 3.

## 0. Preconditions

- [ ] `make checkall && make checkall-ci` exit 0 locally on the commit being pushed.
- [ ] `.github/workflows/ci.yml` present; `toolkit-release.json` holds a full 40-char lowercase hex mux-xr SHA.
- [ ] `public/CNAME` does **not** exist (`test ! -e public/CNAME`).
- [ ] Paul has explicitly approved creating the GitHub repo and pushing.

## 1. Create the GitHub repo and push (after Paul approves)

```bash
gh repo create paulrobello/tower-defense-xr --public --source . --remote origin --push
```

- CI runs on the push. The `deploy` job is skipped because `vars.PAGES_ENABLED` is unset — expected.
- Confirm the `gate` job (`make checkall-ci`) is green before continuing.
- `mux-xr` must be readable by the workflow token (public repo, or add access) so the sibling checkout works.

## 2. Cloudflare DNS: DNS-only CNAME

Zone `pardev.net` (token from parvault). Create:

| Type  | Name          | Target                  | Proxy                    |
| ----- | ------------- | ----------------------- | ------------------------ |
| CNAME | `rift-bastion` | `paulrobello.github.io` | **DNS only** (grey cloud) |

Without this, the `*.pardev.net` wildcard A record falls through to the fallback proxy and 404s.

Wait until it resolves — do not continue before this prints `paulrobello.github.io.`:

```bash
dig +short CNAME rift-bastion.pardev.net
```

## 3. Commit `public/CNAME` — only after DNS resolves

```bash
dig +short CNAME rift-bastion.pardev.net   # must show paulrobello.github.io.
printf 'rift-bastion.pardev.net\n' > public/CNAME
git add public/CNAME && git commit -m "feat(deploy): add CNAME for rift-bastion.pardev.net"
git push origin main
```

Committing it earlier makes Pages 301 the `github.io` URL and takes both addresses down. No Vite `base` change is needed.

## 4. Register the custom domain and enable deploys

GitHub does not apply the domain from the CNAME file alone. Register it explicitly (enable Pages with the Actions
build type if the site does not exist yet):

```bash
# Only if the Pages site does not exist yet (POST fails with 409 if it does):
gh api -X POST repos/paulrobello/tower-defense-xr/pages -f build_type=workflow

# Custom-domain registration (required):
gh api -X PUT repos/paulrobello/tower-defense-xr/pages \
  -f cname=rift-bastion.pardev.net -f build_type=workflow

# Let the deploy job run:
gh variable set PAGES_ENABLED --body true --repo paulrobello/tower-defense-xr
```

Re-run the `main` workflow (`gh workflow run CI` or re-run the last run). Then enforce HTTPS once the certificate
exists:

```bash
gh api repos/paulrobello/tower-defense-xr/pages --jq '{cname, https_enforced, status}'
gh api -X PUT repos/paulrobello/tower-defense-xr/pages -F https_enforced=true
```

HTTPS may sit in Let's Encrypt `authorization_pending` for a few minutes — that is transient; retry.

## 5. Verify live (browser render, not HTTP 200)

- [ ] `deploy` job green on `main`.
- [ ] Open `https://rift-bastion.pardev.net/` in a real browser (Playwright/agentchrome). Confirm the app renders,
      the certificate is valid, and there are **zero console/CSP errors**. HTTP 200 alone is a known false green.
- [ ] `curl -fsS https://rift-bastion.pardev.net/version.json` returns valid JSON with the expected build/commit.
- [ ] `https://paulrobello.github.io/tower-defense-xr/` redirects to the custom domain (does not 404).
- [ ] Record the result in `plans/phase-0-foundation-and-deploy.md` Phase 0 exit criteria.

## Rollback

- `gh variable set PAGES_ENABLED --body false --repo paulrobello/tower-defense-xr` stops further deploys.
- If both URLs are down, `public/CNAME` was committed before DNS: fix DNS first, then re-run step 4.
