import re,sys
rows={}
for m in re.finditer(r"^\('(\w+)', (['\"])(.*?)\2, '([^']*)', '(.*?)', '(.*?)', '(.*?)'\)$", open('logs/mutants.run.log').read(), re.M):
    rows[m.group(1)]=[m.group(3),m.group(4),m.group(5)]
for m in re.finditer(r"^\('(\w+)', (['\"])(.*?)\2, '([^']*)', '(.*?)', '(.*?)', '(.*?)'\)$", open('logs/mutants-rerun.out').read(), re.M):
    rows[m.group(1)]=[m.group(3),m.group(4),m.group(5)]
x={}
for f in ['logs/mutants-x.md','logs/mutants-x-partial.md']:
    try:
        for l in open(f):
            c=[t.strip() for t in l.strip().strip('|').split('|')]
            if len(c)>=4 and re.match(r'^s\d\d$',c[0]): x[c[0]]=(c[2],c[3])
    except FileNotFoundError: pass
out=['| Mutant | Weakened check | `psn.ts` (128 checks) | `psn.x.ts` |','|---|---|---|---|']
for k in sorted(rows):
    d,r,f=rows[k]
    a='dies at '+f.replace('., ',', ').rstrip('.,') if r.startswith('killed') else 'survives'
    b=''
    if k in x: b='dies at '+x[k][1].replace('., ',', ').rstrip('.,') if x[k][0].startswith('killed') else x[k][0].lower()
    out.append(f'| {k[1:]} | {d} | {a} | {b} |')
print('\n'.join(out))
