# GuiVault

*[Version française](README.md)*

**A zero-knowledge vault for passwords *and* infrastructure secrets — on
your own server, or with no server at all.**

GuiVault keeps logins, 2FA codes, passkeys, notes, cards and identities,
but also SSH hosts, keys, AWS access and API keys, and shares them between
the members of a team. Everything is encrypted on the device: the server,
which you host, only keeps blobs it cannot read and holds no key. The same
vault can also live in a plain folder, with no server, KeePass-style — and
move from one to the other when your needs change.

Clients: web interface (served by the server), browser extension, Windows
app, Android app, `gv` command line, and
[Guiterm](https://github.com/GulliGulli28/gui-termius), the SSH client by
the same author.

> **Where the project stands — no embellishment** (October 2026)
>
> - **Young project**: first commit on 15 September 2026, a single
>   developer. About 57,000 lines of Rust, TypeScript and Kotlin, more than
>   250 automated tests run by CI on every commit — unit tests, end-to-end
>   against a real server and a real database, the extension in a real
>   Chromium, the app in its real window (WebKitGTK and WebView2).
> - **No external security audit so far.** The design is documented and
>   argued ([`docs/SECURITY.md`](docs/SECURITY.md), in French), the
>   cryptography relies on well-known libraries (RustCrypto, `@noble`) and
>   nothing home-made — but nothing replaces an independent review. Keep
>   another copy of what you can't afford to lose.
> - **Two languages**: the interface exists in French and English
>   (Settings › Appearance › Language), not yet in others. The technical
>   documentation (`docs/`) is in French.
> - **Distribution still hand-made**: the Docker image is published and
>   signed, but the extension has to be loaded “unpacked” (not in the
>   stores yet), the Windows installers have no Authenticode signature
>   (SmartScreen warns), and the Android APK is installed by hand and was
>   tried on a single real phone. No iOS, no macOS, no Linux app.

## Why GuiVault

1. **Designed against a malicious server, not just a breach.** In February
   2026, ETH Zurich published [31 attacks](https://eprint.iacr.org/2026/058)
   against Bitwarden, LastPass, Dashlane and 1Password, all assuming a
   compromised server. GuiVault answers every family of attacks described:
   an Argon2id floor and parameters pinned per device (the server can't
   impose a cheap derivation), **authenticated** vault key envelopes and
   the inviter's fingerprint verified before accepting, rollback detection,
   emergency access **without** a server-side recovery key, an
   administrator role granted only from the shell, and a sealed **vault
   manifest** that exposes a replayed, withheld or resurrected item.
2. **Local or server, the same vault.** A local vault isn't another format:
   it's exactly what the server would keep, in a folder. You start alone
   without hosting anything, and copy it to a server the day you want to
   share — or the other way round —, history, trash and attachments
   included ([`docs/TRANSFERT.md`](docs/TRANSFERT.md)). Two copies of the
   same local vault (Nextcloud, Syncthing, USB stick) can be synced back
   into one. KeePass has no server; Bitwarden, 1Password and Proton Pass
   have no serverless mode.
3. **Infrastructure secrets as first-class citizens.** Hosts, SSH keys
   (generated in OpenSSH format), AWS access, expiring API keys, synced with
   Guiterm; Guiterm's SSH agent and the app's read the vault (confirmation
   on every signature, commit signing). `gv` reads a secret by reference
   (`gv://vault/item/field`), runs a command with its secrets as
   environment variables (`gv run`), acts as an AWS `credential_process`
   and a Git credential helper. What 1Password sells to developers, as
   self-hosted free software.
4. **Everything, with no paid tier.** Attachments, emergency access, share
   links (text, item or file), TOTP, health report, passkeys: no licence,
   no “premium”. **This is a commitment**: what goes into the free software
   stays there, for everyone; if something is ever sold, it will be service
   (hosting, support), not code.
5. **A server you can run with peace of mind.** A Docker image, a Rust
   binary, PostgreSQL. Automatic backups **restored into a test database**
   every time, to prove they work; an administration that never sees any
   content; quotas, IP restriction, append-only audit log, optional e-mails
   nothing depends on.

## What it does

### The clients

| Client | What it does | Status |
|---|---|---|
| **Web interface** | Everything, from any browser, with the same cryptography as the other clients; usable on a phone, installable (PWA), read-only offline copy | Served by the server at `/` |
| **Extension** ([`EXTENSION.md`](docs/EXTENSION.md)) | One-click or in-field autofill — web components (shadow DOM) and frames included, never handing a site's password to a third-party frame —, TOTP codes, passkeys, generator; against a server or the app's local vault | Chrome, Edge, Firefox ≥ 115; load unpacked |
| **Windows app** ([`APP.md`](docs/APP.md)) | Local vault or server; KeePass-style auto-type, SSH agent, clipboard kept out of Windows history, lock with the session, notification area, local vault backups and sync with a copy, KeePass (KDBX) import, signed updates | MSI and NSIS in the [`app-v*` releases](https://github.com/GulliGulli28/GuiVault/releases) |
| **Android app** ([`ANDROID.md`](docs/ANDROID.md)) | Local vault or server; biometric unlock, autofill for other apps and Chrome ([`REMPLISSAGE.md`](docs/REMPLISSAGE.md)), floating bubble | Signed and attested APK, attached to the same releases; tried on a real phone |
| **`gv`** ([`CLI.md`](docs/CLI.md)) | Secrets by reference, `gv run`, AWS, Git, attachments; encrypted cache readable without the server; `gv recover`: get everything out of a backup, a local vault or an export, with no server | Build it (`cargo build --release -p guivault-cli`) |
| **Guiterm** | SSH client: hosts, keys, snippets and connections synced, SSH agent backed by the vault | Separate repository |

They all read the same blobs: vectors generated by the Rust code and read
back by the TypeScript (and vice versa) check it on every build.

### The vault

- **Item types**: logins (several websites, TOTP, passkeys, password
  history), secure notes, cards, identities, AWS access, API keys, hosts,
  SSH keys, snippets; custom fields, favorites, colored folders, icons.
  Formats in [`docs/ITEMS.md`](docs/ITEMS.md).
- **Encrypted attachments**, one key per file, chunks bound to their place
  ([`docs/PIECES-JOINTES.md`](docs/PIECES-JOINTES.md)).
- **History** of every item and **trash** (30 days by default).
- **Conflicts**: two concurrent edits are merged field by field instead of
  one overwriting the other.
- **Search** across all vaults (Ctrl+K), keyboard shortcuts (`?`),
  clipboard cleared after the chosen delay, lock after inactivity,
  settings that follow the account (encrypted).
- **Generators**: passwords, passphrases (EFF list), Ed25519, RSA and ECDSA
  SSH keys.
- **Import**: Bitwarden (plain or password-protected JSON, CSV), KeePass 2
  and KeePassXC (KDBX 3.1 and 4, key file, attachments and history), CSV
  from 1Password, Proton Pass, Chrome, Firefox, LastPass and KeePassXC.
  **Export**: password-encrypted or plain JSON, CSV.

### Sharing

- **Shared vaults**: a vault's key is wrapped for each member's public key;
  reader / editor / admin / owner roles; invitations, including to someone
  who doesn't have an account yet; **fingerprints** to verify out of band,
  pinned, with an alert if they change; key rotation after someone leaves.
- **Share links** (“Send”): a text, an item or a file passed to someone
  without an account, the key in the link's fragment (never seen by the
  server), with expiry, a number of openings and an optional password.
- **Travel mode**: before a border, only the vaults marked “travel-safe”
  stay on your devices; the others come back on your return (master
  password asked again).
- **Emergency access**: a trusted contact can read some of your vaults if
  you don't refuse their request before the end of a chosen waiting
  period; the keys are wrapped for them client-side, the server only stores
  them.

### Account and security

- Sign-in with a **master password** (Argon2id 64 MiB, 3 passes,
  client-side) with a **TOTP** second factor and recovery codes, or a
  **security key** (WebAuthn); or with a **passkey** (WebAuthn PRF,
  [`docs/PASSKEYS.md`](docs/PASSKEYS.md)).
- **Sessions**: hashed opaque tokens, refresh token rotation with replay
  detection, remote revocation, e-mail alert on a sign-in from a
  never-seen address.
- **Health report**, computed in the browser: weak, reused, old,
  **breached** passwords (Have I Been Pwned with k-anonymity, on request),
  sites that accept 2FA without a saved code, expiring keys and cards.
- **Sync**: monotonic revisions per vault, only changes are downloaded,
  optimistic locking, real-time stream (SSE).
- **Account deletion** (password and second factor asked again).

## Security, in short

```
master password ─Argon2id─▶ master key ─┬─HKDF─▶ auth key ──▶ server (re-hashed with Argon2id)
                                        └─HKDF─▶ key that seals the user key
user key ─▶ X25519 private key ─▶ vault keys (one envelope per member) ─▶ items
```

- **Primitives**: XChaCha20-Poly1305, Argon2id, X25519, HKDF-SHA-256. Each
  item is bound by its AAD to its vault, its id and its type: moved,
  renamed or swapped, it no longer opens.
- **The server sees** e-mail addresses, who is a member of what, the number
  and **type** of items, sizes, dates, session IP addresses — never a name,
  a website, a username or a secret.
- **Changing the password** only re-encrypts the user key; a lost master
  password is **unrecoverable**, by design.
- **Your data doesn't depend on the project**: the formats are described
  byte by byte ([`docs/FORMATS.md`](docs/FORMATS.md)), and `gv recover`
  gets everything out in clear text from a server backup, a local vault or
  an export, with nothing but the password and no server.

The full threat model — what is covered, how, and what isn't — is in
[`docs/SECURITY.md`](docs/SECURITY.md); the key hierarchy in detail in
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) (both in French).

## Known limits

Read before adopting GuiVault; each one is detailed in
[`docs/SECURITY.md`](docs/SECURITY.md) or [`docs/ROADMAP.md`](docs/ROADMAP.md).

- **No external audit**, no bug bounty program yet.
- **Vault manifest**: any member, reader included, can write a valid one
  (no per-account signature), and a device discovering a vault has no
  earlier state to compare with. Guiterm 4.2.0 or later is needed to write
  to a vault that has one.
- **The web interface is delivered by the server** on every load: a
  compromised server could serve a page that steals the master password.
  That's the limit of every web vault (Bitwarden and Proton included); the
  app and Guiterm, installed once, aren't exposed to it. The build is
  reproducible: `scripts/verify-web.sh` checks that the page a server
  serves you is the one of the published code — for you, at that moment.
- **No 1Password-style “Secret Key”**: whoever steals the database can
  attack a weak master password offline. Argon2id makes it expensive, not
  impossible — choose a long passphrase.
- **Security keys and passkeys from the web interface only**: as a second
  factor, the security key only works in the browser (the app and the
  extension have TOTP); passkey sign-in isn't in the extension yet.
- **No enterprise features**: no SSO, SCIM, groups, or policies imposed on
  members.
- **1Password and Proton Pass import through their CSV only** (logins and
  notes; not yet their full `.1pux` and JSON exports), no e-mail aliases.
- **Android**: a local vault lives in the app's private folder, which
  uninstalling erases — export it (`.zip` archive) or copy it to a server
  to keep it safe.
- **Metadata**: the server knows how many items of each type you have, and
  who you share with.

## GuiVault compared

GuiVault doesn't replace a proven manager for everyone. Here is where it
stands, honestly (competitors as of October 2026, check with them).

| | GuiVault | Bitwarden / Vaultwarden | KeePassXC | 1Password | Proton Pass |
|---|---|---|---|---|---|
| Source code | Open (MIT), server and clients | Open (GPL/AGPL, some parts under the Bitwarden licence); Vaultwarden: free server rewritten in Rust | Open (GPL) | Proprietary | Open clients, closed server |
| Self-hosting | Yes (one image, PostgreSQL) | Yes (official or Vaultwarden) | — (a file) | No | No |
| No server at all | Yes (local vault, convertible into an account) | No | Yes, it's its model | No | No |
| Sharing with roles | Yes | Yes (organizations) | No (a shared file) | Yes | Yes |
| Paid features | None | Premium, Teams, Enterprise (Vaultwarden: all included) | None | Subscription | Plus plans and above |
| External audits | **None** | Regular, published | Yes (2023) | Regular, SOC 2 | Yes |
| Platforms | Web, Chrome/Edge/Firefox, Windows, Android, CLI | All, iOS and macOS included | Windows, macOS, Linux; mobile through third-party apps | All | All |
| Infrastructure secrets | SSH hosts and keys, AWS, API keys; SSH agent (Guiterm, app), CLI with references | SSH agent, CLI, Secrets Manager (separate product) | SSH agent, CLI | The most complete: SSH agent, CLI with references, integrations | CLI and SSH agent, recent |
| Protecting a stolen database | Argon2id on the password | Argon2id or PBKDF2 on the password | Argon2 on the file | Password **+ 128-bit Secret Key** | Password |
| Languages | French, English | Dozens | Dozens | Dozens | Dozens |
| Age | A few weeks, one developer | Since 2016, a company | Since 2016, a community | Since 2006, a company | Since 2023, Proton |

**Rather choose…**

- **Bitwarden, or Vaultwarden with the official clients**, if you want a
  self-hostable, audited manager today, on every platform, iPhone
  included. For self-hosting, it's the mature reference.
- **KeePassXC** if you're alone, don't want to host anything and are fine
  with a file you sync yourself.
- **1Password** for a family or a company that wants the most polished
  product, support and the Secret Key, and accepts the cloud and closed
  code.
- **Proton Pass** if you already live in the Proton ecosystem (Mail, Drive,
  VPN), want e-mail aliases and don't want to host anything.

**Choose GuiVault** if you host things yourself, manage machines and want
your SSH keys and cloud access in the same place as your passwords; if you
want to start without a server and be able to share later without
changing tools; if the compromised-server case matters to you — and if you
accept that the project is young.

## Installing the clients

- **Windows and Android app**: the latest
  [`app-v*` release](https://github.com/GulliGulli28/GuiVault/releases)
  (SHA-256 sums attached; the APK is attested by CI). The Windows app
  updates itself; on Android, install the next APK over the current one.
- **Extension**: `cd web && npm install && npm run build:ext`, then “Load
  unpacked” on `web/dist-extension`
  ([`docs/EXTENSION.md`](docs/EXTENSION.md)).
- **`gv`**: `cargo build --release -p guivault-cli` → `target/release/gv`.
- **Web interface**: nothing to install, the server serves it.

## Deployment (Docker)

```bash
git clone https://github.com/GulliGulli28/GuiVault.git && cd GuiVault
cp .env.example .env
# Fill in POSTGRES_PASSWORD, GUIVAULT_SECRET (openssl rand -base64 48)
# and GUIVAULT_ALLOWED_EMAILS (your address: it's the first account).
docker compose pull && docker compose up -d   # or `up -d --build` to build the image yourself
curl http://127.0.0.1:8080/api/v1/health
```

The `ghcr.io/gulligulli28/guivault` image (amd64 and arm64) is published
by CI after every green commit on `main` (`:latest`, `:sha-<commit>`) and
for every `server-v<version>` tag. It is **signed** (keyless cosign: the
identity is the workflow) and comes with a **provenance attestation**
(which repository, which commit, which workflow):

```bash
cosign verify ghcr.io/gulligulli28/guivault:latest \
  --certificate-identity-regexp '^https://github.com/GulliGulli28/GuiVault/.github/workflows/server-image.yml@' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com
gh attestation verify oci://ghcr.io/gulligulli28/guivault:latest -R GulliGulli28/GuiVault
```

The server speaks HTTP on `127.0.0.1:8080`. **Put it behind a TLS reverse
proxy** before exposing it: either your own (Traefik, nginx, Caddy…),
declaring your proxy's address to it (see below), or the built-in profile:

```bash
GUIVAULT_DOMAIN=vault.example.com docker compose --profile tls up -d
```

**HTTPS isn't optional for the web interface.** Over plain HTTP, a browser
puts the page outside a “secure context” and takes part of the WebCrypto
API away from it; above all, anyone on the path can replace its JavaScript
with a version that steals the master password. The page shows a red
warning in that case. For a quick test without a certificate, go through
an SSH tunnel — `localhost` is a secure context:

```bash
ssh -N -L 8082:127.0.0.1:8082 my-server
```

### Behind your own reverse proxy

`GUIVAULT_TRUST_PROXY` says **who** may announce the client IP through
`X-Forwarded-For` — which drives the rate limit of the authentication
routes and what the audit log records. Give it your proxy's address (or
network):

```ini
GUIVAULT_TRUST_PROXY=172.18.0.0/16      # the proxy's Docker network
# or 192.168.1.10, or several separated by commas
```

The server then only reads the header if the connection comes from there —
and a TCP connection address, unlike a header, can't be forged. Someone
reaching the port directly is therefore rate-limited on their real IP.

`true` is still accepted: the header is trusted whoever sends it. Only
keep it if the port really can't be reached otherwise (published on
`127.0.0.1` with a proxy on the same machine and *not* in a container, or
not published at all). `false` (default) ignores the header.

