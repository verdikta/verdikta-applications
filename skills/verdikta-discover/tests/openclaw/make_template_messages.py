#!/usr/bin/env python3
"""Build one model-input message per templates-1.1 case (round 11): prompt, owner context and the material the prompt refers to.

usage: make_template_messages.py CASES_JSON OUT_DIR --commit SHA [--only ID,ID]
`attach: artifact_text` appends the case file's rubric text; `attach: brightwater` appends the six Brightwater claims from the
connected ground truth (BW1-BW6) and the two fixture pages served from the pinned repository commit, in prose, so the agent
authors the request and chooses the source mode itself. Expected labels and checks are never written to messages. The
manifest has the fields extract.py and score_round11.py read.
"""
import json, os, sys

HERE = os.path.dirname(os.path.abspath(__file__))
TESTS = os.path.dirname(HERE)


def main(argv):
    flags = {argv[i]: argv[i + 1] for i, a in enumerate(argv) if a in ("--commit", "--only") and i + 1 < len(argv)}
    cases_path, out_dir = argv[0], argv[1]
    commit = flags.get("--commit")
    if not commit or len(commit) != 40:
        sys.exit("--commit needs the full 40-character SHA the fixture pages are served from")
    only = set(flags["--only"].split(",")) if "--only" in flags else None
    doc = json.load(open(cases_path))
    truth = json.load(open(os.path.join(TESTS, "connected-ground-truth.json")))
    base = json.load(open(os.path.join(TESTS, "connected-cases.json")))["defaults"]["fixture_base"].format(COMMIT=commit)
    os.makedirs(out_dir, exist_ok=True)
    manifest = []
    for c in doc["cases"]:
        if only and c["id"] not in only:
            continue
        parts = [c["prompt"]]
        if c.get("owner_context"):
            parts.append("Owner context: " + c["owner_context"])
        if c.get("attach") == "artifact_text":
            parts.append("Rubric text (public):\n\n" + doc["artifact_text"])
        elif c.get("attach") == "brightwater":
            bw = doc["brightwater"]
            claims = "\n".join(f"{i + 1}. {truth['claims'][f]['text']}" for i, f in enumerate(bw["facts"]))
            pages = "\n".join(f"- {base}{p}" for p in bw["source_paths"])
            parts.append(f"Claims:\n{claims}\n\nDocumentation pages ({bw['version_scope']}):\n{pages}")
        open(os.path.join(out_dir, c["id"] + ".txt"), "w").write("\n\n".join(parts) + "\n")
        manifest.append({"id": c["id"], "group": c["group"], "source_case": None, "expected_decision": c["expected_decision"],
                         "expected_template": c["expected_template"], "expected_zero_mutations": True, "fixture_request": None})
    json.dump(manifest, open(os.path.join(out_dir, "manifest.json"), "w"), indent=1)
    print(len(manifest), "messages in", out_dir)


if __name__ == "__main__":
    main(sys.argv[1:])
