/* =============================================================== Demo.jsx
   The scripted run: register, blocked theft, compromise, claim, review,
   optional bridge advance, settlement. Every button is a real transaction
   against the deployed contracts — nothing here is mocked.
   ====================================================================== */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, safe } from "../lib/api.js";
import { clock, humanWindow, num, short, shortTx, units } from "../lib/format.js";
import { flyValue, once, REDUCED } from "../lib/motion.js";
import {
  ActionButton,
  OfflineBanner,
  Rail,
  Ring,
} from "../components/Bits.jsx";
import { Reveal } from "../components/Reveal.jsx";
import { useToast } from "../components/Toasts.jsx";
import { useNavigate } from "react-router-dom";
import { BEAT_TITLES, useRebind } from "../store/RebindProvider.jsx";

function WalletCard({
  innerRef,
  who,
  role,
  address,
  balance,
  stable,
  stableSymbol = "dUSDC",
  state,
  note,
  extraClass = "",
}) {
  const chip =
    state === "frozen" ? (
      <span className="chip bad live">frozen</span>
    ) : state === "verified" ? (
      <span className="chip ok">verified</span>
    ) : (
      <span className="chip">unverified</span>
    );

  const balRef = useRef(null);
  const prev = useRef(undefined);
  useEffect(() => {
    if (prev.current !== undefined && prev.current !== balance)
      once(balRef, "bump", 680);
    prev.current = balance;
  }, [balance]);

  return (
    <div
      ref={innerRef}
      className={`wcard ${extraClass}${state === "frozen" ? " frozen" : ""}`}
    >
      <div className="top">
        <div className="who">
          {who}
          <span>{role}</span>
        </div>
        {chip}
      </div>
      <div
        className="addr"
        title="Click to copy"
        onClick={() => navigator.clipboard?.writeText(address || "")}
      >
        {address || "…"}
      </div>
      <div ref={balRef} className={`bal${balance > 0 ? "" : " zero"}`}>
        {num(balance)}
        <small>Note</small>
      </div>
      {/* The borrowed stablecoin, so it is visible which wallet is holding the
          advance. Rendered only when non-zero, to keep idle cards clean. */}
      {stable > 0 ? (
        <div className="borrowed">
          + {num(stable)} {stableSymbol} borrowed
        </div>
      ) : null}
      {note ? <div className="note">{note}</div> : null}
    </div>
  );
}

