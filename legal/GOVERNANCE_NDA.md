# Governance NDA — Big 5 Matrix (HDV Foundation)

_Embeddable stub. This text is intentionally short and self-contained so it can be embedded
verbatim in partner onboarding flows and integration agreements. It is not legal advice and
should be reviewed by counsel before production use._

## 1. Purpose

This Governance Non-Disclosure Agreement ("Governance NDA") governs the confidentiality and
governance obligations of any party integrating with, extending, or operating alongside the
Big 5 Matrix ("the System").

## 2. Binding Scope — Third-Party Integrations

**All third-party integrations are bound by this Governance NDA.** No integration may access the
System's transport surface (APEX), security layer (KNOLL), matrix topology, or user data except
under the terms of this Governance NDA. Acceptance of this NDA is a precondition of integration.

## 3. Confidential Information

"Confidential Information" includes, without limitation: routing internals, KNOLL rules and
audit material, matrix topology and parameter accounting, Reflected Hope container contents, and
any non-public credentials, keys, or tokens.

## 4. Obligations

- Use Confidential Information solely to operate the sanctioned integration.
- Do not disclose Confidential Information to any party not bound by this Governance NDA.
- Do not attempt to bypass APEX routing or KNOLL validation, or to de-isolate per-user data.
- Honor opt-in/opt-out consent state for all Reflected Hope data.

## 5. Governance Controls

Integrations submit to the System's governance controls, including the Manual Progression Gate:
structural expansion involving a third party requires human verification and approval before it
takes effect.

## 6. Tactical Intel Exception

Any deliberate manipulation of Reflected Hope data is permitted **only** for security
verification or audit purposes and **must be logged**. Integrations may not rely on, request, or
trigger such manipulation for any other purpose.

## 7. Term & Survival

Confidentiality obligations survive termination of the integration for as long as the
information remains non-public.

## 8. No License

Nothing in this Governance NDA grants any license to the System's intellectual property beyond
the limited access required to operate the sanctioned integration.
