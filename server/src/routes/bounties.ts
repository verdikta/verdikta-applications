import { Router } from "express";
import {
  checkQueryLength,
  MAX_EVALUATION_QUERY_CHARS,
  MAX_HUNTER_QUERY_CHARS,
} from "../config/evaluation.js";

export const router = Router();
  const query = String(req.body?.query ?? "");
  if (!query) return res.status(400).json({ error: "query required" });
  const isHunterArchive = Boolean(req.body?.isHunterArchive);
  if (!checkQueryLength(query, isHunterArchive)) {
    const limit = isHunterArchive ? MAX_HUNTER_QUERY_CHARS : MAX_EVALUATION_QUERY_CHARS;
    const label = isHunterArchive ? "hunter query" : "query";
    return res.status(400).json({ error: `${label} exceeds ${limit} characters` });
  }
  return res.status(200).json({ ok: true });
});
