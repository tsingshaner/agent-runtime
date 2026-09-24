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

The adapter exposes `ask_user` for input requests. External tools and native write
operations require approval by default; `approvalTools` can explicitly select the
required names. `tools` accepts `{ name, description, schema, execute(args, signal) }`
so the adapter can observe actual callback completion. Pass cancellation into
asynchronous work. Uncooperative tools fail cancellation after five seconds and
block reuse of their native session; adapter disposal cannot claim safe closure
while those callbacks remain alive. Aborted remote MCP calls report unconfirmed
cancellation because MCP does not acknowledge that remote effects stopped.

Project resources use the Manager's authenticated MCP bridge and only its selected
skill directories. Every run builds a fresh graph against the same native
checkpoint, so resource changes apply after the Manager drains active runs.
Native file tools use the session working directory; this is not an OS sandbox.
No native long-term memory store or global skill/MCP configuration is loaded.
Tool failures return safe error results to the model. Persisted `.active` markers
prevent resuming abnormal runs even if a checkpoint alone appears complete.
