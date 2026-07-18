const https = require("https");
const http = require("http");
const { URL } = require("url");
const crypto = require("crypto");

// --- Rate Limiter (token bucket per channel) ---
class RateLimiter {
  constructor(ratePerSec = 5, burst = 10) {
    this.ratePerSec = ratePerSec;
    this.burst = burst;
    this.tokens = new Map();
  }
  _bucket(key) {
    if (!this.tokens.has(key)) {
      this.tokens.set(key, { count: this.burst, last: Date.now() });
    }
    return this.tokens.get(key);
  }
  allow(key) {
    const b = this._bucket(key);
    const now = Date.now();
    const elapsed = (now - b.last) / 1000;
    b.count = Math.min(this.burst, b.count + elapsed * this.ratePerSec);
    b.last = now;
    if (b.count >= 1) {
      b.count -= 1;
      return true;
    }
    return false;
  }
}

// --- Channel Implementations ---
class SlackChannel {
  constructor({ webhookUrl, channel }) {
    this.webhookUrl = webhookUrl;
    this.channel = channel || null;
    this.name = "slack";
  }
  async send(notification) {
    const payload = {
      text: notification.message,
      username: "PulseAlert",
      attachments: notification.severity
        ? [{ color: this._color(notification.severity), fields: [{ title: "Severity", value: notification.severity, short: true }] }]
        : undefined,
    };
    if (this.channel) payload.channel = this.channel;
    return this._post(this.webhookUrl, payload);
  }
  _color(sev) {
    const map = { critical: "danger", warning: "warning", info: "good" };
    return map[sev] || "#808080";
  }
  _post(urlStr, body) {
    return new Promise((resolve, reject) => {
      const url = new URL(urlStr);
      const data = JSON.stringify(body);
      const mod = url.protocol === "https:" ? https : http;
      const req = mod.request(
        { hostname: url.hostname, port: url.port, path: url.pathname, method: "POST", headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) } },
        (res) => {
          let d = "";
          res.on("data", (c) => (d += c));
          res.on("end", () => {
            if (res.statusCode >= 200 && res.statusCode < 300) resolve({ ok: true, status: res.statusCode, body: d });
            else reject(new Error(`Slack ${res.statusCode}: ${d}`));
          });
        }
      );
      req.on("error", reject);
      req.write(data);
      req.end();
    });
  }
}

class EmailChannel {
  constructor({ host, port, user, pass, from, to }) {
    this.host = host;
    this.port = port || 587;
    this.user = user;
    this.pass = pass;
    this.from = from;
    this.to = Array.isArray(to) ? to : [to];
    this.name = "email";
  }
  async send(notification) {
    const nodemailer = require("nodemailer");
    const transporter = nodemailer.createTransport({ host: this.host, port: this.port, secure: this.port === 465, auth: { user: this.user, pass: this.pass } });
    const subject = `[PulseAlert] ${notification.severity ? notification.severity.toUpperCase() + ": " : ""}${notification.subject || notification.message.slice(0, 80)}`;
    const html = `<h2>${notification.subject || "Alert"}</h2><p>${notification.message}</p>${notification.metadata ? `<pre>${JSON.stringify(notification.metadata, null, 2)}</pre>` : ""}`;
    const info = await transporter.sendMail({ from: this.from, to: this.to.join(","), subject, html, text: notification.message });
    transporter.close();
    return { ok: true, messageId: info.messageId };
  }
}

class WebhookChannel {
  constructor({ url, method = "POST", headers = {}, secret }) {
    this.url = url;
    this.method = method;
    this.headers = headers;
    this.secret = secret;
    this.name = "webhook";
  }
  async send(notification) {
    const body = JSON.stringify(notification);
    const hdrs = { "Content-Type": "application/json", ...this.headers };
    if (this.secret) hdrs["X-PulseAlert-Signature"] = `sha256=${crypto.createHmac("sha256", this.secret).update(body).digest("hex")}`;
    return new Promise((resolve, reject) => {
      const url = new URL(this.url);
      const mod = url.protocol === "https:" ? https : http;
      const req = mod.request(
        { hostname: url.hostname, port: url.port, path: url.pathname + url.search, method: this.method, headers: { ...hdrs, "Content-Length": Buffer.byteLength(body) } },
        (res) => {
          let d = "";
          res.on("data", (c) => (d += c));
          res.on("end", () => {
            if (res.statusCode >= 200 && res.statusCode < 300) resolve({ ok: true, status: res.statusCode, body: d });
            else reject(new Error(`Webhook ${res.statusCode}: ${d}`));
          });
        }
      );
      req.on("error", reject);
      req.write(body);
      req.end();
    });
  }
}

