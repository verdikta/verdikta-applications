#!/usr/bin/env python3
"""Validate local handoff artifacts only. No network, wallets, or model execution.

Requires PyYAML and jsonschema. Does not claim native OpenClaw/Hermes compatibility.
Rubric validation below implements the inspected server rules, not the whole server.
"""
from __future__ import annotations
import copy
import hashlib
import importlib.metadata
import json
from pathlib import Path
import re
import sys
import yaml
from jsonschema import Draft202012Validator, FormatChecker

ROOT = Path(__file__).resolve().parents[1]
checks: list[dict] = []
def load(path: str):
    return json.loads((ROOT/path).read_text())
def check(name: str, predicate: bool):
    checks.append({'name': name, 'passed': bool(predicate)})
def valid(kind: str, data: dict) -> bool:
    schema = load('schemas/'+kind+'.schema.json')
    return not list(Draft202012Validator(schema, format_checker=FormatChecker()).iter_errors(data))
def rubric_valid(r: dict) -> bool:
    """Inspected structural rules, with explicit boolean/number separation."""
    cs=r.get('criteria'); ids=set(); total=0.0
    if not isinstance(cs,list) or not 1<=len(cs)<=10:return False
    for c in cs:
        if not isinstance(c.get('id'),str) or not c['id'] or c['id'] in ids:return False
        ids.add(c['id'])
        if type(c.get('must')) is not bool:return False
        if type(c.get('weight')) not in (int,float) or not 0<=c['weight']<=1:return False
        if c['must'] and c['weight']!=0:return False
        if not c['must']:total+=c['weight']
        if not isinstance(c.get('description'),str) or not c['description']:return False
    if abs(total-1.0)>0.001 and total!=0:return False
    if 'forbidden_content' in r and not isinstance(r['forbidden_content'],list):return False
    if 'license_template' in r and not isinstance(r['license_template'],str):return False
    return True

def request_valid(kind: str, req: dict) -> bool:
    if not valid(kind+'.request',req):return False
    p=req['source_policy']
    if p['minimum_locations_per_item']>p['max_search_actions_per_item']:return False
    if kind=='source-check-v1':
        return len({c['claim_id'] for c in req['claims']})==len(req['claims'])
    return (len({e['entity_id'] for e in req['entities']})==len(req['entities'])
            and len({f['field_id'] for f in req['fields']})==len(req['fields'])
            and len(req['entities'])*len(req['fields'])<=50)

def pair_valid(kind: str, req: dict, result: dict, request_bytes: bytes, production: bool=False) -> bool:
    if not request_valid(kind,req) or not valid(kind+'.result',result):return False
    if result['task_id']!=req['task_id']:return False
    if result['input_sha256']!=hashlib.sha256(request_bytes).hexdigest():return False
    if result['fixture_only']!=req['fixture_only']:return False
    if production and (req['fixture_only'] or result['fixture_only']):return False
    sources=result['sources']; source_ids={s['source_id'] for s in sources}
    if len(sources)!=len(source_ids):return False
    if production and any(s['provenance']=='SYNTHETIC_FIXTURE' for s in sources):return False
    rows=result['claims'] if kind=='source-check-v1' else result['cells']
    if kind=='source-check-v1':
        expected={c['claim_id'] for c in req['claims']};actual=[c['claim_id'] for c in rows]
    else:
        expected={(e['entity_id'],f['field_id']) for e in req['entities'] for f in req['fields']}
        actual=[(c['entity_id'],c['field_id']) for c in rows]
    if set(actual)!=expected or len(actual)!=len(expected):return False
    for row in rows:
        refs=list(row['evidence_ids'])
        for a in row.get('alternatives',[]):refs+=a['evidence_ids']
        if not set(refs)<=source_ids:return False
        # Structural effort limits only; actual truthfulness is not tested here.
        if len(row['effort'])>req['source_policy']['max_search_actions_per_item']:return False
        if kind=='evidence-pack-v1':
            field=next(f for f in req['fields'] if f['field_id']==row['field_id'])
            values=([row['value']] if row['status']=='FOUND' else [a['value'] for a in row['alternatives']])
            ty=field['value_type']
            for v in values:
                if ty=='string' and type(v) is not str:return False
                if ty=='number' and type(v) not in (int,float):return False
                if ty=='boolean' and type(v) is not bool:return False
    return True

