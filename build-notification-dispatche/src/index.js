const { NotificationDispatcher, SlackChannel, EmailChannel, WebhookChannel } = require("./dispatcher");

function createDispatcher(config = {}) {
  const dispatcher = new NotificationDispatcher({
    maxRetries: config.maxRetries ?? 3,
    retryBaseMs: config.retryBaseMs ?? 1000,
    retryMaxMs: config.retryMaxMs ?? 60000,
    rateLimitPerSec: config.rateLimitPerSec ?? 10,
    rateLimitBurst: config.rateLimitBurst ?? 20,
    dlqMaxSize: config.dlqMaxSize ?? 10000,
  });

  if (config.slack) dispatcher.registerChannel("slack", new SlackChannel(config.slack));
  if (config.email) dispatcher.registerChannel("email", new EmailChannel(config.email));
  if (config.webhook) dispatcher.registerChannel("webhook", new WebhookChannel(config.webhook));
  if (config.channels) {
    for (const [name, ch] of Object.entries(config.channels)) {
      dispatcher.registerChannel(name, ch);
    }
  }

  return dispatcher;
}

module.exports = { createDispatcher, NotificationDispatcher, SlackChannel, EmailChannel, WebhookChannel };