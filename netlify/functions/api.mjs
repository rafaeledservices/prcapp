// Netlify Function: answers every request to /api/* for the online version.
import { getStore } from "@netlify/blobs";
import { handle } from "../lib/core.mjs";

const env = (k) => globalThis.Netlify?.env?.get(k) ?? process.env[k];

export default async (req) =>
  handle(req, {
    store: getStore({ name: "prc", consistency: "strong" }),
    env: { STAFF_PASSWORD: env("STAFF_PASSWORD"), TIMEZONE: env("TIMEZONE") },
  });

export const config = { path: "/api/*" };
