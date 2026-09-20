import NodeClam from 'clamscan';

/**
 * The optional antivirus pass (ARCHITECTURE §1 and §17: "ClamAV container +
 * clamscan", "optional attachment scanning").
 *
 * It is off unless `CLAMAV_HOST` is set, because clamd wants about 2 GB of
 * memory and most self-hosted installs will not run it. Off means
 * `scan_status = 'skipped'` on the row and a file that is still size-capped,
 * sniffed, never rendered inline and always served as a download — the scanner
 * is a layer, not the layer.
 *
 * A scanner that is configured and does not answer is a **failure**, never a
 * pass: the row is rejected with `scan_error`. An install that asked for
 * scanning and silently got none is the worst of the three outcomes.
 */

export type ScanVerdict = 'clean' | 'infected' | 'error';

export interface FileScanner {
  scan(path: string): Promise<ScanVerdict>;
}

export interface ClamavOptions {
  readonly host: string;
  readonly port: number;
  readonly timeoutMs: number;
}

/**
 * clamd over TCP. The connection is opened per scan rather than held, because
 * the worker may be idle for hours between uploads and a socket that has been
 * open that long is a socket that has been closed by something in between.
 */
export const createClamavScanner = ({ host, port, timeoutMs }: ClamavOptions): FileScanner => ({
  async scan(path: string): Promise<ScanVerdict> {
    try {
      const clam = await new NodeClam().init({
        removeInfected: false,
        // Nothing is quarantined on the worker's disk: an infected object is
        // deleted from the bucket and the temporary file is removed with every
        // other temporary file of the job.
        quarantineInfected: false,
        debugMode: false,
        clamdscan: {
          host,
          port,
          timeout: timeoutMs,
          // No falling back to a local `clamscan` binary. An install that
          // points at a daemon and quietly scanned with something else — or
          // with nothing — would report `clean` it has not earned.
          localFallback: false,
          // Not a unix socket, which is what makes `clamscan` stream the file
          // to the daemon over TCP instead of naming a path to it: the worker
          // and clamd are different containers and share no filesystem.
          socket: false,
        },
        preference: 'clamdscan',
      });

      const { isInfected } = await clam.isInfected(path);
      return isInfected === true ? 'infected' : 'clean';
    } catch {
      // Deliberately swallowed: a clamd error quotes the path it was given and
      // the socket it failed on, and the caller turns this into a reason key.
      return 'error';
    }
  },
});
