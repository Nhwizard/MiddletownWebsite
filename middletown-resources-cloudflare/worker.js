const MAX_FILE_SIZE_BYTES = 75 * 1024 * 1024;
const MAX_FILES_PER_CATEGORY = 5;
const SESSION_SECONDS = 8 * 60 * 60;
const LOGIN_WINDOW_SECONDS = 15 * 60;
const MAX_LOGIN_ATTEMPTS = 5;
const SESSION_COOKIE = "mfc_resource_admin";
const VALID_CATEGORIES = new Set(["sermons", "bulletins", "bible-passages"]);
const encoder = new TextEncoder();
const decoder = new TextDecoder();

let schemaReady;

const SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS resources (
    id TEXT PRIMARY KEY,
    category TEXT NOT NULL CHECK (category IN ('sermons', 'bulletins', 'bible-passages')),
    title TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    passage TEXT NOT NULL DEFAULT '',
    resource_date TEXT,
    original_name TEXT NOT NULL,
    r2_key TEXT NOT NULL UNIQUE,
    mime_type TEXT NOT NULL DEFAULT 'application/pdf',
    size_bytes INTEGER NOT NULL CHECK (size_bytes > 0 AND size_bytes <= 78643200),
    created_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_resources_category_date
    ON resources (category, resource_date DESC, created_at DESC)`,
  `CREATE TABLE IF NOT EXISTS login_attempts (
    ip_hash TEXT PRIMARY KEY,
    attempts INTEGER NOT NULL,
    window_started INTEGER NOT NULL
  )`
];

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    try {
      if (url.pathname === "/api/resources" && request.method === "GET") {
        return await listResources(env);
      }

      const fileMatch = url.pathname.match(/^\/api\/resources\/([A-Za-z0-9-]{1,80})\/(view|download)$/);
      if (fileMatch && (request.method === "GET" || request.method === "HEAD")) {
        return await serveResource(request, env, fileMatch[1], fileMatch[2]);
      }

      if (url.pathname === "/api/admin/session" && request.method === "GET") {
        return json({ authenticated: await isAuthenticated(request, env) }, 200, { "Cache-Control": "no-store" });
      }

      if (url.pathname === "/api/admin/login" && request.method === "POST") {
        return await login(request, env);
      }

      if (url.pathname === "/api/admin/logout" && request.method === "POST") {
        if (!isSameOrigin(request)) return json({ error: "Request rejected." }, 403);
        return json(
          { ok: true },
          200,
          { "Set-Cookie": `${SESSION_COOKIE}=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0`, "Cache-Control": "no-store" }
        );
      }

      if (url.pathname === "/api/admin/upload" && request.method === "POST") {
        return await uploadResource(request, env);
      }

      const deleteMatch = url.pathname.match(/^\/api\/admin\/resources\/([A-Za-z0-9-]{1,80})$/);
      if (deleteMatch && request.method === "DELETE") {
        return await deleteResource(request, env, ctx, deleteMatch[1]);
      }

      if (url.pathname.startsWith("/api/")) {
        return json({ error: "Not found." }, 404);
      }

      return env.ASSETS.fetch(request);
    } catch (error) {
      console.error("Resource Worker error", error);
      return json({ error: "The resource service encountered an unexpected error." }, 500);
    }
  }
};

async function ensureReady(env) {
  if (!env.DB || !env.PDFS) throw new Error("Cloudflare D1 and R2 bindings are not configured.");
  if (!schemaReady) {
    schemaReady = env.DB.batch(SCHEMA_STATEMENTS.map((statement) => env.DB.prepare(statement))).catch((error) => {
      schemaReady = undefined;
      throw error;
    });
  }
  await schemaReady;
}

async function listResources(env) {
  await ensureReady(env);
  const result = await env.DB.prepare(
    `SELECT id, category, title, description, passage, resource_date, original_name, size_bytes, created_at
     FROM resources
     ORDER BY category ASC, COALESCE(resource_date, '') DESC, created_at DESC`
  ).all();

  const resources = (result.results || []).map((row) => ({
    ...row,
    view_url: `/api/resources/${encodeURIComponent(row.id)}/view`,
    download_url: `/api/resources/${encodeURIComponent(row.id)}/download`
  }));

  return json({ resources }, 200, { "Cache-Control": "no-store" });
}

async function serveResource(request, env, id, disposition) {
  await ensureReady(env);
  const row = await env.DB.prepare(
    `SELECT r2_key, original_name, size_bytes FROM resources WHERE id = ?`
  ).bind(id).first();

  if (!row) return new Response("PDF not found.", { status: 404 });

  const safeName = safeDownloadName(row.original_name);
  const headers = new Headers({
    "Content-Type": "application/pdf",
    "Content-Disposition": `${disposition === "download" ? "attachment" : "inline"}; filename="${safeName}"`,
    "Accept-Ranges": "bytes",
    "Cache-Control": "public, max-age=300",
    "X-Content-Type-Options": "nosniff"
  });

  if (request.method === "HEAD") {
    const object = await env.PDFS.head(row.r2_key);
    if (!object) return new Response("PDF not found.", { status: 404 });
    headers.set("Content-Length", String(object.size));
    headers.set("ETag", object.httpEtag);
    return new Response(null, { status: 200, headers });
  }

  const rangeHeader = request.headers.get("Range");
  const object = await env.PDFS.get(row.r2_key, rangeHeader ? { range: request.headers } : undefined);
  if (!object || !object.body) return new Response("PDF not found.", { status: 404 });

  headers.set("ETag", object.httpEtag);
  if (object.range) {
    const offset = object.range.offset || 0;
    const length = object.range.length || object.size;
    headers.set("Content-Range", `bytes ${offset}-${offset + length - 1}/${object.size}`);
    headers.set("Content-Length", String(length));
    return new Response(object.body, { status: 206, headers });
  }

  headers.set("Content-Length", String(object.size));
  return new Response(object.body, { status: 200, headers });
}

async function login(request, env) {
  if (!isSameOrigin(request)) return json({ error: "Request rejected." }, 403);
  if (!env.ADMIN_PASSWORD || !env.SESSION_SECRET) {
    return json({ error: "The administrator password has not been configured yet." }, 503);
  }

  await ensureReady(env);
  const ipHash = await sha256Hex(`${env.SESSION_SECRET}:${request.headers.get("CF-Connecting-IP") || "unknown"}`);
  const now = Math.floor(Date.now() / 1000);
  const attempt = await env.DB.prepare(
    `SELECT attempts, window_started FROM login_attempts WHERE ip_hash = ?`
  ).bind(ipHash).first();

  if (attempt && now - attempt.window_started < LOGIN_WINDOW_SECONDS && attempt.attempts >= MAX_LOGIN_ATTEMPTS) {
    return json({ error: "Too many sign-in attempts. Please wait 15 minutes and try again." }, 429, { "Retry-After": "900" });
  }

  let payload;
  try {
    payload = await request.json();
  } catch (_) {
    return json({ error: "Enter the resource password." }, 400);
  }

  const suppliedPassword = typeof payload.password === "string" ? payload.password.slice(0, 200) : "";
  const valid = await passwordsMatch(suppliedPassword, env.ADMIN_PASSWORD);

  if (!valid) {
    if (!attempt || now - attempt.window_started >= LOGIN_WINDOW_SECONDS) {
      await env.DB.prepare(
        `INSERT INTO login_attempts (ip_hash, attempts, window_started)
         VALUES (?, 1, ?)
         ON CONFLICT(ip_hash) DO UPDATE SET attempts = 1, window_started = excluded.window_started`
      ).bind(ipHash, now).run();
    } else {
      await env.DB.prepare(
        `UPDATE login_attempts SET attempts = attempts + 1 WHERE ip_hash = ?`
      ).bind(ipHash).run();
    }
    return json({ error: "That password is incorrect." }, 401);
  }

  await env.DB.prepare(`DELETE FROM login_attempts WHERE ip_hash = ?`).bind(ipHash).run();
  const token = await createSessionToken(env.SESSION_SECRET);
  return json(
    { ok: true },
    200,
    {
      "Set-Cookie": `${SESSION_COOKIE}=${token}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${SESSION_SECONDS}`,
      "Cache-Control": "no-store"
    }
  );
}

async function uploadResource(request, env) {
  if (!isSameOrigin(request)) return json({ error: "Request rejected." }, 403);
  if (!(await isAuthenticated(request, env))) return json({ error: "Please sign in again." }, 401);
  await ensureReady(env);

  let category;
  let title;
  let description;
  let passage;
  let resourceDate;
  let originalName;

  try {
    category = decodedHeader(request, "X-Resource-Category", 40);
    title = decodedHeader(request, "X-Resource-Title", 120);
    description = decodedHeader(request, "X-Resource-Description", 500, false);
    passage = decodedHeader(request, "X-Resource-Passage", 120, false);
    resourceDate = decodedHeader(request, "X-Resource-Date", 10, false);
    originalName = decodedHeader(request, "X-File-Name", 220);
  } catch (error) {
    return json({ error: error.message }, 400);
  }

  if (!VALID_CATEGORIES.has(category)) return json({ error: "Choose a valid resource section." }, 400);
  if (!title) return json({ error: "A title is required." }, 400);
  if (resourceDate && !/^\d{4}-\d{2}-\d{2}$/.test(resourceDate)) return json({ error: "The resource date is invalid." }, 400);
  if (!originalName.toLowerCase().endsWith(".pdf")) return json({ error: "PDF files only." }, 400);
  if ((request.headers.get("Content-Type") || "").split(";")[0].trim().toLowerCase() !== "application/pdf") {
    return json({ error: "PDF files only." }, 415);
  }

  const declaredSize = Number(request.headers.get("X-File-Size") || request.headers.get("Content-Length"));
  if (!Number.isFinite(declaredSize) || declaredSize <= 0) return json({ error: "The PDF is empty or its size is unavailable." }, 400);
  if (declaredSize > MAX_FILE_SIZE_BYTES) return json({ error: "This PDF is larger than the 75 MB limit." }, 413);
  if (!request.body) return json({ error: "No PDF was received." }, 400);

  const id = crypto.randomUUID();
  const r2Key = `${category}/${id}.pdf`;
  let uploaded;

  try {
    uploaded = await env.PDFS.put(r2Key, validatedPdfStream(request.body), {
      httpMetadata: {
        contentType: "application/pdf",
        contentDisposition: `inline; filename="${safeDownloadName(originalName)}"`,
        cacheControl: "public, max-age=300"
      },
      customMetadata: { originalName }
    });
  } catch (error) {
    const message = String(error?.message || error);
    if (message.includes("FILE_TOO_LARGE")) return json({ error: "This PDF is larger than the 75 MB limit." }, 413);
    if (message.includes("NOT_A_PDF")) return json({ error: "The selected file is not a valid PDF." }, 415);
    throw error;
  }

  if (!uploaded) return json({ error: "The PDF could not be stored." }, 500);

  const now = Math.floor(Date.now() / 1000);
  try {
    const result = await env.DB.prepare(
      `INSERT INTO resources
       (id, category, title, description, passage, resource_date, original_name, r2_key, mime_type, size_bytes, created_at)
       SELECT ?, ?, ?, ?, ?, ?, ?, ?, 'application/pdf', ?, ?
       WHERE (SELECT COUNT(*) FROM resources WHERE category = ?) < ?`
    ).bind(
      id,
      category,
      title,
      description,
      passage,
      resourceDate || null,
      originalName,
      r2Key,
      uploaded.size,
      now,
      category,
      MAX_FILES_PER_CATEGORY
    ).run();

    if ((result.meta?.changes || 0) !== 1) {
      await env.PDFS.delete(r2Key);
      return json({ error: "This section already has five PDFs. Delete one before uploading another." }, 409);
    }
  } catch (error) {
    await env.PDFS.delete(r2Key);
    throw error;
  }

  return json({ ok: true, id }, 201, { "Cache-Control": "no-store" });
}

async function deleteResource(request, env, ctx, id) {
  if (!isSameOrigin(request)) return json({ error: "Request rejected." }, 403);
  if (!(await isAuthenticated(request, env))) return json({ error: "Please sign in again." }, 401);
  await ensureReady(env);

  const row = await env.DB.prepare(`SELECT r2_key FROM resources WHERE id = ?`).bind(id).first();
  if (!row) return json({ error: "Resource not found." }, 404);

  await env.DB.prepare(`DELETE FROM resources WHERE id = ?`).bind(id).run();
  ctx.waitUntil(env.PDFS.delete(row.r2_key));
  return json({ ok: true }, 200, { "Cache-Control": "no-store" });
}

function validatedPdfStream(body) {
  let total = 0;
  const prefix = [];
  let signatureChecked = false;

  return body.pipeThrough(new TransformStream({
    transform(chunk, controller) {
      const bytes = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
      total += bytes.byteLength;
      if (total > MAX_FILE_SIZE_BYTES) throw new Error("FILE_TOO_LARGE");

      if (!signatureChecked) {
        for (let index = 0; index < bytes.length && prefix.length < 5; index += 1) prefix.push(bytes[index]);
        if (prefix.length === 5) {
          const signature = String.fromCharCode(...prefix);
          if (signature !== "%PDF-") throw new Error("NOT_A_PDF");
          signatureChecked = true;
        }
      }

      controller.enqueue(bytes);
    },
    flush() {
      if (!signatureChecked || total === 0) throw new Error("NOT_A_PDF");
    }
  }));
}

async function isAuthenticated(request, env) {
  if (!env.SESSION_SECRET) return false;
  const token = readCookie(request, SESSION_COOKIE);
  if (!token) return false;
  return verifySessionToken(token, env.SESSION_SECRET);
}

async function createSessionToken(secret) {
  const payload = toBase64Url(encoder.encode(JSON.stringify({
    exp: Math.floor(Date.now() / 1000) + SESSION_SECONDS,
    nonce: crypto.randomUUID()
  })));
  const signature = await sign(payload, secret);
  return `${payload}.${signature}`;
}

async function verifySessionToken(token, secret) {
  const parts = token.split(".");
  if (parts.length !== 2) return false;
  const expected = await sign(parts[0], secret);
  if (!safeEqualStrings(parts[1], expected)) return false;

  try {
    const payload = JSON.parse(decoder.decode(fromBase64Url(parts[0])));
    return Number.isFinite(payload.exp) && payload.exp > Math.floor(Date.now() / 1000);
  } catch (_) {
    return false;
  }
}

async function sign(value, secret) {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(value));
  return toBase64Url(new Uint8Array(signature));
}

async function passwordsMatch(supplied, expected) {
  const [left, right] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(supplied)),
    crypto.subtle.digest("SHA-256", encoder.encode(expected))
  ]);
  const a = new Uint8Array(left);
  const b = new Uint8Array(right);
  let difference = 0;
  for (let index = 0; index < a.length; index += 1) difference |= a[index] ^ b[index];
  return difference === 0;
}

async function sha256Hex(value) {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(value)));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function toBase64Url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function fromBase64Url(value) {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((value.length + 3) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function safeEqualStrings(left, right) {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  return difference === 0;
}

function readCookie(request, name) {
  const cookies = request.headers.get("Cookie") || "";
  for (const pair of cookies.split(";")) {
    const separator = pair.indexOf("=");
    if (separator === -1) continue;
    if (pair.slice(0, separator).trim() === name) return pair.slice(separator + 1).trim();
  }
  return "";
}

function decodedHeader(request, name, maxLength, required = true) {
  const raw = request.headers.get(name) || "";
  let value;
  try {
    value = decodeURIComponent(raw);
  } catch (_) {
    throw new Error("One of the form fields contains invalid text.");
  }
  value = value.replace(/[\u0000-\u001F\u007F]/g, " ").trim();
  if (required && !value) throw new Error("Complete all required fields.");
  if (value.length > maxLength) throw new Error("One of the form fields is too long.");
  return value;
}

function safeDownloadName(value) {
  const cleaned = String(value || "resource.pdf")
    .replace(/[^A-Za-z0-9._() -]/g, "_")
    .replace(/\s+/g, " ")
    .slice(0, 160)
    .trim();
  return cleaned.toLowerCase().endsWith(".pdf") ? cleaned : `${cleaned || "resource"}.pdf`;
}

function isSameOrigin(request) {
  const url = new URL(request.url);
  const origin = request.headers.get("Origin");
  if (origin && origin !== url.origin) return false;
  const fetchSite = request.headers.get("Sec-Fetch-Site");
  return !fetchSite || fetchSite === "same-origin" || fetchSite === "none";
}

function json(value, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "X-Content-Type-Options": "nosniff",
      ...extraHeaders
    }
  });
}
