import net from 'node:net';

/**
 * A TCP forwarder the conformance suite puts between a driver and a real
 * server. `kill()` is what a dead server (or a dropped VPN) looks like from
 * the driver's side: every socket is torn down at once and nothing listens
 * any more. `restart()` brings the endpoint back on the same port, so the
 * same driver can reconnect, which is the other half of the scenario.
 *
 * It is a stand-in for `kill -9` of the database process: the suite cannot
 * stop the CI service containers, and killing the shared local server would
 * take every other test with it.
 */
export class FlakyProxy {
  private server: net.Server | null = null;
  private readonly sockets = new Set<net.Socket>();
  private _port = 0;

  constructor(
    private readonly targetHost: string,
    private readonly targetPort: number,
  ) {}

  get port(): number {
    return this._port;
  }

  /** Listen on a free port the first time, on the same port afterwards. */
  async start(): Promise<void> {
    const server = net.createServer((client) => {
      const upstream = net.connect(this.targetPort, this.targetHost);
      for (const s of [client, upstream]) {
        this.sockets.add(s);
        s.on('close', () => this.sockets.delete(s));
        s.on('error', () => s.destroy());
      }
      client.pipe(upstream);
      upstream.pipe(client);
      client.on('close', () => upstream.destroy());
      upstream.on('close', () => client.destroy());
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(this._port, '127.0.0.1', () => resolve());
    });
    this._port = (server.address() as net.AddressInfo).port;
    this.server = server;
  }

  /** Drop every connection and stop listening. */
  async kill(): Promise<void> {
    const server = this.server;
    this.server = null;
    for (const s of this.sockets) s.destroy();
    this.sockets.clear();
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  async restart(): Promise<void> {
    if (!this.server) await this.start();
  }

  async stop(): Promise<void> {
    await this.kill();
  }
}
