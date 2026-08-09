# Rebind

**Recovery infrastructure for compliance-restricted real-world assets.**

*Identity outlives the key.*

Cleanverse Build: Trusted Assets Hackathon · RWA Track

---

## The problem

A compliance-restricted asset can only move between verified wallets. That rule
is what makes the asset legally legitimate. It is also what makes it
**unrecoverable**.

When a holder's key is lost, stolen, or rotated:

- Seed restore? The seed is gone.
- Social recovery or multisig rotation? Those move control of an *address*.
  Neither re-binds an identity credential.
- Sweep to a rescue wallet? **The rescue wallet isn't verified.** It reverts.

The holder is still a real, bank-verified person. The chain has no way to hear
them say so. The more compliant the asset, the more permanently it is stranded.

## The insight

**A Cleanverse A-Pass is the only primitive in Web3 that survives the loss of a
key.** A seed phrase proves *control*. An A-Pass proves *personhood* — bound to
a legal entity that still exists after the wallet dies.

Verified against the live sandbox: calling `generate_apass` twice with the same
`customerId` and `override: true` binds a **second wallet to the same identity
record** (`cvRecordId` identical across both). `query_apass_list({customerId})`
then returns every wallet belonging to that person.

That is the rebind primitive. This project builds recovery on top of it.

**The affidavit of loss, executed on-chain.**

## Honest scope

Cleanverse has **no force-transfer endpoint** — I checked every A-Token method.
So Cleanverse provides the *identity* layer, and Rebind provides the *recovery*
layer via `atoken/register_atoken`, which registers a contract you wrote
yourself. That seam is stated openly rather than papered over.

---

## Architecture

```
BindingRegistry     personId <-> wallets, guardians, revocation. Written by the attestor.
RebindableRWA       ERC-20 + ERC-1404, compliance gate in _update(), recoveryTransfer()
RecoveryQueue       EIP-712 claims, cure window, issuer approval and commitment
RebindExecutor      the only address allowed to perform a recovery transfer
BridgeAdvanceVault  lends against a committed claim; repaid inside execution
```

### The gate

OpenZeppelin v5 routes every balance change — `transfer`, `transferFrom`,
`_mint`, `_burn` — through one internal `_update()`. Overriding it once covers
every path with no bypass.

### Asking before you sign — ERC-1404

A gate that only speaks by reverting teaches the rule by costing gas. The token
implements **ERC-1404**, the standard pre-flight interface, so a caller can ask
first:

```solidity
detectTransferRestriction(from, to, value) -> uint8   // 0 = allowed
messageForTransferRestriction(uint8)       -> string
```

| Code | Meaning |
|---|---|
| 0 | Transfer allowed |
| 1 | Sender has no A-Pass binding |
| 2 | Sender binding revoked |
| 3 | Recipient has no A-Pass binding |
| 4 | Recipient binding revoked |
| 5 | Insufficient balance |

Two functions rather than one is deliberate: contracts branch on the cheap
numeric code, and only a UI pays to render the string.

Eligibility is reported **ahead of** balance — topping up cannot fix an
ineligible counterparty, so naming the counterparty is the more useful answer.
A test asserts every non-zero code corresponds to a transfer that really does
revert; a pre-flight check that disagrees with enforcement is worse than none,
because callers trust it and lose the gas anyway.

Conforming rather than approximating is what makes this reachable: any
ERC-1404-aware wallet, exchange or compliance dashboard can query the token
with no bespoke integration.

### The recovery trap

`recoveryTransfer()` moves tokens *out of a revoked wallet*, but it calls
`_transfer` → `_update`, which rejects revoked senders. Without a guard it
reverts on its own gate. A transient `_inRecovery` flag suspends the **sender**
check only, never the recipient check. Recovery is a compliance feature, not a
bypass. Covered by the test `THE TRAP: recoveryTransfer works even though the
sender is revoked`.

### Why an attacker can't steal via a fake claim

1. **Attestation** — opening a claim needs an EIP-712 signature from the
   attestor, who only signs after `query_apass_list` confirms both wallets share
   one `customerId`. A stolen *wallet* is not a stolen *identity*.
2. **Guardian co-sign** — the claim also needs a signature from the guardian
   wallet nominated at registration and recorded on-chain. A compromised
   attestor key is not enough on its own.