### First account

The server can't create an account (it never has the master password). In
`invite_only` mode (default), put your address in
`GUIVAULT_ALLOWED_EMAILS`, sign up from Guiterm or from the web interface
(`https://vault.example.com/`), then invite the others from a shared
vault: an invitation allows sign-up — or, as an administrator (see below),
open sign-up to an address.

### Administration

An account becomes a server administrator from the server's shell — never
through the API, so a stolen session can't grant itself others:

```bash
docker compose exec guivault guivault admin grant you@example.com
docker compose exec guivault guivault admin list     # or revoke <email>
```

The “Administration” entry then appears in the web interface: server
status, accounts (last activity, vaults, stored size, quota), disabling
(sessions cut, nothing erased), deletion (their vaults shared with others
go to the best-placed member), and sign-up opened to an address — useful in
`invite_only` with no vault to share, or in `closed`. An administrator sees
metadata, never content, and can neither disable nor delete another
administrator.

### E-mails (optional)

With `GUIVAULT_SMTP_URL` and `GUIVAULT_SMTP_FROM`, the server notifies: a
vault's invitee (and tells them to create their account if they have
none), an address the administration opens sign-up to, an account holder
on every sign-in from a never-seen IP address (90 days), on every change of
master password or second factor, and both parties of an emergency access
at each step — above all the grantor when their contact **requests**
access, with the date it will open unless refused, then both when it
opens. Each message goes out in the language of the recipient's account
(both languages if unknown). **Nothing depends on them**: without SMTP,
with a misconfigured or failing SMTP, every action still succeeds (sending
happens afterwards, in the background; a failure is logged) and everything
remains visible in the clients. A message contains no secret, no vault
name, and no link other than `GUIVAULT_PUBLIC_URL`. Administration › Server
says whether e-mails work and sends a test e-mail.

