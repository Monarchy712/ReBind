/* ============================================================ Landing.jsx
   Dark hero band, then bone sections. No chain reads of its own — this route
   must render instantly and look finished even when the backend is down.
   ====================================================================== */

import { useNavigate } from "react-router-dom";
import { MaskHeading, Reveal } from "../components/Reveal.jsx";

const STEPS = [
  {
    tag:"01 · off-chain",
    title:"the evidence lives outside the chain",
    body:(
      <>
        a contract cannot call an HTTP API. but the fact that two wallets belong to one person
        exists only in Cleanverse&apos;s <code className="codelet">query_apass_list</code>. an
        attestor reads it and signs an EIP-712 attestation;{" "}
        <code className="codelet">RecoveryQueue</code> runs{" "}
        <code className="codelet">ecrecover</code> and trusts the signer — never whoever
        submitted the transaction.
      </>
    ),
  },
  {
    tag:"02 · enforced",
    title:"the token enforces its own rules",
    body:(
      <>
        transfers pass through ERC-1404:{" "}
        <code className="codelet">detectTransferRestriction</code> returns a numeric code,{" "}
        <code className="codelet">messageForTransferRestriction</code> the human reason. an
        unverified destination is refused by the asset itself, with no coordination from anyone
        off-chain.
      </>
    ),
  },
  {
    tag:"03 · reversible",
    title:"freeze first, review second",
    body:(
      <>
        opening a claim freezes the old wallet in the same transaction, so a stolen key cannot
        race the recovery it triggered. only then does the challenge window run, giving a
        reviewer time to reject an impersonation before anything moves.
      </>
    ),
  },
];

const FACTS = [
  ["evidence", "one customerId, two wallets. read from Cleanverse, signed EIP-712 off-chain."],
  ["gate", "ERC-1404 transfer restrictions, enforced by the token itself."],
  ["safety", "freeze on claim, then a challenge window a human can reject inside."],
];

export default function Landing(){
  const go = useNavigate();

  return (
    <div className="view">
      <section className="hero">
        <svg className="lines" viewBox="0 0 1000 700" preserveAspectRatio="xMidYMid slice" aria-hidden="true">
          <circle cx="500" cy="350" r="250" />
          <line x1="0" y1="250" x2="1000" y2="430" />
          <line x1="0" y1="470" x2="1000" y2="210" />
        </svg>

        <div className="wrap">
          <MaskHeading
            as="h1"
            lines={[{ text:"identity outlives" }, { text:"the key.", fade:true }]}
          />
          <Reveal as="p" className="lede" delay={420}>
            a permissioned asset can only move between wallets that passed kyc. when the
            holder&apos;s key is lost, the compliance gate that stops the thief strands the owner
            too. rebind moves it to another wallet the same verified person already controls — on
            evidence the issuer cannot fabricate.
          </Reveal>
          <Reveal className="cta" delay={520}>
            <button className="btn" onClick={() => go("/demo")}>run the demo</button>
            <button className="btn" onClick={() => go("/recover")}>start a recovery</button>
          </Reveal>
        </div>

        <div className="hero-meta">
          <span className="lbl br side">
            <span><span className="k">restricted</span>erc-1404 · a-pass</span>
          </span>
          <span className="lbl scrollcue">scroll</span>
          <span className="lbl br side right">
            <span><span className="k">evidence</span>eip-712 · ecrecover</span>
          </span>
        </div>
      </section>

      <section className="section">
        <div className="wrap">
          <Reveal className="section-head">
            <span className="kicker">stranded assets → recovered identity</span>
            <h2 className="display">
              a lost key is permanent.{" "}
              <span className="fade">an identity is not.</span>
            </h2>
          </Reveal>

          <Reveal as="dl" className="metrics" delay={100}>
            {FACTS.map(([k, v]) => (
              <div className="metric" key={k}>
                <dt className="lbl br">{k}</dt>
                <dd>{v}</dd>
              </div>
            ))}
          </Reveal>
        </div>
      </section>

      <section className="section" style={{ paddingTop:0 }}>
        <div className="wrap">
          <Reveal className="section-head">
            <span className="kicker">the mechanism</span>
            <h2 className="display">
              three decisions carry it.{" "}
              <span className="fade">each one limits what a compromised party can do.</span>
            </h2>
          </Reveal>

          <div className="steps3">
            {STEPS.map((s) => (
              <Reveal as="article" key={s.tag}>
                <div>
                  <span className="lbl br">{s.tag}</span>
                  <h3 className="display">{s.title}</h3>
                </div>
                <p>{s.body}</p>
              </Reveal>
            ))}
          </div>

          <Reveal as="blockquote" className="display">
            the issuer can approve a claim, and reject one. it can never <em>manufacture</em> one.
            <cite>the property everything else protects</cite>
          </Reveal>
        </div>
      </section>

      <section className="section" style={{ paddingTop:0 }}>
        <div className="wrap">
          <Reveal
            className="panel pad"
            style={{ display:"flex", gap:32, alignItems:"flex-end", flexWrap:"wrap" }}
          >
            <div style={{ flex:"1 1 340px" }}>
              <span className="kicker">see it happen</span>
              <h2 className="display" style={{ fontSize:"var(--step-3)", lineHeight:1.08, maxWidth:"18ch" }}>
                watch a key get stolen, and the asset come back anyway.
              </h2>
            </div>
            <button className="btn primary" onClick={() => go("/demo")}>enter the demo →</button>
          </Reveal>
        </div>
      </section>
    </div>
  );
}
