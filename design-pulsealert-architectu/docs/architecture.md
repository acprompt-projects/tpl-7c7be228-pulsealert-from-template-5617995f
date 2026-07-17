# PulseAlert Architecture

## System Overview

```
┌──────────────┐     ┌──────────────────┐     ┌──────────────┐
│  API Monitor  │────▶│  Ingestion API   │────▶│  Rules Engine │
│  (External)   │     │  POST /events    │     │  (Matcher)    │
└──────────────┘     └──────────────────┘     └──────┬───────┘
                                                       │
                                              ┌────────▼────────┐
                                              │  Dispatch Queue │
                                              │  (In-memory)    │
                                              └──────┬─────────┘
                                                     │
                        ┌────────────┬────────────────┼────────────┐
                        │            │                │            │
                  ┌─────▼─────┐ ┌───▼────┐   ┌──────▼──────┐ ┌──▼───┐
                  │  Slack    │ │ Discord│   │   Email     │ │Webhook│
                  │  Channel  │ │ Channel│   │  (SMTP/SES) │ │(POST) │
                  └─────┬─────┘ └───┬────┘   └──────┬──────┘ └──┬───┘
                        │           │               │          │
                        ▼           ▼               ▼          ▼
                   ┌──────────────────────────────────────────────┐
                   │          Escalation Tracker                   │
                   │  If no ack within threshold → escalate up    │
                   └──────────────────────────────────────────────┘
```

## Components

### 1. Alert Ingestion Endpoint
- Receives health-check events via `POST /api/v1/events`
- Validates payload, normalizes severity levels
- Persists event to store, pushes into rules engine

### 2. Rules Engine
- Matches incoming events against configured rules
- Rules define: conditions (severity, service, status), target channels, repeat suppression, escalation delay
- Supports boolean expressions: `severity >= "critical" AND service == "payments"`

### 3. Notification Channels
Each channel implements a `send(notification, target)` interface:
- **Slack**: Posts to channel via webhook URL
- **Discord**: Posts to channel via webhook URL  
- **Email**: Sends via SMTP or cloud SES with templated body
- **Generic Webhook**: POSTs JSON payload to arbitrary URL

### 4. Escalation Tracker
- After initial notification, tracks acknowledgement
- If no ack within `escalation_delay_minutes`, re-notifies next tier
- Escalation tiers: level-1 (on-call) → level-2 (team lead) → level-3 (VP)

### 5. Data Store
SQLite (dev) / PostgreSQL (prod) for:
- Events, rules, notifications, acknowledgements, channel configs

## Data Model

```
Event:        id, source, service, severity, status, message, metadata, timestamp
Rule:         id, name, conditions_json, channels[], suppression_window, escalation_delay, escalation_tiers[]
Channel:      id, type(slack|discord|email|webhook), config_json, enabled
Notification: id, event_id, rule_id, channel_id, target, status, sent_at, ack_at
Escalation:   id, notification_id, tier, triggered_at, ack_at
```

## API Summary

| Method | Path                    | Description                |
|--------|-------------------------|----------------------------|
| POST   | /api/v1/events          | Ingest a health-check event|
| GET    | /api/v1/events          | List recent events         |
| GET    | /api/v1/events/{id}     | Get event details          |
| POST   | /api/v1/rules           | Create a routing rule      |
| GET    | /api/v1/rules           | List rules                 |
| PUT    | /api/v1/rules/{id}      | Update a rule              |
| DELETE | /api/v1/rules/{id}      | Delete a rule              |
| POST   | /api/v1/channels        | Register a channel         |
| GET    | /api/v1/channels        | List channels              |
| PUT    | /api/v1/channels/{id}   | Update channel config      |
| DELETE | /api/v1/channels/{id}   | Remove a channel           |
| POST   | /api/v1/ack/{event_id}  | Acknowledge an event       |
| GET    | /api/v1/notifications   | List notification history  |

## Tech Stack
- Language: Go (fast, single-binary deploy)
- Store: PostgreSQL with sqlc for typed queries
- Config: YAML file + env vars for secrets
- Observability: Structured JSON logging, Prometheus metrics endpoint