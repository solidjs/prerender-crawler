#!/usr/bin/env node
import { main } from "./cli-main.ts";

process.exitCode = await main(process.argv.slice(2), {
  stdout: line => console.log(line),
  stderr: line => console.error(line)
});