export default function Demo() {
  const S = useRebind();
  const toast = useToast();
  const navigate = useNavigate();

  const [lines, setLines] = useState([]);
  const [remaining, setRemaining] = useState(null);
  const [totalWindow, setTotalWindow] = useState(null);

  const cardA = useRef(null),
    cardB = useRef(null),
    cardX = useRef(null);
  const guardianRow = useRef(null),
    stageRef = useRef(null),
    logRef = useRef(null);
  const announced = useRef(false); // the "window elapsed" line fires once

  const log = useCallback((msg, cls = "dim") => {
    setLines((l) => [
      ...l,
      {
        id: `${Date.now()}-${l.length}`,
        msg,
        cls,
        at: new Date().toLocaleTimeString(),
      },
    ]);
  }, []);

  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [lines]);

  /* ------------------------------------------------------------- timer */
  /* Polls only while a claim is actually under review. Guarded by beat NAME:
     with a vault deployed "advance" sits at index 5, and an index check
     silently froze the ring on that beat. */
  const timed = S.beatId === "review" || S.beatId === "advance";
  useEffect(() => {
    if (!timed || S.claimId === null || S.rejected) return undefined;
    let alive = true;

    const tick = async () => {
      const r = await safe.claim(S.claimId);
      if (!alive || !r) return;
      setRemaining(r.timeRemaining);
      /* Seed the arc from the deployed window, not the first reading: a
         resumed session starts mid-window and would draw from empty. */
      setTotalWindow(
        (t) => t ?? (S.cureWindow || Math.max(r.timeRemaining, 1)),
      );

      if (r.timeRemaining <= 0 && !announced.current) {
        announced.current = true;
        log("challenge window elapsed — recovery is now executable.", "info");
        toast("The challenge window has elapsed.", {
          title: "Recovery unlocked",
          kind: "ok",
        });
      }
    };

    tick();
    const t = setInterval(tick, 1000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [timed, S.claimId, S.rejected, S.cureWindow, log, toast]);

  /* Keep the advance quote fresh while the bridge beat is on screen.
     It used to be read exactly once, immediately after the commit transaction
     resolved. Public RPCs load-balance across replicas, so that read can land
     on a node one block behind, where the claim is not yet committed and
     quote() answers zero — the button then offered "Draw 0.0 dUSDC" against a
     claim actually worth 200. The approve step already retries for this same
     reason. Re-reading until the advance is drawn heals the stale answer and
     costs one cheap call every few seconds. */
  const drawn = !!S.adv?.advance?.drawn;
  const refreshAdvRef = useRef(S.refreshAdvance);
  useEffect(() => { refreshAdvRef.current = S.refreshAdvance; });
  useEffect(() => {
    if (S.beatId !== "advance" || S.claimId === null || drawn) return undefined;
    let alive = true;
    const pull = () => { if (alive) refreshAdvRef.current(S.claimId); };
    pull();
    const t = setInterval(pull, 4000);
    return () => { alive = false; clearInterval(t); };
  }, [S.beatId, S.claimId, drawn]);

  /* The Execute button's enabled state is derived, not imperatively toggled.
     In the vanilla build a re-render rebuilt it disabled and a one-shot flag
     stopped it ever re-enabling; here it simply cannot drift from the data. */
  const windowElapsed = remaining !== null && remaining <= 0;

  /* How full the "unlocks when the window ends" buttons should be drawn.
     Same fraction the ring uses, so the two never disagree on screen. Before
     the first reading lands there is no fraction to show — "pending" sweeps
     instead of claiming a position in a countdown we have not read yet. */
  const windowProgress =
    remaining === null
      ? "pending"
      : totalWindow
        ? Math.min(1, Math.max(0, 1 - remaining / totalWindow))
        : windowElapsed
          ? 1
          : "pending";
  const unlocksIn = remaining !== null && remaining > 0 ? `unlocks in ${clock(remaining)}` : null;

  /* Re-sync with the chain when this route is entered, but only when the chain
     is demonstrably ahead of us.

     The beat lives in the store so navigating away does not restart Alice's
     story — but that also means a claim opened from the recovery wizard or
     settled from the console left this route a step behind, and the next click
     would try to open a second claim against a wallet that already has one.

     The guard matters: "key compromised" is pure narration with no on-chain
     trace, so an unconditional resume on every mount would knock the reader
     back a step for no reason. Only re-read when a claim exists that this
     route has not accounted for. */
  const resumeRef = useRef(S.resume);
  useEffect(() => {
    resumeRef.current = S.resume;
  });
  useEffect(() => {
    if (!S.booted || S.claimCount === 0) return;
    const behind = S.claimId === null || S.beat < S.beats.indexOf("review");
    if (behind) resumeRef.current();
    // Entering the route is the trigger; claimCount catches a claim that
    // appeared while we were on another route.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [S.booted, S.claimCount]);

  /* Beat changes get one cascade. */
  useEffect(() => {
    const el = stageRef.current;
    if (!el || REDUCED) return;
    el.classList.remove("enter");
    void el.offsetWidth;
    el.classList.add("enter");
  }, [S.beatId, S.rejected, S.adv?.advance?.drawn]);

  /* --------------------------------------------------------- balances */
  const bal = (k) => parseFloat(S.balances[S.wallets[k]]?.balance || 0);
  const stable = (k) => parseFloat(S.balances[S.wallets[k]]?.stable || 0);
  const wstate = (k) => {
    const s = S.balances[S.wallets[k]];
    if (!s) return "unknown";
    if (s.revoked) return "frozen";
    return s.active ? "verified" : "unverified";
  };

  /* ---------------------------------------------------------- actions */
  const run = useCallback(
    async (action) => {
      try {
        if (action === "register") {
          const guardianAddress = S.guardian.address;
          if (!guardianAddress) {
            log(
              "set DEMO_WALLET_G (or run local demo mode, which generates one) and reload.",
              "dim",
            );
            throw new Error(
              "No guardian configured. Registration must nominate a guardian address.",
            );
          }
          log("registering A-Pass for wallet A…", "info");
          await api.register({
            customerId: S.customerId,
            address: S.wallets.A,
            guardianAddress,
          });
          log(`guardian nominated · ${guardianAddress}`, "dim");
          once(guardianRow, "pulse", 1400);
          log(
            "the registry pins this guardian to the identity — a later binding cannot swap it.",
            "dim",
          );
          log(`wallet A verified · A-Pass under ${S.customerId}`, "ok");

          const r2 = await api.register({
            customerId: S.customerId,
            address: S.wallets.B,
            override: true,
            guardianAddress,
          });
          log(
            `wallet B bound to the SAME customerId${
              r2.cleanverse?.cvRecordId
                ? ` · record ${r2.cleanverse.cvRecordId}`
                : ""
            }`,
            "ok",
          );

          if (S.wallets.G2) {
            const r2g = await api.register({
              customerId: S.customerId,
              address: S.wallets.G2,
              override: true,
              guardianAddress,
            });
            log(
              `replacement guardian wallet G2 bound to the SAME customerId${
                r2g.cleanverse?.cvRecordId
                  ? ` · record ${r2g.cleanverse.cvRecordId}`
                  : ""
              }`,
              "ok",
            );
          }

          const r3 = await api.mint(S.wallets.A, 250);
          log(`minted 250 NOTE to wallet A · ${shortTx(r3.txHash)}`, "ok");
          once(cardA, "flash-good", 850);
          toast("Alice is registered and holds 250 NOTE.", {
            title: "Issued",
            kind: "ok",
          });
          S.goTo("steal");
        } else if (action === "steal") {
          log("attacker attempts transfer  A → attacker…", "info");
          const r = await api.check(S.wallets.A, S.wallets.X);
          log(
            `BLOCKED — on-chain code ${r.onchain.code}: ${r.onchain.reason}`,
            "err",
          );
          once(cardX, "shake", 540);
          once(cardX, "flash-bad", 860);
          if (r.cleanverse?.reason)
            log(`Cleanverse verify_apass: ${r.cleanverse.reason}`, "err");
          log("the compliance gate refused the transfer.", "ok");
          toast("The token refused the transfer on its own.", {
            title: "Theft blocked",
            kind: "ok",
          });
          S.goTo("compromise");
        } else if (action === "compromise") {
          log(
            "wallet A private key lost / compromised (scenario event — no on-chain change).",
            "warn",
          );
          log(
            "asset is safe (gate blocks theft) but stuck — Alice can't move it either. Nothing is frozen yet.",
            "dim",
          );
          S.goTo("claim");
        } else if (action === "claim" || action === "reopen") {
          /* After a guardian replacement the registry's guardian is the NEW
             guardian; a claim co-signed by the old key reverts with
             BadGuardianAttestation. Fail fast with the fix, not a raw revert. */
          const live = S.liveGuardian;
          const coSign = S.guardian.keys || [];
          if (
            live &&
            live !== "0x0000000000000000000000000000000000000000" &&
            !coSign.some((k) => k.toLowerCase() === live.toLowerCase())
          ) {
            throw new Error(
              `The live guardian is ${live}, but this backend can only co-sign as ${coSign.join(", ")}. ` +
              `A claim needs the CURRENT guardian's signature — after a replacement the old key is ` +
              `obsolete. Set DEMO_NEW_GUARDIAN_PK to the new guardian's key (local mode already knows ` +
              `it) and redeploy, or rotate the guardian back to a key the backend holds.`,
            );
          }
          log(
            action === "claim"
              ? "proving identity equivalence via query_apass_list…"
              : "opening a fresh, genuine recovery claim…",
            "info",
          );
          const r = await api.openClaim({
            customerId: S.customerId,
            oldWallet: S.wallets.A,
            newWallet: S.wallets.B,
          });
          S.setClaimId(r.claimId);
          S.setRejected(false);
          setRemaining(null);
          setTotalWindow(null);
          announced.current = false;
          if (action === "claim")
            log("equivalence confirmed · both wallets → one customerId", "ok");
          /* openClaim() reverts unless BOTH signatures verify, so reaching this
           line is itself the proof that the guardian co-signed. */
          log(
            `guardian co-signature verified against guardianOf${
              r.guardian ? ` · ${r.guardian}` : ""
            }`,
            "ok",
          );
          once(guardianRow, "pulse", 1400);
          log(
            "attestor and guardian sign different EIP-712 types — one key cannot produce both halves.",
            "dim",
          );
          log(
            `claim #${r.claimId} opened · wallet A FROZEN · ${shortTx(
              r.txHash,
            )}`,
            "ok",
          );
          once(cardA, "freezing", 1050);
          toast(`Claim #${r.claimId} is open and wallet A is frozen.`, {
            title: "Claim opened",
            kind: "info",
          });
          S.goTo("review");
        } else if (action === "commit") {
          log("issuer review passed — underwriting the claim…", "info");
          const r = await api.commit(S.claimId);
          log(
            `commit() executed · the issuer can no longer cancel this claim · ${shortTx(
              r.txHash,
            )}`,
            "ok",
          );
          log("the claim is now a receivable a lender can price.", "dim");
          await S.refreshAdvance(S.claimId);
          S.goTo("advance");
        } else if (action === "drawAdvance") {
          log(
            "wallet B signs an advance authorisation (no gas needed)…",
            "info",
          );
          const r = await api.drawAdvance(S.claimId);
          log(
            `advance drawn · ${r.received} ${
              S.advance.stableSymbol
            } to wallet B · ${shortTx(r.txHash)}`,
            "ok",
          );
          log(
            `${r.dueNote} NOTE will be taken from the recovery at settlement.`,
            "dim",
          );
          toast(
            `${r.received} ${S.advance.stableSymbol} advanced to wallet B.`,
            { title: "Advance drawn", kind: "ok" },
          );
          await S.refreshAdvance(S.claimId);
        } else if (action === "reject") {
          log(
            "issuer review: claim flagged as fraudulent impersonation…",
            "warn",
          );
          const r = await api.cancel(S.claimId);
          S.setRejected(true);
          log(
            `cancel() executed · wallet A UNFROZEN · ${shortTx(r.txHash)}`,
            "ok",
          );
          log("recovery denied. no funds moved.", "ok");
          toast("Claim rejected. Wallet A restored, nothing moved.", {
            title: "Rejected",
            kind: "warn",
          });
        } else if (action === "approve") {
          /* Approve and execute are one button but two transactions, so a
             transient RPC failure between them used to strand the claim:
             approved on-chain, unexecuted, and re-clicking tried to approve a
             second time. Read current state first and sign only what is still
             outstanding — that makes this button safe to retry, which on a
             public endpoint it will need to be. */
          const pre = await safe.claim(S.claimId);
          if (pre?.claim?.issuerApproved) {
            log(
              "claim is already approved on-chain — continuing to execution.",
              "dim",
            );
          } else {
            log("issuer countersigns the claim…", "info");
            await api.approve(S.claimId);
            log("issuer approval recorded.", "ok");
          }

          /* Public RPCs lag on read-after-write: the approve tx is mined but a
           follow-up read may hit a node one block behind. Wait until the chain
           reports the claim executable before firing the executor. */
          log("waiting for approval to propagate on-chain…", "dim");
          let ready = false;
          for (let i = 0; i < 10; i++) {
            const st = await safe.claim(S.claimId);
            if (st?.executable) {
              ready = true;
              break;
            }
            await new Promise((res) => setTimeout(res, 1500));
          }
          if (!ready)
            log("still propagating — attempting execution anyway…", "warn");

          log("executor moving balance  A → B…", "info");
          const r = await api.execute(S.claimId);
          S.setRecovered(true);
          S.setLastSplit(r.split || null);

          flyValue(cardA, cardB, `${units(r.newBalance)} NOTE`);
          setTimeout(() => once(cardB, "flash-good", 850), 950);

          if (r.split)
            log(
              `advance repaid from the recovery · ${r.split.toVault} NOTE to the vault`,
              "ok",
            );
          log(
            `RECOVERED · A: ${units(r.oldBalance)} NOTE · B: ${units(
              r.newBalance,
            )} NOTE · ${shortTx(r.txHash)}`,
            "ok",
          );
          toast("The asset now lives in wallet B.", {
            title: "Recovered",
            kind: "ok",
            ms: 6000,
          });
          S.goTo("done");
        } else if (action === "reset") {
          log("issuing a fresh demo session…", "info");
          const cfg = await S.resetDemo();
          if (cfg.toppedUp)
            log(`vault liquidity topped up · ${cfg.toppedUp} dUSDC`, "dim");
          log(
            "the contracts are untouched — this is a new identity on wallets that have never been bound.",
            "dim",
          );
          log(`wallet A · ${short(cfg.wallets.A)}`, "ok");
          log(`wallet B · ${short(cfg.wallets.B)}`, "ok");
          toast("Fresh wallets, same contracts. Start from step one.", {
            title: "Demo reset",
            kind: "ok",
          });
          return; // resetDemo already refreshed state against the new session
        }
      } catch (e) {
        log("ERROR " + e.message, "err");
        toast(e.message, { title: "Action failed", kind: "err", ms: 7000 });
      }
      await S.refreshState();
    },
    [S, log, toast],
  );

  /* ------------------------------------------------------------ stage */
  const stage = useMemo(() => {
    const id = S.beatId;

    if (id === "register")
      return (
        <>
          <h2>Register Alice, then issue the asset</h2>
          <p className="lead">
            Wallet A receives an A-Pass under Alice&apos;s Cleanverse customerId
            and is issued 250 units of a compliance-restricted note. Wallet B is
            registered to the <strong>same</strong> customerId — that shared
            identity is what makes recovery possible later. Registration also
            nominates a <strong>guardian</strong>, who must co-sign any future
            claim.
          </p>
          <div>
            <ActionButton
              className="btn primary"
              onAction={() => run("register")}
            >
              Register and mint 250 NOTE
            </ActionButton>
          </div>
        </>
      );

    if (id === "steal")
      return (
        <>
          <h2>An attacker tries to move the asset</h2>
          <p className="lead">
            Someone attempts to transfer the note from wallet A to an unverified
            wallet. The token&apos;s own compliance gate checks the
            destination&apos;s A-Pass and refuses. The asset is protected before
            recovery enters the picture at all.
          </p>
          <div>
            <ActionButton className="btn danger" onAction={() => run("steal")}>
              Attempt transfer to attacker
            </ActionButton>
          </div>
        </>
      );

    if (id === "compromise")
      return (
        <>
          <h2>Alice&apos;s key is lost</h2>
          <p className="lead">
            The private key for wallet A is gone — lost, phished, or leaked.
            Alice still controls her <strong>identity</strong> at Cleanverse and
            a second verified wallet, and that is all Rebind needs.{" "}
            <strong>Nothing is frozen yet:</strong> the asset locks in the next
            step, the instant a claim opens.
          </p>
          <div>
            <ActionButton className="btn" onAction={() => run("compromise")}>
              Mark the key compromised
            </ActionButton>
          </div>
        </>
      );

    if (id === "claim")
      return (
        <>
          <h2>Alice opens a recovery claim from wallet B</h2>
          <p className="lead">
            The attestor asks Cleanverse whether A and B share one customerId.
            They do, so it signs an EIP-712 attestation — but that alone opens
            nothing. The nominated <strong>guardian</strong> must co-sign the
            same claim under a separate EIP-712 type. The queue verifies both
            signatures or reverts. The moment the claim opens,{" "}
            <strong>wallet A freezes</strong>.
          </p>
          {S.liveGuardian &&
          S.liveGuardian !== "0x0000000000000000000000000000000000000000" &&
          !(S.guardian.keys || []).some(
            (k) => k.toLowerCase() === S.liveGuardian.toLowerCase(),
          ) ? (
            <div className="hint">
              The live guardian ({" "}<code className="codelet">{short(S.liveGuardian)}</code>) is not a
              key this backend can co-sign as. Recovery needs the CURRENT
              guardian&apos;s signature — set{" "}
              <code className="codelet">DEMO_NEW_GUARDIAN_PK</code> and redeploy,
              or rotate the guardian back to a key the backend holds.
            </div>
          ) : null}
          <div>
            <ActionButton className="btn primary" onAction={() => run("claim")}>
              Prove identity and open a claim
            </ActionButton>
          </div>
        </>
      );

    if (id === "review")
      return (
        <>
          <h2>Issuer review</h2>
          <p className="lead">
            Wallet A is frozen and the claim is now scrutinised. The issuer can{" "}
            <strong>reject</strong> a claim or <strong>approve</strong> one, but
            can never <strong>manufacture</strong> one, because the identity
            evidence comes from Cleanverse.
          </p>
          <Ring remaining={remaining} total={totalWindow} />
          <p className="hint">
            Window is {humanWindow(S.cureWindow)} as deployed. In production
            this would be 24 hours or more, so a human reviewer has time to
            catch a fraudulent claim before it becomes executable.
          </p>
          <div className="branch">
            <div className={`lane bad${S.rejected ? " dim" : ""}`}>
              <h4>Fraudulent claim</h4>
              <p>
                {S.rejected
                  ? "Rejected. The issuer flagged this as impersonation. Wallet A has been unfrozen and nothing moved."
                  : "Suppose an impersonator opened this claim to hijack Alice's wallet. The issuer rejects it, and cancel() restores wallet A."}
              </p>
              {S.rejected ? null : (
                <ActionButton
                  className="btn danger"
                  onAction={() => run("reject")}
                >
                  Reject as fraud
                </ActionButton>
              )}
            </div>
            <div className="lane good">
              <h4>Genuine recovery</h4>
              <p>
                {S.rejected
                  ? "Want the other path? Open a fresh, genuine claim — B still shares Alice's identity, and A is active again."
                  : S.advance.enabled
                  ? "It really is Alice. The issuer underwrites the claim, which is what makes it something a lender can safely advance against."
                  : "It really is Alice. Once the challenge window elapses, the issuer approves and the executor moves the asset from A to B."}
              </p>
              {S.rejected ? (
                <ActionButton className="btn" onAction={() => run("reopen")}>
                  Open a genuine claim
                </ActionButton>
              ) : S.advance.enabled ? (
                <>
                  <ActionButton
                    className="btn primary"
                    onAction={() => run("commit")}
                  >
                    Underwrite: approve and waive cancellation
                  </ActionButton>
                  <div className="hint">
                    Irrevocable. After this the claim will settle, and even the
                    issuer cannot stop it.
                  </div>
                </>
              ) : (
                <>
                  <ActionButton
                    className="btn primary"
                    progress={windowElapsed ? undefined : windowProgress}
                    waitLabel={unlocksIn}
                    onAction={() => run("approve")}
                  >
                    Approve and recover A → B
                  </ActionButton>
                  <div className={`hint${windowElapsed ? " good" : ""}`}>
                    {windowElapsed
                      ? "Window elapsed — the issuer may now approve and recover."
                      : "Nothing can move until the challenge window ends. The button fills as it runs down."}
                  </div>
                </>
              )}
            </div>
          </div>
        </>
      );

    if (id === "advance") {
      const q = S.adv?.quote,
        drawn = S.adv?.advance?.drawn;
      const ltv = (S.advance.ltvBps || 0) / 100,
        fee = (S.advance.feeBps || 0) / 100;
      const sym = S.advance.stableSymbol || "";
      return (
        <>
          <h2>
            {drawn
              ? "Advance drawn — the wait costs her nothing"
              : "Alice needs her money before the window ends"}
          </h2>
          <p className="lead">
            {drawn
              ? `Alice holds ${
                  q?.principalStable ?? "—"
                } ${sym} now, against an asset she still cannot touch. When the claim settles, the vault takes ${
                  S.adv?.advance?.dueNote ?? "—"
                } NOTE straight out of the recovery and she keeps the rest.`
              : "The freeze protects the asset and strands the owner equally. She is not poor, she is illiquid against a receivable that is about to settle. Because the issuer has now committed, that receivable is something a lender can price."}
          </p>
          <Ring remaining={remaining} total={totalWindow} />
          <div className="branch">
            <div className="lane good">
              <h4>{drawn ? "Outstanding advance" : "Available now"}</h4>
              <p>
                Claim value <strong>{S.adv?.claimNote ?? "—"} NOTE</strong> ·
                advance at {ltv}% LTV{" "}
                <strong>
                  {q?.principalStable ?? "—"} {sym}
                </strong>{" "}
                · repaid at settlement{" "}
                <strong>
                  {(drawn ? S.adv?.advance?.dueNote : q?.dueNote) ?? "—"} NOTE
                </strong>{" "}
                ({fee}% fee). The {100 - ltv}% gap is the vault&apos;s safety
                margin.
              </p>
              {drawn ? (
                <div className="hint">
                  Drawn. Repayment is intercepted during execution, not
                  requested afterwards.
                </div>
              ) : (
                <>
                  {/* Two reasons this button may not be offerable. A zero
                      quote means the vault's view has not caught up yet, and
                      clicking would send a transaction that can only revert.
                      No borrower key means the backend cannot sign as wallet B
                      at all. Say which, rather than failing on click. */}
                  <ActionButton
                    className="btn primary"
                    disabled={!S.advance.canDraw}
                    /* The quote is polled, not awaited, so there is no
                       fraction to draw — sweep until it reads non-zero. */
                    progress={
                      S.advance.canDraw && !(Number(q?.principalStable) > 0)
                        ? "pending"
                        : undefined
                    }
                    waitLabel="reading the vault quote…"
                    onAction={() => run("drawAdvance")}
                  >
                    {S.advance.canDraw
                      ? `Draw ${q?.principalStable ?? ""} ${sym}`
                      : "Advance unavailable"}
                  </ActionButton>
                  <div className="hint">
                    {S.advance.canDraw ? (
                      "Signed by wallet B and relayed — the borrower never needs gas."
                    ) : (
                      <>
                        Only wallet B can authorise an advance against its own
                        claim, and this backend does not hold its key. Set{" "}
                        <code className="codelet">DEMO_BORROWER_PK</code>, or run
                        the local demo. The recovery itself is unaffected.
                      </>
                    )}
                  </div>
                </>
              )}
            </div>
            <div className="lane bad">
              <h4>Settle the recovery</h4>
              <p>
                Once the window elapses the executor moves the balance,
                splitting it between the vault and wallet B in a single
                transaction.
              </p>
              <ActionButton
                className="btn primary"
                progress={windowElapsed ? undefined : windowProgress}
                waitLabel={unlocksIn}
                onAction={() => run("approve")}
              >
                Recover A → B
              </ActionButton>
              <div className={`hint${windowElapsed ? " good" : ""}`}>
                {windowElapsed
                  ? "Window elapsed — the issuer may now approve and recover."
                  : "Nothing can move until the challenge window ends. The button fills as it runs down."}
              </div>
            </div>
          </div>
        </>
      );
    }

    // done
    const split = S.lastSplit;
    return (
      <>
        <h2>
          {S.recovered ? "Recovered" : "Claim rejected — the asset is safe"}
        </h2>
        <p className="lead">
          {S.recovered
            ? "The challenge window elapsed, the issuer approved, and the executor moved the balance out of the frozen wallet A into wallet B. Same owner, new key — and the issuer could only approve what Cleanverse's records already backed."
            : "The claim was rejected during review and wallet A was restored. Nothing moved."}
        </p>
        {S.recovered && split ? (
          <div className="stats" style={{ marginBottom: 20 }}>
            <div className="stat">
              <div className="k">Recovered</div>
              <div className="v">{split.total}</div>
            </div>
            <div className="stat">
              <div className="k">To the vault</div>
              <div className="v">{split.toVault}</div>
            </div>
            <div className="stat">
              <div className="k">To wallet B</div>
              <div className="v">{split.toWallet}</div>
            </div>
          </div>
        ) : null}
        <p className="hint">
          Reloading resumes this finished run rather than restarting it:
          bindings are deliberately immutable, so wallet A can never be
          re-registered. Running it again therefore does not undo this one — it
          issues a new identity on three wallets that have never been bound.
          The contracts stay exactly as deployed.
        </p>
        {S.canReset ? (
          <div className="row" style={{ marginTop: 22 }}>
            <ActionButton
              className="btn primary"
              progress={S.resetting ? "pending" : undefined}
              waitLabel="issuing a fresh session…"
              onAction={() => run("reset")}
            >
              Run the demo again
            </ActionButton>
          </div>
        ) : (
          <p className="hint">
            This backend has no <code className="codelet">DEMO_MNEMONIC</code>{" "}
            set, so it cannot issue a fresh session. A new run needs a redeploy
            — <code className="codelet">npm run deploy:local</code>, then
            restart the server.
          </p>
        )}
      </>
    );
  }, [S, run, remaining, totalWindow, windowElapsed]);

  return (
    <div className="view page">
      <div className="wrap">
        <Reveal className="section-head">
          <span className="kicker">01 · live demo</span>
          <h2 className="display">
            a key is stolen.{" "}
            <span className="fade">the asset comes back anyway.</span>
          </h2>
          <p className="section-sub">
            running against a live chain. alice holds a restricted note, an
            attacker is refused, her key is lost, and she recovers into a second
            wallet she already had verified.
          </p>
        </Reveal>

        <OfflineBanner
          online={S.online}
          detail={S.connDetail}
          fallback="Nothing on this page will work until the backend is running."
        />

        <Reveal className="ledger" delay={100}>
          <WalletCard
            innerRef={cardA}
            who="Alice"
            role="wallet A · original"
            address={S.wallets.A}
            balance={bal("A")}
            stable={stable("A")}
            stableSymbol={S.advance.stableSymbol}
            state={wstate("A")}
            note={
              S.atOrPast("compromise") && !S.recovered
                ? "Key exposed — an attacker may hold this private key."
                : null
            }
          />
          <WalletCard
            innerRef={cardB}
            who="Alice"
            role="wallet B · recovery destination"
            address={S.wallets.B}
            balance={bal("B")}
            stable={stable("B")}
            stableSymbol={S.advance.stableSymbol}
            state={wstate("B")}
            extraClass={bal("B") > 0 ? "won" : ""}
            note="Same customerId as wallet A. That shared identity is the whole mechanism."
          />
          <WalletCard
            innerRef={cardX}
            who="Attacker"
            role="unknown party"
            address={S.wallets.X}
            balance={bal("X")}
            stable={stable("X")}
            stableSymbol={S.advance.stableSymbol}
            state={wstate("X")}
            extraClass="foe"
            note="No A-Pass. The token refuses it as a destination."
          />
        </Reveal>

        {S.guardian.address ? (
          <Reveal className="guardian" delay={150} innerRef={guardianRow}>
            <span className="lbl br">guardian</span>
            <span className="val">{S.guardian.address}</span>
            <span className={`chip ${S.guardian.canCoSign ? "ok" : "warn"}`}>
              {S.guardian.canCoSign ? "can co-sign" : "signature required"}
            </span>
            <button
              className="btn sm"
              style={{
                marginLeft: 14,
                fontSize: 11,
                padding: "2px 8px",
                height: "auto",
              }}
              disabled={S.beat === 0}
              onClick={() => {
                log(
                  "redirecting to the guardian replacement wizard...",
                  "info",
                );
                S.setRecoverSubMode("guardian");
                navigate("/recover");
              }}
            >
              replace guardian
            </button>
            <span className="why">
              Nominated at registration and pinned to the identity. Must co-sign
              any recovery claim under its own EIP-712 type, so a compromised
              attestor key is not enough on its own.
            </span>
          </Reveal>
        ) : null}

        {/* Sits with the guardian row rather than floating under the rail:
            both are context about this run rather than part of the story, and
            the reset is reachable at any beat — a run that reverts halfway
            used to need a redeploy, which is a bad thing to discover while
            presenting. */}
        {S.canReset ? (
          <Reveal className="guardian runrow" delay={170}>
            <span className="lbl br">run</span>
            <span className="val">{S.customerId || "—"}</span>
            <button
              className="btn sm"
              disabled={S.beat === 0 || S.resetting}
              onClick={() => run("reset")}
            >
              {S.resetting ? "starting over…" : "start over"}
            </button>
            <span className="why">
              Bindings are permanent, so this does not rewind the run — it
              issues a new identity on wallets that have never been bound. The
              contracts stay deployed.
            </span>
          </Reveal>
        ) : null}

        <Reveal delay={190}>
          <Rail beats={S.beats} beat={S.beat} titles={BEAT_TITLES} />
        </Reveal>

        <Reveal className="panel pad stage" delay={230} innerRef={stageRef}>
          {stage}
        </Reveal>

        <Reveal className="panel" delay={280} style={{ marginTop: 22 }}>
          <div className="panel-head">
            <span className="lbl br">trace</span>
            {S.claimId !== null ? (
              <span className="chip info">claim #{S.claimId}</span>
            ) : null}
            <span style={{ marginLeft: "auto" }}>
              <button className="btn sm" onClick={() => setLines([])}>
                clear
              </button>
            </span>
          </div>
          <div className="log" ref={logRef} role="log" aria-live="polite">
            {lines.map((l) => (
              <div key={l.id} className={l.cls}>
                <time>{l.at}</time>
                {l.msg}
              </div>
            ))}
          </div>
        </Reveal>
      </div>
    </div>
  );
}
