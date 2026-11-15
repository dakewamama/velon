# Signing-time authority revalidation

The console checks retained scope checkpoints before and after wallet signing,
then posts the signed reviewed transaction to the native revalidation endpoint.
The endpoint verifies canonical transaction bytes and signatures before fetching
any fresh state. It independently reads the scope with finalized commitment and
a minimum slot bound to the provider's independently requested finalized tip
(which must be at least as new as the review), including program executable data,
parent/plan dependencies and runtime features. Only the clock may change. Changed
or unsupported observations are retained and invalidate the old journal checkpoint.
The exact action is recompiled under the fresh clock before submission is permitted.
RPC failure, changed state, invalid signatures and unsupported deployments block submission.

The new observation has its own retained identifier. It does not overwrite the
reviewed baseline or replace finality verification. The SDK still checks exact
wallet message bytes, cluster, blockhash lifetime and submission uncertainty.
Only independent finalized execution and post-state evidence can produce the
existing durable verification receipt.

This is not an atomic state lock. Native SPL Revoke targets the token account and
does not condition execution on a particular delegate address. A delegate or
program can change after the final read and before transaction execution. A
finalized pre-submission read also cannot see a conflicting unfinalized write.
This residual race remains a release review limitation; the pre-submission check
must not be advertised as proving no intervening authorization existed. Unknown
submission outcomes are still reconciled without automatic resubmission.

## What an account-level revoke promises

The SPL and Token-2022 review clears the token account's **current** delegate
approval. It names the reviewed delegate as the party approved when checked,
not as a condition encoded in the instruction. If an approval changes before
execution, the replacement may be cleared. Finalized and replayed receipts say
that no ordinary account delegate was present in the finalized state read; they
do not establish which approvals existed between observations. Existing receipt
bytes and verification rules are unchanged. Older cached receipts without an
operation label keep a generic evidence description rather than guessing scope.

Native execution tests replace a delegate after constructing the owner's Revoke,
then execute the unchanged bytes. Both SPL and Token-2022 clear the replacement;
Token-2022's mint-wide permanent delegate remains effective. Subscriptions
cancellation, delegation closure and rent return retain their separate wording.
