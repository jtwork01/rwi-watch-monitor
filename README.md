# RWI Watch Monitor

Cloud monitor for Replica Watch Info (RWI). It checks every 5 minutes from GitHub Actions, so your own computer can be completely off.

It contains two monitors:

1. **Permanent seller monitor** — checks the private RWI news feed for new activity from `soyla355`.
2. **Temporary marketplace test monitor** — watches the Replica & Genuine Watch Sales forum for newly created sales threads. Once you see this work, disable it with one repository variable.

## URLs being watched

- News feed: `https://forum.replica-watch.info/whats-new/news-feed`
- Marketplace test: `https://forum.replica-watch.info/forums/replica-genuine-watch-sales.9951900/`

## 1. Create the GitHub repository

Create a **PUBLIC** GitHub repository, for example `rwi-watch-monitor`.

Why public? GitHub-hosted standard runners are free for public repositories. The actual RWI username/password, notification topic, and session-encryption key are **not** stored in the repository; they are GitHub Actions Secrets.

Upload all files from this package to the repository, preserving the `.github/workflows/` and `.private/` folders.

## 2. Install ntfy on your phone

Install the free `ntfy` app. Subscribe to the random topic you chose for `NTFY_TOPIC` below. The topic should be long and hard to guess because an unreserved ntfy topic effectively behaves like a password.

## 3. Add four GitHub Actions Secrets

In the GitHub repository:

**Settings → Secrets and variables → Actions → Secrets → New repository secret**

Add exactly these four names:

- `RWI_USERNAME` — your RWI login username/email
- `RWI_PASSWORD` — your RWI password
- `NTFY_TOPIC` — your long random ntfy topic
- `RWI_SESSION_KEY` — a long random encryption key

Do not put any of those values into a repository file.

## 4. First run

Open the repository's **Actions** tab → **RWI Watch Monitor** → **Run workflow**.

For the first run, turn on **Send an ntfy test notification before checking RWI**.

Expected results:

- Your phone immediately gets `RWI monitor test` — this proves GitHub → ntfy → phone is working.
- The action logs into RWI.
- It reads the current marketplace threads and saves them as the initial baseline without alerting on old listings.
- It reads your news feed and saves the current `soyla355` activity as its baseline.
- It encrypts the RWI browser session into `.private/auth.enc` before committing it. The encryption key itself remains a GitHub Secret.

Afterward, GitHub automatically checks every 5 minutes (offset a couple of minutes from the top of the hour to reduce GitHub scheduler congestion).

## 5. Marketplace test behavior

While `ENABLE_MARKETPLACE_TEST` is not set (or is set to `true`), the action watches the sales forum.

When a genuinely new sales thread appears after the baseline, your phone gets:

`TEST MARKETPLACE — new RWI sale`

Tapping the notification opens the thread.

This tests the complete chain — RWI page load, parser, change detection, GitHub scheduling, and phone notification — without waiting for `soyla355` to post.

## 6. Disable marketplace alerts after the test succeeds

Repository:

**Settings → Secrets and variables → Actions → Variables → New repository variable**

Create:

- Name: `ENABLE_MARKETPLACE_TEST`
- Value: `false`

The marketplace test stops. The `soyla355` monitor keeps running every 5 minutes.

To re-enable it later, change the value to `true`.

## Permanent alert

When the news feed contains a newly detected item from `soyla355`, your phone gets:

`soyla355 — new RWI post`

The alert links back to the most specific RWI post/thread URL the news-feed item exposes.

## If RWI changes its page layout

The workflow sends at most one repeated error notification per error type every six hours, instead of spamming you every five minutes. Open **GitHub → Actions → RWI Watch Monitor → failed run** and inspect the `Check RWI` log.

## If Cloudflare blocks GitHub

The script explicitly detects common Cloudflare verification pages and reports that as the failure. If RWI begins requiring an interactive challenge from GitHub's data-center IPs, the code itself is still fine, but this particular free cloud runner path will need to be changed.

## Security notes

- `RWI_USERNAME`, `RWI_PASSWORD`, `NTFY_TOPIC`, and `RWI_SESSION_KEY` exist only as GitHub Actions Secrets.
- The reusable RWI browser session is AES-256-CBC encrypted with PBKDF2 before being committed as `.private/auth.enc`.
- Decrypted browser state exists only inside the temporary GitHub runner and is deleted at the end of a run.
- Do not commit `.private/auth.json`.

## Staying active on a public repository

GitHub can automatically disable scheduled workflows in public repositories after 60 days with no repository activity. The monitor therefore updates a harmless heartbeat timestamp about once every 30 days, ensuring the repository continues to receive periodic commits even if `soyla355` does not post for a long time.
