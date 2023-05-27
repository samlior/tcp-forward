#!/usr/bin/env node

import net from "net";
import process from "process";
import yargs from "yargs";
import { hideBin } from "yargs/helpers";
import Socks5ClientSocket from "socks5-client";
import * as messages from "./messages";

(async function () {
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
      write: Buffer[];
      read: (Buffer | "close")[];
      connected: boolean;
    }
  >();

  // upstream socket instance
  let up: net.Socket | undefined;
  let connecting = false;
  setInterval(() => {
    if (up === undefined && !connecting) {
      // change connecting flag
      connecting = true;

      // create upstream
      const _up = createSocket().connect({
        host: args.upstreamIp,
        port: args.upstreamPort,
        keepAlive: true,
      });

      const handleConnect = () => {
        // revmove listeners
        _up.off("connect", handleConnect);
        _up.off("error", handleConnectError);
        // add listeners
        _up.on("data", (data) => {
          if (data.length < 4) {
            console.log("upstream data is less than 4 bytes, ignore");
            return;
          }
          const id = data.readInt32BE();
          data = data.subarray(4);
          const down = downs.get(id);
          if (down) {
            writeToDownstream(id, data);
          } else {
            console.log("incoming upstream connection", id);
            createDown(id, data);
          }
        });
        _up.on("close", () => {
          console.log("lose upstream connection");
          up = undefined;
        });
        _up.on("error", (err) => {
          console.log("upstream connection error:", err);
          _up.destroy(); // safety off
          up = undefined;
        });
        console.log("successfully connect with upstream server");
        // save upstream instance
        up = _up;

        // clear queue
        for (const [id, { read }] of downs) {
          if (read.length > 0) {
            writeToUpstream(id);
          }
        }

        // change connecting flag
        connecting = false;
      };
      const handleConnectError = (err: Error) => {
        console.log("(connecting)upstream connection error:", err);
        _up.destroy(); // safety off

        // change connecting flag
        connecting = false;
      };

      _up.once("connect", handleConnect);
      _up.once("error", handleConnectError);
    }
  }, 1000);

  const writeToDownstream = (id: number, data?: Buffer) => {
    const down = downs.get(id);
    if (!down) {
      // ignore
      return;
    }

    if (data) {
      down.write.push(data);
    }

    if (down.connected) {
      while (down.write.length > 0) {
        const data = down.write.shift()!;
        if (data.equals(messages.close)) {
          console.log("close from upstream", id);
          downs.delete(id);
          down.socket.destroy();
          break;
        } else {
          console.log("write", data.length, "bytes for", id);
          down.socket.write(data);
        }
      }
    }
  };

  const writeToUpstream = (id: number, data?: Buffer | "close") => {
    const down = downs.get(id);
    if (!down) {
      // ignore
      return;
    }

    // push to queue
    if (data) {
      down.read.push(data);
    }

    if (!up) {
      // ignore
      return;
    }

    while (down.read.length > 0) {
      const data = down.read.shift()!;
      const upsteamData = Buffer.concat([
        Buffer.alloc(4),
        data === "close" ? messages.close : data,
      ]);
      upsteamData.writeInt32BE(id);
      up.write(upsteamData);
      if (data === "close") {
        console.log("close from downstream", id);
      } else {
        console.log("reply", data.length, "bytes for", id);
      }
    }
  };

  const createDown = (id: number, data: Buffer) => {
    const _down = createSocket().connect({
      port: args.downstreamPort,
      host: args.downstreamIp,
      keepAlive: true,
    });
    const write: Buffer[] = [data];
    const read: (Buffer | "close")[] = [];
    const ctx = { socket: _down, write, read, connected: false };
    downs.set(id, ctx);
    _down.on("connect", () => {
      if (!downs.has(id)) {
        // ignore
        return;
      }
      ctx.connected = true;
      writeToDownstream(id);
      _down.on("data", (data) => {
        if (downs.has(id)) {
          writeToUpstream(id, data);
        }
      });
      _down.on("close", () => {
        if (downs.has(id)) {
          console.log("downstream closed", id);
          writeToUpstream(id, "close");
          downs.delete(id);
        }
      });
      _down.on("error", () => {
        if (downs.has(id)) {
          writeToUpstream(id, "close");
          downs.delete(id);
        }
      });
    });
  };

  // handle signal
  let closing = false;
  process.on("SIGINT", () => {
    if (!closing) {
      closing = true;
      console.log("client is closing...");

      // close all sockets
      if (up) {
        up.destroy();
      }
      for (const [, { socket }] of downs) {
        socket.destroy();
      }

      console.log("client closed");
      process.exit(0);
    }
  });
})().catch((err) => {
  console.log("catch error:", err);
});
