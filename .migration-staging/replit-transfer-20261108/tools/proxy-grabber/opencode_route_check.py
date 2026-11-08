import concurrent.futures, json, pathlib, subprocess, time
root=pathlib.Path(__file__).resolve().parent
result_files=sorted((root/'results').glob('proxy-check-*.json'), key=lambda p:p.stat().st_mtime, reverse=True)
if not result_files: raise SystemExit('No proxy-check JSON found; run the grabber first.')
rows=json.loads(result_files[0].read_text(encoding='utf-8-sig'))
proxies=[r for r in rows if r.get('ok') and r.get('protocol') in ('http','https')]
url='https://opencode.ai/zen/v1/responses'
marker='\n__META__'
def check(row):
    scheme='https' if row['protocol']=='https' else 'http'
    proxy=f"{scheme}://{row['host']}:{row['port']}"
    cmd=['curl.exe','--proxy',proxy,'--noproxy','','--connect-timeout','3','--max-time','6','--silent','--show-error','--output','-','--write-out',marker+'%{http_code}|%{time_appconnect}|%{time_total}|%{ssl_verify_result}','-X','POST','-H','Content-Type: application/json','--data-binary','{}',url]
    start=time.perf_counter()
    try:
        p=subprocess.run(cmd,capture_output=True,text=True,encoding='utf-8',errors='replace',timeout=8)
        out=p.stdout
        body,sep,meta=out.rpartition(marker)
        bits=meta.split('|') if sep else []
        code=int(bits[0]) if bits and bits[0].isdigit() else 0
        tls=float(bits[1]) if len(bits)>1 else 0.0
        total=float(bits[2]) if len(bits)>2 else time.perf_counter()-start
        ssl=int(bits[3]) if len(bits)>3 and bits[3].isdigit() else -1
        # The OpenCode endpoint must answer at application layer; no credentials are sent.
        ok=p.returncode==0 and code in (400,401,403,405,422) and ssl==0 and tls>0
        return {'proxy':proxy,'host':row['host'],'port':row['port'],'status':code,'curl_exit':p.returncode,'tls_seconds':round(tls,3),'total_seconds':round(total,3),'ssl_verify_result':ssl,'ok_for_opencode_route':ok,'detail':body[:250] if not ok else 'OpenCode endpoint reached; auth/model payload intentionally omitted'}
    except Exception as exc:
        return {'proxy':proxy,'host':row['host'],'port':row['port'],'status':0,'curl_exit':-1,'tls_seconds':0,'total_seconds':round(time.perf_counter()-start,3),'ssl_verify_result':-1,'ok_for_opencode_route':False,'detail':type(exc).__name__+': '+str(exc)[:150]}
print(f'Testing {len(proxies)} previously passing HTTP proxies against {url} (no API key).',flush=True)
with concurrent.futures.ThreadPoolExecutor(max_workers=10) as pool:
    results=list(pool.map(check,proxies))
results.sort(key=lambda x:(not x['ok_for_opencode_route'],x['total_seconds']))
outfile=root/'results'/'opencode-route-check.json'
outfile.write_text(json.dumps(results,indent=2),encoding='utf-8')
passed=[r for r in results if r['ok_for_opencode_route']]
print(f'OPENCODE_ROUTE_PASS={len(passed)} / {len(results)}')
for r in results:
    print(f"{'PASS' if r['ok_for_opencode_route'] else 'FAIL'} {r['proxy']} HTTP={r['status']} TLS={r['tls_seconds']}s total={r['total_seconds']}s SSL={r['ssl_verify_result']} {r['detail'][:100]}")
print('RESULT_FILE='+str(outfile))
