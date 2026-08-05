---
name: code-review
description: |
  Code review skill for analyzing code quality, detecting bugs, and ensuring best practices.
  Provides comprehensive code review with actionable feedback.

  Use proactively when user requests code review, quality check, or bug detection.

  Triggers: code review, review code, check code, analyze code, bug detection,
  코드 리뷰, 코드 검토, 버그 검사, コードレビュー, バグ検出, 代码审查, 代码检查,
  revisión de código, revisar código, detección de errores,
  revue de code, réviser le code, détection de bugs,
  Code-Review, Code überprüfen, Fehlererkennung,
  revisione del codice, rivedere codice, rilevamento bug

  Do NOT use for: design document creation, deployment tasks, or gap analysis (use phase-8-review).
argument-hint: "[file|directory|pr]"
user-invocable: true
agent: bkit:code-analyzer
allowed-tools:
  - Read
  - Glob
  - Grep
  - LSP
  - Task
  - Bash
imports:
  - ${PLUGIN_ROOT}/templates/pipeline/phase-8-review.template.md
next-skill: null
pdca-phase: check
task-template: "[Code-Review] {feature}"
# hooks: Managed by hooks/hooks.json (unified-stop.js) - GitHub #9354 workaround
---

# Code Review Skill

> Skill for code quality analysis and review

## Arguments

| Argument | Description | Example |
|----------|-------------|---------|
| `[file]` | Review specific file | `/code-review src/lib/auth.ts` |
| `[directory]` | Review entire directory | `/code-review src/features/` |
| `[pr]` | PR review (PR number) | `/code-review pr 123` |

## Review Categories

### 1. Code Quality
- Duplicate code detection
- Function/file complexity analysis
- Naming convention check
- Type safety verification

### 2. Bug Detection
- Potential bug pattern detection
- Null/undefined handling check
- Error handling inspection
- Boundary condition verification

### 3. Security
- XSS/CSRF vulnerability check
- SQL Injection pattern detection
- Sensitive information exposure check
- Authentication/authorization logic review

### 4. Performance & Reliability (Staff Engineer Audit)
- **N+1 query pattern detection**: Find hidden loops that blow up DB load.
- **Race conditions**: Identify state transitions that lack proper locks/sync.
- **Trust boundaries**: Check for unvalidated inputs across internal services.
- **Enum completeness**: Ensure all status/type constants are handled in switch/allowlists.
- **Stale reads**: Check for potential cache/DB synchronization issues.
- **Retry logic**: Audit backoff and failure modes for external calls.

## Language-Specific Review Checklists

### 🟦 TypeScript / JavaScript
- **Strict Mode**: Ensure `noImplicitAny` is respected; avoid `any` wherever possible.
- **Discriminated Unions**: Use for exhaustive state/type handling in `switch` blocks.
- **Module System**: Verify ESM (`import`/`export`) vs CJS (`require`) consistency.
- **Async/Await**: Check for unhandled promises or missing `await` in loops.

### 🐍 Python
- **PEP 8**: Naming conventions (snake_case), docstrings, and indentation.
- **Type Hints**: Ensure function signatures have appropriate type annotations.
- **Idiomatic Code**: Use list comprehensions, `with` statements, and `pathlib` appropriately.
- **Virtual Environments**: Check for `requirements.txt` or `pyproject.toml` updates.

### 🗄️ Database (SQL / NoSQL)
- **N+1 Queries**: Identify nested loops executing multiple database calls.
- **Indexing**: Check if filtered/joined columns have appropriate indexes.
- **Injection**: Ensure all inputs are parameterized or properly escaped.
- **Schema Integrity**: Verify foreign keys, constraints, and migration scripts.

## External Tool: ocr delegate (Alibaba OpenCodeReview)

Before writing the manual review, pull the deterministic rule checklist from `ocr delegate`
(Apache-2.0, `github.com/alibaba/open-code-review`) and use it as a first pass alongside the
categories above. `ocr delegate` makes **no LLM call and needs no API key** — it only prints a
rule checklist — so it is safe to run unconditionally as a zero-cost supplement.

```bash
# no install needed; fetched on demand via npx
npx -y -p @alibaba-group/open-code-review ocr delegate preview --from main --to HEAD
npx -y -p @alibaba-group/open-code-review ocr delegate rule <file1> <file2> ...
```

- `ocr delegate preview` lists which files changed in a diff range (or the workspace, with no
  flags) so you know what to run `rule` against without guessing.
- `ocr delegate rule` prints the rule set applicable to the given files (grouped by content:
  JS/TS, React, security, DB, etc.) — treat it as a checklist, not a finished review. Check each
  item against the target files yourself and report violations under the matching category
  (Code Quality / Security / etc.) below.
- If `npx` or network access is unavailable, skip this step and proceed with the categories
  above only — it's a supplement, not a hard dependency.

## Review Output Format

```
## Code Review Report

### Summary
- Files reviewed: N
- Issues found: N (Critical: N, Major: N, Minor: N)
- Score: N/100

### Critical Issues
1. [FILE:LINE] Issue description
   Suggestion: ...

### Major Issues
...

### Minor Issues
...

### Recommendations
- ...
```

## Agent Integration

This Skill calls the `code-analyzer` Agent for in-depth code analysis.

| Agent | Role |
|-------|------|
| code-analyzer | Code quality, security, performance analysis |

## Usage Examples

```bash
# Review specific file
/code-review src/lib/auth.ts

# Review entire directory
/code-review src/features/user/

# PR review
/code-review pr 42

# Review current changes
/code-review staged
```

## Confidence-Based Filtering

code-analyzer Agent uses confidence-based filtering:

| Confidence | Display | Description |
|------------|---------|-------------|
| High (90%+) | Always shown | Definite issues |
| Medium (70-89%) | Selectively shown | Possible issues |
| Low (<70%) | Hidden | Uncertain suggestions |

## PDCA Integration

- **Phase**: Check (Quality verification)
- **Trigger**: Auto-suggested after implementation
- **First pass**: `ocr delegate` rule checklist (see External Tool section above)
- **Output**: docs/03-analysis/code-review-{date}.md


## ⚡ Optimization Integration
When using this skill for critical tasks, please run it within a /native-trace context to capture performance data for self-improvement via /aioptimize.