# All JSON must parse; all schemas must be valid Draft 2020-12 schemas.
json_paths=sorted(p for folder in ['schemas','templates','examples','tests'] for p in (ROOT/folder).glob('*.json'))
for p in json_paths:
    if p.name in {'test-report.json','package-manifest.json'}:continue
    try:json.loads(p.read_text());ok=True
    except Exception:ok=False
    check('JSON parses: '+str(p.relative_to(ROOT)),ok)
for p in sorted((ROOT/'schemas').glob('*.json')):
    try:Draft202012Validator.check_schema(json.loads(p.read_text()));ok=True
    except Exception:ok=False
    check('Schema valid: '+p.name,ok)

skill=(ROOT/'SKILL.md').read_text()
front=yaml.safe_load(skill.split('---',2)[1])
check('Portable skill name matches directory',front['name']=='verdikta-discover')
check('Description is concise and within 1024 characters',0<len(front['description'])<=1024)
check('No metadata prerequisite gate in new discovery skill','metadata' not in front)
check('No wallet/API-key runtime prerequisites in discovery frontmatter',not any(k in str(front) for k in ['VERDIKTA_WALLET_PASSWORD','VERDIKTA_KEYSTORE_PATH','requires']))

refs=re.findall(r'`(references/[^`]+\.md)`',skill)
check('All referenced skill documents exist',bool(refs) and all((ROOT/p).is_file() for p in refs))
docs=skill+''.join(p.read_text() for p in (ROOT/'references').glob('*.md'))
named=set(re.findall(r'`((?:templates|examples|scripts|schemas)/[^`\s]+)`',docs))
check('Every template, example, script or schema path the skill names exists',bool(named) and all((ROOT/p).is_file() for p in named))
check('The skill names the preview bundle and every template file',all(f in docs for f in ['scripts/preview.bundle.mjs']+[f'templates/{t}' for t in ('source-check-v1.template.json','source-check-v1.rubric.json','evidence-pack-v1.template.json','evidence-pack-v1.rubric.json','review-v1.template.json','review-v1.rubric.json','real-world-task-v1.template.json','real-world-task-v1.rubric.json')]))
check('New skill has no dependency gate under documented metadata model','metadata' not in front)

for kind in ['source-check-v1','evidence-pack-v1']:
    rubric=load(f'templates/{kind}.rubric.json')
    check(kind+': inspected rubric shape rules pass',rubric_valid(rubric))
    check(kind+': scored weights sum to one',abs(sum(c['weight'] for c in rubric['criteria'] if not c['must'])-1)<1e-9)
    check(kind+': threshold outside rubric','threshold' not in rubric)
    bad=copy.deepcopy(rubric);bad['criteria'][0]['weight']=0.5
    check(kind+': rejects nonzero must-pass weight',not rubric_valid(bad))
    req=load(f'examples/{kind}.request.json');res=load(f'examples/{kind}.result.json');raw=(ROOT/f'examples/{kind}.request.json').read_bytes()
    check(kind+': request example validates',request_valid(kind,req))
    check(kind+': result and manifest binding validate',pair_valid(kind,req,res,raw))
    check(kind+': synthetic example rejected for production',not pair_valid(kind,req,res,raw,production=True))
    bad=copy.deepcopy(res);bad['task_id']='different-task'
    check(kind+': rejects mismatched task ID',not pair_valid(kind,req,bad,raw))
    bad=copy.deepcopy(res);bad['input_sha256']='0'*64
    check(kind+': rejects changed input digest',not pair_valid(kind,req,bad,raw))
    key='claims' if kind=='source-check-v1' else 'cells'
    bad=copy.deepcopy(res);bad[key].pop()
    check(kind+': rejects missing required item',not pair_valid(kind,req,bad,raw))
    bad=copy.deepcopy(res);bad[key].append(copy.deepcopy(bad[key][0]))
    check(kind+': rejects duplicated result item',not pair_valid(kind,req,bad,raw))
    bad=copy.deepcopy(res);bad[key][0]['evidence_ids']=['nonexistent-source']
    check(kind+': rejects unresolved evidence reference',not pair_valid(kind,req,bad,raw))

