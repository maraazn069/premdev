import type { FastifyPluginAsync } from "fastify";
import { config } from "../lib/config.js";
import { requireUser } from "../lib/auth-helpers.js";

export const dbRoutes: FastifyPluginAsync = async (app) => {
  app.get("/phpmyadmin-redirect", async (req, reply) => {
    const u = await requireUser(req, reply);
    if (!u) return;
    // Redirect to phpMyAdmin subdomain
    const target = `https://db.${config.PRIMARY_DOMAIN}`;
    reply.redirect(target);
  });
};
