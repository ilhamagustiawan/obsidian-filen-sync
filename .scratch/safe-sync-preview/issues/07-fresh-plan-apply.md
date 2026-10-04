# 07: Apply a preview through fresh planning and renewed review

**What to build:** Users select Apply on a valid preview to run sync against freshly inspected state. If the reviewed target, actions, or safety effects changed, they review the updated plan before execution rather than authorizing stale work.

**Blocked by:** 05 — Preview push and pull with accurate exclusions.

**Status:** completed

- [x] Apply prepares the target and replans through normal coordination; it never sends stored preview actions directly to the executor.
- [x] Recheck target binding, direction, filters, local/remote state, action set, and safety effects. Changed target or proposed effects require renewed review; dismissing review executes nothing.
- [x] Preserve bulk and local-delete confirmations, per-operation revalidation, target-bound history, content/identity checks, bounded replanning, and uncertain-write reconciliation.
- [x] Serialize fresh-plan generation, active review, and execution. Automatic work waits during review and resumes afterward without losing queued path revisions.
- [x] Existing changes can still occur externally after review; preserve final revalidation and do not imply atomic vault sync or a cross-device lock.
- [x] Shared preview controls support desktop and mobile; mobile menu availability is delivered independently by ticket 06.
- [x] Expose preview/apply correlation and actual execution outcome for later history without persisting executable plans.
- [x] Manually change local/remote content, target, and filters after preview; verify renewed review, cancellations, unattended refusal, edits during execution, remote object replacement, and interrupted mutation recovery. Automated test additions are out of scope.
