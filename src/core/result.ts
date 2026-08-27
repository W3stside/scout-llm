/**
 * Result<T, E> — explicit success/failure without exceptions.
 *
 * Why not just throw: nearly every operation in Scout fails as a matter of routine,
 * not exception. A site returns a bot-challenge page, a recipe's selector stops
 * matching after a redesign, the model emits JSON that misses a field, Telegram
 * rate-limits. A polling loop must keep running through all of it and report which
 * target degraded. Exceptions collapse that into one control-flow channel and make
 * "which of the six targets failed, and how" something you reconstruct from logs.
 *
 * Thrown errors are still caught at the I/O boundary (see `attempt`) and converted,
 * so third-party libraries that throw do not leak past their adapter.
 */

export type Ok<T> = { readonly ok: true; readonly value: T };
export type Err<E> = { readonly ok: false; readonly error: E };
export type Result<T, E> = Ok<T> | Err<E>;

export function ok<T>(value: T): Ok<T> {
    return { ok: true, value };
}

export function err<E>(error: E): Err<E> {
    return { ok: false, error };
}

export function isOk<T, E>(r: Result<T, E>): r is Ok<T> {
    return r.ok;
}

export function isErr<T, E>(r: Result<T, E>): r is Err<E> {
    return !r.ok;
}

export function map<T, U, E>(r: Result<T, E>, f: (value: T) => U): Result<U, E> {
    return r.ok ? ok(f(r.value)) : r;
}

export function flatMap<T, U, E>(
    r: Result<T, E>,
    f: (value: T) => Result<U, E>,
): Result<U, E> {
    return r.ok ? f(r.value) : r;
}

export function mapErr<T, E, F>(r: Result<T, E>, f: (error: E) => F): Result<T, F> {
    return r.ok ? r : err(f(r.error));
}

export function unwrapOr<T, E>(r: Result<T, E>, fallback: T): T {
    return r.ok ? r.value : fallback;
}

/**
 * Partition a batch into successes and failures. Used by the poll pipeline, where one
 * malformed listing among fifty must not discard the other forty-nine.
 */
export function partition<T, E>(
    results: readonly Result<T, E>[],
): { readonly values: T[]; readonly errors: E[] } {
    const values: T[] = [];
    const errors: E[] = [];
    for (const r of results) {
        if (r.ok) {
            values.push(r.value);
        } else {
            errors.push(r.error);
        }
    }
    return { values, errors };
}

/** Run a throwing function and capture the throw. The boundary adapter for libraries. */
export function attempt<T>(f: () => T): Result<T, unknown> {
    try {
        return ok(f());
    } catch (thrown: unknown) {
        return err(thrown);
    }
}

/** Async form of `attempt`. */
export async function attemptAsync<T>(f: () => Promise<T>): Promise<Result<T, unknown>> {
    try {
        return ok(await f());
    } catch (thrown: unknown) {
        return err(thrown);
    }
}

/**
 * Normalize an unknown throw into a message. `unknown` rather than `any` is the whole
 * point: TypeScript forces this narrowing instead of letting `e.message` through on a
 * value that might be a string, a DOMException, or undefined.
 */
export function messageOf(thrown: unknown): string {
    if (thrown instanceof Error) {
        return thrown.message;
    }
    if (typeof thrown === 'string') {
        return thrown;
    }
    if (thrown !== undefined && thrown !== null) {
        return String(thrown);
    }
    return 'unknown error';
}
