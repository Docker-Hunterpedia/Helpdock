/**
 * `socket_connections` is one of the figures ARCHITECTURE §14 puts on
 * `/metrics`, and M0-10 owns the registry it lives on. The gateway writes to
 * that gauge through this interface rather than importing `prom-client`: the
 * only thing `realtime/` needs to know about metrics is how to set one number.
 */

export interface SocketConnectionsGauge {
  /** `prom-client`'s labelled `set`. The label is the Socket.IO namespace. */
  set(labels: { readonly namespace: string }, value: number): void;
}

/**
 * The gauge the unit tests use. It is not a spy on purpose: the value is
 * readable, so a test can assert the gateway keeps it honest across connects,
 * disconnects and revocations rather than asserting that a method was called.
 */
export class InMemorySocketConnectionsGauge implements SocketConnectionsGauge {
  readonly #values = new Map<string, number>();

  set({ namespace }: { readonly namespace: string }, value: number): void {
    this.#values.set(namespace, value);
  }

  get(namespace: string): number {
    return this.#values.get(namespace) ?? 0;
  }

  snapshot(): Readonly<Record<string, number>> {
    return Object.fromEntries(this.#values);
  }
}