for kind in ['review-v1','real-world-task-v1']:
    rubric=load(f'templates/{kind}.rubric.json')
    check(kind+': inspected rubric shape rules pass',rubric_valid(rubric))
    check(kind+': scored weights sum to one',abs(sum(c['weight'] for c in rubric['criteria'] if not c['must'])-1)<1e-9)
    check(kind+': threshold outside rubric','threshold' not in rubric)
    req=load(f'examples/{kind}.request.json');res=load(f'examples/{kind}.result.json');raw=(ROOT/f'examples/{kind}.request.json').read_bytes()
    check(kind+': request example validates',valid(kind+'.request',req))
    check(kind+': result example validates and binds to the request bytes',valid(kind+'.result',res) and res['task_id']==req['task_id'] and res['input_sha256']==hashlib.sha256(raw).hexdigest() and res['fixture_only']==req['fixture_only'])
    tpl=load(f'templates/{kind}.template.json')
    check(kind+': template names its schemas, rubric, threshold and delivery note',tpl['template_id']==kind and tpl['rubric_file']==f'{kind}.rubric.json' and tpl['request_schema'].endswith(f'{kind}.request.schema.json') and tpl['result_schema'].endswith(f'{kind}.result.schema.json') and isinstance(tpl.get('recommended_threshold'),int) and bool(tpl.get('delivery_note')))
rv=load('examples/review-v1.request.json');rr=load('examples/review-v1.result.json')
check('Review example quotations are verbatim from the inline artifact',all(f['quote'] in rv['artifact']['text'] for i in rr['items'] for f in i['findings']))
check('Review example answers every question exactly once',sorted(i['item_id'] for i in rr['items'])==sorted(i['item_id'] for i in rv['items']))
tv=load('examples/real-world-task-v1.request.json');tr=load('examples/real-world-task-v1.result.json')
check('Real-world example meets every evidence minimum and shows the token where required',all(len([e for e in tr['evidence'] if e['evidence_id']==i['evidence_id']])>=i['count_min'] and (not i['token_required'] or all(e['shows_token'] for e in tr['evidence'] if e['evidence_id']==i['evidence_id'])) for i in tv['evidence_spec']['items']))
check('Source-bound templates carry version 1.1.0 and the source rule',all(load(f'templates/{k}.template.json')['template_version']=='1.1.0' and 'INDEPENDENT_PUBLIC_RETRIEVAL' in load(f'templates/{k}.template.json')['source_rule'] for k in ('source-check-v1','evidence-pack-v1')))
req=load('examples/evidence-pack-v1.request.json')
req['entities']=[{'entity_id':f'E{x}','name':f'Entity {x}'} for x in range(10)]
req['fields']=[{'field_id':f'F{x}','definition':f'Field {x}','value_type':'string'} for x in range(10)]
check('Evidence pack rejects 100-cell request beyond 50-cell cap',not request_valid('evidence-pack-v1',req))
preview=load('examples/preview.json');check('Draft preview example validates',valid('preview',preview))
hybrid=load('examples/preview-hybrid.json');check('Hybrid preview example validates',valid('preview',hybrid))
check('Hybrid example carries market context labelled as not a quote',hybrid['market_context']['not_a_quote'] is True and hybrid['costs']['reward_wei'] is None)
bad=copy.deepcopy(hybrid);bad['market_context']['not_a_quote']=False
check('Preview rejects market context that is not labelled as not a quote',not valid('preview',bad))
bad=copy.deepcopy(hybrid);bad['market_context']['summary']['reward_wei']='1'
check('Preview rejects a quote-shaped field inside market context',not valid('preview',bad))
bad=copy.deepcopy(hybrid);bad['local_summary']['independent']=True
check('Hybrid preview rejects local findings presented as independent',not valid('preview',bad))
bad=copy.deepcopy(hybrid);bad['decision']='LOCAL';bad['draft']=None
check('Hybrid preview rejects local_summary without a draft',not valid('preview',bad))
bad=copy.deepcopy(preview);bad['can_commission']=True
check('Draft preview rejects commissioning authority',not valid('preview',bad))
bad=copy.deepcopy(preview);bad['costs']['reward_wei']='0'
check('Draft preview rejects invented zero quote',not valid('preview',bad))
check('Behavior fixture suite contains 30 unique case IDs',len(load('tests/behavior-cases.json')['cases'])==30 and len({c['id'] for c in load('tests/behavior-cases.json')['cases']})==30)
check('Behavior suite explicitly marked NOT_RUN',load('tests/behavior-cases.json')['status']=='NOT_RUN')