### Web interface

The binary serves at `/` an application (React) that does exactly what
Guiterm does with the server: derive the keys from the master password in
the browser, decrypt the vaults, encrypt what it writes. The server sees
nothing more than with Guiterm. Nothing is kept after the tab closes
(apart from fingerprints, pinned Argon2id parameters and the last vault
revisions seen); the threat model specific to the web is in
[`docs/SECURITY.md`](docs/SECURITY.md).

### Environment variables

| Variable | Default | Role |
|---|---|---|
| `GUIVAULT_DATABASE_URL` | — | PostgreSQL URL (required) |
| `GUIVAULT_SECRET` | — | ≥ 32 characters (required) |
| `GUIVAULT_BIND` | `0.0.0.0:8080` | Listen address |
| `GUIVAULT_REGISTRATION` | `invite_only` | `open` / `invite_only` / `closed` |
| `GUIVAULT_ALLOWED_EMAILS` | — | Addresses or `@domains` always allowed to sign up |
| `GUIVAULT_TRUST_PROXY` | `false` | IP/CIDR of the proxies allowed to set `X-Forwarded-For` (`true` = all, see above) |
| `GUIVAULT_ACCESS_TTL_SECS` | `900` | Access token lifetime |
| `GUIVAULT_REFRESH_TTL_SECS` | `2592000` | Refresh token lifetime (30 d) |
| `GUIVAULT_INVITATION_TTL_SECS` | `1209600` | Invitation lifetime (14 d) |
| `GUIVAULT_MAX_ITEM_BYTES` | `1048576` | Max size of an encrypted item |
| `GUIVAULT_ITEM_HISTORY` | `20` | Previous versions kept per item (history, encrypted); `0`: neither history nor trash |
| `GUIVAULT_TRASH_DAYS` | `30` | Days a deleted item stays in the trash |
| `GUIVAULT_SEND_MAX_DAYS` | `30` | Maximum lifetime of a share link (days); `0`: links disabled, public routes included |
| `GUIVAULT_HEALTH_LOOKUPS` | `true` | Relay the health report's lookups (k-anonymity breaches, list of 2FA sites); `false`: no outgoing request |
| `GUIVAULT_HIBP_URL` / `GUIVAULT_2FA_DIRECTORY_URL` | public services | Where to relay them (internal mirror, tests) |
| `GUIVAULT_MAX_ATTACHMENT_MB` | `100` | Maximum size of an (encrypted) attachment; `0`: attachments disabled |
| `GUIVAULT_QUOTA_MB` | `0` | Storage quota per account (MiB of ciphertext in the vaults it owns); `0`: none. Adjustable per account in the administration |
| `GUIVAULT_ALLOWED_IPS` | — | The only ranges served (IP/CIDR, comma-separated): API, interface, share links; `/api/v1/health` stays reachable. Empty: all |
| `GUIVAULT_ADMIN_ALLOWED_IPS` | — | Ranges the administration (`/admin`) answers from; empty: all |
| `GUIVAULT_SMTP_URL` | — | Optional e-mails: `smtps://user:password@host:465` or `smtp://…:587?tls=required` (STARTTLS). Without it, or if unreachable, everything works the same |
| `GUIVAULT_SMTP_FROM` | — | Sender, e.g. `GuiVault <vault@example.com>` (required with `GUIVAULT_SMTP_URL`) |
| `GUIVAULT_PUBLIC_URL` | — | The server's public address (`https://vault.example.com`), quoted in e-mails; it also enables **passkey sign-in** (its domain is the passkeys' site, its origin the only one accepted — see `docs/PASSKEYS.md`) |
| `GUIVAULT_SECURITY_CONTACT` | — | Who to report a flaw of *this* server to (e-mail, `mailto:` or `https:`), at the top of `/.well-known/security.txt`; the project is always listed after it |
| `GUIVAULT_BACKUP_DIR` | — (`/backups` with the compose file) | Automatic backups folder; empty: none |
| `GUIVAULT_BACKUP_INTERVAL_HOURS` / `_KEEP` | `24` / `7` | Frequency; number kept |
| `GUIVAULT_BACKUP_VERIFY_DATABASE_URL` | — (set by the compose file) | Test database where each backup is restored and compared — **erased every time**: empty or reserved for this (created if missing on the same Postgres) |
| `GUIVAULT_AUTH_RATE_PER_SECOND` / `_BURST` | `2` / `10` | Per-IP rate limit of the auth routes |
| `GUIVAULT_LOG_JSON` | `false` | JSON logs |
| `RUST_LOG` | `info,sqlx=warn` | Log filter |

