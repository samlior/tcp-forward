#!/usr/bin/env node

import yargs from "yargs";
import { hideBin } from "yargs/helpers";

yargs
  .command("new", "Create a new ED25519 key pair", async () => {
    const ed25519 = await import("@noble/ed25519");
    const privateKey = ed25519.utils.randomPrivateKey();
    const publicKey = await ed25519.getPublicKeyAsync(privateKey);
    console.log(
      "Private key:",
      ed25519.etc.bytesToHex(privateKey),
      "\nPublic key:",
      ed25519.etc.bytesToHex(publicKey)
    );
  })
  .parse(hideBin(process.argv));
