# Reviewer — Go supplement

Idiomatic checklist for Go. Apply alongside the Cross-Cutting checks in the core role. Skip items that don't apply to the diff.

**Idioms**

- Errors are values: return `(T, error)`; check `err != nil` immediately
- Wrap with context: `fmt.Errorf("operation X for id %s: %w", id, err)` — generic wraps add no value
- Use `errors.Is` / `errors.As` for sentinel/typed checks; **never** `==` against a wrapped error
- Define sentinel errors as `var ErrFoo = errors.New("foo")`; custom error types implement `Error() string`

**Context**

- `context.Context` is the **first parameter** of every function that does I/O, blocking work, or spawns goroutines
- Never store `Context` in a struct field; pass it explicitly
- Check `ctx.Err()` / `ctx.Done()` in long loops and before blocking operations
- Always pair `context.WithCancel`/`WithTimeout`/`WithDeadline` with `defer cancel()`

**Concurrency**

- Goroutines must have a clear lifecycle owner; document who cancels them
- Use channels for ownership transfer; use mutexes for protecting shared state — pick one per resource
- `sync.WaitGroup` or `errgroup.Group` for fan-out joins; `errgroup` for first-error semantics
- Avoid leaking goroutines: every `go` must have a path to exit on context cancellation

**Generics (1.18+)**

- Use generics when removing duplication of identical-shape code (e.g., `Map[K,V]`, `slices.Map`)
- Don't use generics where an interface or `any` is clearer; constraints are the new abstraction cost

**Style**

- `gofmt`/`goimports` clean (non-negotiable)
- Receiver names short and consistent across all methods of a type
- Exported identifiers documented; comment starts with the identifier name
- Prefer small interfaces defined at the consumer side
- `nil` slice vs empty slice — be intentional; document the contract
- Avoid named return values except for documentation in short funcs or for `defer` recovery

**Resource management**

- `defer Close()` immediately after acquiring; check the close error if it matters
- `io.Reader`/`io.Writer` over concrete types in signatures
