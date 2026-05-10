# Severity and Ownership Matrix

Shared reference for the squad. Each topic has a single primary owner. Other agents may mention a topic only to forward it to the owner.

## Ownership by Topic

| Topic                                            | Primary Owner         | Notes                           |
| ------------------------------------------------ | --------------------- | ------------------------------- |
| Business value and requirements                  | PO                    | Not technical correctness       |
| User experience (messages, flows, journey)       | PO                    |                                 |
| Plan viability and trade-off framing (pre-impl)  | TechLead-Planner      | Design-time judgment only       |
| Final merge verdict (post-impl)                  | TechLead-Consolidator | Consolidates all reports        |
| Design trade-offs                                | TechLead-Consolidator | Complexity vs. benefit          |
| CI/CD, pipelines, deploy, rollout                | TechLead-Consolidator | Feature flags, release strategy |
| Technical debt classification                    | TechLead-Consolidator |                                 |
| Module and domain boundaries                     | Senior-Architect      | Bounded contexts                |
| Coupling and dependency direction                | Senior-Architect      |                                 |
| DI registrations and lifetimes                   | Senior-Architect      |                                 |
| Architectural scalability                        | Senior-Architect      |                                 |
| Queries and database performance                 | Senior-DBA            | SQL and LINQ                    |
| Migrations and schema changes                    | Senior-DBA            |                                 |
| EF mappings and configuration                    | Senior-DBA            |                                 |
| Data cache (strategy and invalidation)           | Senior-DBA            |                                 |
| Database concurrency and locks                   | Senior-DBA            |                                 |
| Readability and code smells                      | Senior-Dev-Reviewer   |                                 |
| C#/.NET best practices (syntax level)            | Senior-Dev-Reviewer   |                                 |
| Naming conventions                               | Senior-Dev-Reviewer   |                                 |
| OWASP Top 10 vulnerabilities                     | Senior-Dev-Security   |                                 |
| Authentication and authorization                 | Senior-Dev-Security   |                                 |
| Sensitive data protection                        | Senior-Dev-Security   | PII, financial, credentials     |
| Technical correctness of implementation          | Senior-Developer      |                                 |
| Robustness and failure scenarios                 | Senior-Developer      |                                 |
| API contracts (DTOs, status codes)               | Senior-Developer      |                                 |
| External integrations (retry, timeout, CB)       | Senior-Developer      |                                 |
| Observability (logs, metrics, correlation IDs)   | Senior-Developer      |                                 |
| Application performance (CPU, memory, alloc)     | Senior-Developer      |                                 |
| Test quality and coverage                        | Senior-QA             |                                 |
| Test strategy (unit, integration, contract, e2e) | Senior-QA             |                                 |

## Severity Levels

Every finding carries a severity. Agents must use these labels consistently.

| Level      | Meaning                                                                                    | Merge Impact                 |
| ---------- | ------------------------------------------------------------------------------------------ | ---------------------------- |
| Blocker    | Cannot ship: correctness break, security hole, data loss, production outage likely         | Halts merge                  |
| Major      | Significant risk or violation with no reasonable justification                             | Halts merge unless justified |
| Minor      | Quality issue, local smell, limited impact                                                 | Does not block               |
| Suggestion | Improvement opportunity, nitpick, or stylistic preference                                  | Does not block               |

## Standard Section: Assumptions and Limitations

Every agent report must end with:

```
### Assumptions and Limitations
- What was assumed due to missing context
- What could not be validated from the diff alone
- Information that would need confirmation
```

## Consolidation Rules (TechLead-Consolidator)

1. Any Blocker from any agent — merge blocked.
2. Major without written justification — merge blocked.
3. Conflicting recommendations — TechLead-Consolidator arbitrates and justifies.
4. Agent that did not report — record as "Not evaluated" and assess risk of the gap.
5. After fixes, the consolidator may re-run affected agents on the delta (not the full diff).