3. **Cure window** — opening a claim immediately freezes the old binding, so a
   compromised key cannot drain the asset while the claim is reviewed. This is
   the transfer agent's notice period, on-chain.
4. **Issuer approval** — a human countersigns, and may reject during the window.

Defeating all four needs the wallet *and* the identity *and* the guardian key
*and* the issuer.

Two degenerate cases are closed explicitly: a claim where `oldWallet ==
newWallet` is rejected (it would otherwise freeze a wallet and go nowhere), and
only one claim may be active per old wallet at a time (so two claims cannot
race for approval).

**The guardian key must not be the attestor key.** If one party signs both
halves, layer 2 collapses back into layer 1 and the claim above stops being
true. The backend refuses to fall back to `ATTESTOR_PK`; set `GUARDIAN_PK`, and
in local mode a separate disposable key is derived automatically.

**Who may cancel — and why it is not the old wallet.** `cancel()` is
`onlyRole(ISSUER_ROLE)`. Giving the incumbent wallet a veto looks protective
until you name who holds that key in the scenario we exist for: in a theft it is
the attacker, and in a genuine loss nobody holds it at all. A thief cannot move
the asset — the gate already stops them — so a veto would be their *only*
remaining power, purely to grief the rightful owner. Rejection therefore sits
with the issuer, who restores the old binding on cancel.

---

## Setup

### 1. Install

```bash
npm install
cp .env.example .env      # then fill it in
```

### 2. Keys

You need **two** private keys:

- `DEPLOYER_PK` — deploys contracts, owns the token, acts as issuer
- `ATTESTOR_PK` — signs equivalence attestations only

Keep them separate. It's the point of the trust model, and judges notice.

Base Sepolia testnet ETH: https://www.alchemy.com/faucets/base-sepolia

### 3. Compile and test

```bash
npm run compile
npm test              # 133 tests (contract, bridge advance, backend, local stub)
```

**If `npx hardhat compile` fails with HH502** (can't reach
`binaries.soliditylang.org` — common on locked-down networks):

```bash
npm run compile:offline    # compiles via the solc npm package
npm run test:offline       # hardhat test --no-compile
```

### 3b. Run the whole demo locally (no testnet, no credentials)

The steps below need Base Sepolia ETH, Cleanverse API keys, and a
`register_atoken` approval that has a human in the loop and can take hours.
None of that is worth waiting on when you only want to see the flow — or work
on the UI. Local mode runs every beat against a Hardhat node with an in-memory
Cleanverse stub:

```bash
npm run node:local     # terminal 1 — local chain, leave it running
npm run fund:local     # terminal 2 — funds your .env keys, starts the block heartbeat
npm run deploy:local   #            — writes deployments.json
npm run server:local   #            — http://localhost:3000
```

You still need `DEPLOYER_PK`, `ATTESTOR_PK` and `IDENTITY_COMMITMENT_SALT` in
`.env` — any values will do, since the chain is disposable. `CV_API_ID` and
`CV_API_KEY` are not read at all.

Three things worth knowing:

- **`fund:local` turns on interval mining.** A Hardhat node only advances
  `block.timestamp` when it mines, and it mines only on a transaction. The
  challenge window is read through a view call, so without a 1s heartbeat the
  countdown sits frozen and the recovery never becomes executable.
- **The stub is shape-compatible, not behaviour-compatible.** It reproduces the
  response shapes callers destructure, not Cleanverse's quirks (every response
  being HTTP 200, frozen passes surfacing as code `0002`). Those are what
  `backend/cleanverse.js` exists to absorb — see `test/cleanverse-local.test.js`.
- **`npm run server:local` sets `DEMO_MODE=local` inline**, which needs a POSIX
  shell. On Windows use `set DEMO_MODE=local && node backend/server.js`.

### Running the demo more than once

A `BindingRegistry` binding is permanent — a wallet belongs to one person, ever
— so the same three wallets can run the recovery story exactly once. That used
to make a second run a redeploy: `deploy:local`, restart the server, and on a
public chain re-register the token with Cleanverse.

