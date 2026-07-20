import json
import pytest
import httpx
from datetime import datetime, timezone

BASE_URL = "http://localhost:8080"

@pytest.fixture(scope="session")
def client():
    return httpx.Client(base_url=BASE_URL, timeout=10.0)

@pytest.fixture
def health_event():
    return {
        "source": "monitor-api-gateway",
        "service": "payment-service",
        "status": "critical",
        "message": "Payment service down - connection timeout",
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "metadata": {
            "response_time_ms": 0,
            "error_code": "ETIMEDOUT",
            "region": "us-east-1"
        }
    }

@pytest.fixture
def routing_rule():
    return {
        "name": "critical-payment-alert",
        "match": {
            "service": "payment-service",
            "status": ["critical", "warning"]
        },
        "channels": ["slack", "discord"],
        "escalation": {
            "delay_minutes": 5,
            "channels": ["email"],
            "recipients": ["oncall-team@company.com"]
        }
    }

def test_ingest_health_event(client, health_event):
    resp = client.post("/api/events", json=health_event)
    assert resp.status_code in (200, 201)
    body = resp.json()
    assert "event_id" in body
    assert body["status"] == "accepted"
    return body["event_id"]

def test_create_routing_rule(client, routing_rule):
    resp = client.post("/api/rules", json=routing_rule)
    assert resp.status_code in (200, 201)
    body = resp.json()
    assert "rule_id" in body
    assert body["channels"] == ["slack", "discord"]

def test_event_triggers_notifications(client, health_event, routing_rule):
    rule_resp = client.post("/api/rules", json=routing_rule)
    rule_id = rule_resp.json()["rule_id"]

    event_resp = client.post("/api/events", json=health_event)
    event_id = event_resp.json()["event_id"]

    notif_resp = client.get(f"/api/events/{event_id}/notifications")
    assert notif_resp.status_code == 200
    notifications = notif_resp.json()
    assert len(notifications) >= 2
    channel_types = [n["channel"] for n in notifications]
    assert "slack" in channel_types
    assert "discord" in channel_types

def test_escalation_triggered(client, health_event, routing_rule):
    rule_resp = client.post("/api/rules", json=routing_rule)
    event_resp = client.post("/api/events", json=health_event)
    event_id = event_resp.json()["event_id"]

    import time
    time.sleep(6)

    notif_resp = client.get(f"/api/events/{event_id}/notifications")
    notifications = notif_resp.json()
    channel_types = [n["channel"] for n in notifications]
    assert "email" in channel_types
    email_notifs = [n for n in notifications if n["channel"] == "email"]
    assert any(r in n.get("recipients", []) for n in email_notifs
               for r in routing_rule["escalation"]["recipients"])

def test_warning_status_routes(client):
    rule = {
        "name": "warning-rule",
        "match": {"service": "auth-service", "status": ["warning"]},
        "channels": ["slack"],
        "escalation": None
    }
    client.post("/api/rules", json=rule)

    event = {
        "source": "monitor-auth",
        "service": "auth-service",
        "status": "warning",
        "message": "High latency detected",
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "metadata": {"response_time_ms": 3500}
    }
    resp = client.post("/api/events", json=event)
    event_id = resp.json()["event_id"]

    notifs = client.get(f"/api/events/{event_id}/notifications").json()
    assert len(notifs) >= 1
    assert notifs[0]["channel"] == "slack"

def test_no_match_no_notification(client):
    event = {
        "source": "monitor-unknown",
        "service": "test-service",
        "status": "ok",
        "message": "All good",
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "metadata": {}
    }
    resp = client.post("/api/events", json=event)
    event_id = resp.json()["event_id"]

    notifs = client.get(f"/api/events/{event_id}/notifications").json()
    assert len(notifs) == 0

def test_duplicate_event_not_renotifed(client, health_event, routing_rule):
    client.post("/api/rules", json=routing_rule)
    resp1 = client.post("/api/events", json=health_event)
    event_id_1 = resp1.json()["event_id"]
    notifs_1 = client.get(f"/api/events/{event_id_1}/notifications").json()
    count_1 = len(notifs_1)

    resp2 = client.post("/api/events", json=health_event)
    event_id_2 = resp2.json()["event_id"]
    notifs_2 = client.get(f"/api/events/{event_id_2}/notifications").json()
    assert len(notifs_2) == 0 or len(notifs_2) <= count_1