// --- Dead-Letter Queue ---
class DeadLetterQueue {
  constructor(maxSize = 10000) {
    this.items = [];
    this.maxSize = maxSize;
  }
  enqueue(entry) {
    if (this.items.length >= this.maxSize) this.items.shift();
    entry.dlqId = crypto.randomUUID();
    entry.dlqTimestamp = Date.now();
    this.items.push(entry);
  }
  dequeue() { return this.items.shift() || null; }
  peek() { return this.items[0] || null; }
  size() { return this.items.length; }
  getAll() { return [...this.items]; }
  purge() { this.items = []; }
}

// --- Retry helper with exponential backoff + jitter ---
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
function backoff(attempt, baseMs = 1000, maxMs = 60000) {
  const delay = Math.min(baseMs * Math.pow(2, attempt), maxMs);
  const jitter = delay * 0.2 * Math.random();
  return delay + jitter;
}

// --- Main Dispatcher ---
class NotificationDispatcher {
  constructor(config = {}) {
    this.channels = new Map();
    this.rateLimiter = new RateLimiter(config.rateLimitPerSec || 10, config.rateLimitBurst || 20);
    this.dlq = new DeadLetterQueue(config.dlqMaxSize || 10000);
    this.maxRetries = config.maxRetries ?? 3;
    this.retryBaseMs = config.retryBaseMs || 1000;
    this.retryMaxMs = config.retryMaxMs || 60000;
    this._inFlight = 0;
  }

  registerChannel(name, channel) {
    if (!channel || typeof channel.send !== "function") throw new Error("Channel must implement send()");
    this.channels.set(name, channel);
    return this;
  }

  async dispatch(notification) {
    const id = notification.id || crypto.randomUUID();
    const targets = notification.channels || [...this.channels.keys()];
    const results = {};
    const errors = {};

    for (const target of targets) {
      const channel = this.channels.get(target);
      if (!channel) {
        errors[target] = `Unknown channel: ${target}`;
        continue;
      }
      if (!this.rateLimiter.allow(target)) {
        errors[target] = "Rate limited";
        this.dlq.enqueue({ id, channel: target, notification, error: "Rate limited", attempts: 0, maxRetries: this.maxRetries });
        continue;
      }
      try {
        results[target] = await this._sendWithRetry(channel, { ...notification, id }, target);
      } catch (err) {
        errors[target] = err.message;
        this.dlq.enqueue({ id, channel: target, notification, error: err.message, attempts: this.maxRetries, maxRetries: this.maxRetries });
      }
    }

    return { id, results, errors, dlqSize: this.dlq.size() };
  }

  async _sendWithRetry(channel, notification, channelName) {
    let lastErr;
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        this._inFlight++;
        const result = await channel.send(notification);
        this._inFlight--;
        return result;
      } catch (err) {
        this._inFlight--;
        lastErr = err;
        if (attempt < this.maxRetries) {
          await sleep(backoff(attempt, this.retryBaseMs, this.retryMaxMs));
        }
      }
    }
    throw lastErr;
  }

  async retryFromDLQ(limit = 10) {
    const retried = [];
    const toRetry = [];
    for (let i = 0; i < limit && this.dlq.size() > 0; i++) {
      toRetry.push(this.dlq.dequeue());
    }
    for (const entry of toRetry) {
      const channel = this.channels.get(entry.channel);
      if (!channel) { this.dlq.enqueue(entry); continue; }
      try {
        const result = await channel.send(entry.notification);
        retried.push({ id: entry.id, channel: entry.channel, result });
      } catch (err) {
        entry.attempts += 1;
        entry.error = err.message;
        this.dlq.enqueue(entry);
      }
    }
    return retried;
  }

  getDLQ() { return this.dlq.getAll(); }
  getDLQSize() { return this.dlq.size(); }
  purgeDLQ() { this.dlq.purge(); }
  inFlight() { return this._inFlight; }
}

module.exports = { NotificationDispatcher, SlackChannel, EmailChannel, WebhookChannel, DeadLetterQueue, RateLimiter };