**"Start over" in the UI does it without any of that.** It does not undo the
previous run, because nothing on-chain can be undone; it issues a new identity
on wallets that have never been bound, derived from `DEMO_MNEMONIC` at a
session index the browser picks:

```
m/44'/60'/{session}'/0/{0..4}   ->   A, B, attacker, guardian, replacement guardian
```

Set `DEMO_MNEMONIC` to a BIP-39 phrase **of its own** — it must share no keys
with `DEPLOYER_PK` or `ATTESTOR_PK`, since the session index comes from the
request. Without it the button is hidden and the UI says why. Local mode falls
back to the Hardhat phrase.

It costs nothing on any network: no demo wallet ever sends a transaction. The
blocked-transfer beat is a `staticcall`, the bridge advance is an EIP-712
authorisation the issuer relays, and every state change is sent by the issuer
or attestor — so fresh addresses never need gas.

Two consequences worth knowing:

- **Sessions are per-browser**, carried on an `X-Rebind-Session` header, so two
  people can run the demo at once against one deployment without colliding.
  The backend derives rather than stores them, so a restart strands nothing.
- **Vault liquidity is the one thing that accumulates.** Every advance takes
  stable out and returns NOTE, and nothing puts the stable back. A reset tops
  the vault up when it falls below `ADVANCE_TOPUP_FLOOR`.

To reset the chain itself rather than the demo — after a node restart, say —
re-run `fund:local` / `deploy:local` as above.

### 4. Answer the open question first

```bash
npm run freeze-test
```

Determines whether `update_status` freezes a **wallet** or a whole
**customerId**. Rebind's step 5 revokes the old binding — that only works if
freeze is per-wallet.

- **PASS** → set `CV_FREEZE_PER_WALLET=true` in `.env` and ship as designed.
- **FAIL** → leave `CV_FREEZE_PER_WALLET=false`. `/api/claim` then skips the
  `cv.updateStatus` mirror and relies on the on-chain freeze alone, which
  `RecoveryQueue.openClaim()` performs atomically via `revokeForRecovery()`.
  The contracts already support this. Say so on stage; a documented platform
  limitation reads as rigour.

### 5. Deploy

```bash
npm run deploy         # writes deployments.json
```

### 6. Register with Cleanverse

```bash
npm run register
```

Signs EIP-191 over `lowercase(chain) + lowercase(tokenAddress)` — no separator —
and calls `register_atoken`, then polls until `ISSUED`.

**Approval has a human in the loop and can take hours.** Run it early.

### 7. Run the demo

```bash
npm run server         # http://localhost:3000
```

The three demo wallets (Alice A, Alice B, attacker) are served by
`GET /api/config`. In live mode they are **required** — set `DEMO_WALLET_A`,
`DEMO_WALLET_B` and `DEMO_WALLET_X` in `.env` to fresh, never-bound addresses.
They must **not** be the issuer/deployer address: `deploy.js` binds the issuer
(the default fallback receiver) as an institutional wallet, so registering it
as Alice fails with "already bound to a different customer identity". Local mode
derives the wallets from the Hardhat mnemonic and ignores these variables. The
guardian-replacement candidate (`wallets.G2`) is generated by `deploy.js` — see
"Guardian Replacement" below.

Reloading the page resumes from chain state rather than starting over, so a
refresh mid-demo will not double-mint or lose your place. The two beats that
leave no on-chain trace — the blocked transfer, which is a read-only preflight,
and "key compromised", which is narration — replay from the last provable step.

---

## Deploying it

One web service. The Express backend serves the API *and* hands out the built
React bundle, the frontend calls same-origin, and routing is hash-based — so
there is no second deploy, no CORS between the halves, and no SPA rewrite rule.
`render.yaml` is a Render blueprint that encodes all of it.

**Render dashboard → New → Blueprint → pick this repo.** It reads the
blueprint, then prompts for the eight secrets. That is the whole flow.

### Two things that are easy to get wrong

**`npm ci --include=dev`, not `npm ci`.** The build runs `hardhat compile` to
regenerate `artifacts/`, which is gitignored and which the backend reads ABIs
from at runtime. Hardhat is a devDependency, so a production-only install gives
you a server that boots cleanly and then fails every single route.

