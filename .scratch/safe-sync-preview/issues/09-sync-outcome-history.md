# 09: Record sync outcomes alongside previews

**What to build:** Users can investigate ordinary and preview-initiated syncs in the same bounded diagnostic history, distinguish proposed work from completed work, and trace an Apply run back to its preview.

**Blocked by:**
- 07 — Apply a preview through fresh planning and renewed review.
- 08 — Browse recent preview history.

**Status:** ready-for-agent

- [ ] Capture manual, initial, directional, and automatic sync plans using existing plan preparation rather than adding scans solely for diagnostics.
- [ ] Record trigger, direction, safety outcome, timings, actual full/narrow/cache provenance, and execution outcome within the established retention and target-binding rules.
- [ ] Link preview and Apply records without treating preview as execution evidence; renewed plans remain distinguishable from the original reviewed proposal.
- [ ] Distinguish success, failure, cancellation, and partial application. Completed operations reflect execution evidence, not planned counts or dispatch progress.
- [ ] Pre-plan failures and uncertain mutation outcomes are represented honestly, without fabricated plans, replay authorization, or false completion claims.
- [ ] History capture does not weaken guard behavior, overwrite baseline semantics, drop queued edits, or turn diagnostic storage failure into a reason to replay completed mutations.
- [ ] Manually inspect warm/narrow and full runs, cancellation, guard refusal, partial failure, replan, interrupted mutation, and preview-to-Apply correlation. Automated test additions are out of scope.
