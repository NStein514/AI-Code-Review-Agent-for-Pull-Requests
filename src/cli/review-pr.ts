import "dotenv/config";
import process from "node:process";
import { main } from "./review-pr-command.js";

void main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error) => {
    console.error(
      error instanceof Error ? error.stack ?? error.message : String(error),
    );
    process.exitCode = 1;
  });
