# Hermes harness

Runs Voice Memory as the evidence tool for a [Hermes Agent](https://github.com/NousResearch/hermes-agent).

- `config.example.yaml`: the `mcp_servers` entry (local stdio or remote URL).
- `SOUL.md`: the agent's rules: record facts only from `ask_records`,
  public reference kept separate, no diagnoses.
- `skills/voice-memory-records/`: the call order and pre-reply checks.

Tools the agent gets: `list_cases`, `ask_records`, `create_workspace`,
`workspace_status`, `add_document_text` / `upload_document` (local only,
confirmed by the person), and two key-free public lookups from the US
National Library of Medicine: `lookup_test_code` (LOINC, Clinical Tables)
and `test_education` (MedlinePlus Connect). The public lookups are tested
against their documented response formats; run them once against the live
services before relying on them.
