import { onAuthRequest, onRequestGet, onRequestPost } from "./functions/api/state.js";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/api/state") {
      if (request.method === "GET") {
        return onRequestGet({ request, env });
      }

      if (request.method === "POST") {
        return onRequestPost({ request, env });
      }

      return new Response("Method Not Allowed", {
        status: 405,
        headers: { Allow: "GET, POST" },
      });
    }

    if (url.pathname === "/api/auth") {
      return onAuthRequest({ request, env });
    }

    return env.ASSETS.fetch(request);
  },
};