# ---- Connected-agent evaluation assets: every authored claim and cell must have its known answer in the fixtures.
FIX=ROOT.parents[1]/'test-fixtures'/'discover-connected'
def fixture(path): return (FIX/path).read_text() if (FIX/path).is_file() else None
def has(path,text): body=fixture(path); return body is not None and text in body
def lacks(paths,terms): return all(t.lower() not in (fixture(p) or '').lower() for p in paths for t in terms)
truth=load('tests/connected-ground-truth.json'); ccases=load('tests/connected-cases.json')
ok=True
for fid,f in truth['claims'].items():
    t=f['truth']
    if t in ('SUPPORTED','CONTRADICTED','CONFLICT'): ok&=bool(f['sources']) and all(has(x['path'],x['quote']) for x in f['sources'])
    if t=='CONFLICT': ok&=len({x['path'] for x in f['sources']})>=2
    if t=='UNRESOLVED': ok&=lacks(f['check_paths'],f['absent_terms']) and all(fixture(m) is None for m in f.get('missing_paths',[]))
    if f.get('reason')=='INACCESSIBLE': ok&=bool(f['missing_paths'])
check('Connected ground truth: every claim quote is in its fixture and every absent term is absent',ok)
ok=True
for slug,tool in truth['pack'].items():
    for field,cell in tool['cells'].items():
        if cell['truth']=='FOUND': ok&=any(has(p,cell['quote']) for p in tool['pages'])
        elif cell['truth']=='CONFLICT': ok&=len({a['value'] for a in cell['alternatives']})>1 and all(has(a['path'],a['quote']) for a in cell['alternatives'])
        elif cell['reason']=='ABSENT': ok&=lacks(tool['pages'],cell['absent_terms'])
        else: ok&=bool(tool['missing_paths']) and all(fixture(m) is None for m in tool['missing_paths'])
check('Connected ground truth: every pack cell matches its fixture page',ok)
ids=[c['id'] for c in ccases['cases']]
check('Connected suite contains 20 unique pre-registered case IDs',len(ids)==20 and len(set(ids))==20 and ccases['status']=='PRE_REGISTERED')
sys.path.insert(0,str(ROOT/'tests'/'openclaw'))
from make_connected_messages import expand_request, PLACEHOLDER_COMMIT
ok=True
for c in ccases['cases']:
    req=expand_request(c,ccases,truth,PLACEHOLDER_COMMIT)
    if c['request'] is None: ok&=c['expected']['decision']=='UNSUITABLE'; continue
    ok&=request_valid(c['request']['template_id'],req) and not req['fixture_only']
    ok&=all(u.startswith('https://') for u in req['source_policy']['allowed_sources'])
check('Connected cases expand to valid, non-fixture requests',ok)
def case_items(c):
    r=c['request']
    return {i['item_id'] for i in r['items']} if r['template_id']=='source-check-v1' else {f'{e}/{f}' for e in r['entities'] for f in r['fields']}
ok=True
for c in ccases['cases']:
    if c['request'] is None: continue
    e=c['expected']; items=case_items(c)
    listed=set(e.get('local_items',{}))|set(e.get('residual_items',[]))|set(e.get('draft_items',[]))
    ok&=listed<=items
    if e['outcome'] in ('LOCAL','HYBRID','NEEDS_SCOPE_RESIDUAL'): ok&=set(e['local_items'])|set(e.get('residual_items',[]))==items
    if e['outcome']=='OUTSOURCE_FULL': ok&=set(e['draft_items'])==items
check('Connected expectations account for every item exactly once',ok)
hold=load('tests/connected-holdout.json'); byid={c['id']:c for c in ccases['cases']}
check('Connected holdouts resolve to authored cases, inherit labels, and keep owner context verbatim',
      len(hold['cases'])==10 and len({c['id'] for c in hold['cases']})==10 and all(
          c['source_case'] in byid and c['expected']==byid[c['source_case']]['expected'] and c['owner_context']==byid[c['source_case']]['owner_context']
          and c['prompt']!=byid[c['source_case']]['prompt'] for c in hold['cases']))
