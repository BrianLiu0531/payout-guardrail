// Payout Guardrail policy. Amounts are in the token's smallest unit (USDC: 6 decimals).
// Evaluated by the API when a payout is proposed and again by the signer before it signs.
// A forbid always wins over a permit.

// ---- Who may propose ------------------------------------------------------------------

@id("requesters-propose")
permit (principal is User, action == Action::"propose_payout", resource is Payout)
when { principal.role == "requester" || principal.role == "admin" };

// ---- Limits (apply to proposing and signing) ------------------------------------------

@id("per-payout-limit")         // 50,000 USDC
forbid (principal, action, resource is Payout)
when { resource.amount > 50000000000 };

@id("rolling-24h-limit")        // 100,000 USDC across all payouts in 24 hours
forbid (principal, action, resource is Payout)
when { context.spentToday + resource.amount > 100000000000 };

@id("payee-must-be-active")     // only addresses added through an approved payee change
forbid (principal, action, resource is Payout)
unless { resource.payeeActive };

@id("payee-cooldown")           // demo: 2 minutes. Production: 86400 (24 hours)
forbid (principal, action, resource is Payout)
when { resource.payeeAgeSeconds < 120 };

// ---- Signing --------------------------------------------------------------------------

@id("approvals-small")          // up to 1,000 USDC: one approver other than the requester
permit (principal is Signer, action == Action::"sign_payout", resource is Payout)
when { context.approvals >= 1 && resource.amount <= 1000000000 };

@id("approvals-large")          // above 1,000 USDC: two
permit (principal is Signer, action == Action::"sign_payout", resource is Payout)
when { context.approvals >= 2 };

@id("circuit-breaker")          // nothing is signed while the breaker is open
forbid (principal, action == Action::"sign_payout", resource)
when { context.breakerOpen };

// ---- Governance: new payees, new approvers, breaker reset -----------------------------

@id("governance-two-approvers")
permit (principal is Signer, action == Action::"apply_governance", resource is Governance)
when { context.approvals >= 2 };
