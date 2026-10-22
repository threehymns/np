# Workspace diagnostic pull loop

Unopened files only receive diagnostics if the language server provides workspace-wide diagnostics via `workspace/diagnostic`. We run one pull loop per server rather than per document or per workspace.

Each loop runs on a child Effect scope of the runtime. Stopping a server or disposing the runtime closes that scope, which cancels in-flight pulls and discards previous result identifiers. Between pulls, the loop waits for a configured idle interval, backing off with jitter on errors.

When a server sends a `workspace/diagnostic/refresh` request, the client replies immediately before initiating a repull. Replying first prevents deadlocks because servers do not process subsequent pulls while waiting for their refresh response. Multiple refresh requests arriving in quick succession latch into a single repull.

Document pulls always take precedence over workspace pulls for open buffers. Workspace pull reports supply diagnostics for unopened files, while document pulls manage open files.