### Backups

The server backs itself up: `GUIVAULT_BACKUP_DIR` (enabled by the provided
`docker-compose.yml`, `backups` volume) receives every
`GUIVAULT_BACKUP_INTERVAL_HOURS` a `guivault-YYYYMMDD-….jsonl.gz` file, the
last `GUIVAULT_BACKUP_KEEP` kept. Each backup is **verified**: fully read
back (gzip, every line, counts and SHA-256 per table), and — with
`GUIVAULT_BACKUP_VERIFY_DATABASE_URL`, set by the compose file — **restored
into a test database** then backed up again: same rows, same checksums, or
the backup is marked failed. The status is in Administration › Backups (in
red if the last one failed or if the last successful one is too old), with
“Back up now”.

```bash
docker compose exec guivault guivault backup create /backups          # by hand
docker compose exec guivault guivault backup verify /backups/guivault-….jsonl.gz
# Restore: into an empty database (or one where the server has only started),
# server stopped; the backup's schema is recreated then migrated.
docker compose stop guivault
docker compose run --rm guivault backup restore /backups/guivault-….jsonl.gz
```

**Copy the folder elsewhere** (another disk, another machine): a backup
next to the database doesn't protect against losing the disk. The file
contains no secret in clear text — without each person's master password
it's useless —, but everything the database has (addresses, hashes,
ciphertext): protect it like the database. `GUIVAULT_SECRET` isn't in it:
keep it separately; without it, restored TOTP second factors have to be
enrolled again. `pg_dump` remains possible alongside.

