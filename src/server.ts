#!/usr/bin/env node

import net from "net";
import process from "process";
import yargs from "yargs";
import { hideBin } from "yargs/helpers";
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
    .option("binding-ip", {
      string: true,
      demandOption: true,
      description: "binding ip address",
    })
    .parse();

  // auto-increment connection id
  let globalId = 0;
  const getId = () => ++globalId;

  // upstream sockets
  const ups = new Map<
    number,
    { socket: net.Socket; queue: (Buffer | "close")[] }
  >();

  // downstream socket instance
  let down: net.Socket | undefined;
  const writeToDownstream = (id: number, data?: Buffer | "close") => {
    const up = ups.get(id);
    if (!up) {
      // ignore
      return;
    }

    // push to queue
    if (data) {
      up.queue.push(data);
    }

    if (!down) {
      // ignore
      return;
    }

    // send messages
    while (up.queue.length > 0) {
      const data = up.queue.shift()!;
      const content = data === "close" ? messages.close : data;
      const downstreamData = Buffer.concat([Buffer.alloc(8), content]);
      downstreamData.writeInt32BE(id);
      downstreamData.writeInt32BE(content.length, 4);
      down.write(downstreamData);
      if (data === "close") {
        console.log("close from upstream", id);
      } else {
        console.log("reply", data.length, "bytes for", id);
      }
    }
  };

  // create downstream server
  const downstream = net.createServer({ keepAlive: true });
  downstream.on("connection", (_down) => {
    const remote = `${_down.remoteAddress}:${_down.remotePort}`;
    if (down) {
      console.log("ignore incoming downstream connection", remote);
      _down.destroy();
      return;
    }
    console.log("incoming downstream connection", remote);

    // pending data
    let length = 0;
    let id = 0;
    let pending = Buffer.alloc(0);

    _down.on("data", (data) => {
      while (data.length > 0) {
        if (length === 0) {
          if (data.length < 8) {
            console.log("downstream data is less than 8 bytes, ignore");
            return;
          }
          // init pending data
          id = data.readInt32BE();
          length = data.readInt32BE(4);
          pending = Buffer.alloc(0);

          // slice data, ignore header
          data = data.subarray(8);
        }

        if (length > 0) {
          // append pending data
          const _length = length > data.length ? data.length : length;
          const _data = data.subarray(0, _length);
          length -= _length;
          pending = Buffer.concat([pending, _data]);
          data = data.subarray(_length);
        }

        if (length === 0) {
          const up = ups.get(id);
          if (up) {
            if (data.equals(messages.close)) {
              console.log("close from downstream", id);
              up.socket.destroy(new Error("downstream close"));
              ups.delete(id);
            } else {
              console.log("reply", data.length, "bytes for", id);
              up.socket.write(data);
            }
          } else {
            console.log("ignore reply for", id);
          }

          // clear pending data
          id = 0;
          pending = Buffer.alloc(0);
        }
      }
    });

    _down.on("close", () => {
      console.log("lose downstream connection", remote);
      down = undefined;
    });
    _down.on("error", (err) => {
      console.log("downsteam connection error:", err);
      _down.destroy(); // safety off
      down = undefined;
    });
    // save downstream instance
    down = _down;

    // clear queue
    for (const [id, { queue }] of ups) {
      if (queue.length > 0) {
        writeToDownstream(id);
      }
    }
  });
  downstream.on("listening", () => {
    console.log(
      `downstream server is listening at ${args.bindingIp}:${args.downstreamPort}`
    );
  });
  downstream.on("error", (err) => {
    console.log("downstream error:", err);
  });
  downstream.listen(args.downstreamPort, args.bindingIp);

  // create upstream server
  const upstream = net.createServer({ keepAlive: true });
  upstream.on("connection", (up) => {
    const id = getId();
    console.log("incoming upstream connection", id);
    const queue: (Buffer | "close")[] = [];
    ups.set(id, { socket: up, queue });
    up.on("data", (data) => {
      if (ups.has(id)) {
        writeToDownstream(id, data);
      }
    });
    up.on("close", () => {
      if (ups.has(id)) {
        console.log("upstream closed", id);
        writeToDownstream(id, "close");
        ups.delete(id);
      }
    });
    up.on("error", () => {
      if (ups.has(id)) {
        writeToDownstream(id, "close");
        ups.delete(id);
      }
    });
  });
  upstream.on("listening", () => {
    console.log(
      `upstream server is listening at ${args.bindingIp}:${args.upstreamPort}`
    );
  });
  upstream.on("error", (err) => {
    console.log("upstream error:", err);
  });
  upstream.listen(args.upstreamPort, args.bindingIp);

  // handle signal
  let closing = false;
  process.on("SIGINT", () => {
    if (!closing) {
      closing = true;
      console.log("server is closing...");

      // close all sockets
      if (down) {
        down.destroy();
      }
      for (const [, { socket }] of ups) {
        socket.destroy();
      }

      setTimeout(() => {
        console.log("server close timeout");
        process.exit(1);
      }, 5000);
      Promise.all([
        new Promise<void>((r) => downstream.close(() => r())),
        new Promise<void>((r) => upstream.close(() => r())),
      ]).then(() => {
        console.log("server closed");
        process.exit(0);
      });
    }
  });
})().catch((err) => {
  console.log("catch error:", err);
});