**`deployments.json` is committed on purpose.** The backend requires it for
contract addresses and it cannot be regenerated without deploying, so a host
building from a clean clone has to find it in the repo. It holds addresses and
a chainId — never a key. Redeploying the contracts means committing the new
file.

### Secrets to set in the dashboard

| Variable | What it is |
|---|---|
| `DEPLOYER_PK` | The issuer. Pays gas for every step of every run — keep it funded. |
| `ATTESTOR_PK` | Signs the EIP-712 identity attestation. |
| `GUARDIAN_PK` | Co-signs claims. Must be a different key from the attestor, or the fourth trust layer is theatre — the server refuses to start if they match. |
| `DEMO_MNEMONIC` | Derives each run's wallets. A phrase of its own, sharing no keys with the two above. |
| `IDENTITY_COMMITMENT_SALT` | Makes the on-chain `personId` unguessable from a customerId. |
| `CV_API_ID` / `CV_API_KEY` | Cleanverse credentials. |
| `RPC_URL` | A **keyed** Base Sepolia endpoint. |

Use a keyed RPC provider rather than the public `https://sepolia.base.org`. It
throttles under demo traffic and the symptom is not an error — it is a
countdown that stops moving while the room watches.

### What a public link exposes

Every write endpoint is unauthenticated by design (the demo has no login) and
every one of them spends the issuer's gas and a slice of the Cleanverse quota.
Two things hold that down, both in `backend/server.js`:

- **CORS** allows this service's own origin and localhost, nothing else. Set
  `ALLOWED_ORIGINS` only if the page is ever hosted apart from the API.
- **A per-IP rate limit** on non-GET requests — `RATE_MAX` actions per
  `RATE_WINDOW_MS`, defaulting to 120 per 10 minutes, which is several full
  runs. It is in-memory and per-instance: a courtesy that stops a bored visitor
  from draining the faucet, not a security boundary.

Watch the issuer's balance. Nothing in the app warns you when it runs dry; the
demo simply starts failing at whichever step exhausts it.

---

## The demo — under four minutes

| # | Beat | What the room sees |
|---|---|---|
| 1 | Register & mint | A-Pass for wallet A, guardian nominated, 250 NOTE issued |
| 2 | **Attacker attempts theft** | **Reverts.** `RecipientNotEligible` |
| 3 | Alice claims from wallet B | Same `customerId` proven, guardian co-signs, claim opened |
| 4 | Cure window | Countdown; wallet A already frozen, issuer may reject |
| 5 | Bridge advance *(if a vault is deployed)* | Issuer underwrites, Alice borrows against the frozen claim |
| 6 | Approve & execute | Note lands in B, advance repays itself out of the recovery |
| 7 | Audit pack | Real Cleanverse Travel Rule PDF |

**Beat 2 is the moment.** The audience watches compliance *block* an attacker,
then watches the same machinery *return the asset* to its rightful owner.

The line: *"Every other project here asks how to keep the wrong people out.
This one asks what we owe the people we already verified."*

---

## Bridge advances — borrowing against a frozen claim

The cure window protects the asset by freezing it. It freezes the rightful
owner just as effectively. Over a realistic 48-hour window that is the
difference between *"my recovery is proceeding"* and *"I cannot make rent"*.

She is not poor during those hours. She is **illiquid against a receivable that
is about to settle**. `BridgeAdvanceVault` prices that receivable: it lends a
stable asset at an LTV haircut, and is repaid out of the recovery itself.

### Why a pending claim was not lendable

`cancel()` works right up until execution — **including after `approve()`**. So
an issuer could approve a claim, watch a lender disburse against it, then
cancel and leave the lender with an unsecured loss and nothing to collect
against. Approval was never a promise; it was a revocable opinion.

`RecoveryQueue.commit()` adds the missing state. It approves the claim **and
permanently surrenders the issuer's right to cancel it.** The vault refuses
approved claims and lends only against committed ones, so its credit question
is not *"will the issuer honour this?"* but *"has the issuer already given up
the ability not to?"*

The honest cost, stated in the contract too: a claim committed by mistake can
no longer be rejected. Commitment must follow the same review that approval
does, not precede it.

### Why repayment cannot be skipped

