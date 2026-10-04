# 06: Bring preview to the mobile sync menu

**What to build:** Mobile users can open, inspect, and dismiss the same read-only previews through the existing sync menu, including large action lists and safety warnings, without desktop-only status-bar interactions.

**Blocked by:** 05 — Preview push and pull with accurate exclusions.

**Status:** ready-for-agent

- [ ] Existing mobile sync menu exposes Preview changes with all supported directions and the verified target.
- [ ] Plugin-owned presentation makes counts, reasons, exclusions, freshness, and safety warnings accessible by touch without relying on hover tooltips.
- [ ] Large action lists remain navigable without mounting every row at once; dismissal causes no sync.
- [ ] No shared Obsidian status-bar DOM workaround, floating overlay, or noisy automatic notices are introduced.
- [ ] Keep shared preview presentation compatible with later Apply controls, without implementing a separate mobile execution flow.
- [ ] Manually verify small and large previews, failures, dismissal, and foreground/resume behavior on mobile. Automated test additions are out of scope.