**A lost master password is unrecoverable** — there is no possible
server-side “reset”, by design.

## Development

```bash
scripts/test-db.sh        # throwaway Postgres in Docker (port 55432)
cargo test                # unit + end-to-end integration (real server, real crypto)
cargo clippy --all-targets && cargo fmt --all --check
cd web && npm install && npm test && npm run lint && npm run build   # web interface
cd web && npm run build:ext && npm run test:ext                      # extension and its autofill corpus
cd web && npm run build:app                                          # the app's interface
cd app-tauri && cargo build && cd ../web && npm run test:app         # the app, driven by WebDriver
```

The web interface is embedded in the binary at `cargo build` time
(`web/dist`, created by `npm run build`); without that build, the server
still compiles and answers on `/` that the interface is missing. To work
on it with hot reload: `cargo run` on one side, `cd web && npm run dev` on
the other (Vite serves on `http://localhost:1430` and proxies `/api` to the
server).

Layout:

- `crates/guivault-crypto` — primitives and key hierarchy, shared with the
  clients. **All encryption happens here, client-side.**
- `crates/guivault-protocol` — the API's JSON types.
- `crates/guivault-items` — the clear-text formats of secrets, so a Rust
  client reads them without redefining them. Tested against what the web
  interface writes.
- `crates/guivault-server` — the server (axum + sqlx/PostgreSQL), which
  also serves the web interface.
