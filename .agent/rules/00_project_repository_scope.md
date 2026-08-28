# Project Repository Scope — giip-fde-agent

## Canonical repository

This project is anchored to the GitHub repository:

- Repository: `LowyShin/giip-fde-agent`
- Default branch: `main`
- Access method: use the connected GitHub integration/plugin when repository inspection or modification is required.

## Mandatory scope rule

1. Treat `LowyShin/giip-fde-agent` as the canonical source of truth for this project unless the user explicitly overrides the repository for a specific task.
2. Before code, architecture, rule, role, skill, workflow, or documentation work, resolve the repository and inspect the relevant files in this repository first.
3. Do not silently substitute similarly named GIIP repositories, backup repositories, forks, local assumptions, or repositories remembered from another project/session.
4. When a task references "this project", "the agent", "role", "rule", "skill", or repository-relative paths without naming another repository, resolve them against `LowyShin/giip-fde-agent`.
5. When another repository is needed as a dependency or implementation target, keep `LowyShin/giip-fde-agent` as the governing agent/rule/skill context unless the user explicitly changes the project context.
6. If repository evidence conflicts with memory, conversation assumptions, generated documentation, or external descriptions, repository contents win unless the user explicitly states otherwise.

## Repository verification

For repository-backed tasks:

1. Resolve `LowyShin/giip-fde-agent` through the connected GitHub integration.
2. Read `AGENTS.md` first.
3. Read applicable files under `.agent/rules/`, `.agent/roles/`, and `.agent/skills/` before making material changes.
4. Verify writes by re-reading the changed file or commit result when practical.

## Anti-confusion guardrail

Never perform work against a different repository merely because it appeared in another GIIP conversation, project, issue, or memory. Repository switching requires an explicit task-level instruction from the user.
