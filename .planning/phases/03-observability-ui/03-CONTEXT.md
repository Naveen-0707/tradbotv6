# Context: Phase 3 - Observability (UI)

## Role & Goal
To provide better visibility into what the bot is doing without the user constantly checking the logs.

## Current State
The UI provides trade updates, log scrolling, and PnL. Critical bot behaviors like Macro Spikes blocking trades, or database state, are only visible through scrolling log messages, making them easy to miss. API errors fail silently or with an obscure 400.

## Requirements
- **UI-01**: Dashboard displays real-time toast notifications for critical bot events (Macro Guard, Heartbeat failure).
- **UI-02**: API errors (from Bridge) are captured and displayed to the user with actionable feedback.
- **UI-03**: Visual indicator in UI showing "DB Connection" status.

## Key Constraints
- Avoid adding new dependencies to the React frontend if possible.
- Re-use the existing SSE (Server-Sent Events) stream for UI-01 & UI-03.
- Handle styling directly in `index.html`.