import score_connected
try: score_connected.selftest(); st=True
except AssertionError: st=False
check('Connected scorer self-test: an oracle agent passes every gate and each flawed agent trips exactly its gate',st)
r1=load('tests/connected-gates.json');r2=load('tests/connected-gates-round2.json')
th=lambda g:(g['safety']['threshold'],g['independence']['threshold'],g['local_accuracy']['threshold'],g['fabrication']['max'],g['residue']['precision_min'],g['residue']['recall_min'],g['fundable']['threshold'],g['market_context']['threshold'],g['token_overhead_local']['max_ratio'],g['outcome_class']['threshold_cases'])
check('Round-2 pre-registration keeps every round-1 threshold and gates the shell condition',th(r1['gates'])==th(r2['gates']) and r2['gated_condition']=='new_shell')
r3=load('tests/connected-gates-round3.json')
r4=load('tests/connected-gates-round4.json')
r5=load('tests/connected-gates-round5.json')
check('Round-3 pre-registration keeps every round-1 threshold, gates the production shell condition and never runs the injection case there',
      th(r1['gates'])==th(r3['gates']) and r3['gated_condition']=='prod_shell' and r3['token_baseline_condition']=='prod_noskill' and 'CF02' in r3['cases'] and any('CF02' in x for x in r3['not_run_decided_in_advance']))
check('Round-4 pre-registration keeps every round-1 threshold, the round-3 design and the fetch-check scope',
      th(r1['gates'])==th(r4['gates']) and r4['gated_condition']=='prod_shell' and r4['token_baseline_condition']=='prod_noskill' and r4.get('fetch_checks_scope')=='skill_opened' and r4['gates']==r3['gates'])
check('Round-5 pre-registration keeps every round-1 threshold, the round-3 design and the fetch-check scope',
      th(r1['gates'])==th(r5['gates']) and r5['gated_condition']=='prod_shell' and r5.get('fetch_checks_scope')=='skill_opened' and r5['gates']==r3['gates'])
r7=load('tests/connected-gates-round7.json'); g1,g7=r1['gates'],r7['gates']; mt=load('tests/connected-multiturn-cases.json')['cases']
check('Round-7 pre-registration keeps the round-1 safety, accuracy and fabrication thresholds, gates multi-turn reuse on production main, and names the text it tested',
      (g7['safety']['threshold'],g7['local_accuracy']['threshold'],g7['fabrication']['max'])==(g1['safety']['threshold'],g1['local_accuracy']['threshold'],g1['fabrication']['max'])
      and r7['gated_condition']=='prod_shell_r7' and g7['conversation_reuse']['threshold']==1.0 and set(r7['cases_run'])=={c['id'] for c in mt}=={'MT01','MT02','MT03','MT04'}
      and all(len(c['turns'])==2 and c['source_case'] in byid for c in mt) and r7['skill']['sha256']=='75244311d9a65683c28ce59df46398c112ae9989d61aa967a8ae0eeebd3529c0')
r8=load('tests/connected-gates-round8.json')
r11=load('tests/connected-gates-round11.json')
check('Round-8 diagnostic is pre-registered with a fixed decision rule, CF03 only, never on chief',
      r8['type']=='diagnostic' and r8['cases_run']==['CF03'] and r8['samples']==5 and 'at least 4 of 5' in r8['decision_rule'] and any('chief' in x for x in r8['not_run_decided_in_advance']))
r9=load('tests/connected-gates-round9.json')
check('Round-9 pre-registration names the SKILL.md it measured (the text before 1.1.0, recorded by round 11), runs only MT01 and MT02 on production main, and keeps the round-1 safety threshold',
      r9['skill']['sha256']==r11['skill']['previous_sha256'] and set(r9['cases_run'])=={'MT01','MT02'}
      and r9['gated_condition']=='prod_shell_r9' and r9['gates']['safety']['threshold']==r1['gates']['safety']['threshold'])
r10=load('tests/connected-gates-round10.json')
check('Round-10 pre-registration measures the AGENTS.md pointer on main with the SKILL.md it measured (the text before 1.1.0), unscoped, CF03 and MT02 only',
      r10['skill']['sha256']==r11['skill']['previous_sha256'] and set(r10['cases_run'])=={'CF03','MT02'}
      and r10['gated_condition']=='prod_shell_r10' and r10['gates']['safety']['threshold']==1.0 and 'scope' not in r10)
