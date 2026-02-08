import { OpenApiGeneratorV3 } from "@asteasolutions/zod-to-openapi";
import { registry } from "../src/schemas.js";
import { writeFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const projectRoot = join(__dirname, "..");

const generator = new OpenApiGeneratorV3(registry.definitions);

const document = generator.generateDocument({
  openapi: "3.0.0",
  info: {
    title: "Apollo Service",
    description:
      "Service for searching and enriching leads via the Apollo API",
    version: "1.0.0",
  },
  servers: [
    { url: process.env.SERVICE_URL || "http://localhost:3004" },
  ],
});

const outputFile = join(projectRoot, "openapi.json");
writeFileSync(outputFile, JSON.stringify(document, null, 2));
console.log("openapi.json generated");
