# MEEPO

**M**ulti-worker **E**xecution **E**ngine for **P**roject-isolated **O**rchestration.

MEEPO is a project-isolated agent execution and dispatch framework tailored for team IM integration (such as Feishu/Lark). It decouples the centralized conversational control plane from distributed, heterogeneous execution workers (developer laptops, bare-metal servers, and cloud sandboxes).

## Architecture Highlights

- **Space-Isolated Long-Term Memory**: Multi-chat mapping to unified project boundaries (e.g., dev chat + support chat share a single Space memory).
- **Control/Data Plane Separation**: The central server manages Feishu webhooks, routing, and memory persistence without executing heavy local coding tools.
- **Heterogeneous Workers**: Workers run locally on developer laptops or cloud sandboxes, executing coding tasks via isolated Git worktrees and `@earendil-works/pi-agent-core`.
- **Dual Interaction Modes**:
  - **Interactive Session**: Low-latency, capacity-aware streaming session mapped to Feishu message threads.
  - **Ticket Pipeline**: Asynchronous ticket-driven background runs for PR creation, batch test execution, and Cron automation.

## Workspace Layout

```
meepo/
├── apps/
│   ├── meepo-server/      # Central Control Plane
│   ├── meepo-worker/      # Worker Execution Daemon
│   └── meepo-console/     # Management Dashboard (React + Vite)
├── packages/
│   ├── core/              # Domain Models & Core Interfaces
│   ├── protocol/          # Wire Contracts & Event Envelopes
│   └── sdk/               # Programmatic Client SDK
└── specs/                 # Architectural & Feature Specifications
```

## Quick Start

### Prerequisites

- Node.js >= 22.0.0
- pnpm >= 11.0.0
- [Moon](https://moonrepo.dev/) CLI: `npm install -g @moonrepo/cli`

### Installation

```bash
# Install dependencies across all packages
pnpm install
```

### Development & Checks

```bash
# Run lint, typecheck, and tests across all projects
pnpm check

# Format source code
pnpm format
```

## License

MIT
