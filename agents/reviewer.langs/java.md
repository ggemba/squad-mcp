# Reviewer — Java supplement

Idiomatic checklist for Java (21+ LTS). Apply alongside the Cross-Cutting checks in the core role. Skip items that don't apply to the diff.

**Modern features**

- Use **records** for immutable data carriers; combine with **compact constructors** for validation
- Use **sealed interfaces/classes** to model closed hierarchies; pair with `switch` for exhaustiveness
- **Pattern matching for `instanceof`** and **switch** — avoid casting after `instanceof`
- **Record patterns** for destructuring (`if (obj instanceof Point(int x, int y))`)
- **Text blocks** (`"""`) for multiline strings
- `var` for local variables when the type is obvious from RHS; not for fields/params

**Concurrency**

- Use **virtual threads** (`Thread.ofVirtual()`, `Executors.newVirtualThreadPerTaskExecutor()`) for blocking I/O — do not pool them
- Avoid `synchronized` on virtual threads; prefer `ReentrantLock` (avoids carrier pinning)
- Use `CompletableFuture` for async composition; never block on `.get()` in a virtual thread that holds locks
- `StructuredTaskScope` (preview/stable depending on JDK) for fan-out with cancellation

**Idioms**

- Streams for transformations, not for side effects (`forEach` should be the last resort)
- `Optional` only for return types; never for fields, parameters, or collection elements
- Immutable collections via `List.of`, `Map.of`, `Set.of` or `Collectors.toUnmodifiableList()`
- Builder pattern over telescoping constructors when records don't fit

**Errors**

- Checked exceptions only when caller can act on them; otherwise wrap in unchecked
- Custom exceptions per domain; avoid `RuntimeException` directly
- Don't swallow `InterruptedException`; restore the flag (`Thread.currentThread().interrupt()`) and rethrow

**Style**

- `final` on locals/params signals intent (project-policy dependent)
- Avoid mutable static state
- Package-private as default; `public` is a deliberate API decision
