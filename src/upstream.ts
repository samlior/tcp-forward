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
  const writeToDownstream = (id: number, queue: (Buffer | "close")[]) => {
    if (!down) {
      // ignore
      return;
    }
    while (queue.length > 0) {
      const data = queue.shift()!;
      const downsteamData = Buffer.concat([
        Buffer.alloc(4),
        data === "close" ? closeMessage : data,
      ]);
      downsteamData.writeInt32BE(id);
      down.write(downsteamData);
      if (data === "close") {
        console.log("close from upstream", id);
      } else {
        console.log("write", data.length, "bytes for", id);
      }
    }
  };

  // create downstream server
  const downstream = net.createServer();
  downstream.on("connection", (_down) => {
    const remote = `${_down.remoteAddress}:${_down.remotePort}`;
    if (down) {
      console.log("ignore incoming downstream connection", remote);
      _down.destroy(new Error("downstream connection already exists"));
      return;
    }
    console.log("incomming downstream connection", remote);
    _down.on("data", (data) => {
      if (data.length < 4) {
        console.log("downstream data is less than 4 bytes, ignore");
        return;
      }
      const id = data.readInt32BE();
      data = data.subarray(4);
      const up = ups.get(id);
      if (up) {
        if (data.equals(closeMessage)) {
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
    // clear queue
    for (const [id, { queue }] of ups) {
      if (queue.length > 0) {
        writeToDownstream(id, queue);
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
  const upstream = net.createServer();
  upstream.on("connection", (up) => {
    const id = getId();
    const queue: (Buffer | "close")[] = [];
    ups.set(id, { socket: up, queue });
    up.on("data", (data) => {
      if (ups.has(id)) {
        queue.push(data);
        writeToDownstream(id, queue);
      }
    });
    up.on("close", () => {
      if (ups.has(id)) {
        queue.push("close");
        writeToDownstream(id, queue);
        ups.delete(id);
      }
    });
    up.on("error", () => {
      if (ups.has(id)) {
        queue.push("close");
        writeToDownstream(id, queue);
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
