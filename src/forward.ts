#!/usr/bin/env node

import net from "net";
import process from "process";
import yargs from "yargs";
import { hideBin } from "yargs/helpers";

(async function () {
  // parse args
  const args = await yargs(hideBin(process.argv))
    .option("listen-port", {
      number: true,
      demandOption: true,
      description: "listen port",
    })
    .option("forward-port", {
      number: true,
      demandOption: true,
      description: "forward port",
    })
    .option("binding-ip", {
      string: true,
      demandOption: true,
      description: "binding ip address",
    })
    .option("forward-ip", {
      string: true,
      demandOption: true,
      description: "forward ip address",
    })
    .parse();

  // create server
  const server = net.createServer({ keepAlive: true });
  server.on("connection", (socket) => {
    const remote = `${socket.remoteAddress}:${socket.remotePort}`;
    console.log("new connection from", remote);
    const forwardSocket = new net.Socket()
      .connect(args.forwardPort, args.forwardIp)
      .setKeepAlive(true);
    socket.on("close", () => {
      console.log("connection closed", remote);
      forwardSocket.destroy();
    });
    socket.on("error", (err) => {
      forwardSocket.destroy();
    });
    forwardSocket.on("connect", () => {
      socket.on("data", (data) => {
        forwardSocket.write(data);
        console.log("forward", data.length, "bytes");
      });
      forwardSocket.on("data", (data) => {
        socket.write(data);
        console.log("reply", data.length, "bytes");
      });
    });
    forwardSocket.on("close", () => {
      socket.destroy();
    });
    forwardSocket.on("error", () => {
      socket.destroy();
    });
  });
  server.on("listening", () => {
    console.log(
      `forward server is listening at ${args.bindingIp}:${args.listenPort}, forward to ${args.forwardIp}:${args.forwardPort}`
    );
  });
  server.on("error", (err) => {
    console.log("server error:", err);
  });
  server.listen(args.listenPort, args.bindingIp);

  // handle signal
  let closing = false;
  process.on("SIGINT", () => {
    if (!closing) {
      closing = true;
      console.log("forward server is closing...");
      setTimeout(() => {
        console.log("forward server close timeout");
        process.exit(1);
      }, 5000);
      server.close((err) => {
        if (err) {
          console.log("forward server close error:", err);
        }
        console.log("forward server closed");
        process.exit(0);
      });
    }
  });
})().catch((err) => {
  console.log("catch error:", err);
});
