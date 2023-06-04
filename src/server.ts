#!/usr/bin/env node

import net from "net";
import crypto from "crypto";
import process from "process";
import yargs from "yargs";
import { hideBin } from "yargs/helpers";

(async function () {
  // import ESM package
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
      default: "127.0.0.1",
      description: "upstream binding ip address",
    })
    .option("downstream-ip", {
      string: true,
      default: "127.0.0.1",
      description: "downstream binding ip address",
    })
    .option("public-key", {
      string: true,
      demandOption: true,
      description: "ED25519 public key",
    })
    .option("max-pending-downstream", {
      number: true,
      default: 5,
      description: "max connection size of pending downstream",
    })
    .parse();

  // auto increment id
  let autoId = 0;
  const getId = () => {
    return ++autoId;
  };

  // upstream sockets
  const ups = new Map<
    number,
    { socket: net.Socket; queue: (Buffer | "close")[] }
  >();

  // downstream sockets
  const downs = new Map<number, { socket: net.Socket }>();

  // pending upstreams
  const pendingUps: number[] = [];

  // pending downstreams
  const pendingDowns: { socket: net.Socket; setId: (id: number) => void }[] =
    [];

  const writeToDownstream = (id: number, data?: Buffer | "close") => {
    const up = ups.get(id);
    if (!up) {
      // ignore
      return;
    }

    if (data) {
      // push to queue
      up.queue.push(data);
    }

    const down = downs.get(id);
    if (!down) {
      if (data) {
        console.log("pending", data.length, "bytes for", id);
      }
      return;
    }

    while (up.queue.length > 0) {
      const data = up.queue.shift()!;
      if (data === "close") {
        ups.delete(id);
        up.socket.destroy();
        downs.delete(id);
        down.socket.destroy();
        console.log("close from upstream");
        break;
      } else {
        down.socket.write(data);
        console.log("write", data.length, "bytes for", id);
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
      console.log("close from downstream");
    } else {
      up.socket.write(data);
      console.log("reply", data.length, "bytes for", id);
    }
  };

  // create downstream server
  const downstream = net.createServer({ keepAlive: true });
  downstream.on("connection", (down) => {
    const remote = `${down.remoteAddress}:${down.remotePort}`;
    if (pendingDowns.length >= args.maxPendingDownstream) {
      console.log(
        "too many pending downstreams, ignore incoming downstream from:",
        remote
      );
      down.destroy();
      return;
    }

    console.log(
      "incoming downstream connection from:",
      remote,
      " challenging..."
    );

    // downstream id
    let id: number | undefined;

    // challenge response timeout
    let timeout = setTimeout(() => {
      console.log("downstream challenge timeout, from:", remote);
      down.destroy();
    }, 1000);

    // generate and send question to the remote
    const question = crypto.randomBytes(32);
    down.write(question);

    down.once("data", (data) => {
      clearTimeout(timeout);
      ed25519
        .verifyAsync(data, question, args.publicKey)
        .then((result) => {
          if (!result) {
            throw new Error("verify failed");
          }

          if (pendingDowns.length >= args.maxPendingDownstream) {
            console.log(
              "too many pending downstreams, ignore incoming downstream from:",
              remote
            );
            down.destroy();
            return;
          }

          console.log(
            "incoming downstream connection challenging succeeded, from:",
            remote
          );

          // choose a upstream
          if (pendingUps.length > 0) {
            // pick an existing pending upstream from the queue
            id = pendingUps.shift()!;
            downs.set(id, { socket: down });
            // immediately write the data in the memory
            writeToDownstream(id);
          } else {
            // waiting for incoming upstream
            pendingDowns.push({
              socket: down,
              setId: (_id) => (id = _id),
            });
          }

          down.on("data", (data) => {
            if (id !== undefined) {
              writeToUpstream(id, data);
            }
          });
        })
        .catch((err) => {
          console.log("downstream challenge failed:", err);
          down.destroy();
        });
    });
    down.on("close", () => {
      if (id !== undefined) {
        console.log("close from downstream id:", id);
        writeToUpstream(id, "close");
      } else {
        const index = pendingDowns.findIndex(({ socket }) => socket === down);
        if (index !== -1) {
          console.log("lose pending downstream");
          pendingDowns.splice(index, 1);
        }
      }
    });
    down.on("error", (err) => {
      if (id !== undefined) {
        console.log("downstream id:", id, "error:", err);
        writeToUpstream(id, "close");
      } else {
        const index = pendingDowns.findIndex(({ socket }) => socket === down);
        if (index !== -1) {
          console.log("lose pending downstream");
          pendingDowns.splice(index, 1);
        }
      }
    });
  });
  downstream.on("listening", () => {
    console.log(
      `downstream server is listening at ${args.downstreamIp}:${args.downstreamPort}`
    );
  });
  downstream.on("error", (err) => {
    console.log("downstream error:", err);
  });
  downstream.listen(args.downstreamPort, args.downstreamIp);

  // create upstream server
  const upstream = net.createServer({ keepAlive: true });
  upstream.on("connection", (up) => {
    const remote = `${up.remoteAddress}:${up.remotePort}`;
    const id = getId();
    console.log("incoming upstream connection id:", id, "from:", remote);

    // save to upstreams
    ups.set(id, { socket: up, queue: [] });

    // choose a downstream
    if (pendingDowns.length > 0) {
      const { socket: down, setId } = pendingDowns.shift()!;
      downs.set(id, { socket: down });
      setId(id);
    } else {
      // push self to pending queue
      pendingUps.push(id);
    }

    up.on("data", (data) => {
      writeToDownstream(id, data);
    });
    up.on("close", () => {
      console.log("upstream closed id:", id, "from:", remote);
      writeToDownstream(id, "close");
      if (pendingUps.indexOf(id) !== -1) {
        // remove from pending queue
        pendingUps.splice(pendingUps.indexOf(id), 1);
      }
    });
    up.on("error", (err) => {
      console.log("upstream id:", id, "from:", remote, "error:", err);
      writeToDownstream(id, "close");
      if (pendingUps.indexOf(id) !== -1) {
        // remove from pending queue
        pendingUps.splice(pendingUps.indexOf(id), 1);
      }
    });
  });
  upstream.on("listening", () => {
    console.log(
      `upstream server is listening at ${args.upstreamIp}:${args.upstreamPort}`
    );
  });
  upstream.on("error", (err) => {
    console.log("upstream error:", err);
  });
  upstream.listen(args.upstreamPort, args.upstreamIp);

  // handle signal
  let closing = false;
  process.on("SIGINT", () => {
    if (!closing) {
      closing = true;
      console.log("server is closing...");

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

      // close all sockets
      for (const [, { socket }] of downs) {
        socket.destroy();
      }
      for (const [, { socket }] of ups) {
        socket.destroy();
      }
      for (const { socket } of pendingDowns) {
        socket.destroy();
      }
    }
  });
})().catch((err) => {
  console.log("catch error:", err);
});
