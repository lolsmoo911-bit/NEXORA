import subprocess,time,concurrent.futures,json,pathlib
candidates=['http://103.237.102.191:11111','http://101.36.112.205:1081','http://103.230.48.110:8082']
url='https://opencode.ai/zen/v1/responses'
def once(proxy,round_no):
    cmd=['curl.exe','--proxy',proxy,'--noproxy','','--connect-timeout','4','--max-time','8','--silent','--show-error','--output','NUL','--write-out','HTTP=%{http_code}|TLS=%{time_appconnect}|TOTAL=%{time_total}|SSL=%{ssl_verify_result}','-X','POST','-H','Content-Type: application/json','--data-binary','{}',url]
    try:
        p=subprocess.run(cmd,capture_output=True,text=True,encoding='utf-8',errors='replace',timeout=10)
        s=p.stdout.strip().split('|')
        vals={x.split('=',1)[0]:x.split('=',1)[1] for x in s if '=' in x}
        code=int(vals.get('HTTP','0')); tls=float(vals.get('TLS','0')); ssl=int(vals.get('SSL','-1')); total=float(vals.get('TOTAL','0'))
        ok=p.returncode==0 and code==400 and tls>0 and ssl==0
        return {'proxy':proxy,'round':round_no,'ok':ok,'http':code,'tls':tls,'ssl':ssl,'total':total,'curl':p.returncode,'stderr':p.stderr[:160]}
    except Exception as e:return {'proxy':proxy,'round':round_no,'ok':False,'error':str(e)}
work=[(p,n) for p in candidates for n in range(1,4)]
with concurrent.futures.ThreadPoolExecutor(max_workers=3) as ex: rows=list(ex.map(lambda x:once(*x),work))
for r in rows: print(f"{'PASS' if r['ok'] else 'FAIL'} {r['proxy']} r{r['round']} HTTP={r.get('http')} TLS={r.get('tls')} SSL={r.get('ssl')} {r.get('stderr','')}")
out=pathlib.Path('results/opencode-stability-check.json');out.write_text(json.dumps(rows,indent=2),encoding='utf-8')
passed={p:sum(1 for r in rows if r['proxy']==p and r['ok']) for p in candidates}
print('PASS_COUNTS='+json.dumps(passed));print('FILE='+str(out.resolve()))
