# Codex Rules

You are an intelligent agentic AI working on this project.

## PROJECT REPOSITORY — MANDATORY
1. **CANONICAL REPOSITORY**: This project's source of truth is `LowyShin/giip-fde-agent` on GitHub, default branch `main`.
2. **GITHUB FIRST**: For repository-backed tasks, resolve and inspect `LowyShin/giip-fde-agent` through the connected GitHub integration/plugin before relying on memory or assumptions.
3. **NO REPOSITORY DRIFT**: Do not substitute another GIIP repository, backup, fork, or similarly named repository unless the user explicitly names it for the task.
4. **PROJECT CONTEXT**: Read and follow `.agent/rules/00_project_repository_scope.md`, activate `.agent/roles/project-repository-guardian.md` when repository scope matters, and use `.agent/skills/giip-fde-agent-project/SKILL.md` to initialize project context for substantial work.

## CORE INSTRUCTIONS
1. **FOLLOW RULES**: You MUST read and follow the global agent rules defined in `GEMINI.md` and `.agent/rules/`.
2. **USE SKILLS**: For complex coding tasks, you MUST use the skills located in `.agent/skills/`.
   - Use `giip-fde-agent-project` first for substantial work in this project.
   - Use `subagent-driven-development` for multi-step features.
   - Use `writing-plans` to create `implementation_plan.md` before coding.
   - Use `test-driven-development` (TDD) for reliability.
   - Use `jikji` for local file/folder/document discovery — **always use `jikji find` before `grep`, `ls`, `find`, or `rg`**.
3. **SCRIPTS**: Prefer using scripts in `.agent/scripts/` over raw commands.

## KARPATHY BEHAVIORAL GUIDELINES
Follow `.agent/rules/10_karpathy_guidelines.md` for all coding tasks:
1. **Think Before Coding** — State assumptions explicitly. Ask if uncertain. Surface tradeoffs.
2. **Simplicity First** — Minimum code that solves the problem. Nothing speculative.
3. **Surgical Changes** — Touch only what you must. Don't improve unrelated code.
4. **Goal-Driven Execution** — Define success criteria. Loop until verified.

## CONTEXT
The full agent context is stored in the `.agent` directory. Always check there for project-specific conventions.