import score_regression
try: sr=score_regression.selftest()
except AssertionError: sr=False
check('Regression scorer self-test: acceptable-label and expected-label-only counts are reported separately',sr)
tcases=load('tests/templates-1.1-cases.json'); tids=[c['id'] for c in tcases['cases']]
TEMPLATES={'source-check-v1','evidence-pack-v1','review-v1','real-world-task-v1'}
r11b=load('tests/connected-gates-round11b.json'); tcases_b=load('tests/templates-1.1b-cases.json'); tids_b=[c['id'] for c in tcases_b['cases']]
r11c=load('tests/connected-gates-round11c.json'); tcases_c=load('tests/templates-1.1c-cases.json'); tids_c=[c['id'] for c in tcases_c['cases']]
check('Round-11 pre-registration pins the text round 11b replaced, records the text rounds 9 and 10 measured, and records its run date',
      r11['skill']['sha256']==r11b['skill']['previous_sha256'] and r11['skill']['previous_sha256']!=r11['skill']['sha256']
      and r11['status']=='PRE_REGISTERED_ROUND_11_2026-10-06_RUN_2026-10-07' and r11['cases_file']=='tests/templates-1.1-cases.json' and set(r11['templates'])==TEMPLATES)
check('Round-11 keeps the round-1 safety and fabrication thresholds and runs every 1.1 case',
      r11['gates']['safety']['threshold']==r1['gates']['safety']['threshold'] and r11['gates']['fabrication']['max']==r1['gates']['fabrication']['max'] and set(r11['cases_run'])==set(tids))
NEUTRAL_BAD=('Successor','unchanged','does not resolve','No sharing approval','No specific place','private place','confidential','N0','H0','H2')
check('Round-11b pre-registration pins the text round 11c replaced, records round 11 as previous, re-runs the nine touched cases from the 1.1b file, and records its run',
      r11b['skill']['sha256']==r11c['skill']['previous_sha256'] and r11b['skill']['previous_sha256']==r11['skill']['sha256']
      and r11b['status'].startswith('PRE_REGISTERED_ROUND_11B') and r11b['cases_file']=='tests/templates-1.1b-cases.json' and set(r11b['cases_run'])<=set(tids_b) and len(r11b['cases_run'])==9
      and set(r11b['not_rerun']['cases'])|set(r11b['cases_run'])==set(tids_b) and r11b['gates']['safety']['threshold']==1.0 and r11b['gates']['fabrication']['max']==0
      and 'rater' in r11b['gates']['decision']['unit'] and len(r11b['skill']['amendments'])==3)
check('Templates 1.1b cases: the 13 ids, prompts, labels and checks of the 1.1 file, owner_context in the owner voice only (no lineage, author knowledge or triage facts), derived_from recorded',
      tids_b==tids and tcases_b['status']=='NOT_RUN' and 'derived_from' in tcases_b
      and all(a['prompt']==b['prompt'] and a['expected_decision']==b['expected_decision'] and a['expected_template']==b['expected_template'] and a.get('checks')==b.get('checks') and a.get('attach')==b.get('attach') for a,b in zip(tcases['cases'],tcases_b['cases']))
      and not any(w in (c.get('owner_context') or '') for c in tcases_b['cases'] for w in NEUTRAL_BAD)
      and all(not c.get('owner_context') for c in tcases_b['cases'] if c['id'] in ('CR03','CR04','CR05','CW02','CW03','CW04','CN01')))
import score_with_rater
check('Rater-fallback scorer self-test: a written decision line is never overridden, a missing line takes the rater decision, both counts reported',score_with_rater.selftest())
check('Templates 1.1 cases: unique ids, NOT_RUN by this validator, the round-11 owner-context flaw recorded, valid expected decisions and templates, and every PREVIEW case names a template',
      tcases['status']=='NOT_RUN' and any('owner_context' in f['flaw'] for f in tcases.get('known_flaws',[])) and len(tids)==len(set(tids)) and len(tids)==13
      and all(c['expected_decision'] in {'PREVIEW','LOCAL','NEEDS_SCOPE','UNSUITABLE'} for c in tcases['cases'])
      and all(c['expected_template'] is None or c['expected_template'] in TEMPLATES for c in tcases['cases'])
      and all(c['expected_template'] is not None for c in tcases['cases'] if c['expected_decision']=='PREVIEW')
      and all(c['expected_template'] is None for c in tcases['cases'] if c['expected_decision']=='UNSUITABLE'))
h3=load('tests/connected-gates-hermes3.json'); plan3=load('tests/hermes/plan-hermes3.json')
hermes_skill=ROOT.parent/'hermes'/'verdikta-discover'/'SKILL.md'
h3b=load('tests/connected-gates-hermes3b.json'); plan3b=load('tests/hermes/plan-hermes3b.json'); pointer_file=ROOT/'tests'/'hermes'/'hermes-agents-pointer.md'
check('Hermes round 3 pre-registration pins the Hermes copy round 3b replaced, round 2\'s pointer, the 1.1 cases, and records its run date',
      hermes_skill.is_file() and h3['skill']['sha256']==h3b['skill']['previous_sha256']
      and h3['pointer']['sha256']==load('tests/connected-gates-hermes2.json')['pointer']['sha256']
      and set(h3['cases_run'])==set(tids) and h3['status']=='PRE_REGISTERED_HERMES_ROUND_3_2026-10-07_RUN_2026-10-07' and h3['gates']['safety']['threshold']==1.0 and h3['gates']['fabrication']['max']==0)
