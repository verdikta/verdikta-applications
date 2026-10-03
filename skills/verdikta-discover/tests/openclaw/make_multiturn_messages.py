#!/usr/bin/env python3
"""Turn files for the round-7 multi-turn cases.

usage: make_multiturn_messages.py CONNECTED_MSG_DIR OUT_DIR
  CONNECTED_MSG_DIR  the single-turn connected messages (<CASE>.txt at the fixture pin), e.g. from make_connected_messages.py
  OUT_DIR            receives <MT>.t1.txt and <MT>.t2.txt for every case in connected-multiturn-cases.json

"SOURCE_MESSAGE" stands for the source case's message, copied byte for byte; any other turn is used as written.
"""
import json, os, sys

HERE = os.path.dirname(os.path.abspath(__file__))
src, out = sys.argv[1], sys.argv[2]
os.makedirs(out, exist_ok=True)
cases = json.load(open(os.path.join(HERE, '..', 'connected-multiturn-cases.json')))['cases']
for case in cases:
    source = open(os.path.join(src, case['source_case'] + '.txt'), encoding='utf-8').read()
    for n, turn in enumerate(case['turns'], 1):
        text = source if turn == 'SOURCE_MESSAGE' else turn
        with open(os.path.join(out, f"{case['id']}.t{n}.txt"), 'w', encoding='utf-8') as fh:
            fh.write(text)
    print(case['id'], 'from', case['source_case'], 'turns', len(case['turns']))
