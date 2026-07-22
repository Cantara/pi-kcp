# Architecture — the proxy sits between the agent and its tools

The harness is a Model Context Protocol proxy. It front-runs the downstream
tool servers, classifies every call, and adjudicates governed calls against the
active skill's declared scope before forwarding them. The agent never talks to a
tool directly; containment is structural, not advisory.