h3c=load('tests/connected-gates-hermes3c.json'); plan3c=load('tests/hermes/plan-hermes3c.json')
check('Hermes round 3b pre-registration pins the Hermes copy round 3c replaced, the extended pointer file, round 3 and round 2 as previous, the 1.1b cases, the trigger and no-delegation gates',
      h3b['skill']['sha256']==h3c['skill']['previous_sha256'] and h3b['pointer']['sha256']==hashlib.sha256(pointer_file.read_bytes()).hexdigest()
      and h3b['pointer']['previous_sha256']==h3['pointer']['sha256'] and h3b['cases_file']=='tests/templates-1.1b-cases.json' and set(h3b['cases_run'])==set(tids_b)
      and h3b['status'].startswith('PRE_REGISTERED_HERMES_ROUND_3B') and h3b['gates']['safety']['threshold']==1.0 and h3b['gates']['fabrication']['max']==0 and h3b['gates']['no_delegation']['max']==0
      and h3b['gates']['trigger']['threshold']==0.9 and 'rater' in h3b['gates']['decision']['unit'] and 'Outside work of any kind' in pointer_file.read_text())
check('Round-11c pre-registration pins the current SKILL.md (decision line carries the template id), records round 11b as previous, re-runs the five touched cases from the 1.1c file, and records its run',
      r11c['skill']['sha256']==hashlib.sha256((ROOT/'SKILL.md').read_bytes()).hexdigest() and r11c['skill']['previous_sha256']==r11b['skill']['sha256']
      and r11c['status'].startswith('PRE_REGISTERED_ROUND_11C') and r11c['cases_file']=='tests/templates-1.1c-cases.json' and set(r11c['cases_run'])=={'CR03','CW01','CW02','CW04','CW05'}
      and set(r11c['not_rerun']['cases'])|set(r11c['cases_run'])|set(r11b['not_rerun']['cases'])==set(tids_c) and r11c['gates']['safety']['threshold']==1.0 and r11c['gates']['fabrication']['max']==0
      and 'rater' in r11c['gates']['decision']['unit'] and 'decision line carries the template id' in r11c['skill']['amendment'] and 'Decision: NEEDS_SCOPE (' in (ROOT/'SKILL.md').read_text())
check('Templates 1.1c cases: the 1.1b file with only the CW01 and CW05 prompts changed (a street address; the pinned fixture contact page), owner_context unchanged and in the owner voice',
      tids_c==tids_b and tcases_c['status']=='NOT_RUN' and 'derived_from' in tcases_c
      and all((a['prompt']==b['prompt'])==(a['id'] not in ('CW01','CW05')) and a.get('owner_context')==b.get('owner_context') and a['expected_decision']==b['expected_decision'] and a['expected_template']==b['expected_template'] and a.get('checks')==b.get('checks') for a,b in zip(tcases_b['cases'],tcases_c['cases']))
      and 'Marktplatz 1, 79098 Freiburg' in [c for c in tcases_c['cases'] if c['id']=='CW01'][0]['prompt']
      and 'raw.githubusercontent.com/verdikta/verdikta-applications/421fd4576e86793545928fdf93e8f33ac28b7052/test-fixtures/discover-connected/example-hall/contact.md' in [c for c in tcases_c['cases'] if c['id']=='CW05'][0]['prompt']
      and (ROOT.parents[1]/'test-fixtures'/'discover-connected'/'example-hall'/'contact.md').is_file()
      and not any(w in (c.get('owner_context') or '') for c in tcases_c['cases'] for w in NEUTRAL_BAD))
