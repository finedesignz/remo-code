# OBSRV-05: Cap-Approach Alerting — Summary

**Status:** SHIPPED
**Branch:** OBSRV-05-cap-approach-alerting
**Date:** 2026-06-27

## What Was Built

Additive informational alerting that fires when daily token or dollar-cost accumulation
approaches either cap. Zero behavior change to enforcement; purely observational.

## Files Changed

- hub/src/observability/cap-alert.ts — NEW evaluator with in-memory per-day throttle
- hub/src/orchestrator/macro-cycle.ts — +import, +optional evaluateCapAlert? seam, +wired call
- hub/test/orchestrator-cap-alert.test.ts — NEW 7 test scenarios
- .planning/phases/OBSRV-05-cap-approach-alerting/PLAN.md — NEW
- .planning/phases/OBSRV-05-cap-approach-alerting/SUMMARY.md — NEW

## Key Decisions

- In-memory throttle: no DB needed; worst case = one duplicate alert after process restart
- event: 'info' never halts; always fires regardless of lifecycle stage
- Mark alerted before fanOut: prevents retry on throw
- CapAlertDeps.fanOut on MacroCycleDeps: optional seam for test spies

## Test Results

7/7 pass, 0 fail.

## Env Knob

REMO_ORCHESTRATOR_CAP_ALERT_PCT — default 80. Invalid values fall back to 80.
