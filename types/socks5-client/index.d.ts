declare module "socks5-client/lib/Socket" {
  import type { Socket, SocketConstructorOpts } from "net";

  interface Socks5ClientSocketOptions extends SocketConstructorOpts {
    socksHost?: string;
    socksPort?: number;
    socksUsername?: string;
    socksPassword?: string;
  }

  class Socks5ClientSocket extends Socket {
    constructor(options: Socks5ClientSocketOptions);
  }

  export = Socks5ClientSocket;
}
