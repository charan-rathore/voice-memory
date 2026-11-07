# Dense model memory boundaries

This repair checks pressure after background model load, before/after each
background embedding, and after query/text embeddings. A model over the existing
90% pressure threshold is retired without waiting for a later user query. New
work cannot acquire that retiring pipeline; disposal still waits for active
inference leases. Completed source-derived embeddings remain valid. Incomplete
text batches return null and callers keep the existing keyword fallback.
A one-second, unref'd local sampler exists only while a model is resident to
catch native allocator growth that arrives after inference completes. It only
retires the optional model; it never reloads, restarts, polls a website, changes
admission for source documents, or spends credits. Retirement/upload pause stops
that sampler. The sampling interval is not a hard peak-memory bound.

The effective dense ceiling is the smaller of a valid configured policy ceiling
and a readable cgroup limit. Configured Infinity/NaN/nonpositive values fail
closed. Health reports configured and host values separately; process RSS is
rounded MiB, not cgroup memory.current. A configured ceiling is not host
memory enforcement.

These are admission and retirement checks, not a hard RSS cap. Native allocation
can exceed a ceiling during load/inference before a boundary is reached, and
native allocators may retain memory after disposal. The sampler observes process RSS, not a causal attribution to the model. No hosting change, watchdog restart policy, model
precision change, source/clinical admission change or provider call is included.

Deterministic child-process tests replace the model and RSS readings to exercise
load/warm/query/text pressure, lease draining and normal completion. They are
control-flow regressions, not real native RSS or an enforced-512MiB/OOM result.
Separate native/resource evidence must state its actual enforcement and workload.

The unchanged installed Transformers path defaults to fp32 despite the legacy
quantized:true option. This repair does not change model precision. A native
probe observed ~422 MiB incremental RSS after load/embedding; the default model
admission estimate is raised from 360 to 448 MiB (26 MiB above that observation).
On a 512 MiB policy budget this declines a cold load above 64 MiB baseline RSS.
That intentionally reduces optional dense availability; keyword retrieval and
exact source/citation safeguards remain. An estimate plus sampled retirement is
not proof of zero OOM under arbitrary documents or native allocator behavior.