It is not a promise the borrower keeps. `RebindExecutor` asks the vault what is
owed and routes that much of the recovered balance to it **in the same
transaction that settles the claim**, before the remainder reaches the
borrower. There is no instant at which the borrower holds the full balance and
could decline to repay.

Worked example, at the demo's 80% LTV and 0.5% fee:

| | |
|---|---|
| Claim value | 5,000 NOTE |
| Advanced now | 4,000 dUSDC |
| Owed at settlement | 4,020 NOTE |
| On execution → vault | 4,020 NOTE |
| On execution → wallet B | 980 NOTE |

The borrower signs an EIP-712 authorisation and anyone may relay it, so a
wallet in the middle of recovering an asset does not need gas to borrow.

### What the vault still risks

1. **Balance falls after the draw.** It cannot be spent — the wallet is frozen
   — but the issuer can still burn, and a redemption could reduce it. The LTV
   haircut is the buffer, and the executor caps repayment at whatever actually
   arrives, so the vault absorbs the shortfall rather than the recovery
   reverting. Stranding a rightful owner's asset because a lender is underwater
   would make the loan a hostage.
2. **Price.** Repayment arrives in the note, not the stable that was lent, so
   the vault runs long the note and short stables. At par with a redeemable
   note that is inventory; with a note that trades at a discount it is
   solvency, and the LTV must reflect it. `ParAdvanceOracle` values at par and
   is deliberately not configurable — an oracle an admin can silently re-point
   is a worse trust assumption than one that cannot move. Swap in a different
   `IAdvanceOracle` for a real feed.
3. **The vault must hold an A-Pass.** The note is transfer-restricted, so
   losing that binding would strand every outstanding advance. `deploy.js`
   binds it as an institutional wallet.

### Running it

On by default in `deploy.js`; set `BRIDGE_ADVANCE=false` to deploy without it,
and the executor takes `address(0)` for the vault and behaves exactly as it did
before advances existed. Tune with `ADVANCE_LTV_BPS`, `ADVANCE_FEE_BPS` and
`ADVANCE_SEED`. On a network with a real stablecoin, set `STABLE_ADDRESS` and
`DemoStablecoin` is never deployed.

---

## Security Upgrades: Guardian Replacement & Fallback Repayment

### 1. Guardian Replacement Queue (`GuardianReplacementQueue.sol`)
The `BindingRegistry` originally pinned the `guardianOf` identity forever. If a user lost access to their guardian key, recovery was blocked permanently. 

To solve this, we introduced the **Guardian Replacement Queue** which matches the trust model of the main recovery flow:
* **Attestor Attestation**: Initiating a replacement requires an EIP-712 signature from the Cleanverse attestor (`signGuardianChange`), proving the requesting wallet belongs to the customer ID.
* **Wallet Remains Active**: Unlike a recovery claim, a guardian replacement **does not freeze** the wallet. The holder can continue using their funds during the challenge period.
* **Challenge Window**: A 30-second challenge window (configurable in production, e.g., 24-48 hours) starts upon request opening, giving the issuer time to veto fraudulent replacements.
* **Stale Attestation Check**: Reverts with `StaleGuardian(signedOldGuardian, liveOldGuardian)` if the old guardian in the attestation doesn't match the current live guardian on-chain (preventing replay attacks).

The demo pre-provisions a replacement: every `deploy.js` run generates a fresh
candidate wallet (Hardhat-mnemonic account 9 locally, a random address live; pin
it with `DEMO_NEW_GUARDIAN_ADDRESS`), writes it to `deployments.json` as
`newGuardian`, and the register beat binds it to the demo `customerId`. The
**Guardian Replacement form** on `/recover` autofills that verified candidate —
it can never equal the live guardian, so the `SameGuardian` revert is impossible
to trip by accident, and a green ✓ confirms the candidate is verified before you
open the request.

Once a replacement is finalized, the **live** guardian changes — and a recovery
claim co-signed by the old key would revert with `BadGuardianAttestation`. To
keep the demo flowing past that point, the claim beat co-signs as the *current*
guardian: the backend holds a keyring (`GUARDIAN_PK`,
`DEMO_NEW_GUARDIAN_PK`, plus the mnemonic-derived demo wallets locally) and
picks whichever matches `guardianOf`. Locally the new guardian is mnemonic
account 9, so everything keeps working for free; on live deployments you must
pin the replacement with `DEMO_NEW_GUARDIAN_PK=…` (deriving the address from
the same key) before `npm run deploy`, otherwise the claim step explains the
mismatch instead of hanging on a raw revert.

