# Deep Agents runtime

`DeepAgentsRuntime({ dataDir, baseUrl?, apiKeyEnv? })` registers `deepagents` with
`RuntimeManager`. Select a model explicitly when creating the session. The default
provider is OpenAI compatible (`OPENAI_API_KEY`); `model: (name) => chatModel` injects
another LangChain provider without persisting credentials. Native checkpoints live
in `dataDir/checkpoints.sqlite`, separate from the Manager database.

Import and construction perform no I/O. Sessions create empty durable native
checkpoints without calling a model. Missing history fails; unfinished native work
is never replayed implicitly. Normal completed sessions resume across host restarts.

Tests use the real Deep Agents/LangGraph graph and SQLite with a deterministic
model, through the Manager public API. Hosted model validation is separate.