- `crates/guivault-local` — the local vault: what the server keeps, in a
  folder, with no key and no crypto.
- `crates/guivault-cli` — `gv`.
- `web/` — the web interface (Vite + React + TypeScript).
  `src/lib/crypto.ts` is the port of `guivault-crypto`; vectors generated by
  the Rust crate (and vice versa) guarantee both read the same blobs.
  `web/extension/`: the extension, on the same code; `web/app/`: the app's
  interface. Interface texts are written in French in the code (`t("…")`)
  and translated in `web/src/i18n/en.json`.
- `app-tauri/` — the Windows and Android app (Tauri 2, separate Cargo
  workspace; Android's Kotlin in `gen/android`).

Guiterm consumes `guivault-crypto`, `guivault-protocol` and
`guivault-items` as git dependencies, pinned to a commit: a response that
changes breaks compilation on both sides instead of drifting apart.

## Documentation

The technical documentation is in French.

| Document | Content |
|---|---|
| [`ARCHITECTURE.md`](docs/ARCHITECTURE.md) | How it works, key hierarchy, sync |
| [`FORMATS.md`](docs/FORMATS.md) | The formats, byte by byte: enough to read your data back without GuiVault |
| [`SECURITY.md`](docs/SECURITY.md) | Threat model: covered, accepted, limits |
| [`API.md`](docs/API.md) | Routes and error codes |
| [`ITEMS.md`](docs/ITEMS.md) | Item formats, import and export |
| [`EXTENSION.md`](docs/EXTENSION.md) | Browser extension |
| [`APP.md`](docs/APP.md) | App, local vault, releasing versions |
| [`ANDROID.md`](docs/ANDROID.md) · [`REMPLISSAGE.md`](docs/REMPLISSAGE.md) | Android, autofill service |
| [`CLI.md`](docs/CLI.md) | `gv` |
| [`PASSKEYS.md`](docs/PASSKEYS.md) · [`PIECES-JOINTES.md`](docs/PIECES-JOINTES.md) · [`TRANSFERT.md`](docs/TRANSFERT.md) · [`MANIFESTE.md`](docs/MANIFESTE.md) | Detailed designs |
| [`DESIGN.md`](docs/DESIGN.md) | Interface style and rules |
| [`ROADMAP.md`](docs/ROADMAP.md) | What's done, what's left |

## Contributing

Issues and pull requests welcome, in French or English: the non-negotiable
rules, how to build and test, what's expected of a contribution —
[`CONTRIBUTING.md`](CONTRIBUTING.md).

## Reporting a vulnerability

Through a [private security advisory](https://github.com/GulliGulli28/GuiVault/security/advisories/new)
on GitHub, not a public issue — response times, scope and maintained
versions in the [security policy](SECURITY.md).

## Licence

MIT.
