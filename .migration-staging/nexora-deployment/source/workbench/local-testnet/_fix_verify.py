from pathlib import Path
import re
p = Path('workbench/local-testnet/verify_task1.py')
t = p.read_text(encoding='utf-8')
# replace any `re([` that starts an evmd call (module re has no __call__)
t = re.sub(r'(\s)re\(\[(\"genesis\"|\"config\"|\"keys\"|\"init\")', r'\1ev([\2', t)
p.write_text(t, encoding='utf-8')
print('ev count', t.count('ev(['), 'remaining re([genesis', t.count('re(["genesis"'))