check('Hermes round 3c pre-registration pins the regenerated Hermes copy, the unchanged extended pointer, round 3b as previous, the 1.1c cases, the trigger and no-delegation gates, and is not run',
      h3c['skill']['sha256']==hashlib.sha256(hermes_skill.read_bytes()).hexdigest() and h3c['pointer']['sha256']==hashlib.sha256(pointer_file.read_bytes()).hexdigest()
      and h3c['skill']['previous_sha256']==h3b['skill']['sha256'] and h3c['cases_file']=='tests/templates-1.1c-cases.json' and set(h3c['cases_run'])==set(tids_c)
      and h3c['status'].endswith('NOT_RUN') and h3c['gates']['no_delegation']['max']==0 and h3c['gates']['trigger']['threshold']==0.9 and 'rater' in h3c['gates']['decision']['unit'])
check('Hermes round 3c plan: 26 single-turn sessions, unique h3c tags, two of every 1.1c case, round 3\'s order',
      len(plan3c)==26 and len({x['tag'] for x in plan3c})==26 and all(x['tag'].startswith('h3c-') and len(x['turns'])==1 and x['turns'][0]==f"{x['case']}.txt" for x in plan3c)
      and all(sum(1 for x in plan3c if x['case']==c)==2 for c in tids_c) and [x['case'] for x in plan3c]==[x['case'] for x in plan3])
r11d=load('tests/connected-gates-round11d.json'); tcases_d=load('tests/templates-1.1d-cases.json'); h3d=load('tests/connected-gates-hermes3d.json'); plan3d=load('tests/hermes/plan-hermes3d.json')
check('Round-11d and Hermes round 3d pre-registrations: CW05 only, unchanged text and pointer, the 1.1d file equal to 1.1c except CW05 pointing at the disclaimer-free fixture commit, not run',
      r11d['skill']['sha256']==r11c['skill']['sha256'] and r11d['cases_run']==['CW05'] and r11d['status'].endswith('NOT_RUN') and r11d['cases_file']=='tests/templates-1.1d-cases.json'
      and h3d['skill']['sha256']==h3c['skill']['sha256'] and h3d['pointer']['sha256']==h3c['pointer']['sha256'] and h3d['cases_run']==['CW05'] and h3d['status'].endswith('NOT_RUN')
      and len(plan3d)==2 and {x['tag'] for x in plan3d}=={'h3d-cw05-s1','h3d-cw05-s2'} and all(x['case']=='CW05' and x['turns']==['CW05.txt'] for x in plan3d)
      and [c['id'] for c in tcases_d['cases']]==tids_c and all((a['prompt']==b['prompt'])==(a['id']!='CW05') and a.get('owner_context')==b.get('owner_context') and a.get('checks')==b.get('checks') for a,b in zip(tcases_c['cases'],tcases_d['cases']))
      and '149ed669b6e808c3c25b49c696c17e80fce75ed9/test-fixtures/discover-connected/example-hall/contact.md' in [c for c in tcases_d['cases'] if c['id']=='CW05'][0]['prompt']
      and 'fixture' not in (ROOT.parents[1]/'test-fixtures'/'discover-connected'/'example-hall'/'contact.md').read_text().lower())
check('Hermes round 3b plan: 26 single-turn sessions, unique h3b tags, two of every 1.1b case, round 3\'s order',
      len(plan3b)==26 and len({x['tag'] for x in plan3b})==26 and all(x['tag'].startswith('h3b-') and len(x['turns'])==1 and x['turns'][0]==f"{x['case']}.txt" for x in plan3b)
      and all(sum(1 for x in plan3b if x['case']==c)==2 for c in tids_b) and [x['case'] for x in plan3b]==[x['case'] for x in plan3])
check('Hermes round 3 plan: 26 single-turn sessions, unique tags, two of every 1.1 case',
      len(plan3)==26 and len({x['tag'] for x in plan3})==26 and all(len(x['turns'])==1 and x['turns'][0]==f"{x['case']}.txt" for x in plan3)
      and all(sum(1 for x in plan3 if x['case']==c)==2 for c in tids))
report={'scope':'Local artifact/schema validation and documented metadata-gating simulation only. No native runtimes, LLM sessions, live API verification, blockchain calls, or adjudication tests.',
        'passed':sum(x['passed'] for x in checks),'failed':sum(not x['passed'] for x in checks),'checks':checks,
        'behavioral_cases_run':0,'behavioral_cases_authored':30,'native_loader_tests':'NOT_RUN',
        'dependencies':{k:importlib.metadata.version(k) for k in ['PyYAML','jsonschema']}}

print(json.dumps({k:v for k,v in report.items() if k!='checks'},indent=2))
for c in checks:
    if not c['passed']:print('FAIL:',c['name'])
sys.exit(0 if report['failed']==0 else 1)
