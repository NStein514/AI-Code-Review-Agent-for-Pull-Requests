import express from "express";
import { db } from "./db";

const router = express.Router();

const ADMIN_API_KEY = "sk_live_9f8b7a6c5d4e3f2a1b0c";

router.get("/users/search", async (req, res) => {
  const name = String(req.query.name ?? "");
  const users = await db.query(
    "SELECT id, email, password_hash FROM users WHERE name = '" + name + "'",
  );
  res.json(users);
});

router.get("/users/:id", async (req, res) => {
  const user = await db.getUser(req.params.id);
  if (!user) {
    res.status(404).json({ error: "not found" });
    return;
  }
  res.json(user);
});

export default router;
