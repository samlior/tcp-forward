#!/usr/bin/env node

import net from "net";
import process from "process";
import yargs from "yargs";
import { hideBin } from "yargs/helpers";

// magical fixed close message
const closeMessage = Buffer.from("__close");

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
    .parse();

  // auto-increment connection id
  let globalId = 0;
  const getId = () => ++globalId;

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
      const _up = net.connect({
        port: args.upstreamPort,
        host: args.upstreamIp,
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
        // save upstream instance
        up = _up;

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
        if (data.equals(closeMessage)) {
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

  const writeToUpstream = (id: number, read: (Buffer | "close")[]) => {
    if (!up) {
      // ignore
      return;
    }
    while (read.length > 0) {
      const data = read.shift()!;
      const upsteamData = Buffer.concat([
        Buffer.alloc(4),
        data === "close" ? closeMessage : data,
      ]);
      upsteamData.writeInt32BE(id);
      up.write(upsteamData);
      if (data === "close") {
        console.log("close from downstream", id);
      } else {
        console.log("write", data.length, "bytes for", id);
      }
    }
  };

  const createDown = (id: number, data: Buffer) => {
    const _down = net.connect({
      port: args.downstreamPort,
      host: args.downstreamIp,
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
          read.push(data);
          writeToUpstream(id, read);
        }
      });
      _down.on("close", () => {
        if (downs.has(id)) {
          read.push("close");
          writeToUpstream(id, read);
          downs.delete(id);
        }
      });
      _down.on("error", () => {
        if (downs.has(id)) {
          read.push("close");
          writeToUpstream(id, read);
          downs.delete(id);
        }
      });
    });
  };
})().catch((err) => {
  console.log("catch error:", err);
});
