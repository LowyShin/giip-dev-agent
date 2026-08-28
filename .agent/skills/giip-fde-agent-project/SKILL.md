# Skill: giip-fde-agent-project

Use this skill to initialize and protect repository context for work performed in this project.

## Canonical context

- Repository: `LowyShin/giip-fde-agent`
- Default branch: `main`
- Repository access: connected GitHub integration/plugin
- Governing context: root `AGENTS.md` plus `.agent/rules/`, `.agent/roles/`, and `.agent/skills/`

## When to use

Use this skill before substantial analysis, implementation, review, documentation, role/rule/skill changes, workflow changes, or repository-backed planning for this project.

## Procedure

1. Resolve `LowyShin/giip-fde-agent` through the connected GitHub integration.
2. Read `AGENTS.md`.
3. Read `.agent/rules/00_project_repository_scope.md`.
4. Identify and read task-relevant roles, rules, and skills.
5. Inspect the actual target files before making assumptions about architecture or behavior.
6. Execute changes only in this repository unless the user explicitly names another target repository.
7. If another repository is inspected or modified as part of the task, keep this repository's agent context authoritative unless the user explicitly changes project context.
8. Verify material repository writes by re-reading the changed state when practical.

## Guardrails

- Never infer a repository from another conversation when the current project context is available.
- Never substitute `giipprj-hub`, `giipv3`, `giipfaw`, backup repositories, forks, or similarly named repositories for this project's canonical repository without explicit user direction.
- Do not treat remembered file structures as current truth; inspect GitHub first.
- If repository contents and prior assumptions differ, report the discrepancy and follow repository contents.

## Expected outcome

Every task executed under this project starts from the same canonical repository and the same governing role/rule/skill context, minimizing accidental cross-project edits and inconsistent agent behavior.
