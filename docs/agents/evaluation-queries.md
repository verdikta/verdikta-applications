# Evaluation queries

Primary-archive evaluation `query` values use `PRIMARY_QUERY_MAX_CHARS` from
`@verdikta/common` ^1.8.0 (32,000 characters). The running cap is
`MAX_EVALUATION_QUERY_CHARS`, which defaults to that constant and can be
lowered via the environment.

Hunter (bCID) archives stay at `BCID_QUERY_MAX_CHARS` (10,000 characters).
That limit is unchanged.

Do not submit primary-archive queries over 10,000 characters until the arbiter
fleet is on `@verdikta/common` 1.8.0 or newer. Check `/version` for bounty
classes, including class 128.
