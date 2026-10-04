#!/bin/bash
# Thin wrapper so Hermes cron (clean env: PATH=/usr/bin:/bin) can run the
# BTC position monitor. stdout is the message; empty stdout = silent tick.
exec /usr/bin/python3 /home/ubuntu/.hermes/scripts/btc-position-monitor.py
