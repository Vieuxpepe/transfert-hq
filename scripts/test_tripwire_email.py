"""Test dispatch of safety tripwire security alert email."""

from __future__ import annotations

import json
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

import hq_security as SEC


def main():
    config_path = ROOT / "bridge_config.json"
    if not config_path.is_file():
        print(f"Error: {config_path} not found")
        sys.exit(1)

    with open(config_path, "r", encoding="utf-8") as f:
        config = json.load(f)

    tw = SEC.get_tripwire_config(config)
    print("Tripwire configuration:")
    print(f"  Recipient: {tw['recipient_email']}")
    print(f"  Resend API Key: {'[SET]' if tw['resend_api_key'] else '[NOT SET]'}")
    print(f"  Brevo API Key:  {'[SET]' if tw['brevo_api_key'] else '[NOT SET]'}")
    print(f"  SMTP Host:      {tw['smtp_host']}:{tw['smtp_port']}")
    print(f"  SMTP User:      {tw['smtp_user']}")
    print(f"  SMTP Pass:      {'[SET]' if tw['smtp_password'] else '[NOT SET]'}")

    if len(sys.argv) > 1:
        arg = sys.argv[1].strip()
        if arg.startswith("re_"):
            config.setdefault("tripwire", {})["resend_api_key"] = arg
            tw["resend_api_key"] = arg
            print("  Using Resend API key provided as CLI argument.")
        elif arg.startswith("xkeysib-"):
            config.setdefault("tripwire", {})["brevo_api_key"] = arg
            tw["brevo_api_key"] = arg
            print("  Using Brevo API key provided as CLI argument.")
        else:
            config.setdefault("tripwire", {})["smtp_password"] = arg
            tw["smtp_password"] = arg
            print("  Using SMTP password provided as CLI argument.")
    elif not tw["resend_api_key"] and not tw["brevo_api_key"] and not tw["smtp_password"]:
        print("\nAttention : Aucune clé de relais (Resend re_..., Brevo ou mot de passe SMTP) configurée.")
        print("Usage : py -3 scripts/test_tripwire_email.py <cle_api_ou_mot_de_passe>")
        sys.exit(2)

    token = SEC.create_lockdown_token(config)
    base = tw.get("base_url") or "https://vieuxpeepee.taila4d470.ts.net"
    clean_base = base.rstrip("/")
    t_now = time.strftime("%H:%M:%S")

    alert_data = {
        "subject": f"🚨 [Alerte Sécurité HQ] NOUVEAU TEST COMPLET AVEC LES 2 BOUTONS ({t_now})",
        "ip": "127.0.0.1 (Test Manuel)",
        "timestamp_str": f"2026-11-11 {t_now} EST",
        "user_agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X)",
        "action_url": f"{clean_base}/emergency/lockdown?token={token}",
        "wifi_action_url": f"http://192.168.2.110:8765/emergency/lockdown?token={token}",
        "unlock_url": f"{clean_base}/emergency/unlock",
        "wifi_unlock_url": "http://192.168.2.110:8765/emergency/unlock",
        "recipient": tw["recipient_email"],
    }

    print("\nTentative d'envoi du courriel de test...")
    ok, msg = SEC.send_tripwire_email(config, alert_data)
    if ok:
        print(f"SUCCÈS : {msg}")
    else:
        print(f"ÉCHEC : {msg}")


if __name__ == "__main__":
    main()
