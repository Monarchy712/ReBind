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
BindingRegistry   personId <-> wallets, revocation. Written by the attestor.
RebindableRWA     ERC-20 with a compliance gate in _update() + recoveryTransfer()
RecoveryQueue     EIP-712 claims, cure window, issuer approval
RebindExecutor    the only address allowed to perform a recovery transfer
```

### The gate

OpenZeppelin v5 routes every balance change — `transfer`, `transferFrom`,
`_mint`, `_burn` — through one internal `_update()`. Overriding it once covers
every path with no bypass.

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
2. **Cure window** — the claim sits publicly; the incumbent wallet cancels
   instantly. This is the transfer agent's notice period, on-chain.
3. **Issuer approval** — a human countersigns.

Defeating all three needs the wallet *and* the identity *and* the issuer.

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
npm test              # 31 tests
```

**If `npx hardhat compile` fails with HH502** (can't reach
`binaries.soliditylang.org` — common on locked-down networks):

```bash
npm run compile:offline    # compiles via the solc npm package
npm run test:offline       # hardhat test --no-compile
```

### 4. Answer the open question first

```bash
npm run freeze-test
```

Determines whether `update_status` freezes a **wallet** or a whole
**customerId**. Rebind's step 5 revokes the old binding — that only works if
freeze is per-wallet.

- **PASS** → ship as designed.
- **FAIL** → in `backend/server.js` `/api/revoke`, drop the `cv.updateStatus`
  call and rely on `registry.revokeWallet()` alone. The contracts already
  support this. Say so on stage; a documented platform limitation reads as
  rigour.

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

Put three wallet addresses into the `W` object at the top of the script block in
`frontend/index.html` (Alice A, Alice B, attacker).

---

## The demo — six beats, under four minutes

| # | Beat | What the room sees |
|---|---|---|
| 1 | Register & mint | A-Pass for wallet A, 250 NOTE issued |
| 2 | **Attacker attempts theft** | **Reverts.** `RecipientNotEligible` |
| 3 | Alice claims from wallet B | Same `customerId` proven, claim opened |
| 4 | Cure window | Countdown; wallet A could cancel |
| 5 | Approve & execute | Note lands in B, old binding revoked |
| 6 | Audit pack | Real Cleanverse Travel Rule PDF |

**Beat 2 is the moment.** The audience watches compliance *block* an attacker,
then watches the same machinery *return the asset* to its rightful owner.

The line: *"Every other project here asks how to keep the wrong people out.
This one asks what we owe the people we already verified."*

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
contracts/     BindingRegistry, RebindableRWA, RecoveryQueue, RebindExecutor
test/          31 tests incl. every attack path
scripts/       deploy, register-atoken, freeze-scope-test, compile-local
backend/       cleanverse.js (API+AES), attestor.js (EIP-712), server.js
frontend/      single-file demo UI
```
# ReBind
