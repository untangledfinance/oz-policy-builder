#!/usr/bin/env python3
"""Builds the sLOC ladder of the gate: each rung is the previous rung's source with one group of cuts applied, then rustfmt'd. rNN.rs is the code only (comments stripped)."""
import re, subprocess, sys, os
D = os.path.dirname(os.path.abspath(__file__))
def fmt(path): subprocess.run(['rustfmt', '--edition', '2021', path], check=True)
def sloc(path):
    n = 0
    for l in open(path).read().splitlines():
        s = l.strip()
        if s and not s.startswith('//'): n += 1
    return n
def sub(t, old, new, count=1):
    if t.count(old) != count: raise SystemExit(f'pattern count {t.count(old)} != {count}: {old[:100]!r}')
    return t.replace(old, new)
rungs = []
def rung(n, title, fn):
    prev = open(f'{D}/r{n-1:02d}.rs').read()
    t = fn(prev)
    p = f'{D}/r{n:02d}.rs'; open(p, 'w').write(t); fmt(p)
    print(f'r{n:02d} {sloc(p):4d}  {title}')
