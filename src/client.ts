#!/usr/bin/env node

import net from "net";
import process from "process";
import yargs from "yargs";
import { hideBin } from "yargs/helpers";
import Socks5ClientSocket from "socks5-client/lib/Socket";

(async function () {
  const ed25519 = await import("@noble/ed25519");

  // parse args
  const args = await yargs(hideBin(process.argv))
    .option("upstream-port", {
      number: true,
      demandOption: true,
      description: "upstream port",
    })
    .option("downstream-port", {
      number: true,
      demandOption: true,
      description: "downstream port",
    })
    .option("upstream-ip", {
      string: true,
      demandOption: true,
      description: "upstream ip address",
    })
    .option("downstream-ip", {
      string: true,
      demandOption: true,
      description: "downstream ip address",
    })
    .option("proxy", {
      boolean: true,
      description: "connect with upstream through proxy",
    })
    .option("proxy-username", {
      string: true,
      description: "proxy username",
    })
    .option("proxy-password", {
      string: true,
      description: "proxy password",
    })
    .option("proxy-host", {
      string: true,
      description: "proxy host",
    })
    .option("proxy-port", {
      number: true,
      description: "proxy port",
    })
    .option("private-key", {
      string: true,
      demandOption: true,
      description: "ED25519 private key",
    })
    .parse();

  // create socket or proxied socket
  function createSocket(options?: net.SocketConstructorOpts): net.Socket {
    if (args.proxy) {
      return new Socks5ClientSocket({
        ...options,
        socksHost: args.proxyHost,
        socksPort: args.proxyPort,
        socksUsername: args.proxyUsername,
        socksPassword: args.proxyPassword,
      });
    }
    return new net.Socket(options);
  }

  // downstream sockets
  const downs = new Map<
    number,
    {
      socket: net.Socket;
      queue: (Buffer | "close")[];
      connected: boolean;
    }
  >();

  // upstream sockets
  const ups = new Map<number, { socket: net.Socket }>();

  // pending upstream socket
  let pending: net.Socket | undefined = undefined;

  // auto increment id
  let autoId = 0;
  const getId = () => {
    return ++autoId;
  };

  const writeToDownstream = (id: number, data?: Buffer | "close") => {
    const down = downs.get(id);
    if (!down) {
      // ignore
      return;
    }

    if (data) {
      down.queue.push(data);
    }

    while (down.connected && down.queue.length > 0) {
      const data = down.queue.shift()!;
      if (data === "close") {
        console.log("close from upstream", id);
        downs.delete(id);
        down.socket.destroy();
        break;
      } else {
        console.log("write", data.length, "bytes for", id);
        down.socket.write(data);
      }
    }
  };

  const writeToUpstream = (id: number, data: Buffer | "close") => {
    const up = ups.get(id);
    if (!up) {
      // ignore
      return;
    }

    if (data === "close") {
      console.log("close from downstream", id);
      ups.delete(id);
      up.socket.destroy();
    } else {
      console.log("reply", data.length, "bytes for", id);
      up.socket.write(data);
    }
  };

  const createPending = () => {
    if (pending !== undefined) {
      // safety check
      return;
    }

    let id: number | undefined = undefined;
    const _pending = createSocket();
    _pending.on("connect", () => {
      _pending.once("data", async (question) => {
        if (question.length !== 32) {
          console.log("invalid question:", question.toString("hex"));
          _pending.destroy();
          return;
        }

        // send signature to the remote
        _pending.write(await ed25519.signAsync(question, args.privateKey));

        _pending.on("data", (data) => {
          if (id === undefined) {
            id = getId();
            ups.set(id, { socket: _pending });

            // create a new pending socket now
            pending = undefined;
            createPending();
          }

          if (ups.has(id)) {
            if (downs.has(id)) {
              writeToDownstream(id, data);
            } else {
              createDown(id, data);
            }
          }
        });
      });
    });
    _pending.on("close", () => {
      if (id !== undefined) {
        console.log("upstream closed", id);
        writeToDownstream(id, "close");
      } else {
        // maybe something is wrong,
        // sleep a while and reconnect
        pending = undefined;
        if (!closing) {
          setTimeout(() => createPending(), 1000);
        }
      }
    });
    _pending.on("error", (err) => {
      if (id !== undefined) {
        console.log("upstream id:", id, "error:", err);
        writeToDownstream(id, "close");
      } else {
        console.log("pending upstream error:", err);
        // maybe something is wrong,
        // sleep a while and reconnect
        pending = undefined;
        if (!closing) {
          setTimeout(() => createPending(), 1000);
        }
      }
    });

    // connect to remote
    _pending.connect(args.upstreamPort, args.upstreamIp).setKeepAlive(true);

    // save pending socket object
    pending = _pending;
  };

  const createDown = (id: number, data: Buffer) => {
    const _down = new net.Socket()
      .connect(args.downstreamPort, args.downstreamIp)
      .setKeepAlive(true);
    const ctx = { socket: _down, queue: [data], connected: false };
    downs.set(id, ctx);
    _down.on("connect", () => {
      if (!downs.has(id)) {
        // ignore
        return;
      }
      ctx.connected = true;
      writeToDownstream(id);
      _down.on("data", (data) => {
        writeToUpstream(id, data);
      });
    });
    _down.on("close", () => {
      console.log("downstream closed", id);
      writeToUpstream(id, "close");
    });
    _down.on("error", (err) => {
      console.log("downstream id:", id, "error:", err);
      writeToUpstream(id, "close");
    });
  };

  // handle signal
  let closing = false;
  process.on("SIGINT", () => {
    if (!closing) {
      closing = true;
      console.log("client is closing...");

      // close all sockets
      if (pending) {
        pending.destroy();
      }
      for (const [, { socket }] of downs) {
        socket.destroy();
      }
      for (const [, { socket }] of ups) {
        socket.destroy();
      }

      console.log("client closed");
      process.exit(0);
    }
  });

  // start connecting to the server
  createPending();
})().catch((err) => {
  console.log("catch error:", err);
});
