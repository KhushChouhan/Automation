export class FakeClock {
  constructor(private instant: Date) {}

  now(): Date {
    return new Date(this.instant);
  }

  set(instant: Date): void {
    this.instant = new Date(instant);
  }

  advance(milliseconds: number): void {
    this.instant = new Date(this.instant.getTime() + milliseconds);
  }
}

export function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

export function captureCalls<TArgs extends unknown[], TResult>(
  implementation: (...args: TArgs) => TResult,
) {
  const calls: TArgs[] = [];
  const fn = (...args: TArgs): TResult => {
    calls.push(args);
    return implementation(...args);
  };
  return { fn, calls };
}
