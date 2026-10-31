# Repository guidance

- Read `PROJECT_BLUEPRINT.md` and `docs/agent-state.md` before changing architecture or workflow behavior.
- Keep PostgreSQL as the authoritative state; Redis/BullMQ is a delivery mechanism.
- Keep production publishing disabled by default. Do not add real external-service calls or credentials to the milestone-one flow.
- Preserve package boundaries: `@gcs/core` stays framework and infrastructure independent.
- Use strict TypeScript, validate configuration and external input, keep operational endpoints read-only, and avoid logging secrets or sensitive payloads.
- Use the repository scripts for typecheck, lint, formatting checks, and tests. Do not modify another agent's slice without coordinating first.
