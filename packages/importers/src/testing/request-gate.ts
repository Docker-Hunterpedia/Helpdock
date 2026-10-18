export type VendorRequestGate = { readonly waiting: boolean; release(): void };
type PendingRequest = {
  path: string;
  used: boolean;
  entered(): void;
  promise: Promise<void>;
  release(): void;
};

/** Holds one matching request so a crash test can kill a worker during actual source I/O. */
export class VendorRequestGates {
  private pending: PendingRequest | undefined;

  hold(path: string): VendorRequestGate {
    if (this.pending) throw new Error('A vendor request is already held');
    let waiting = false;
    let release!: () => void;
    const promise = new Promise<void>((resolve) => {
      release = resolve;
    });
    const pending: PendingRequest = {
      path,
      used: false,
      entered: () => {
        waiting = true;
      },
      promise,
      release: () => {
        waiting = false;
        if (this.pending === pending) this.pending = undefined;
        release();
      },
    };
    this.pending = pending;
    return {
      get waiting() {
        return waiting;
      },
      release: pending.release,
    };
  }

  async wait(path: string): Promise<void> {
    const pending = this.pending;
    if (!pending || pending.used || pending.path !== path) return;
    pending.used = true;
    pending.entered();
    await pending.promise;
  }

  close(): void {
    this.pending?.release();
  }
}