### 2. Fallback Repayment & Failure Tolerance (`BridgeAdvanceVault.sol`)
If a vault becomes insolvent or is revoked from the Cleanverse whitelist, its token transfers or `vault.settle()` calls could revert, causing the entire recovery execution transaction to fail and stranding the borrower's funds.

We implemented try/catch safety tolerance in the settlement pipeline:
* **Fallback Receiver**: The vault registers a `fallbackReceiver` address during deployment.
* **Try/Catch Settlement**: During recovery execution, the `RebindExecutor` attempts to repay the vault. If the vault transfer or settlement reverts, the executor catches the error and redirects the note repayment to the `fallbackReceiver` instead.
* **Defensive Netting**: If both the vault and the fallback receiver transfers fail, the executor nets the vault repayment to `0` and sends 100% of the recovered funds directly to the user's new wallet, ensuring the recovery never blocks.

---

## Traps

| Trap | Detail |
|---|---|
| `min_tier` is **strictly greater than** | `min_tier: 30` rejects tier 30. Sandbox users are tier 50 |
| Decimals | 6, like USDC. `1000000` = 1 token |
| `customerId` | ≥12 chars, `A-Za-z0-9` only. **No hyphens** — a raw UUID fails |
| 403 from Cleanverse | Almost always AES, not auth. Base64-decode the key first; IV is 16 zero bytes |
| Frozen A-Pass | Returns outer `code: 0002` with `APassNotActive`, **not** `data.code: 3`. Both handled in `cleanverse.js` |
| `query_apass` | Never returns `customerId`. Equivalence must use `query_apass_list` |
| `currentKycHash` | Per-binding, not per-person. Never use it for equivalence |
| Faucet | Roughly once per day |
| Shared sandbox | Other teams' records appear under this `api-id`. Always use freshly generated addresses |
| OpenZeppelin | v5 uses `_update`. v4 tutorials showing `_beforeTokenTransfer` won't compile |
| Chain | Base has 22 A-Tokens; Monad has 1. Build on Base |

---

## Layout

```
contracts/     BindingRegistry, RebindableRWA, RecoveryQueue, RebindExecutor, IERC1404
               BridgeAdvanceVault + IAdvanceOracle/ParAdvanceOracle (lending
               against a committed claim), DemoStablecoin (demo only)
test/          133 tests. rebind.test.js covers every on-chain attack path and
               every ERC-1404 code; bridge-advance.test.js covers the lending
               invariants; backend.test.js and cleanverse-local.test.js run
               offline (stub fetch, no credentials)
scripts/       deploy, register-atoken, freeze-scope-test, compile-local, fund-local
backend/       cleanverse.js (API+AES), attestor.js (EIP-712), server.js
               cleanverse-local.js (offline stub), cleanverse-client.js (mode switch)
frontend/      Vite + React frontend application (dist/ holds compiled production build)
```

---

## Frontend React Application

The frontend is a Vite + React application configured with `react-router-dom` using hash routing for seamless static page loading under `frontend/dist`.

### Route Structure
* **`/` — Overview / Landing**: Static showcase of the protocol. Operates without any blockchain/backend dependency, so it displays instantly even when offline.
* **`/demo` — Live Demo**: A scripted walkthrough illustrating the full lifecycle: wallet registration -> blocked transfer -> compromise -> recovery claim -> issuer review -> optional bridge advance -> settlement. Includes a **"replace guardian"** shortcut that redirects to the Recover replacement form.
* **`/recover` — Recover**: The user recovery wizard. Supports both standard claims and the **Guardian Replacement Form** (accessible via *"I've lost access to my guardian too"*).
* **`/console` — Console**: The issuer dashboard for approving/committing/rejecting claims. Includes the **Vault Fallback Receiver admin panel**, **failed repayments logs**, and a list of active guardian requests with an **"object"** veto button.

### Local Development
To run the front-end dev server with hot-reload and proxy configuration pointing to port 3000:
```bash
npm run web
```

To build production static assets:
```bash
npm run web:build
```

